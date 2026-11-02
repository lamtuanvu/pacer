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
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

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
        .filter(|n| **n != "plugin.install")
        .map(|name| NativeOp {
            name,
            call: requires_owner,
        })
        .collect()
}
#[derive(Default)]
struct State {
    ops: Arc<PublicOperations>,
    epochs: HashMap<String, String>,
    surface_epochs: HashMap<String, Value>,
    generation: String,
}
#[derive(Default)]
pub struct Service {
    state: tokio::sync::Mutex<State>,
    actions: Arc<Mutex<HashSet<String>>>,
}
struct ActionGuard {
    set: Arc<Mutex<HashSet<String>>>,
    key: String,
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.key);
        }
    }
}
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
            resets: HashSet::new(),
            logs: vec![],
        };
        // Parameter and manifest-surface checks precede action admission, including
        // a concurrent request which will be refused before waiting on UI state.
        let mut params = params;
        if op == "plugin.ui.action" {
            params = runtime
                .request(json!({"kind":"prepare", "op":op, "params":params}))
                .await?;
            let id = params["plugin"].as_str().unwrap_or("");
            let entry = runtime
                .refresh(ctx)?
                .into_iter()
                .find(|e| e.id == id)
                .ok_or_else(|| {
                    CoreError::new(Code::UnknownPlugin, format!("unknown plugin {id}"))
                })?;
            entry.check_surface(
                params["surface"].as_str().unwrap_or(""),
                params["id"].as_str().unwrap_or(""),
            )?;
        }
        let _action = if op == "plugin.ui.action" {
            let key = format!("{}\0{}", params["plugin"], params["id"]);
            let mut set = self
                .actions
                .lock()
                .map_err(|_| CoreError::new(Code::Internal, "plugin action state unavailable"))?;
            if !set.insert(key.clone()) {
                return Err(CoreError::new(
                    Code::Conflict,
                    format!(
                        "surface {} already has an action in flight",
                        params["id"].as_str().unwrap_or("")
                    ),
                )
                .hint("Retry shortly."));
            }
            Some(ActionGuard {
                set: self.actions.clone(),
                key,
            })
        } else {
            None
        };
        let params = runtime
            .request(json!({"kind":"prepare", "op":op, "params":params}))
            .await?;
        let ops = {
            let mut state = self.state.lock().await;
            if state.generation != target.1 {
                *state = State {
                    generation: target.1.clone(),
                    ..State::default()
                };
            }
            let epochs = runtime
                .entries
                .iter()
                .map(|e| {
                    (
                        e["id"].as_str().unwrap_or("").to_owned(),
                        e["epoch"].as_str().unwrap_or("").to_owned(),
                    )
                })
                .collect::<HashMap<_, _>>();
            let changed = state
                .epochs
                .keys()
                .chain(epochs.keys())
                .filter(|id| state.epochs.get(*id) != epochs.get(*id))
                .cloned()
                .collect::<HashSet<_>>();
            for id in changed {
                state.ops.invalidate(&id, None);
            }
            state.epochs = epochs;
            for e in &runtime.entries {
                let id = e["id"].as_str().unwrap_or("");
                let previous = state
                    .surface_epochs
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if let Some(surfaces) = e["surfaceEpochs"].as_object() {
                    for (surface, revision) in surfaces {
                        if previous[surface] != *revision {
                            state.ops.invalidate(id, Some(surface));
                        }
                    }
                }
                state
                    .surface_epochs
                    .insert(id.into(), e["surfaceEpochs"].clone());
            }
            state
                .surface_epochs
                .retain(|id, _| runtime.entries.iter().any(|e| e["id"] == *id));
            Arc::clone(&state.ops)
        };
        let result = ops.call(ctx, &mut runtime, op, params).await;
        for (id, message) in std::mem::take(&mut runtime.logs) {
            // Logging must not replace the original operation error.
            let _ = runtime
                .request(json!({"kind":"log", "id":id, "message":message}))
                .await;
        }
        if result.is_ok() {
            runtime.request(json!({"kind":"publish", "op":op})).await?;
        }
        result
    }
}
struct Owner {
    target: (u16, String),
    entries: Vec<Value>,
    resets: HashSet<String>,
    logs: Vec<(String, String)>,
}
impl Owner {
    async fn request(&mut self, body: Value) -> Result<Value, CoreError> {
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
                .map_err(internal)?;
            let value: Value = pacer_plugin_ops::json::parse(&bytes).map_err(|e| {
                if e == "JSON nesting exceeds 512 levels" {
                    CoreError::new(Code::InvalidInput, "This plugin's view couldn't be shown")
                } else {
                    internal(e)
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
    fn stop<'a>(&'a mut self, _: &'a Ctx, id: &'a str) -> OpFuture<'a> {
        Box::pin(async move { self.request(json!({"kind":"stop", "id":id})).await })
    }
    fn reset(&mut self, id: &str) {
        self.resets.insert(id.into());
    }
    fn changed<'a>(&'a mut self, _: &'a Ctx, id: &'a str, invalidate: bool) -> OpFuture<'a> {
        let reset = self.resets.remove(id);
        Box::pin(async move {
            self.request(json!({"kind":"changed", "id":id, "reset":reset, "invalidate":invalidate}))
                .await
        })
    }
    fn log(&mut self, _: &Ctx, id: &str, message: &str) {
        self.logs.push((id.into(), message.into()));
    }
}
