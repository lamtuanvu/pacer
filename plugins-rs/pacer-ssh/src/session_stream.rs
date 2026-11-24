//! Remote full-session socket bridge (`session-stream.ts`), run by
//! `hostRunner.stream`. Uses the SDK-owned duplex stream to push output frames
//! and pull owned input frames, discarding login-shell chatter before the fixed
//! `__PACER_BEGIN__` payload marker.

use crate::argv::session_pipe_argv;
use crate::handlers::Session;
use pacer_plugin::{Ctx, PluginError, js};
use serde_json::{Value, json};

const MARKER: &str = "__PACER_BEGIN__\n";

/// Drop login-shell chatter and the fixed marker without retaining opaque
/// bytes (`session-stream.ts` `payload()`).
struct Payload {
    prefix: Vec<u8>,
    framed: bool,
    line_start: bool,
}

impl Payload {
    fn new() -> Self {
        Self {
            prefix: Vec::new(),
            framed: false,
            line_start: true,
        }
    }

    fn framed(&self) -> bool {
        self.framed
    }

    /// Take `chunk`, returning the framed payload bytes (empty until framed).
    fn take(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.framed {
            return chunk.to_vec();
        }
        let mut bytes = Vec::with_capacity(self.prefix.len() + chunk.len());
        bytes.extend_from_slice(&self.prefix);
        bytes.extend_from_slice(chunk);
        self.prefix.clear();
        let marker = MARKER.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if self.line_start && bytes[i] == marker[0] {
                let remaining = &bytes[i..];
                if remaining.len() < marker.len() && marker[..remaining.len()] == *remaining {
                    self.prefix = remaining.to_vec();
                    return Vec::new();
                }
                if remaining.starts_with(marker) {
                    self.framed = true;
                    return remaining[marker.len()..].to_vec();
                }
            }
            self.line_start = bytes[i] == b'\n';
            i += 1;
        }
        Vec::new()
    }
}

fn is_uuid4(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b[..8].iter().all(u8::is_ascii_hexdigit)
        && b[9..13].iter().all(u8::is_ascii_hexdigit)
        && b[14..18].iter().all(u8::is_ascii_hexdigit)
        && b[19..23].iter().all(u8::is_ascii_hexdigit)
        && b[24..].iter().all(u8::is_ascii_hexdigit)
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}

/// The public `hostRunner.stream` handler body: `session_stream.ts` `streamSession`.
pub async fn stream_session(
    input: &Value,
    ctx: &Ctx,
    session: &Session,
) -> Result<Value, PluginError> {
    let stream_id = input.get("streamId").and_then(Value::as_str).unwrap_or_default();
    let args = input.get("args").and_then(Value::as_array);
    let timeout_ms = input.get("timeoutMs").and_then(js::safe_integer);
    let max_bytes = input.get("maxBytes").and_then(js::safe_integer);
    let owned = ctx.owned_stream();
    if ctx.cancel.is_cancelled()
        || input.get("script").and_then(Value::as_str) != Some("SESSION_PIPE")
        || args.map(|a| a.len() != 1).unwrap_or(true)
        || !is_uuid4(stream_id)
        || timeout_ms.is_none()
        || timeout_ms.unwrap_or(0) < 2000
        || timeout_ms.unwrap_or(0) > 60_000
        || max_bytes.is_none()
        || max_bytes.unwrap_or(0) < 1
        || max_bytes.unwrap_or(0) > 65_536
        || input.get("stdin").is_some()
        || owned.is_none()
    {
        return Err(PluginError::new(
            "capability_denied",
            "remote session stream was not issued for this provider",
        ));
    }
    let owned = owned.expect("owned stream presence checked");
    let timeout_ms = timeout_ms.expect("timeout checked");
    let argv = (|| {
        let args = args.expect("args presence checked");
        session_pipe_argv(&session.ssh_target, &session.control_path, args).map_err(String::from)
    })()
    .map_err(|_| {
        PluginError::new(
            "capability_denied",
            "invalid host-issued session pipe tuple",
        )
    })?;
    let opened = ctx
        .host
        .call(
            "capability.process.duplex.open",
            json!({ "argv": argv, "timeoutMs": timeout_ms }),
        )
        .await?;
    let handle = opened
        .get("handle")
        .and_then(Value::as_str)
        .filter(|h| is_uuid4(h))
        .ok_or_else(|| {
            PluginError::new("plugin_refused", "SSH session broker returned an invalid handle")
        })?
        .to_owned();
    // Incoming: pull owned input frames and write them back to the remote.
    let incoming = {
        let ctx = ctx.clone();
        let owned = owned.clone();
        let handle = handle.clone();
        let timeout_ms = timeout_ms;
        async move {
            while !ctx.cancel.is_cancelled() {
                let frame = owned.next_input().await?;
                let bytes = frame.bytes().to_vec();
                if bytes.is_empty() || bytes.len() > 65_536 {
                    return Err(PluginError::new(
                        "plugin_refused",
                        "session input frame exceeds the bound",
                    ));
                }
                let receipt = ctx
                    .host
                    .call(
                        "capability.process.duplex.write",
                        json!({
                            "handle": handle,
                            "base64": js::base64::encode(&bytes),
                            "timeoutMs": timeout_ms,
                        }),
                    )
                    .await?;
                if receipt.get("bytes").and_then(Value::as_i64) != Some(bytes.len() as i64) {
                    return Err(PluginError::new(
                        "plugin_refused",
                        "SSH session input receipt is incomplete",
                    ));
                }
                frame.ack().await?;
            }
            Ok(())
        }
    };
    let incoming_handle = tokio::spawn(incoming);
    let outgoing = async {
        let mut decoded = Payload::new();
        let mut sequence: u64 = 0;
        let mut total: u64 = 0;
        while !ctx.cancel.is_cancelled() {
            let frame = ctx
                .host
                .call(
                    "capability.process.duplex.read",
                    json!({
                        "handle": handle,
                        "length": 65_536,
                        "timeoutMs": timeout_ms,
                        "pollMs": 1000,
                    }),
                )
                .await?;
            let base64 = frame.get("base64").and_then(Value::as_str).unwrap_or_default();
            let eof = frame.get("eof").and_then(Value::as_bool).unwrap_or(false);
            if base64.len() > 87_384 {
                return Err(PluginError::new(
                    "plugin_refused",
                    "SSH session output frame is invalid",
                ));
            }
            let bytes = match js::base64::decode(base64) {
                Some(b) if !b.is_empty() && b.len() <= 65_536 && js::base64::encode(&b) == base64 => b,
                _ => {
                    return Err(PluginError::new(
                        "plugin_refused",
                        "SSH session output frame is invalid",
                    ))
                }
            };
            let next = decoded.take(&bytes);
            if !next.is_empty() {
                total = total
                    .checked_add(next.len() as u64)
                    .ok_or_else(|| {
                        PluginError::new("too_large", "SSH session byte count overflow")
                    })?;
                owned.progress(stream_id, sequence, &next).await?;
                sequence += 1;
            }
            if eof {
                break;
            }
        }
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "SSH session owner ended",
            ));
        }
        if !decoded.framed() {
            return Err(PluginError::new(
                "plugin_refused",
                "SSH session payload marker missing",
            ));
        }
        Ok((sequence, total))
    };
    // `outgoing` racing `incoming`: an incoming that finishes before cancel
    // means the owned input ended early.
    let result = tokio::select! {
        out = outgoing => match out {
            Ok((_, total)) => Ok(total),
            Err(e) => Err(e),
        },
        inc = incoming_handle => match inc {
            Err(_) => Err(PluginError::new("plugin_unavailable", "SSH session input ended early")),
            Ok(Ok(())) if ctx.cancel.is_cancelled() => {
                Err(PluginError::new("plugin_unavailable", "SSH session owner ended"))
            }
            Ok(Ok(())) => {
                Err(PluginError::new("plugin_unavailable", "SSH session input ended early"))
            }
            Ok(Err(e)) => Err(e),
        },
    };
    let total = result?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new("plugin_unavailable", "SSH session owner ended"));
    }
    let receipt = ctx
        .host
        .call(
            "capability.process.duplex.close",
            json!({ "handle": handle, "graceful": true }),
        )
        .await?;
    if receipt.get("ok").and_then(Value::as_bool) != Some(true)
        || receipt.get("code").and_then(Value::as_i64) != Some(0)
        || receipt.get("signal").is_some()
        || receipt.get("terminated").and_then(Value::as_bool).unwrap_or(true)
    {
        return Err(PluginError::new(
            "plugin_unavailable",
            "SSH session ended without a clean remote exit",
        ));
    }
    Ok(json!({ "code": 0, "bytes": total }))
}