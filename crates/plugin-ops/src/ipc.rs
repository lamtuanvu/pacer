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
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct Fake {
        reply: Mutex<Option<Result<Vec<u8>, Failure>>>,
        sent: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(reply: Result<&[u8], Failure>) -> Self {
            Self {
                reply: Mutex::new(Some(reply.map(<[u8]>::to_vec))),
                sent: Mutex::new(vec![]),
            }
        }
    }

    impl CoreIpc for Fake {
        fn exchange(&self, body: String) -> Exchange<'_> {
            self.sent.lock().unwrap().push(body);
            let reply = self.reply.lock().unwrap().take().unwrap();
            Box::pin(async move { reply })
        }
    }

    fn deep(levels: usize) -> Vec<u8> {
        let mut text = String::from("{\"value\":");
        text.push_str(&"[".repeat(levels));
        text.push_str(&"]".repeat(levels));
        text.push_str(",\"entries\":[]}");
        text.into_bytes()
    }

    #[tokio::test]
    async fn value_and_entries_round_trip_through_ipc_json() {
        let fake = Fake::new(Ok(br#"{"value":{"a":"\ud800"},"entries":[{"id":"fx"}]}"#));
        let mut entries = vec![];
        let body =
            json!({"kind":"prepare", "op":"plugin.list", "params":{"x":"\u{fdd0}+Infinity"}});
        let value = request(&fake, &body, &mut entries).await.unwrap();
        assert_eq!(entries, vec![json!({"id":"fx"})]);
        // The lone surrogate stays in the quoted form, not U+FFFD.
        assert_eq!(crate::json::stringify(&value), r#"{"a":"\ud800"}"#);
        // Private IPC keeps Infinity recoverable by JSON.parse.
        assert_eq!(
            fake.sent.lock().unwrap()[0],
            r#"{"kind":"prepare","op":"plugin.list","params":{"x":1e400}}"#
        );
    }

    #[tokio::test]
    async fn error_envelopes_keep_the_snapshot_and_decode_the_error() {
        let fake = Fake::new(Ok(
            br#"{"error":{"code":"conflict","message":"busy","hint":"Retry shortly."},"entries":[{"id":"fx"}]}"#,
        ));
        let mut entries = vec![];
        let error = request(&fake, &json!({"kind":"stop", "id":"fx"}), &mut entries)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::Conflict);
        assert_eq!(error.hint.as_deref(), Some("Retry shortly."));
        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn carrier_failures_map_like_the_http_door() {
        for (failure, kind, code, message) in [
            (
                Failure::Unavailable,
                "stop",
                Code::Unavailable,
                "plugin process owner is unavailable",
            ),
            (
                Failure::Refused,
                "stop",
                Code::Unavailable,
                "plugin process owner refused private request",
            ),
            (
                Failure::Body("length limit exceeded".into()),
                "prepare",
                Code::Unavailable,
                crate::json::NESTING_FALLBACK,
            ),
            (
                Failure::Body("length limit exceeded".into()),
                "stop",
                Code::Internal,
                "length limit exceeded",
            ),
        ] {
            let fake = Fake::new(Err(failure));
            let error = request(&fake, &json!({"kind":kind}), &mut vec![])
                .await
                .unwrap_err();
            assert_eq!((error.code, error.message.as_str()), (code, message));
        }
    }

    #[tokio::test]
    async fn nesting_selects_fallback_for_prepare_and_refuses_deep_renders() {
        let body = deep(600);
        let prepare = request(
            &Fake::new(Ok(&body)),
            &json!({"kind":"prepare"}),
            &mut vec![],
        )
        .await
        .unwrap_err();
        assert_eq!(prepare.message, crate::json::NESTING_FALLBACK);
        for kind in ["call", "relay"] {
            let render = request(
                &Fake::new(Ok(&body)),
                &json!({"kind":kind, "method":"ui.render"}),
                &mut vec![],
            )
            .await
            .unwrap_err();
            assert_eq!(render.code, Code::InvalidInput);
            assert_eq!(render.message, "This plugin's view couldn't be shown");
        }
        let shallow = request(
            &Fake::new(Ok(&deep(500))),
            &json!({"kind":"prepare"}),
            &mut vec![],
        )
        .await;
        assert!(shallow.is_ok());
    }

    #[tokio::test]
    async fn a_silent_carrier_times_out() {
        struct Silent;
        impl CoreIpc for Silent {
            fn exchange(&self, _: String) -> Exchange<'_> {
                Box::pin(std::future::pending())
            }
        }
        let error = request_within(
            &Silent,
            &json!({"kind":"stop"}),
            &mut vec![],
            Duration::from_millis(10),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, Code::PluginTimeout);
    }
}
