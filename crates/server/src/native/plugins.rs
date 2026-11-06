//! Public plugin handlers use Core's process snapshot over generation-private IPC.
//! No public request can choose a target, token, process, path or arbitrary method.
//!
//! P4d-3 registers X3 mutation ops on HTTP via the private channel as the four
//! reads. P4d-4 registers retired `plugin.install` (refuse parity) and, when
//! the native host is enabled, routes plugin RPC spawn/call/stop through the
//! serve [`SharedOwner`] so TypeScript does not also own those children.
//! Flag-on private IPC is prepare/spawn_spec/call_authority/ready/stop/changed/
//! publish/log — `call` stays flag-off only (P4d-5 shrink). Stdio keeps plugin
//! ops in TypeScript (no second process owner).
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
use pacer_plugin_ops::{
    mutations::{MUTATION_OPERATIONS, MutationOperations, MutationRuntime},
    public::{Entry, PublicOperations, Runtime},
};
use pacer_plugin_runtime::{
    SharedOwner, SpawnSpec, call_resources_from_value, host_snapshots_from_value,
    observation_bootstrap_from_value, orca_context_from_value, session_for_call,
    session_from_hello, worktree_context_from_value,
};
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

/// HTTP-native plugin ops: four reads plus X3 mutations including retired install.
pub(super) fn registered_names() -> impl Iterator<Item = &'static str> {
    pacer_plugin_ops::public::OPERATIONS
        .iter()
        .copied()
        .chain(MUTATION_OPERATIONS.iter().copied())
}

pub(super) fn operations() -> Vec<NativeOp> {
    registered_names()
        .map(|name| NativeOp {
            name,
            call: requires_owner,
        })
        .collect()
}

pub(crate) fn is_mutation(op: &str) -> bool {
    MUTATION_OPERATIONS.contains(&op)
}

pub(crate) fn is_read(op: &str) -> bool {
    pacer_plugin_ops::public::OPERATIONS.contains(&op)
}

#[derive(Default)]
struct Epochs {
    epochs: HashMap<String, String>,
    surface_epochs: HashMap<String, Value>,
    generation: String,
}

/// Ops and reads stay off the epoch lock so a long plugin RPC cannot stall
/// independent list/settings/action requests (parity with TS admission).
pub struct Service {
    ops: MutationOperations,
    reads: PublicOperations,
    epochs: tokio::sync::Mutex<Epochs>,
    actions: Arc<Mutex<HashSet<String>>>,
    /// Serve ProcessOwner when the native host is enabled. Absent under the
    /// default TypeScript ownership path (P4d-5 keeps that default).
    native_owner: Option<SharedOwner>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            ops: MutationOperations::default(),
            reads: PublicOperations::default(),
            epochs: tokio::sync::Mutex::new(Epochs::default()),
            actions: Arc::new(Mutex::new(HashSet::new())),
            native_owner: None,
        }
    }
}

impl Service {
    pub fn with_native_owner(owner: SharedOwner) -> Self {
        Self {
            native_owner: Some(owner),
            ..Self::default()
        }
    }
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
        // Retired Orca install: refuse without Core IPC (parity with TS handler).
        if op == "plugin.install" {
            return self
                .ops
                .call(
                    ctx,
                    &mut Owner {
                        target: (0, String::new()),
                        entries: vec![],
                        resets: HashSet::new(),
                        logs: vec![],
                        native_owner: None,
                    },
                    op,
                    params,
                )
                .await;
        }
        let target = core
            .target()
            .await
            .ok_or_else(|| CoreError::new(Code::Unavailable, "pacer core is restarting"))?;
        let mut runtime = Owner {
            target: target.clone(),
            entries: vec![],
            resets: HashSet::new(),
            logs: vec![],
            native_owner: self.native_owner.clone(),
        };
        // Parameter and manifest-surface checks precede action admission, including
        // a concurrent request which will be refused before waiting on UI state.
        let mut params = params;
        if op == "plugin.ui.action" {
            params = runtime
                .request(json!({"kind":"prepare", "op":op, "params":params}))
                .await?;
            let id = params["plugin"].as_str().unwrap_or("");
            let entry = Runtime::refresh(&mut runtime, ctx)?
                .into_iter()
                .find(|e| e.id == id)
                .ok_or_else(|| {
                    CoreError::new(Code::UnknownPlugin, format!("unknown plugin {id}"))
                })?;
            entry.surface(
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
        {
            let mut state = self.epochs.lock().await;
            if state.generation != target.1 {
                *state = Epochs {
                    generation: target.1.clone(),
                    ..Epochs::default()
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
                self.ops.invalidate(&id, None);
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
                            self.ops.invalidate(id, Some(surface));
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
        }
        let result = if is_mutation(op) {
            self.ops.call(ctx, &mut runtime, op, params).await
        } else {
            self.reads.call(ctx, &mut runtime, op, params).await
        };
        for (id, message) in std::mem::take(&mut runtime.logs) {
            // Logging must not replace the original operation error.
            let _ = runtime
                .request(json!({"kind":"log", "id":id, "message":message}))
                .await;
        }
        if result.is_ok() && is_mutation(op) && op != "plugin.install" {
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
    native_owner: Option<SharedOwner>,
}

impl Owner {
    async fn request(&mut self, body: Value) -> Result<Value, CoreError> {
        let prepare = body["kind"] == "prepare";
        let render_call = body["kind"] == "call" && body["method"] == "ui.render";
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
                } else if render_call && error == pacer_plugin_ops::json::NESTING_FALLBACK {
                    // Deep ui.render documents must not fall back to stale cache.
                    CoreError::new(Code::InvalidInput, "This plugin's view couldn't be shown")
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

impl Owner {
    async fn call_native(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        // Flag-off only: private `call` is retired once ProcessOwner owns RPC.
        let Some(owner) = self.native_owner.clone() else {
            return self
                .request(json!({"kind":"call", "id":id, "method":method, "params":params}))
                .await;
        };
        let spec_body = self.request(json!({"kind":"spawn_spec", "id":id})).await?;
        let argv = spec_body["argv"]
            .as_array()
            .ok_or_else(|| internal("spawn_spec missing argv"))?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if argv.is_empty() {
            return Err(internal("spawn_spec empty argv"));
        }
        let cwd = spec_body["cwd"]
            .as_str()
            .ok_or_else(|| internal("spawn_spec missing cwd"))?;
        let mut env = HashMap::new();
        if let Some(object) = spec_body["env"].as_object() {
            for (key, value) in object {
                if let Some(text) = value.as_str() {
                    env.insert(key.clone(), text.to_owned());
                }
            }
        }
        let hello = spec_body
            .get("hello")
            .cloned()
            .ok_or_else(|| internal("spawn_spec missing hello"))?;
        // P4d-7: Core seals call-scoped CallResources before the plugin method.
        let authority_body = self
            .request(json!({"kind":"call_authority", "id":id, "method":method}))
            .await?;
        let resources = call_resources_from_value(
            authority_body
                .get("resources")
                .unwrap_or(&Value::Object(Default::default())),
        )
        .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
        let grants = authority_body
            .get("grants")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });
        let ttl = authority_body
            .get("ttlMs")
            .and_then(Value::as_u64)
            .filter(|ms| *ms > 0)
            .unwrap_or(30_000);
        let call_lifetime = Duration::from_millis(ttl);
        let observation = observation_bootstrap_from_value(&authority_body)
            .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
        let host_attach = host_snapshots_from_value(&authority_body)
            .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
        let orca_context = orca_context_from_value(&authority_body)
            .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
        let worktree_context = worktree_context_from_value(&authority_body)
            .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
        let spec = SpawnSpec {
            argv,
            cwd: cwd.into(),
            env,
        };
        let result = {
            let mut guard = owner.lock().await;
            guard
                .ensure(id, &spec)
                .map_err(|error| CoreError::new(Code::PluginUnavailable, error.to_string()))?;
            let mut session = session_for_call(
                &hello,
                resources,
                grants,
                call_lifetime,
                observation,
                Some(&host_attach),
                orca_context,
                worktree_context,
            )
            .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
            session
                .bind_process_owner_hosts(owner.clone())
                .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
            session
                .bind_process_owner_orca(owner.clone())
                .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
            session
                .bind_process_owner_worktree()
                .await
                .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
            guard
                .install_capability_session(id, session)
                .map_err(|error| CoreError::new(Code::PluginUnavailable, error.to_string()))?;
            if !guard.is_ready(id) {
                let hello_result = guard
                    .call_plugin(id, "plugin.hello", hello.clone(), Duration::from_secs(5))
                    .await
                    .map_err(|error| CoreError::new(Code::PluginRefused, error.to_string()))?;
                guard.mark_ready(id);
                let protocol = hello_result["protocol"].as_str().unwrap_or("").to_owned();
                let mut served = vec!["diagnostic".to_owned()];
                if let Some(points) = hello_result["contributes"].as_array() {
                    for point in points {
                        if let Some(name) = point.as_str()
                            && name != "diagnostic"
                            && !served.iter().any(|s| s == name)
                        {
                            served.push(name.to_owned());
                        }
                    }
                }
                drop(guard);
                self.request(json!({
                    "kind":"ready",
                    "id":id,
                    "protocol":protocol,
                    "served":served,
                }))
                .await?;
                let mut guard = owner.lock().await;
                let value = guard
                    .call_plugin(id, method, params, Duration::from_secs(30))
                    .await
                    .map_err(|error| CoreError::new(Code::PluginUnavailable, error.to_string()));
                // Drop call-scoped natives; keep hello-only between calls.
                if let Ok(idle) = session_from_hello(&hello, Duration::from_secs(300)) {
                    let _ = guard.install_capability_session(id, idle);
                }
                value
            } else {
                let value = guard
                    .call_plugin(id, method, params, Duration::from_secs(30))
                    .await
                    .map_err(|error| CoreError::new(Code::PluginUnavailable, error.to_string()));
                if let Ok(idle) = session_from_hello(&hello, Duration::from_secs(300)) {
                    let _ = guard.install_capability_session(id, idle);
                }
                value
            }
        };
        self.flush_capability_logs(owner, id).await;
        result
    }

    async fn flush_capability_logs(&mut self, owner: SharedOwner, id: &str) {
        let logs = {
            let guard = owner.lock().await;
            let Some(session) = guard.capability_session(id) else {
                return;
            };
            drop(guard);
            let mut session = session.lock().await;
            session.take_logs()
        };
        for (level, message) in logs {
            let mut text = if level == "info" {
                message
            } else {
                format!("[{level}] {message}")
            };
            if text.len() > 1000 {
                text.truncate(1000);
            }
            let _ = self
                .request(json!({"kind":"log", "id":id, "message":text}))
                .await;
        }
    }

    async fn stop_native(&mut self, id: &str) -> Result<Value, CoreError> {
        if let Some(owner) = self.native_owner.clone() {
            let mut guard = owner.lock().await;
            if guard.find_plugin(id).is_some() {
                guard
                    .terminate(id)
                    .await
                    .map_err(|error| CoreError::new(Code::PluginUnavailable, error.to_string()))?;
            }
        }
        // Registry bookkeeping (state / backoff) stays on Core even when Rust owns the OS child.
        self.request(json!({"kind":"stop", "id":id})).await
    }
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
        Box::pin(async move { self.call_native(id, method, params).await })
    }
}

impl MutationRuntime for Owner {
    fn refresh(&mut self, ctx: &Ctx) -> Result<Vec<Entry>, CoreError> {
        Runtime::refresh(self, ctx)
    }
    fn call<'a>(
        &'a mut self,
        ctx: &'a Ctx,
        id: &'a str,
        method: &'a str,
        params: Value,
    ) -> OpFuture<'a> {
        Runtime::call(self, ctx, id, method, params)
    }
    fn stop<'a>(&'a mut self, _: &'a Ctx, id: &'a str) -> OpFuture<'a> {
        Box::pin(async move { self.stop_native(id).await })
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
