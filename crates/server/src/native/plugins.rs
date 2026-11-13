//! Public plugin handlers use Core's process snapshot over private IPC: the
//! generation-token HTTP channel on serve, the sync-keyed `_internal.plugins`
//! line on stdio ([`pacer_plugin_ops::ipc`]). No public request can choose a
//! target, token, process, path or arbitrary method.
//!
//! Both doors register the four reads, the X3 mutations and retired
//! `plugin.install` (refuse parity). Who runs plugin RPC is [`ProcessRpc`]:
//! Core's own registry when the native host is off (private `call`), a
//! [`SharedOwner`] in this process when it is on (serve, or a stdio connection
//! with no live serve owner, ADR 0027), or the live serve owner a stdio
//! connection attached to (private `relay`, plus `_host.plugin.stop`). With the
//! host on, Core keeps the bookkeeping kinds prepare/spawn_spec/call_authority/
//! ready/stop/changed/publish/log/crashed and never spawns a child itself. A
//! local owner starts a child no sooner than Core's sealed `nextStartAt` and
//! its own restart floor, and an in-flight call whose child died answers
//! `plugin_unavailable` naming the plugin once the crash is on record.
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
    ipc::{CoreIpc, Exchange, Failure},
    mutations::{MUTATION_OPERATIONS, MutationOperations, MutationRuntime},
    public::{Entry, PublicOperations, Runtime},
};
use pacer_plugin_runtime::{
    CallFailure, CrashReport, DoorRefusal, DoorRequest, OwnerKey, SharedOwner, StopOutcome,
    call_door, stop_on_owner,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

/// A failed sealed call as the error Core raises. A plugin's own JSON-RPC error reply keeps
/// its code only when that is one of pacer's reply codes, as TypeScript `pluginReplyError`
/// reads it; anything else is `plugin_unavailable`.
fn call_error(failure: CallFailure) -> CoreError {
    let code = match failure.code.as_str() {
        "unknown_op" => Code::UnknownOp,
        "unknown_task" => Code::UnknownTask,
        "invalid_input" => Code::InvalidInput,
        "unknown_executor" => Code::UnknownExecutor,
        "conflict" => Code::Conflict,
        "not_allowed" => Code::NotAllowed,
        "plugin_timeout" => Code::PluginTimeout,
        "plugin_refused" => Code::PluginRefused,
        "capability_denied" => Code::CapabilityDenied,
        "unknown_plugin" => Code::UnknownPlugin,
        "not_found" => Code::NotFound,
        "too_large" => Code::TooLarge,
        _ => Code::PluginUnavailable,
    };
    let error = CoreError::new(code, failure.message);
    match failure.hint {
        Some(hint) => error.hint(hint),
        None => error,
    }
}

fn requires_owner(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "plugin process owner is unavailable",
        ))
    })
}

/// Native plugin ops on both doors: four reads plus X3 mutations including retired install.
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

/// Who runs a plugin's process RPC for this door.
#[derive(Clone, Default)]
pub enum ProcessRpc {
    /// Native host off: Core's registry owns children (private `call`).
    #[default]
    Core,
    /// A ProcessOwner in this process: serve's, or a stdio connection's own.
    Local(SharedOwner),
    /// The live serve owner at this `host.sock`, reached by a stdio connection:
    /// Core relays calls through its `PACER_HOST_SOCKET` (private `relay`);
    /// the door only stops lanes there, proving the owner's credential.
    Attached(PathBuf, OwnerKey),
}

/// Ops and reads stay off the epoch lock so a long plugin RPC cannot stall
/// independent list/settings/action requests (parity with TS admission).
#[derive(Default)]
pub struct Service {
    ops: MutationOperations,
    reads: PublicOperations,
    epochs: tokio::sync::Mutex<Epochs>,
    actions: Arc<Mutex<HashSet<String>>>,
    rpc: ProcessRpc,
}

impl Service {
    pub fn with_native_owner(owner: SharedOwner) -> Self {
        Self::with_process_rpc(ProcessRpc::Local(owner))
    }

    pub fn with_process_rpc(rpc: ProcessRpc) -> Self {
        Self {
            rpc,
            ..Self::default()
        }
    }
}

/// Core's private plugin channel for one operation, and the Core generation
/// it reaches (a new generation resets epoch tracking).
pub(crate) type CoreLink = (Arc<dyn CoreIpc>, String);

/// The serve door's carrier: generation-token HTTP to `/_internal/plugins`.
struct HttpIpc {
    port: u16,
    token: String,
}

impl CoreIpc for HttpIpc {
    fn exchange(&self, body: String) -> Exchange<'_> {
        Box::pin(async move {
            let client: Client<HttpConnector, Body> =
                Client::builder(TokioExecutor::new()).build_http();
            let req = Request::builder()
                .method("POST")
                .uri(format!("http://127.0.0.1:{}/_internal/plugins", self.port))
                .header("authorization", format!("Bearer {}", self.token))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .map_err(|error| Failure::Body(error.to_string()))?;
            let response = client
                .request(req)
                .await
                .map_err(|_| Failure::Unavailable)?;
            if !response.status().is_success() {
                return Err(Failure::Refused);
            }
            axum::body::to_bytes(
                Body::new(response.into_body()),
                pacer_plugin_ops::ipc::MAX_REPLY_BYTES,
            )
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| Failure::Body(error.to_string()))
        })
    }
}

/// Deliver the owner's crash reports to the owning door's Core as the private
/// `crashed` kind, so Core records restarts, backoff and `failing` as the
/// TypeScript registry does. A report Core cannot take (restarting) is dropped.
pub(crate) async fn deliver_crashes<F, Fut>(
    mut reports: tokio::sync::mpsc::UnboundedReceiver<CrashReport>,
    link: F,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = Option<CoreLink>>,
{
    while let Some(report) = reports.recv().await {
        if let Some((ipc, _)) = link().await {
            let body = json!({"kind":"crashed", "id":report.id, "reason":report.reason});
            let _ = pacer_plugin_ops::ipc::request(&*ipc, &body, &mut Vec::new()).await;
        }
        let _ = report.done.send(());
    }
}

/// Answer the owner's private requests (observation events and reads, idle
/// `capability.log` lines) from the owning door's Core, each on its own task
/// so a slow read never holds up another lane's pump.
pub(crate) async fn deliver_door_requests<F, Fut>(
    mut requests: tokio::sync::mpsc::UnboundedReceiver<DoorRequest>,
    link: F,
) where
    F: Fn() -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Option<CoreLink>> + Send,
{
    while let Some(request) = requests.recv().await {
        let link = link.clone();
        tokio::spawn(async move {
            let reply = match link().await {
                Some((ipc, _)) => {
                    pacer_plugin_ops::ipc::request(&*ipc, &request.body, &mut Vec::new())
                        .await
                        .map_err(|error| DoorRefusal {
                            code: serde_json::to_value(error.code)
                                .ok()
                                .and_then(|code| code.as_str().map(str::to_owned))
                                .unwrap_or_else(|| "internal".into()),
                            message: error.message,
                        })
                }
                None => Err(DoorRefusal {
                    code: "unavailable".into(),
                    message: "plugin process owner is unavailable".into(),
                }),
            };
            let _ = request.reply.send(reply);
        });
    }
}

/// The serve door's link to its current Core child.
pub(crate) async fn http_link(core: &CoreChild) -> Option<CoreLink> {
    let (port, token) = core.target().await?;
    let ipc: Arc<dyn CoreIpc> = Arc::new(HttpIpc {
        port,
        token: token.clone(),
    });
    Some((ipc, token))
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
    /// `core` is awaited only when the operation needs Core.
    pub async fn call(
        &self,
        ctx: &Ctx,
        core: impl Future<Output = Option<CoreLink>>,
        op: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        // Retired Orca install: refuse without Core IPC (parity with TS handler).
        if op == "plugin.install" {
            struct Offline;
            impl CoreIpc for Offline {
                fn exchange(&self, _: String) -> Exchange<'_> {
                    Box::pin(async { Err(Failure::Unavailable) })
                }
            }
            return self
                .ops
                .call(
                    ctx,
                    &mut Owner {
                        ipc: Arc::new(Offline),
                        entries: vec![],
                        resets: HashSet::new(),
                        logs: vec![],
                        rpc: ProcessRpc::Core,
                    },
                    op,
                    params,
                )
                .await;
        }
        let (ipc, generation) = core
            .await
            .ok_or_else(|| CoreError::new(Code::Unavailable, "pacer core is restarting"))?;
        let mut runtime = Owner {
            ipc,
            entries: vec![],
            resets: HashSet::new(),
            logs: vec![],
            rpc: self.rpc.clone(),
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
            if state.generation != generation {
                *state = Epochs {
                    generation: generation.clone(),
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
    ipc: Arc<dyn CoreIpc>,
    entries: Vec<Value>,
    resets: HashSet<String>,
    logs: Vec<(String, String)>,
    rpc: ProcessRpc,
}

impl Owner {
    async fn request(&mut self, body: Value) -> Result<Value, CoreError> {
        pacer_plugin_ops::ipc::request(&*self.ipc, &body, &mut self.entries).await
    }
}

fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, e.to_string())
}

/// A plugin call's absolute deadline on a local owner: any restart wait, the
/// hello and the method.
const CALL_DEADLINE: Duration = Duration::from_secs(30);

impl Owner {
    async fn call_native(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        let owner = match &self.rpc {
            // Private `call` is retired once a ProcessOwner owns RPC.
            ProcessRpc::Core => {
                return self
                    .request(json!({"kind":"call", "id":id, "method":method, "params":params}))
                    .await;
            }
            // Core's registry seals the call to the serve owner and answers the
            // plugin's capability requests over its own socket connection.
            ProcessRpc::Attached(..) => {
                return self
                    .request(json!({"kind":"relay", "id":id, "method":method, "params":params}))
                    .await;
            }
            ProcessRpc::Local(owner) => owner.clone(),
        };
        let spawn = self.request(json!({"kind":"spawn_spec", "id":id})).await?;
        // P4d-7: Core seals call-scoped CallResources before the plugin method.
        let authority = self
            .request(json!({"kind":"call_authority", "id":id, "method":method}))
            .await?;
        let call = call_door(
            &owner,
            id,
            method,
            params,
            &spawn,
            authority,
            std::time::Instant::now() + CALL_DEADLINE,
            spawn["state"] == "ready",
        )
        .await
        .map_err(internal)?;
        for (level, message) in call.logs {
            // Logging must not replace the call's own result.
            let _ = self
                .request(json!({"kind":"log", "id":id, "level":level, "message":message}))
                .await;
        }
        if let Some(ready) = call.ready {
            let hello = &ready.hello;
            let contributes = &spawn["hello"]["manifest"]["contributes"];
            let served = hello["served"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|name| {
                    *name == "diagnostic"
                        || name
                            .as_str()
                            .is_some_and(|name| contributes.get(name).is_some())
                })
                .cloned()
                .collect::<Vec<_>>();
            let reported = self
                .request(json!({
                    "kind":"ready",
                    "id":id,
                    "protocol":hello["protocol"],
                    "served":served,
                }))
                .await;
            if reported.is_err() {
                ready.unreported();
            }
            reported?;
        }
        call.value.map_err(call_error)
    }

    async fn stop_native(&mut self, id: &str) -> Result<Value, CoreError> {
        match &self.rpc {
            ProcessRpc::Core => {}
            ProcessRpc::Local(owner) => {
                let mut guard = owner.lock().await;
                if guard.find_plugin(id).is_some() {
                    guard.terminate(id).await.map_err(|error| {
                        CoreError::new(Code::PluginUnavailable, error.to_string())
                    })?;
                }
            }
            ProcessRpc::Attached(socket, key) => match stop_on_owner(socket, key, id).await {
                Ok(StopOutcome::Stopped | StopOutcome::NotRunning | StopOutcome::OwnerGone) => {}
                Err(error) => {
                    return Err(CoreError::new(Code::PluginUnavailable, error.to_string())
                        .hint(error.hint()));
                }
            },
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
            // Enabling clears this door's restart floor with Core's backoff;
            // an attached door cannot clear the serve owner's floor.
            if reset && let ProcessRpc::Local(owner) = &self.rpc {
                owner.lock().await.clear_restart_floor(id);
            }
            self.request(json!({"kind":"changed", "id":id, "reset":reset, "invalidate":invalidate}))
                .await
        })
    }
    fn log(&mut self, _: &Ctx, id: &str, message: &str) {
        self.logs.push((id.into(), message.into()));
    }
}

#[cfg(test)]
mod tests;
