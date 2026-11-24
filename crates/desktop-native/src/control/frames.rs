//! Native control socket frame kinds and validation.
//!
//! The wire uses the same compact length-prefixed JSON framing as the update
//! adapter (`pacer_desktop_update::adapter::encode_frame` /
//! `FrameDecoder`). Frame validation reproduces the desktop's `requestSchema`
//! and `helloSchema` discriminations: a fixed `schema`, a session binding and
//! a positive, strictly incrementing sequence for every post-hello request.

use serde_json::Value;
use std::borrow::Cow;

/// A desktop frame kind. Unknown or helper-only kinds are preserved so the
/// dispatch loop can reject them before any authority effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Hello,
    Heartbeat,
    Op,
    Snapshot,
    SubscribeEvents,
    DesktopReady,
    QueryReadiness,
    ObserveLaunch,
    EffectAck,
    Adoption,
    Helper,
    Unknown,
}

impl FrameKind {
    pub fn parse(kind: &str) -> FrameKind {
        match kind {
            "hello" => FrameKind::Hello,
            "heartbeat" => FrameKind::Heartbeat,
            "op" => FrameKind::Op,
            "snapshot" => FrameKind::Snapshot,
            "subscribe-events" => FrameKind::SubscribeEvents,
            "desktop-ready" => FrameKind::DesktopReady,
            "query-readiness" => FrameKind::QueryReadiness,
            "observe-launch" => FrameKind::ObserveLaunch,
            "effect-ack" => FrameKind::EffectAck,
            "adoption-context"
            | "adoption-release"
            | "adoption-suppress"
            | "adoption-recovery-context"
            | "adoption-shutdown"
            | "adoption-reconnect"
            | "adoption-observe-launch"
            | "adoption-readiness" => FrameKind::Adoption,
            "helper-context"
            | "fixture-cleanup"
            | "suppress-lifecycle"
            | "shutdown-service"
            | "shutdown-desktop"
            | "release-reservation" => FrameKind::Helper,
            _ => FrameKind::Unknown,
        }
    }
}

/// Maximum number of frames a peer may have queued before it is closed.
pub const MAX_PENDING_FRAMES: usize = 8;

/// A validated post-hello request. Ownership of `value` lets the dispatch
/// loop forward the raw body when it needs it (e.g. synthesized op posts).
#[derive(Clone, Debug)]
pub struct Request {
    pub kind: FrameKind,
    pub session_id: String,
    pub sequence: u64,
    pub op: Option<String>,
    pub params: Option<Value>,
    pub value: Value,
}

/// Failure to decode a request frame.
#[derive(Debug)]
pub struct RequestError;

impl Request {
    /// Parse and validate a post-hello request against the desktop schema.
    ///
    /// Mirrors `requestSchema`: schema must be `1`, `sessionId` a bounded
    /// identifier, `sequence` a positive integer, and `kind` one of the
    /// known frame kinds. Unknown kinds still parse (the dispatch loop
    /// decides whether they are permitted) so malformed-but-identifiable
    /// frames are rejected during dispatch, as in the reference.
    pub fn parse(value: &Value) -> Result<Request, RequestError> {
        let object = value.as_object().ok_or(RequestError)?;
        if object.get("schema").and_then(Value::as_u64) != Some(1) {
            return Err(RequestError);
        }
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .map(FrameKind::parse)
            .ok_or(RequestError)?;
        let session_id = match object.get("sessionId").and_then(Value::as_str) {
            Some(id) if is_identifier(id) => id.to_owned(),
            _ => return Err(RequestError),
        };
        let sequence = object
            .get("sequence")
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .ok_or(RequestError)?;
        let op = object.get("op").and_then(Value::as_str).map(str::to_owned);
        let params = object.get("params").cloned();
        Ok(Request {
            kind,
            session_id,
            sequence,
            op,
            params,
            value: value.clone(),
        })
    }
}

/// A validated `hello` frame (`helloSchema`).
#[derive(Clone, Debug)]
pub struct Hello {
    pub role: String,
    pub version: String,
    pub nonce: String,
    pub challenge: String,
    pub client_id: String,
    pub value: Value,
}

/// Validate a hello frame against `helloSchema`.
pub fn parse_hello(value: &Value) -> Result<Hello, RequestError> {
    let object = value.as_object().ok_or(RequestError)?;
    if object.get("schema").and_then(Value::as_u64) != Some(1)
        || object.get("kind").and_then(Value::as_str) != Some("hello")
    {
        return Err(RequestError);
    }
    let role = match object.get("role").and_then(Value::as_str) {
        Some(role @ ("desktop" | "helper")) => role.to_owned(),
        _ => return Err(RequestError),
    };
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(RequestError)?
        .to_owned();
    let nonce = object
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|v| is_hex_64(v))
        .ok_or(RequestError)?
        .to_owned();
    let challenge = object
        .get("challenge")
        .and_then(Value::as_str)
        .filter(|v| is_hex_64(v))
        .ok_or(RequestError)?
        .to_owned();
    let client_id = object
        .get("clientId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_default();
    Ok(Hello {
        role,
        version,
        nonce,
        challenge,
        client_id,
        value: value.clone(),
    })
}

fn is_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut chars = value.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !(first.is_ascii_alphanumeric() || first == '_' || first == '-') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_hex_64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Extract the bounded identifier from `sessionId` for use as a client
/// instance token when the desktop forwards ops to the front door.
pub fn client_instance(session_id: &str) -> Cow<'_, str> {
    session_id.into()
}

#[cfg(test)]
#[path = "tests/frames.rs"]
mod tests;
