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
    entries: HashMap<String, Entry>,
}

pub struct Entry {
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
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::parse_manifest;

    fn manifest() -> ParsedManifest {
        parse_manifest(serde_json::json!({"id":"fx-good","version":"1.0.0","publisher":"fixture","host":">=1.6.0","contributes":{"usage":{}}})).unwrap()
    }

    #[test]
    fn shadow_never_starts_a_second_host() {
        let mut registry = Registry::shadow();
        registry.insert(manifest(), false, true);
        assert_eq!(registry.mode(), HostMode::Shadow);
        assert!(matches!(
            registry.prepare_native(),
            Err(RegistryError::TypeScriptOwnsHost)
        ));
        assert!(matches!(
            registry.start("fx-good", 0),
            Err(RegistryError::TypeScriptOwnsHost)
        ));
        assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Idle);
    }

    #[test]
    fn crash_window_backoff_and_enable_match_ts() {
        let mut registry = Registry::shadow();
        registry.insert(manifest(), false, true);
        registry.crash("fx-good", 100).unwrap();
        assert_eq!(registry.get("fx-good").unwrap().next_start_at, 1100);
        registry.crash("fx-good", 200).unwrap();
        assert_eq!(registry.get("fx-good").unwrap().next_start_at, 2200);
        registry.crash("fx-good", 300).unwrap();
        assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Failing);
        registry.enable("fx-good").unwrap();
        assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Idle);
    }

    #[test]
    fn handshake_filters_claims_and_negotiates_features() {
        let mut registry = Registry::shadow();
        registry.insert(manifest(), false, true);
        registry.entries.get_mut("fx-good").unwrap().state = PluginState::Starting;
        let hello: HelloResult = serde_json::from_value(serde_json::json!({
            "protocol":"1.10.0", "id":"fx-good", "version":"1.0.0",
            "contributes":["usage","policy"], "features":["chunkedResults","policyRedactionMetadata","unknown"]
        })).unwrap();
        registry.handshake("fx-good", hello).unwrap();
        let entry = registry.get("fx-good").unwrap();
        assert_eq!(entry.state, PluginState::Ready);
        assert_eq!(entry.served, ["diagnostic", "usage"]);
        assert_eq!(
            entry.features,
            ["chunkedResults", "policyRedactionMetadata"]
        );
    }
}
