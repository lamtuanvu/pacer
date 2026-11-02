//! Public plugin handlers use Core's single process owner over generation-private IPC.
//! No public request can choose a target, token, process, path or arbitrary method.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use crate::serve::core_child::CoreChild;
use axum::{body::Body, http::Request};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, NativeOp, OpFuture},
};
use pacer_plugin_ops::public::{Entry, PublicOperations, Runtime};
use serde_json::{Value, json};
use std::time::Duration;

fn requires_owner(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "plugin process owner is unavailable",
        ))
    })
}
pub(super) fn operations() -> Vec<NativeOp> {
    pacer_plugin_ops::public::OPERATIONS
        .iter()
        .map(|name| NativeOp {
            name,
            call: requires_owner,
        })
        .collect()
}
#[derive(Default)]
pub struct Service {}
impl Service {
    pub async fn call(
        &self,
        ctx: &Ctx,
        core: &CoreChild,
        op: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        let target = core
            .target()
            .await
            .ok_or_else(|| CoreError::new(Code::Unavailable, "pacer core is restarting"))?;
        let mut runtime = Owner {
            target: target.clone(),
            entries: vec![],
        };
        let params = runtime
            .request(json!({"kind":"prepare", "op":op, "params":params}))
            .await?;
        PublicOperations::default()
            .call(ctx, &mut runtime, op, params)
            .await
    }
}
struct Owner {
    target: (u16, String),
    entries: Vec<Value>,
}
impl Owner {
    async fn request(&mut self, body: Value) -> Result<Value, CoreError> {
        let prepare = body["kind"] == "prepare";
        let work = async {
            let client: Client<HttpConnector, Body> =
                Client::builder(TokioExecutor::new()).build_http();
            let req = Request::builder()
                .method("POST")
                .uri(format!(
                    "http://127.0.0.1:{}/_internal/plugins",
                    self.target.0
                ))
                .header("authorization", format!("Bearer {}", self.target.1))
                .header("content-type", "application/json")
                .body(Body::from(pacer_plugin_ops::settings::ipc_json(&body)))
                .map_err(internal)?;
            let response = client.request(req).await.map_err(|_| {
                CoreError::new(Code::Unavailable, "plugin process owner is unavailable")
            })?;
            if !response.status().is_success() {
                return Err(CoreError::new(
                    Code::Unavailable,
                    "plugin process owner refused private request",
                ));
            }
            let bytes = axum::body::to_bytes(Body::new(response.into_body()), 8 * 1024 * 1024)
                .await
                .map_err(|error| {
                    if prepare {
                        // No plugin RPC has run: use the ordinary TS read when
                        // aggregate manifests exceed the native snapshot budget.
                        CoreError::new(Code::Unavailable, pacer_plugin_ops::json::NESTING_FALLBACK)
                    } else {
                        internal(error)
                    }
                })?;
            let value: Value = pacer_plugin_ops::json::parse(&bytes).map_err(|error| {
                if prepare && error == pacer_plugin_ops::json::NESTING_FALLBACK {
                    CoreError::new(Code::Unavailable, error)
                } else {
                    internal(error)
                }
            })?;
            self.entries = value["entries"]
                .as_array()
                .cloned()
                .ok_or_else(|| internal("invalid plugin owner snapshot"))?;
            if let Some(error) = value.get("error") {
                return Err(decode_error(error));
            }
            Ok(value["value"].clone())
        };
        tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| CoreError::new(Code::PluginTimeout, "plugin process owner timed out"))?
    }
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
impl Runtime for Owner {
    fn refresh(&mut self, _: &Ctx) -> Result<Vec<Entry>, CoreError> {
        self.entries
            .iter()
            .cloned()
            .map(|v| serde_json::from_value(v).map_err(internal))
            .collect()
    }
    fn call<'a>(
        &'a mut self,
        _: &'a Ctx,
        id: &'a str,
        method: &'a str,
        params: Value,
    ) -> OpFuture<'a> {
        Box::pin(async move {
            self.request(json!({"kind":"call", "id":id, "method":method, "params":params}))
                .await
        })
    }
}
