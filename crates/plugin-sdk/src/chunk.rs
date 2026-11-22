//! Protocol-gated result chunking for `usage.read` and planner transactions,
//! mirroring `packages/plugin-sdk/src/index.ts:128-…`.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{Host, wire};

/// The byte threshold above which a chunkable result is split into base64
/// `$/resultChunk` calls (TS: `bytes.length > 768 * 1024`).
const CHUNK_THRESHOLD: usize = 768 * 1024;
/// Per-chunk payload size in bytes (TS: `chunkSize = 256 * 1024`).
const CHUNK_SIZE: usize = 256 * 1024;

/// Protocol feature flags, read from the hello state, that gate chunking.
#[derive(Clone, Copy, Default)]
pub struct ChunkPolicy {
    pub major: i64,
    pub minor: i64,
    pub chunk_offered: bool,
    pub planner_transactions: bool,
}

impl From<(i64, i64, bool, bool)> for ChunkPolicy {
    fn from((major, minor, chunk_offered, planner_transactions): (i64, i64, bool, bool)) -> Self {
        Self {
            major,
            minor,
            chunk_offered,
            planner_transactions,
        }
    }
}

/// Build the wire response for a successful handler result, applying
/// protocol-gated result chunking for `usage.read` and planner transactions.
///
/// Mirrors the TypeScript server: when the result is scoped to an owning
/// plugin call that has been cancelled the result is dropped with
/// `plugin_unavailable`; a large chunkable result is sent as `$/resultChunk`
/// calls and finished with a `_chunkedResult` envelope.
pub async fn finish(
    value: Value,
    id: &Value,
    method: &str,
    scoped: bool,
    policy: ChunkPolicy,
    host: &Host,
    cancel: &CancellationToken,
) -> String {
    if scoped && cancel.is_cancelled() {
        return wire::error(
            id,
            -32000,
            "owning plugin call ended",
            json!({"code": "plugin_unavailable"}),
        );
    }
    let chunked = (method == "usage.read"
        || ((method == "planner.install" || method == "planner.uninstall")
            && policy.planner_transactions))
        && id.is_number()
        && policy.major == 1
        && policy.minor >= 1
        && policy.chunk_offered;
    let bytes = if chunked {
        serde_json::to_vec(&value).unwrap_or_default()
    } else {
        Vec::new()
    };
    if !(chunked && bytes.len() > CHUNK_THRESHOLD) {
        return wire::result(id, value);
    }
    let mut offset = 0usize;
    let mut failure: Option<(String, String)> = None;
    while offset < bytes.len() {
        if cancel.is_cancelled() {
            failure = Some((
                "plugin_unavailable".into(),
                "owning plugin call ended".into(),
            ));
            break;
        }
        let end = (offset + CHUNK_SIZE).min(bytes.len());
        let ack = host
            .call(
                "$/resultChunk",
                json!({"request": id, "offset": offset,
                    "base64": crate::js::base64::encode(&bytes[offset..end])}),
            )
            .await;
        match ack {
            Ok(a)
                if a.get("bytes")
                    .and_then(Value::as_u64)
                    .is_some_and(|b| b as usize == offset + (end - offset)) =>
            {
                offset = end;
            }
            Ok(_) => {
                failure = Some((
                    "plugin_refused".into(),
                    "incomplete result chunk acknowledgement".into(),
                ));
                break;
            }
            Err(e) => {
                failure = Some((e.code.clone(), e.message.clone()));
                break;
            }
        }
    }
    match failure {
        Some((code, message)) => wire::error(id, -32000, &message, json!({"code": code})),
        None => {
            if cancel.is_cancelled() {
                wire::error(
                    id,
                    -32000,
                    "owning plugin call ended",
                    json!({"code": "plugin_unavailable"}),
                )
            } else {
                wire::result(id, json!({"_chunkedResult": {"bytes": bytes.len()}}))
            }
        }
    }
}
