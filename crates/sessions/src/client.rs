//! A minimal viewer client that types into a live built-in session, ported from
//! `typeIntoSession` (`src/messaging/live.ts`). B2-8 needs it to answer a question
//! in a running PTY; the task-send slice reuses it. No operation is registered here.
#![allow(clippy::result_large_err)]
use crate::{
    framing::WireDecoder,
    version::{negotiate, parse_versions, SESSION_PROTOCOL},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::{Instant, timeout},
};

mod frame {
    pub const HELLO: u8 = 1;
    pub const CONTROL: u8 = 5;
    pub const TAKE: u8 = 8;
    pub const RELEASE: u8 = 9;
    pub const INPUT: u8 = 10;
    pub const DELIVER: u8 = 13;
    pub const GRANTED: u8 = 14;
    pub const DELIVERED: u8 = 15;
}

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const EXPIRED_UNUSED: &str = "expired-unused";
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(3000);
const SUBMIT_DELAY: Duration = Duration::from_millis(150);
const GRANT_WAIT: Duration = Duration::from_millis(10_000 + 3000);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeResult {
    Typed,
    Busy,
    Refused { controller: Option<String> },
    Pending { reason: String },
}

/// An input failure that records whether bytes may already have reached the PTY.
#[derive(Debug)]
pub struct SessionError {
    pub message: String,
    pub input_attempted: bool,
}

impl SessionError {
    fn new(message: impl Into<String>, input_attempted: bool) -> Self {
        Self {
            message: message.into(),
            input_attempted,
        }
    }
}

struct Reply {
    kind: u8,
    body: Value,
}

async fn send_frame(stream: &mut UnixStream, kind: u8, data: &[u8]) -> Result<(), String> {
    let frame = crate::framing::wire(kind, data).map_err(|e| format!("invalid frame: {e}"))?;
    stream
        .write_all(&frame)
        .await
        .map_err(|e| format!("the session closed the connection: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("the session closed the connection: {e}"))?;
    Ok(())
}

/// Read one control/granted/delivered reply, decoding frames as they arrive.
async fn next_reply(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    replies: &mut Vec<Reply>,
    buf: &mut [u8],
    wait: Duration,
) -> Result<Reply, String> {
    let deadline = Instant::now() + wait;
    loop {
        if !replies.is_empty() {
            return Ok(replies.remove(0));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("the session did not answer in time".into());
        }
        let read = timeout(remaining, stream.read(buf))
            .await
            .map_err(|_| "the session did not answer in time".to_owned())?
            .map_err(|e| format!("the session closed the connection: {e}"))?;
        if read == 0 {
            return Err("the session closed the connection".into());
        }
        for f in decoder
            .push(&buf[..read])
            .map_err(|e| format!("invalid frame: {e}"))?
        {
            if matches!(f.kind, frame::CONTROL | frame::GRANTED | frame::DELIVERED) {
                let body: Value =
                    serde_json::from_slice(&f.data).map_err(|e| format!("invalid reply: {e}"))?;
                replies.push(Reply {
                    kind: f.kind,
                    body,
                });
            }
        }
    }
}

/// Message content must never end bracketed paste mode: an ESC byte could close
/// the paste early and inject the bytes that follow as keystrokes into the PTY.
fn paste_body(body: &str) -> String {
    body.chars().filter(|c| *c != '\u{1b}').collect()
}

fn text(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn reason(body: &Value, fallback: &str) -> String {
    text(body, "reason").unwrap_or_else(|| fallback.to_owned())
}

/// Connect as viewer `pacer`, paste `body` and submit it while `still_idle` holds.
pub async fn type_into_session(
    socket_path: &Path,
    body: &str,
    still_idle: impl Fn() -> bool,
) -> Result<TypeResult, SessionError> {
    let mut attempted = false;
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| SessionError::new(e.to_string(), false))?;
    let mut decoder = WireDecoder::default();
    let mut replies: Vec<Reply> = Vec::new();
    let mut buf = [0u8; 8192];

    let run = async {
        send_frame(
            &mut stream,
            frame::HELLO,
            &serde_json::to_vec(&json!({
                "v": 1,
                "client": "cli",
                "label": "pacer",
                "versions": [SESSION_PROTOCOL[0], SESSION_PROTOCOL[1]],
                "pacer": env!("CARGO_PKG_VERSION"),
            }))
            .map_err(|e| e.to_string())?,
        )
        .await?;
        let hello = next_reply(&mut stream, &mut decoder, &mut replies, &mut buf, DEFAULT_TIMEOUT)
            .await?
            .body;
        let versions = hello.get("versions").and_then(parse_versions);
        let minor = negotiate(versions, SESSION_PROTOCOL).unwrap_or(1);
        if minor >= 2 {
            deliver(
                &mut stream,
                &mut decoder,
                &mut replies,
                &mut buf,
                body,
                &mut attempted,
                &still_idle,
            )
            .await
        } else {
            take_control(
                &mut stream,
                &mut decoder,
                &mut replies,
                &mut buf,
                body,
                &mut attempted,
                &still_idle,
            )
            .await
        }
    };
    let result = run.await.map_err(|message| SessionError::new(message, attempted));
    let _ = stream.shutdown().await;
    result
}

async fn send_input(
    stream: &mut UnixStream,
    body: &str,
    attempted: &mut bool,
) -> Result<(), String> {
    *attempted = true;
    send_frame(
        stream,
        frame::INPUT,
        format!("{PASTE_START}{}{PASTE_END}", paste_body(body)).as_bytes(),
    )
    .await?;
    tokio::time::sleep(SUBMIT_DELAY).await;
    send_frame(stream, frame::INPUT, b"\r").await
}

async fn deliver(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    replies: &mut Vec<Reply>,
    buf: &mut [u8],
    body: &str,
    attempted: &mut bool,
    still_idle: &impl Fn() -> bool,
) -> Result<TypeResult, String> {
    send_frame(stream, frame::DELIVER, b"{}").await?;
    let mut reply = next_reply(stream, decoder, replies, buf, GRANT_WAIT).await?;
    while reply.kind == frame::CONTROL
        || (reply.kind == frame::DELIVERED && reply.body.get("ok") == Some(&Value::Bool(true)))
    {
        reply = next_reply(stream, decoder, replies, buf, GRANT_WAIT).await?;
    }
    if reply.kind == frame::DELIVERED {
        return Ok(TypeResult::Pending {
            reason: reason(&reply.body, "the session refused the delivery"),
        });
    }
    if !still_idle() {
        send_frame(stream, frame::DELIVER, br#"{"cancel":true}"#).await?;
        return Ok(TypeResult::Busy);
    }
    if let Some(ended) = replies
        .iter()
        .find(|r| r.kind == frame::DELIVERED && r.body.get("ok") != Some(&Value::Bool(true)))
    {
        return Ok(TypeResult::Pending {
            reason: reason(&ended.body, "the delivery window ended"),
        });
    }
    send_input(stream, body, attempted).await?;
    send_frame(stream, frame::DELIVER, br#"{"done":true}"#).await?;
    loop {
        let done = next_reply(stream, decoder, replies, buf, DEFAULT_TIMEOUT).await?;
        if done.kind != frame::DELIVERED {
            continue;
        }
        if done.body.get("ok") == Some(&Value::Bool(true)) {
            return Ok(TypeResult::Typed);
        }
        if text(&done.body, "cause").as_deref() == Some(EXPIRED_UNUSED) {
            return Ok(TypeResult::Pending {
                reason: reason(&done.body, "the delivery window expired"),
            });
        }
        return Err(format!(
            "the delivery window ended before the input was submitted: {}",
            reason(&done.body, "")
        ));
    }
}

async fn take_control(
    stream: &mut UnixStream,
    decoder: &mut WireDecoder,
    replies: &mut Vec<Reply>,
    buf: &mut [u8],
    body: &str,
    attempted: &mut bool,
    still_idle: &impl Fn() -> bool,
) -> Result<TypeResult, String> {
    send_frame(stream, frame::TAKE, b"{}").await?;
    let mut control = next_reply(stream, decoder, replies, buf, DEFAULT_TIMEOUT).await?;
    while control.body.get("you") != Some(&Value::Bool(true))
        && text(&control.body, "reason").as_deref() != Some("refused")
        && control.body.get("controller").is_none()
    {
        control = next_reply(stream, decoder, replies, buf, DEFAULT_TIMEOUT).await?;
    }
    if control.body.get("you") != Some(&Value::Bool(true)) {
        return Ok(TypeResult::Refused {
            controller: text(&control.body, "controller"),
        });
    }
    if !still_idle() {
        send_frame(stream, frame::RELEASE, b"{}").await?;
        return Ok(TypeResult::Busy);
    }
    send_input(stream, body, attempted).await?;
    send_frame(stream, frame::RELEASE, b"{}").await?;
    while next_reply(stream, decoder, replies, buf, DEFAULT_TIMEOUT)
        .await?
        .body
        .get("you")
        == Some(&Value::Bool(true))
    {}
    Ok(TypeResult::Typed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_body_cannot_close_bracketed_paste() {
        assert_eq!(paste_body("plain answer"), "plain answer");
        assert_eq!(paste_body("a\x1b[201~\rmalicious"), "a[201~\rmalicious");
    }
}
