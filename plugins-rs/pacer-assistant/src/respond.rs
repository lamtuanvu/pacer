//! The `assistant.respond` transport and handler. Port of
//! `plugins/assistant/index.ts:43-62` (`respond`) plus the handler wiring from
//! `index.ts:64-66`.
//!
//! The transport abstraction lets tests inject a fake; the shipped
//! `ReqwestTransport` performs a real HTTPS call (reqwest, rustls). The key is
//! resolved through `capability.secrets.resolve` and sent as a Bearer header
//! only when non-empty, exactly as the TypeScript reference does. Error
//! mapping is fixed:
//!
//! * transport `Timeout` → `plugin_timeout` "The model did not answer in time."
//! * turn cancelled → `plugin_unavailable` "The turn was cancelled."
//! * other unreachability → `plugin_unavailable` "The model endpoint could not be reached."
//! * non-2xx status → `plugin_unavailable` "The model endpoint answered HTTP <status>."
//!   (the body is never read — it can echo the key).

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use pacer_plugin::{CancellationToken, Ctx, HandlerResult, Plugin, PluginError, TS_SDK_FEATURES};
use serde_json::{Value, json};

use crate::chat::{chat_request, chat_result};

/// A transport that posts a chat request and yields (status, raw bytes) or a
/// transport error.
pub trait ChatTransport: Send + Sync {
    /// The interface is prescribed verbatim by the M3 C4 brief; the return
    /// type is naturally complex.
    #[allow(clippy::type_complexity)]
    fn post(
        &self,
        url: String,
        bearer: Option<String>,
        body: String,
        deadline: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), TransportError>> + Send>>;
}

/// A transport failure other than a rejected HTTP status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    /// The deadline elapsed before an answer arrived.
    Timeout,
    /// The endpoint could not be reached at all.
    Unreachable,
}

/// The shipped transport: a `reqwest` client with the default redirect
/// follow policy (the fetch default is "follow").
pub struct ReqwestTransport;

impl ChatTransport for ReqwestTransport {
    fn post(
        &self,
        url: String,
        bearer: Option<String>,
        body: String,
        deadline: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), TransportError>> + Send>> {
        Box::pin(async move {
            let client = reqwest::Client::new();
            let mut builder = client
                .post(&url)
                .header("content-type", "application/json")
                .body(body);
            if let Some(key) = bearer {
                builder = builder.bearer_auth(key);
            }
            let result = tokio::time::timeout(deadline, async {
                let response = builder
                    .send()
                    .await
                    .map_err(|_| TransportError::Unreachable)?;
                let status = response.status().as_u16();
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|_| TransportError::Unreachable)?
                    .to_vec();
                Ok::<_, TransportError>((status, bytes))
            })
            .await;
            match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(TransportError::Unreachable)) => Err(TransportError::Unreachable),
                Ok(Err(TransportError::Timeout)) => Err(TransportError::Timeout),
                Err(_) => Err(TransportError::Timeout),
            }
        })
    }
}

fn resolve_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!("{trimmed}/chat/completions")
}

/// Run one turn: resolve the key, build the request, post it, and map the
/// reply. Mirrors `respond` in the TypeScript reference. `key` is
/// `None` when the secret is null (no Bearer header is then sent).
pub async fn respond(
    p: &Value,
    key: Option<String>,
    cancel: &CancellationToken,
    transport: &dyn ChatTransport,
) -> Result<Value, PluginError> {
    let base_url = p
        .get("context")
        .and_then(|c| c.get("backend"))
        .and_then(|b| b.get("baseUrl"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let url = resolve_url(base_url);
    let deadline_ms = p
        .get("limits")
        .and_then(|l| l.get("deadlineMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let deadline = Duration::from_millis(deadline_ms);
    let body = serde_json::to_string(&chat_request(p)).unwrap_or_default();

    let transport_fut = transport.post(url, key, body, deadline);
    let (status, bytes) = tokio::select! {
        r = transport_fut => match r {
            Ok(value) => value,
            Err(TransportError::Timeout) => {
                return Err(PluginError::new(
                    "plugin_timeout",
                    "The model did not answer in time.",
                ))
            }
            Err(TransportError::Unreachable) => {
                return Err(PluginError::new(
                    "plugin_unavailable",
                    "The model endpoint could not be reached.",
                ))
            }
        },
        _ = cancel.cancelled() => {
            return Err(PluginError::new("plugin_unavailable", "The turn was cancelled."))
        }
    };
    if !(200..300).contains(&status) {
        // Status only: an error body can echo credentials.
        return Err(PluginError::new(
            "plugin_unavailable",
            format!("The model endpoint answered HTTP {status}."),
        ));
    }
    let parsed: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => return Err(PluginError::new("internal", error.to_string())),
    };
    chat_result(&parsed)
}

/// The handler entry: resolve the endpoint account's key through the host,
/// then run the turn with the given transport.
async fn respond_handler(
    params: &Value,
    ctx: &Ctx,
    transport: Arc<dyn ChatTransport>,
) -> HandlerResult {
    let account = params
        .get("context")
        .and_then(|c| c.get("backend"))
        .and_then(|b| b.get("account"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resolved = ctx
        .host
        .call(
            "capability.secrets.resolve",
            json!({ "ref": format!("endpoint/{account}") }),
        )
        .await?;
    let key = resolved
        .get("value")
        .and_then(Value::as_str)
        .map(str::to_owned);
    respond(params, key, &ctx.cancel, transport.as_ref()).await
}

/// The native bundled plugin with a caller-supplied transport (for tests).
pub fn plugin_with(transport: Arc<dyn ChatTransport>) -> Plugin {
    Plugin::new(crate::manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("assistant.respond", move |params, ctx| {
            let transport = transport.clone();
            async move { respond_handler(&params, &ctx, transport).await }
        })
}
