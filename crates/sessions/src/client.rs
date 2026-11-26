//! Interactive input client (`src/messaging/live.ts:171-246`, B3-10 Task 1).
//!
//! Connects as viewer `pacer`, negotiates the session protocol and drives one
//! paste into the live PTY. On protocol 1.2 it uses a delivery window; on 1.1
//! it takes and releases control. Kept here so both `task.send` (B3-10) and
//! `task.answer` (B3-7) can reuse the same byte contract.
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

use crate::framing::{Frame, WireDecoder, wire};
use crate::version::{SESSION_PROTOCOL, negotiate};

const HELLO: u8 = 1;
const CONTROL: u8 = 5;
const TAKE: u8 = 8;
const RELEASE: u8 = 9;
const INPUT: u8 = 10;
const DELIVER: u8 = 13;
const GRANTED: u8 = 14;
const DELIVERED: u8 = 15;

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const EXPIRED_UNUSED: &str = "expired-unused";
const DELIVERY_TIMEOUT_MS: u64 = 10_000;
const SUBMIT_DELAY_MS: u64 = 150;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeResult {
    Typed,
    Busy,
    Refused { controller: Option<String> },
    Pending { reason: String },
}

#[derive(Debug)]
pub struct SessionError {
    pub message: String,
    pub input_attempted: bool,
}
impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for SessionError {}

fn err(message: impl Into<String>, attempted: bool) -> SessionError {
    SessionError { message: message.into(), input_attempted: attempted }
}

/// Drive one message into the session socket at `path`. `still_idle` is checked
/// after the delivery grant (1.2) or control grant (1.1) so a competing viewer
/// never receives the paste.
pub async fn type_into_session(
    path: &Path,
    body: &str,
    still_idle: impl Fn() -> bool,
) -> Result<TypeResult, SessionError> {
    let mut attempted = false;
    let mut stream = UnixStream::connect(path)
        .await
        .map_err(|e| err(format!("cannot connect to session: {e}"), false))?;
    let hello = json!({
        "v": 1, "client": "cli", "label": "pacer",
        "versions": [SESSION_PROTOCOL[0], SESSION_PROTOCOL[1]], "pacer": "native",
    });
    let hello_bytes = serde_json::to_vec(&hello).map_err(|e| err(e.to_string(), false))?;
    send(&mut stream, HELLO, &hello_bytes, &mut attempted).await?;

    let mut decoder = WireDecoder::default();
    let (_, hello_reply) = next(&mut stream, &mut decoder, 3000, &mut attempted).await?;
    let versions = hello_reply
        .get("versions")
        .and_then(Value::as_array)
        .map(|items| {
            [
                items.first().and_then(Value::as_u64).unwrap_or(1),
                items.get(1).and_then(Value::as_u64).unwrap_or(1),
            ]
        })
        .unwrap_or([1, 1]);
    let version = negotiate(Some(SESSION_PROTOCOL), versions).unwrap_or(1);
    if version >= 2 {
        deliver_v12(&mut stream, &mut decoder, body, still_idle, &mut attempted).await
    } else {
        deliver_v11(&mut stream, &mut decoder, body, still_idle, &mut attempted).await
    }
}

async fn send(
    stream: &mut UnixStream,
    kind: u8,
    data: &[u8],
    attempted: &mut bool,
) -> Result<(), SessionError> {
    let frame = wire(kind, data).map_err(|e| err(e.to_string(), *attempted))?;
    timeout(Duration::from_secs(3), stream.write_all(&frame))
        .await
        .map_err(|_| err("session write timed out", *attempted))
        .and_then(|result| result.map_err(|e| err(format!("session write failed: {e}"), *attempted)))
}

/// Read the next control/granted/delivered frame, returning its kind and JSON body.
async fn next(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    wait_ms: u64,
    attempted: &mut bool,
) -> Result<(u8, Value), SessionError> {
    let deadline = Duration::from_millis(wait_ms);
    loop {
        let frames = timeout(deadline, async {
            let mut buffer = [0u8; 8192];
            let n = stream
                .read(&mut buffer)
                .await
                .map_err(|e| err(format!("session read failed: {e}"), *attempted))?;
            if n == 0 {
                return Err(err("the session closed the connection", *attempted));
            }
            decoder.push(&buffer[..n]).map_err(|e| err(e.to_string(), *attempted))
        })
        .await
        .map_err(|_| err("the session did not answer in time", *attempted))??;
        for Frame { kind, data, .. } in frames {
            if matches!(kind, CONTROL | GRANTED | DELIVERED) {
                let body = serde_json::from_slice(&data)
                    .map_err(|e| err(format!("invalid session reply: {e}"), *attempted))?;
                return Ok((kind, body));
            }
        }
    }
}

async fn type_body(
    stream: &mut UnixStream,
    body: &str,
    attempted: &mut bool,
) -> Result<(), SessionError> {
    *attempted = true;
    send(stream, INPUT, format!("{PASTE_START}{body}{PASTE_END}").as_bytes(), attempted).await?;
    tokio::time::sleep(Duration::from_millis(SUBMIT_DELAY_MS)).await;
    send(stream, INPUT, b"\r", attempted).await
}

async fn deliver_v12(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    body: &str,
    still_idle: impl Fn() -> bool,
    attempted: &mut bool,
) -> Result<TypeResult, SessionError> {
    send(stream, DELIVER, b"{}", attempted).await?;
    let grant_wait = DELIVERY_TIMEOUT_MS + 3000;
    loop {
        let (kind, reply) = next(stream, decoder, grant_wait, attempted).await?;
        break match kind {
            GRANTED => {
                if !still_idle() {
                    send(stream, DELIVER, br#"{"cancel":true}"#, attempted).await?;
                    Ok(TypeResult::Busy)
                } else {
                    type_body(stream, body, attempted).await?;
                    send(stream, DELIVER, br#"{"done":true}"#, attempted).await?;
                    // The host applies frames in order: skip incidental control
                    // frames and wait for the delivered reply to our completed window.
                    let done = loop {
                        let (kind, body) = next(stream, decoder, 3000, attempted).await?;
                        if kind == DELIVERED {
                            break body;
                        }
                    };
                    if done.get("ok") == Some(&json!(true)) {
                        Ok(TypeResult::Typed)
                    } else if done.get("cause").and_then(Value::as_str) == Some(EXPIRED_UNUSED) {
                        Ok(TypeResult::Pending {
                            reason: done.get("reason").and_then(Value::as_str).unwrap_or("the delivery window expired").to_owned(),
                        })
                    } else {
                        Err(err("the delivery window ended before the input was submitted", *attempted))
                    }
                }
            }
            // Another client's completed delivery is only news; keep waiting
            // for our own grant (src/messaging/live.ts:211).
            DELIVERED if reply.get("ok") == Some(&json!(true)) => continue,
            DELIVERED => Ok(TypeResult::Pending {
                reason: reply.get("reason").and_then(Value::as_str).unwrap_or("the session refused the delivery").to_owned(),
            }),
            _ => continue,
        };
    }
}

async fn deliver_v11(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    body: &str,
    still_idle: impl Fn() -> bool,
    attempted: &mut bool,
) -> Result<TypeResult, SessionError> {
    send(stream, TAKE, b"{}", attempted).await?;
    loop {
        let (_, control) = next(stream, decoder, 3000, attempted).await?;
        let you = control.get("you") == Some(&json!(true));
        let refused = control.get("reason").and_then(Value::as_str) == Some("refused")
            || control.get("controller").is_some();
        if you || refused {
            if !you {
                break Ok(TypeResult::Refused {
                    controller: control.get("controller").and_then(Value::as_str).map(str::to_owned),
                });
            }
            if !still_idle() {
                send(stream, RELEASE, b"{}", attempted).await?;
                break Ok(TypeResult::Busy);
            }
            type_body(stream, body, attempted).await?;
            send(stream, RELEASE, b"{}", attempted).await?;
            loop {
                let (_, back) = next(stream, decoder, 3000, attempted).await?;
                if back.get("you") != Some(&json!(true)) {
                    break;
                }
            }
            break Ok(TypeResult::Typed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn frame(kind: u8, body: &str) -> Vec<u8> {
        wire(kind, body.as_bytes()).unwrap()
    }

    /// A protocol 1.2 host: hello -> control(versions) -> granted -> delivered(ok).
    #[tokio::test]
    async fn protocol_12_types_a_bracketed_paste_and_submit() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let host = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut decoder = WireDecoder::default();
            let mut input = Vec::new();
            loop {
                let mut buffer = [0u8; 2048];
                let n = stream.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                for Frame { kind, data, .. } in decoder.push(&buffer[..n]).unwrap() {
                    match kind {
                        HELLO => {
                            stream.write_all(&frame(CONTROL, r#"{"versions":[1,2]}"#)).await.unwrap()
                        }
                        DELIVER => {
                            let body: Value = serde_json::from_slice(&data).unwrap();
                            if body.get("done").is_some() {
                                stream.write_all(&frame(DELIVERED, r#"{"ok":true}"#)).await.unwrap();
                            } else {
                                stream.write_all(&frame(GRANTED, "{}")).await.unwrap();
                            }
                        }
                        INPUT => input.extend_from_slice(&data),
                        _ => {}
                    }
                }
            }
            input
        });
        let result = type_into_session(&socket, "hello", || true).await.unwrap();
        assert_eq!(result, TypeResult::Typed);
        let typed = String::from_utf8(host.await.unwrap()).unwrap();
        assert_eq!(typed, "\x1b[200~hello\x1b[201~\r");
    }

    /// A protocol 1.1 host: hello -> control(versions [1,1]) -> take -> control(you)
    /// -> input -> release, with no `deliver`/`granted`/`delivered` frames.
    #[tokio::test]
    async fn protocol_11_takes_control_types_and_releases() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let host = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut decoder = WireDecoder::default();
            let mut saw_take = false;
            let mut saw_release = false;
            let mut input = Vec::new();
            loop {
                let mut buffer = [0u8; 2048];
                let n = stream.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                for Frame { kind, data, .. } in decoder.push(&buffer[..n]).unwrap() {
                    match kind {
                        HELLO => {
                            stream.write_all(&frame(CONTROL, r#"{"versions":[1,1]}"#)).await.unwrap()
                        }
                        TAKE => {
                            saw_take = true;
                            stream.write_all(&frame(CONTROL, r#"{"you":true}"#)).await.unwrap();
                        }
                        INPUT => input.extend_from_slice(&data),
                        RELEASE => {
                            saw_release = true;
                            stream.write_all(&frame(CONTROL, r#"{"you":false}"#)).await.unwrap();
                        }
                        _ => {}
                    }
                }
            }
            (saw_take, saw_release, input)
        });
        let result = type_into_session(&socket, "hello", || true).await.unwrap();
        assert_eq!(result, TypeResult::Typed);
        let (saw_take, saw_release, typed) = host.await.unwrap();
        assert!(saw_take, "a 1.1 host expects take before input");
        assert!(saw_release, "a 1.1 host expects release after input");
        assert_eq!(String::from_utf8(typed).unwrap(), "\x1b[200~hello\x1b[201~\r");
    }
}
