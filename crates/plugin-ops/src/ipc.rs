//! Core's private plugin channel, shared by the HTTP and stdio front doors.
//!
//! Both doors send the same `ipc_json` body to Core's `pluginNativeRequest` and
//! read back the same `{value | error, entries}` envelope. Only the carrier
//! differs: generation-token HTTP (`/_internal/plugins`) on serve, the
//! sync-keyed `_internal.plugins` line on stdio. [`request`] owns the timeout,
//! the nesting fallbacks and the error mapping so the doors cannot drift.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;
use std::{future::Future, pin::Pin, time::Duration};

/// Envelope budget; a larger reply is an aggregate the native snapshot does not hold.
pub const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// One private exchange may wait on a plugin's own call deadline plus Core's work.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// Why an exchange produced no envelope.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// Core could not be reached.
    Unavailable,
    /// Core answered but refused the private request.
    Refused,
    /// The reply body could not be read whole (for example past [`MAX_REPLY_BYTES`]).
    Body(String),
}

pub type Exchange<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, Failure>> + Send + 'a>>;

/// A carrier for one private request body and its raw reply bytes.
pub trait CoreIpc: Send + Sync {
    fn exchange(&self, body: String) -> Exchange<'_>;
}

/// Send `body` and decode Core's envelope; `entries` takes the process snapshot
/// even when the envelope carries an error.
pub async fn request(
    ipc: &dyn CoreIpc,
    body: &Value,
    entries: &mut Vec<Value>,
) -> Result<Value, CoreError> {
    request_within(ipc, body, entries, TIMEOUT).await
}

async fn request_within(
    ipc: &dyn CoreIpc,
    body: &Value,
    entries: &mut Vec<Value>,
    timeout: Duration,
) -> Result<Value, CoreError> {
    let prepare = body["kind"] == "prepare";
    let render_call =
        matches!(body["kind"].as_str(), Some("call" | "relay")) && body["method"] == "ui.render";
    let work = async {
        let bytes = ipc
            .exchange(crate::settings::ipc_json(body))
            .await
            .map_err(|failure| match failure {
                Failure::Unavailable => {
                    CoreError::new(Code::Unavailable, "plugin process owner is unavailable")
                }
                Failure::Refused => CoreError::new(
                    Code::Unavailable,
                    "plugin process owner refused private request",
                ),
                // No plugin RPC has run: use the ordinary TS read when
                // aggregate manifests exceed the native snapshot budget.
                Failure::Body(_) if prepare => {
                    CoreError::new(Code::Unavailable, crate::json::NESTING_FALLBACK)
                }
                Failure::Body(message) => internal(message),
            })?;
        let value: Value = crate::json::parse(&bytes).map_err(|error| {
            if prepare && error == crate::json::NESTING_FALLBACK {
                CoreError::new(Code::Unavailable, error)
            } else if render_call && error == crate::json::NESTING_FALLBACK {
                // Deep ui.render documents must not fall back to stale cache.
                CoreError::new(Code::InvalidInput, "This plugin's view couldn't be shown")
            } else {
                internal(error)
            }
        })?;
        *entries = value["entries"]
            .as_array()
            .cloned()
            .ok_or_else(|| internal("invalid plugin owner snapshot"))?;
        if let Some(error) = value.get("error") {
            return Err(decode_error(error));
        }
        Ok(value["value"].clone())
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| CoreError::new(Code::PluginTimeout, "plugin process owner timed out"))?
}

fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, e.to_string())
}

fn decode_error(e: &Value) -> CoreError {
    let code = match e["code"].as_str().unwrap_or("internal") {
        "unknown_op" => Code::UnknownOp,
        "unknown_task" => Code::UnknownTask,
        "invalid_input" => Code::InvalidInput,
        "unknown_executor" => Code::UnknownExecutor,
        "conflict" => Code::Conflict,
        "not_allowed" => Code::NotAllowed,
        "not_found" => Code::NotFound,
        "too_large" => Code::TooLarge,
        "unavailable" => Code::Unavailable,
        "rate_limited" => Code::RateLimited,
        "plugin_timeout" => Code::PluginTimeout,
        "plugin_unavailable" => Code::PluginUnavailable,
        "plugin_refused" => Code::PluginRefused,
        "capability_denied" => Code::CapabilityDenied,
        "unknown_plugin" => Code::UnknownPlugin,
        _ => Code::Internal,
    };
    let mut error = CoreError::new(
        code,
        e["message"]
            .as_str()
            .unwrap_or("invalid plugin owner error"),
    );
    error.hint = e["hint"].as_str().map(str::to_owned);
    error.data = e["data"].as_object().cloned();
    error
}

#[cfg(test)]
#[path = "ipc/tests.rs"]
mod tests;
