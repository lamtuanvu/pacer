//! Process-owner gate and live child map.
//!
//! Production serve keeps [`Ownership::TypeScript`] unless the P4d-1 flag path
//! constructs [`ProcessOwner::native_for_serve`]. The native test token can hold
//! [`PluginProcess`] children in library form without claiming serve supervision
//! or setting `PACER_HOST_SOCKET`. Flag-on calls answer `capability.*` through an
//! installed [`crate::PluginCapabilitySession`] (P4d-6).

use crate::capability::PluginCapabilitySession;
use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use thiserror::Error;
use tokio::sync::Mutex;

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

/// Holds live plugin children. Default serve constructs
/// [`ProcessOwner::typescript`]; the P4d-1 flag path uses
/// [`ProcessOwner::native_for_serve`].
pub struct ProcessOwner {
    ownership: Ownership,
    children: HashMap<String, PluginProcess>,
    /// Plugins that completed `plugin.hello` under this owner.
    ready: HashMap<String, ()>,
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
            children: HashMap::new(),
            ready: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
    }

    /// Test harness that pretends native ownership without activating serve.
    pub fn native_for_tests() -> Self {
        Self {
            ownership: Ownership::native_for_tests(),
            children: HashMap::new(),
            ready: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
    }

    /// Flag-on serve path: native ownership with supervision claimable.
    pub fn native_for_serve() -> Self {
        Self {
            ownership: Ownership::native_for_serve(),
            children: HashMap::new(),
            ready: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
        }
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
        self.children.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut PluginProcess> {
        self.children.get_mut(id)
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
        self.ready.remove(&id);
        self.sessions.remove(&id);
        self.children.insert(id, child);
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
        self.ready.remove(&id);
        self.sessions.remove(&id);
        self.children.insert(id, child);
        Ok(())
    }

    /// Terminate and drop a tracked child.
    pub async fn terminate(&mut self, id: &str) -> Result<(), OwnerError> {
        self.ensure_native_library()?;
        self.ready.remove(id);
        self.sessions.remove(id);
        let child = self
            .children
            .remove(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        child.terminate().await?;
        Ok(())
    }

    pub fn is_ready(&self, id: &str) -> bool {
        self.ready.contains_key(id)
    }

    pub fn mark_ready(&mut self, id: impl Into<String>) {
        self.ready.insert(id.into(), ());
    }

    pub fn clear_ready(&mut self, id: &str) {
        self.ready.remove(id);
    }

    /// Pid of a tracked child, if still alive to the OS.
    pub fn find_plugin(&self, id: &str) -> Option<u32> {
        self.children.get(id).and_then(PluginProcess::pid)
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
        self.ensure_native_library()?;
        let session = self.sessions.get(id).cloned();
        let child = self
            .children
            .get_mut(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        match session {
            Some(session) => Ok(child
                .request_with_handler(method, params, deadline, None, move |cap, body, meta| {
                    let session = session.clone();
                    async move {
                        let mut guard = session.lock().await;
                        guard.answer(&cap, body, meta).await
                    }
                })
                .await?),
            None => Ok(child.request(method, params, deadline, None).await?),
        }
    }

    fn ensure_native_library(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { .. } => Ok(()),
        }
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
