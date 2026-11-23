//! `capability.net.http` with `httpBodyChunks` staging/reading when the
//! request or response exceeds one frame. Port of `packages/plugin-sdk/src/http.ts`.
//!
//! Not feature-gated because it is core TypeScript SDK API.

use crate::{FEATURE_HTTP_BODY_CHUNKS, Host, PluginError, js, host};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::atomic::Ordering;

pub(crate) const BODY: usize = 4 * 1024 * 1024; // 4194304
pub(crate) const CHUNK: usize = 262_144;
pub(crate) const HTTP: &str = "capability.net.http";
/// `capability.net.http.body.` — prefix of the staged-body capability that the
/// host issues as handles; kept here for parity with the TypeScript SDK's
/// vocabulary even though this port only ever issues the concrete sub-methods.
#[allow(dead_code)]
pub(crate) const PREFIX: &str = "capability.net.http.body.";
pub(crate) const BEGIN: &str = "capability.net.http.body.begin";
pub(crate) const STAGE: &str = "capability.net.http.body.stageChunk";
pub(crate) const READ: &str = "capability.net.http.body.readChunk";
pub(crate) const RELEASE: &str = "capability.net.http.body.release";

fn internal(message: &str) -> PluginError {
    PluginError::new("internal", message)
}

fn oversized() -> PluginError {
    internal("HTTP oversized request requires httpBodyChunks")
}

fn frame_exceeded() -> PluginError {
    internal("HTTP complete frame exceeds limit")
}

/// The decoded result of one `capability.net.http` call.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Map<String, Value>,
    pub body: String,
}

impl Host {
    /// Whether a request with this method and params fits one 1 MiB frame,
    /// counting the next id and this call's _meta (index.ts:217).
    pub fn fits(&self, method: &str, params: &Value) -> bool {
        self.envelope(method, params).len() <= self.frame_limit()
    }

    fn check_fits(&self, method: &str, params: &Value) -> Result<(), PluginError> {
        if self.fits(method, params) {
            Ok(())
        } else {
            Err(frame_exceeded())
        }
    }

    fn envelope(&self, method: &str, params: &Value) -> Vec<u8> {
        let id = format!("p{}", self.next_id());
        let mut obj = Map::new();
        obj.insert("jsonrpc".into(), json!("2.0"));
        obj.insert("id".into(), json!(id));
        obj.insert("method".into(), json!(method));
        obj.insert("params".into(), params.clone());
        if let Some(token) = &self.capability_call {
            obj.insert("_meta".into(), json!({ "capabilityCall": token }));
        }
        let mut bytes = serde_json::to_vec(&Value::Object(obj)).unwrap_or_default();
        bytes.push(b'\n');
        bytes
    }

    fn frame_limit(&self) -> usize {
        self.frame_limit.load(Ordering::Relaxed)
    }

    #[cfg(feature = "testing")]
    /// Test-only override of the per-frame limit (matches the TS `fits` override).
    pub fn set_frame_limit_for_test(&self, limit: usize) {
        self.frame_limit.store(limit, Ordering::Relaxed);
    }

    fn negotiated(&self) -> bool {
        match self.state.read() {
            Ok(s) => s.negotiated.contains(FEATURE_HTTP_BODY_CHUNKS),
            Err(e) => e
                .into_inner()
                .negotiated
                .contains(FEATURE_HTTP_BODY_CHUNKS),
        }
    }

    fn ended(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }

    /// `capability.net.http` with `httpBodyChunks` staging/reading when the
    /// request or response exceeds one frame. `request` is passed through as
    /// JSON (url, method, headers?, body?, timeoutMs, authorization?) so
    /// numbers keep their JSON form. One transaction at a time per call.
    pub async fn http(&self, request: Value) -> Result<HttpResponse, PluginError> {
        if self.ended() {
            return Err(host::owning_ended());
        }
        let queue = self.queue.clone();
        let cancel = self.cancel.clone();
        let guard = match &cancel {
            Some(token) => {
                let lock = queue.lock();
                tokio::pin!(lock);
                tokio::select! {
                    g = &mut lock => g,
                    _ = token.cancelled() => return Err(host::owning_ended()),
                }
            }
            None => queue.lock().await,
        };
        let outcome = execute_once(self, request).await;
        drop(guard);
        outcome
    }
}

/// One complete `execute` transaction: optional upload, the HTTP call,
/// optional staged response read, then release of every handle.
async fn execute_once(host: &Host, request: Value) -> Result<HttpResponse, PluginError> {
    if host.ended() {
        return Err(host::owning_ended());
    }
    let bytes = request
        .get("body")
        .and_then(Value::as_str)
        .map(|s| s.as_bytes().to_vec());
    if let Some(b) = &bytes {
        if b.len() > BODY {
            return Err(internal("HTTP body exceeds 4MiB UTF8"));
        }
    }
    let mut upload: Option<String> = None;
    let mut download: Option<String> = None;
    // Run the request; on failure we still must release any staged handle.
    let result = send(host, request, bytes.as_ref(), &mut upload, &mut download).await;
    let mut failure: Option<PluginError> = result.as_ref().err().cloned();
    // Release every handle via call_cleanup, even after errors and even after
    // cancellation; a cleanup failure cannot become success.
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    if let Some(d) = &download {
        order.push(d.clone());
    }
    if let Some(u) = &upload {
        order.push(u.clone());
    }
    for handle in order {
        if !seen.insert(handle.clone()) {
            continue;
        }
        let params = Value::Object(Map::from_iter([("handle".into(), Value::String(handle))]));
        if !host.fits(RELEASE, &params) {
            failure = Some(frame_exceeded());
            continue;
        }
        if let Err(e) = host.call_cleanup(RELEASE, params).await {
            failure = Some(e);
        }
    }
    if let Some(e) = failure {
        return Err(e);
    }
    // A completed transaction is still rejected if the owner ended while we
    // were releasing (index.ts: active() after cleanup).
    if host.ended() {
        return Err(host::owning_ended());
    }
    result
}

async fn send(
    host: &Host,
    mut wire: Value,
    bytes: Option<&Vec<u8>>,
    upload: &mut Option<String>,
    download: &mut Option<String>,
) -> Result<HttpResponse, PluginError> {
    if !host.fits(HTTP, &wire) {
        let b = bytes.ok_or_else(oversized)?;
        if !host.negotiated() {
            return Err(oversized());
        }
        let mut reserved = wire.clone();
        if let Some(o) = reserved.as_object_mut() {
            o.insert("body".into(), json!({ "handle": "\0".repeat(256) }));
        }
        host.check_fits(HTTP, &reserved)?;
        host.check_fits(BEGIN, &json!({ "bytes": b.len() }))?;
        let opened = host.call(BEGIN, json!({ "bytes": b.len() })).await?;
        let handle = opened
            .get("handle")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty() && h.len() <= 256)
            .ok_or_else(|| internal("invalid HTTP upload handle"))?
            .to_owned();
        *upload = Some(handle.clone());
        if let Some(o) = wire.as_object_mut() {
            o.insert("body".into(), json!({ "handle": handle }));
        }
        host.check_fits(HTTP, &wire)?;
        let mut offset = 0usize;
        while offset < b.len() {
            let end = (offset + CHUNK).min(b.len());
            let part = &b[offset..end];
            let ack = host
                .call(
                    STAGE,
                    json!({
                        "handle": upload.as_deref().unwrap_or_default(),
                        "offset": offset,
                        "base64": js::base64::encode(part),
                    }),
                )
                .await?;
            let expected = offset + part.len();
            let got = ack
                .get("bytes")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            if got != Some(expected) {
                return Err(internal("invalid HTTP upload acknowledgement"));
            }
            offset += part.len();
        }
    }
    let reply = host.call(HTTP, wire).await?;
    let body = match reply.get("body").cloned() {
        Some(Value::String(s)) => s,
        Some(desc) => {
            if !host.negotiated() {
                return Err(internal("invalid HTTP response body descriptor"));
            }
            let obj = desc
                .as_object()
                .ok_or_else(|| internal("invalid HTTP response body descriptor"))?;
            let handle = obj
                .get("handle")
                .and_then(Value::as_str)
                .filter(|h| !h.is_empty() && h.len() <= 256)
                .ok_or_else(|| internal("invalid HTTP response body descriptor"))?;
            let len = obj
                .get("bytes")
                .and_then(js::safe_integer)
                .ok_or_else(|| internal("invalid HTTP response body descriptor"))?;
            if len < 0 || len as usize > BODY {
                return Err(internal("invalid HTTP response body descriptor"));
            }
            *download = Some(handle.to_owned());
            let len = len as usize;
            let mut decoded = Vec::new();
            let mut offset = 0usize;
            while offset < len {
                let length = (len - offset).min(CHUNK);
                let part = host
                    .call(
                        READ,
                        json!({
                            "handle": handle,
                            "offset": offset,
                            "length": length,
                        }),
                    )
                    .await?;
                let b64 = part
                    .get("base64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| internal("invalid HTTP body chunk"))?;
                let chunk = js::base64::decode_lenient(b64);
                if chunk.len() != length || js::base64::encode(&chunk) != b64 {
                    return Err(internal("invalid HTTP body chunk"));
                }
                decoded.extend_from_slice(&chunk);
                offset += chunk.len();
            }
            String::from_utf8_lossy(&decoded).into_owned()
        }
        None => return Err(internal("invalid HTTP response body descriptor")),
    };
    if body.as_bytes().len() > BODY {
        return Err(internal("decoded HTTP response exceeds 4MiB UTF8"));
    }
    Ok(HttpResponse {
        status: reply.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
        headers: reply
            .get("headers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        body,
    })
}