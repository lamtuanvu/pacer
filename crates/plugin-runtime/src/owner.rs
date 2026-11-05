//! Process-owner gate and live child map.
//!
//! Production serve must keep [`Ownership::TypeScript`] until P4d. The native
//! test token can hold [`PluginProcess`] children in library form without
//! flipping serve or setting `PACER_HOST_SOCKET`.

use pacer_plugin_host::{PluginProcess, PluginState, ProcessError, Registry, SpawnSpec};
use std::collections::HashMap;
use thiserror::Error;

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
    /// Reserved for the P4d single-owner cutover. Not constructible from serve.
    #[allow(dead_code)]
    Native { _private: () },
}

impl Ownership {
    pub fn typescript() -> Self {
        Self::TypeScript
    }

    /// Test-only native token. Production serve must not call this.
    pub fn native_for_tests() -> Self {
        Self::Native { _private: () }
    }

    pub fn is_native(&self) -> bool {
        matches!(self, Self::Native { .. })
    }
}

/// Holds live plugin children after the library path is exercised under the
/// native test token. Serve still constructs only [`ProcessOwner::typescript`]
/// and must not call [`Self::spawn`].
pub struct ProcessOwner {
    ownership: Ownership,
    children: HashMap<String, PluginProcess>,
    /// Optional mirror of [`Registry`] state ids without owning children.
    shadow: HashMap<String, PluginState>,
}

impl ProcessOwner {
    /// Production serve constructor: TypeScript remains the process owner.
    pub fn typescript() -> Self {
        Self {
            ownership: Ownership::typescript(),
            children: HashMap::new(),
            shadow: HashMap::new(),
        }
    }

    /// Test harness that pretends native ownership without activating serve.
    pub fn native_for_tests() -> Self {
        Self {
            ownership: Ownership::native_for_tests(),
            children: HashMap::new(),
            shadow: HashMap::new(),
        }
    }

    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }

    /// Claiming native supervision for serve fails until P4d, even under the
    /// library test token.
    pub fn claim_native_supervision(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { .. } => Err(OwnerError::NativeNotActivated),
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

    /// Spawn and track a child. Refused while TypeScript owns the host.
    pub fn spawn(&mut self, id: impl Into<String>, spec: &SpawnSpec) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        let child = PluginProcess::spawn(spec)?;
        self.children.insert(id, child);
        Ok(())
    }

    /// Adopt an already-spawned child. Refused while TypeScript owns the host.
    pub fn track(&mut self, id: impl Into<String>, child: PluginProcess) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        self.children.insert(id, child);
        Ok(())
    }

    /// Terminate and drop a tracked child.
    pub async fn terminate(&mut self, id: &str) -> Result<(), OwnerError> {
        self.ensure_native_library()?;
        let child = self
            .children
            .remove(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        child.terminate().await?;
        Ok(())
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
