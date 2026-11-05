use crate::ParsedManifest;
use pacer_plugin_protocol::{HelloResult, VERSION};
use std::{collections::HashMap, time::Duration};
use thiserror::Error;

/// Shadow mode is the only service mode in P4a. It cannot spawn plugin children.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostMode {
    Shadow,
    Native,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginState {
    Disabled,
    Refused,
    NeedsGrant,
    Idle,
    Starting,
    Ready,
    Failing,
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("TypeScript currently owns plugin processes")]
    TypeScriptOwnsHost,
    #[error("unknown plugin: {0}")]
    UnknownPlugin(String),
    #[error("plugin handshake refused: {0}")]
    Refused(String),
}

pub struct Registry {
    mode: HostMode,
    pub(crate) entries: HashMap<String, Entry>,
}

pub struct Entry {
    pub(crate) bundled: bool,
    pub manifest: ParsedManifest,
    pub state: PluginState,
    pub served: Vec<String>,
    pub protocol: Option<String>,
    pub features: Vec<String>,
    crashes: Vec<u64>,
    next_start_at: u64,
}

impl Registry {
    pub fn shadow() -> Self {
        Self {
            mode: HostMode::Shadow,
            entries: HashMap::new(),
        }
    }

    /// Native ownership is deliberately unavailable until the P4d single-owner cutover.
    pub fn prepare_native(&self) -> Result<(), RegistryError> {
        Err(RegistryError::TypeScriptOwnsHost)
    }

    pub fn mode(&self) -> HostMode {
        self.mode
    }

    pub fn insert(&mut self, manifest: ParsedManifest, disabled: bool, grant_covers: bool) {
        let state = if disabled {
            PluginState::Disabled
        } else if grant_covers {
            PluginState::Idle
        } else {
            PluginState::NeedsGrant
        };
        self.entries.insert(
            manifest.id.to_string(),
            Entry {
                bundled: false,
                manifest,
                state,
                served: Vec::new(),
                protocol: None,
                features: Vec::new(),
                crashes: Vec::new(),
                next_start_at: 0,
            },
        );
    }

    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.get(id)
    }

    /// Stable id/state pairs for optional ProcessOwner shadow sync (no children).
    pub fn plugin_states(&self) -> Vec<(String, PluginState)> {
        let mut states: Vec<_> = self
            .entries
            .iter()
            .map(|(id, entry)| (id.clone(), entry.state))
            .collect();
        states.sort_by(|a, b| a.0.cmp(&b.0));
        states
    }

    /// Missing legacy grants have no policy marker: closed mode cannot prove them safe.
    pub fn policy_unavailable(&self, config: &crate::PluginsConfig) -> Vec<(String, String)> {
        let mut unavailable = vec![];
        for (id, grant) in &config.installed {
            if config.is_disabled(id) || self.entries.get(id).is_some_and(|e| e.bundled) {
                continue;
            }
            match self.entries.get(id) {
                None if grant.policy != Some(false) => {
                    unavailable.push((id.clone(), "plugin folder is missing".into()))
                }
                Some(entry) => {
                    let policy = serde_json::to_value(&entry.manifest.contributes)
                        .ok()
                        .is_some_and(|v| v.get("policy").is_some());
                    let covered = config.grant_covers(&entry.manifest);
                    let healthy = policy
                        && covered
                        && matches!(
                            entry.state,
                            PluginState::Idle
                                | PluginState::Starting
                                | PluginState::Ready
                                | PluginState::Failing
                        );
                    if !healthy && (policy || grant.policy == Some(true)) {
                        let reason = if !covered {
                            "needs_grant".to_owned()
                        } else {
                            match entry.state {
                                PluginState::NeedsGrant => "needs_grant".into(),
                                state => format!("{state:?}").to_lowercase(),
                            }
                        };
                        unavailable.push((id.clone(), reason));
                    }
                }
                _ => {}
            }
        }
        unavailable.sort_by(|a, b| a.0.cmp(&b.0));
        unavailable
    }

    pub fn start(&mut self, id: &str, now_ms: u64) -> Result<Duration, RegistryError> {
        if self.mode == HostMode::Shadow {
            return Err(RegistryError::TypeScriptOwnsHost);
        }
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownPlugin(id.into()))?;
        if entry.state != PluginState::Idle {
            return Err(RegistryError::Refused(format!("state {:?}", entry.state)));
        }
        entry.state = PluginState::Starting;
        Ok(Duration::from_millis(
            entry.next_start_at.saturating_sub(now_ms),
        ))
    }

    /// Compare exactly the identity and major version checked by the TypeScript host.
    pub fn handshake(&mut self, id: &str, hello: HelloResult) -> Result<(), RegistryError> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownPlugin(id.into()))?;
        if entry.state != PluginState::Starting {
            return Err(RegistryError::Refused("handshake outside startup".into()));
        }
        let major = hello
            .protocol
            .split('.')
            .next()
            .and_then(|part| part.parse::<u32>().ok());
        if major != Some(1) {
            return Err(RegistryError::Refused(format!(
                "plugin speaks protocol {}; this pacer serves {VERSION}",
                hello.protocol
            )));
        }
        if hello.id != entry.manifest.id.as_str() || hello.version != entry.manifest.version {
            return Err(RegistryError::Refused(
                "handshake identity does not match the manifest".into(),
            ));
        }
        let minor = hello
            .protocol
            .split('.')
            .nth(1)
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        entry.features = hello
            .features
            .into_iter()
            .filter_map(|feature| {
                let name: String = feature.into();
                let minimum = match name.as_str() {
                    "chunkedResults" => 1,
                    "httpBodyChunks" => 2,
                    "fileWriteChunks" | "plannerInstallTransactions" => 4,
                    "policyObservations" => 6,
                    "policyRedactionMetadata" => 8,
                    _ => return None,
                };
                (minor >= minimum).then_some(name)
            })
            .collect();
        entry.protocol = Some(hello.protocol);
        entry.served = std::iter::once("diagnostic".to_string())
            .chain(hello.contributes.into_iter().filter(|point| {
                point != "diagnostic" && entry.manifest.declared_points.contains(point)
            }))
            .collect();
        entry.state = PluginState::Ready;
        Ok(())
    }

    pub fn crash(&mut self, id: &str, now_ms: u64) -> Result<(), RegistryError> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownPlugin(id.into()))?;
        entry
            .crashes
            .retain(|time| now_ms.saturating_sub(*time) < 60_000);
        entry.crashes.push(now_ms);
        if entry.crashes.len() >= 3 {
            entry.state = PluginState::Failing;
        } else {
            entry.state = PluginState::Idle;
            entry.next_start_at = now_ms + (1_000 << (entry.crashes.len() - 1));
        }
        Ok(())
    }

    pub fn enable(&mut self, id: &str) -> Result<(), RegistryError> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownPlugin(id.into()))?;
        entry.crashes.clear();
        entry.next_start_at = 0;
        entry.state = PluginState::Idle;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
