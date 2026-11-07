//! Process-owner gate and live child map.
//!
//! Production serve keeps [`Ownership::TypeScript`] unless the P4d-1 flag path
//! constructs [`ProcessOwner::native_for_serve`]. The native test token can hold
//! [`PluginProcess`] children in library form without claiming serve supervision
//! or setting `PACER_HOST_SOCKET`. Flag-on calls answer `capability.*` through an
//! installed [`crate::PluginCapabilitySession`] (P4d-6).

use crate::capability::PluginCapabilitySession;
use crate::orca_attach::SharedOrcaBridge;
use crate::process::PluginProcess;
use pacer_plugin_host::{PluginState, ProcessError, Registry, SpawnSpec};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use thiserror::Error;
use tokio::{
    sync::{Mutex, RwLock, watch},
    time::{Instant, timeout_at},
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OwnerError {
    #[error("TypeScript currently owns plugin processes")]
    TypeScriptOwnsHost,
    #[error("native process ownership is not activated in serve")]
    NativeNotActivated,
    #[error("plugin already tracked: {0}")]
    AlreadyTracked(String),
    #[error("unknown tracked plugin: {0}")]
    UnknownPlugin(String),
    #[error("plugin process unavailable: {0}")]
    Process(String),
}

impl From<ProcessError> for OwnerError {
    fn from(error: ProcessError) -> Self {
        Self::Process(error.to_string())
    }
}

/// Who supervises plugin child processes for a serve generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Production default: TypeScript registry via generation-private IPC.
    TypeScript,
    /// Native owner. `supervision` is true only on the flagged serve path.
    Native {
        /// Serve claimed supervision (`ProcessOwner::native_for_serve`).
        supervision: bool,
    },
}

impl Ownership {
    pub fn typescript() -> Self {
        Self::TypeScript
    }

    /// Test-only native token. Production serve must not call this.
    pub fn native_for_tests() -> Self {
        Self::Native { supervision: false }
    }

    /// Flag-on serve constructor: supervision may be claimed.
    pub fn native_for_serve() -> Self {
        Self::Native { supervision: true }
    }

    pub fn is_native(&self) -> bool {
        matches!(self, Self::Native { .. })
    }

    pub fn supervision_claimed(&self) -> bool {
        matches!(self, Self::Native { supervision: true })
    }
}

/// One tracked child. The owner lock covers lookup and replacement only; a call
/// holds the child's `gate`, so calls to different plugins run in parallel.
/// Exclusive turns keep one call at a time; a reentrant plugin's calls may share.
pub struct PluginLane {
    process: PluginProcess,
    gate: RwLock<()>,
    hello: Mutex<()>,
    /// `Some` once the child answered `plugin.hello`, with the summary when the
    /// caller recorded one.
    ready: std::sync::Mutex<Option<Option<Value>>>,
}

impl PluginLane {
    fn new(process: PluginProcess) -> Self {
        Self {
            process,
            gate: RwLock::new(()),
            hello: Mutex::new(()),
            ready: std::sync::Mutex::new(None),
        }
    }

    pub fn process(&self) -> &PluginProcess {
        &self.process
    }

    pub fn gate(&self) -> &RwLock<()> {
        &self.gate
    }

    /// Held while sending `plugin.hello`, so overlapping calls send it once.
    pub fn hello_turn(&self) -> &Mutex<()> {
        &self.hello
    }

    fn ready_slot(&self) -> std::sync::MutexGuard<'_, Option<Option<Value>>> {
        self.ready
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_ready(&self) -> bool {
        self.ready_slot().is_some()
    }

    pub fn ready_hello(&self) -> Option<Value> {
        self.ready_slot().clone().flatten()
    }

    pub fn mark_ready(&self, hello: Option<Value>) {
        *self.ready_slot() = Some(hello);
    }

    /// Wait for an exclusive turn until `expires`.
    async fn exclusive(
        &self,
        expires: Instant,
    ) -> Result<tokio::sync::RwLockWriteGuard<'_, ()>, OwnerError> {
        timeout_at(expires, self.gate.write())
            .await
            .map_err(|_| ProcessError::Timeout.into())
    }
}

/// Holds live plugin children. Default serve constructs
/// [`ProcessOwner::typescript`]; the P4d-1 flag path uses
/// [`ProcessOwner::native_for_serve`].
pub struct ProcessOwner {
    ownership: Ownership,
    orca_bridge: Option<SharedOrcaBridge>,
    children: HashMap<String, Arc<PluginLane>>,
    /// Optional mirror of [`Registry`] state ids without owning children.
    shadow: HashMap<String, PluginState>,
    /// Per-plugin capability broker sessions (P4d-6). Absent → deny caps.
    sessions: HashMap<String, Arc<Mutex<PluginCapabilitySession>>>,
}

impl ProcessOwner {
    /// Production serve constructor: TypeScript remains the process owner.
    pub fn typescript() -> Self {
        Self {
            ownership: Ownership::typescript(),
            orca_bridge: None,
            children: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
    }

    /// Test harness that pretends native ownership without activating serve.
    pub fn native_for_tests() -> Self {
        Self {
            ownership: Ownership::native_for_tests(),
            orca_bridge: None,
            children: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
    }

    /// Flag-on serve path: native ownership with supervision claimable.
    pub fn native_for_serve() -> Self {
        Self {
            ownership: Ownership::native_for_serve(),
            orca_bridge: None,
            children: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
    }

    pub fn set_orca_bridge(&mut self, bridge: SharedOrcaBridge) {
        self.orca_bridge = Some(bridge);
    }

    pub(crate) fn orca_bridge(&self) -> Option<&SharedOrcaBridge> {
        self.orca_bridge.as_ref()
    }

    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }

    /// Succeeds only for [`Self::native_for_serve`]. TypeScript and the library
    /// test token still refuse.
    pub fn claim_native_supervision(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { supervision: false } => Err(OwnerError::NativeNotActivated),
            Ownership::Native { supervision: true } => Ok(()),
        }
    }

    /// Copy registry plugin states into the shadow table. Never spawns children
    /// and never sets `PACER_HOST_SOCKET`. Safe under TypeScript ownership.
    pub fn sync_shadow_from(&mut self, registry: &Registry) {
        self.shadow.clear();
        for (id, state) in registry.plugin_states() {
            self.shadow.insert(id, state);
        }
    }

    pub fn shadow_state(&self, id: &str) -> Option<PluginState> {
        self.shadow.get(id).copied()
    }

    pub fn shadow_len(&self) -> usize {
        self.shadow.len()
    }

    pub fn tracked_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.children.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn len(&self) -> usize {
        self.children.len()
    }

    pub fn is_empty(&self) -> bool {
        self.children.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&PluginProcess> {
        self.children.get(id).map(|lane| lane.process())
    }

    /// The tracked child's lane, for calls that run without the owner lock.
    pub fn lane(&self, id: &str) -> Option<Arc<PluginLane>> {
        self.children.get(id).cloned()
    }

    /// Install or replace the capability broker session for a tracked plugin.
    pub fn install_capability_session(
        &mut self,
        id: impl Into<String>,
        session: PluginCapabilitySession,
    ) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        self.sessions.insert(id, Arc::new(Mutex::new(session)));
        Ok(())
    }

    /// Shared handle to a plugin's capability session, if installed.
    pub fn capability_session(&self, id: &str) -> Option<Arc<Mutex<PluginCapabilitySession>>> {
        self.sessions.get(id).cloned()
    }

    /// Spawn and track a child. Refused while TypeScript owns the host.
    pub fn spawn(&mut self, id: impl Into<String>, spec: &SpawnSpec) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        let child = PluginProcess::spawn(spec)?;
        self.sessions.remove(&id);
        self.children.insert(id, Arc::new(PluginLane::new(child)));
        Ok(())
    }

    /// Spawn when absent; no-op when already tracked. Refuses TypeScript ownership.
    pub fn ensure(&mut self, id: impl Into<String>, spec: &SpawnSpec) -> Result<bool, OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Ok(false);
        }
        self.spawn(id, spec)?;
        Ok(true)
    }

    /// Adopt an already-spawned child. Refused while TypeScript owns the host.
    pub fn track(&mut self, id: impl Into<String>, child: PluginProcess) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        self.sessions.remove(&id);
        self.children.insert(id, Arc::new(PluginLane::new(child)));
        Ok(())
    }

    /// Terminate and drop a tracked child.
    pub async fn terminate(&mut self, id: &str) -> Result<(), OwnerError> {
        self.ensure_native_library()?;
        self.sessions.remove(id);
        let lane = self
            .children
            .remove(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        lane.process().terminate().await?;
        Ok(())
    }

    pub fn is_ready(&self, id: &str) -> bool {
        self.children.get(id).is_some_and(|lane| lane.is_ready())
    }

    pub fn mark_ready(&mut self, id: &str) {
        if let Some(lane) = self.children.get(id) {
            lane.mark_ready(None);
        }
    }

    /// Mark ready and keep the hello summary until the child is replaced.
    pub fn mark_ready_with(&mut self, id: &str, hello: Value) {
        if let Some(lane) = self.children.get(id) {
            lane.mark_ready(Some(hello));
        }
    }

    pub fn ready_hello(&self, id: &str) -> Option<Value> {
        self.children.get(id).and_then(|lane| lane.ready_hello())
    }

    pub fn clear_ready(&mut self, id: &str) {
        if let Some(lane) = self.children.get(id) {
            *lane.ready_slot() = None;
        }
    }

    /// Pid of a tracked child, if still alive to the OS.
    pub fn find_plugin(&self, id: &str) -> Option<u32> {
        self.children.get(id).and_then(|lane| lane.process().pid())
    }

    /// JSON-RPC request against a tracked child (`_host.plugin.call`).
    ///
    /// When a [`PluginCapabilitySession`] is installed, plugin-to-host
    /// `capability.*` requests are answered through that broker; otherwise they
    /// stay denied (pre-P4d-6 behavior).
    pub async fn call_plugin(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, OwnerError> {
        self.call_plugin_cancellable(id, method, params, deadline, None)
            .await
    }

    /// [`Self::call_plugin`] that sends `$/cancel` to the child when `cancel` flips.
    pub async fn call_plugin_cancellable(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&watch::Receiver<bool>>,
    ) -> Result<Value, OwnerError> {
        self.ensure_native_library()?;
        let session = self.sessions.get(id).cloned();
        let lane = self
            .lane(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        let expires = Instant::now() + deadline;
        let _turn = lane.exclusive(expires).await?;
        let left = expires.saturating_duration_since(Instant::now());
        let child = lane.process();
        match session {
            Some(session) => Ok(child
                .request_with_handler(method, params, left, cancel, move |cap, body, meta| {
                    let session = session.clone();
                    async move {
                        let mut guard = session.lock().await;
                        guard.answer(&cap, body, meta).await
                    }
                })
                .await?),
            None => Ok(child.request(method, params, left, cancel).await?),
        }
    }

    fn ensure_native_library(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { .. } => Ok(()),
        }
    }

    /// Direct JSON-RPC to a provider child for `hostRunner.*` (bypasses capability broker).
    pub(crate) async fn call_host_runner(
        &mut self,
        id: &str,
        method: &str,
        params: serde_json::Value,
        deadline: Duration,
    ) -> Result<serde_json::Value, OwnerError> {
        self.ensure_native_library()?;
        let lane = self
            .lane(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        let expires = Instant::now() + deadline;
        let _turn = lane.exclusive(expires).await?;
        let left = expires.saturating_duration_since(Instant::now());
        Ok(lane.process().request(method, params, left, None).await?)
    }
}

impl Default for ProcessOwner {
    fn default() -> Self {
        Self::typescript()
    }
}

impl std::fmt::Debug for ProcessOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOwner")
            .field("ownership", &self.ownership)
            .field("children", &self.tracked_ids())
            .field("shadow", &self.shadow)
            .finish()
    }
}
