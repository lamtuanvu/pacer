use pacer_plugin_protocol::Manifest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Parsed snapshot of the shared `plugins:` strategy section.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PluginsConfig {
    pub policy: Policy,
    pub disabled: Vec<String>,
    pub installed: HashMap<String, PluginGrant>,
    pub config: HashMap<String, HashMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Policy {
    #[serde(deserialize_with = "policy_mode")]
    pub mode: String,
}
fn policy_mode<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let mode = String::deserialize(deserializer)?;
    if ["open", "closed"].contains(&mode.as_str()) {
        Ok(mode)
    } else {
        Err(serde::de::Error::custom("invalid policy mode"))
    }
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            mode: "open".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginGrant {
    pub version: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub surfaces: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<bool>,
}

impl PluginsConfig {
    pub fn is_disabled(&self, id: &str) -> bool {
        self.disabled.iter().any(|item| item == id)
    }

    pub fn grant_covers(&self, manifest: &Manifest) -> bool {
        let Some(grant) = self.installed.get(manifest.id.as_str()) else {
            return false;
        };
        // The TS registry checks capability names and UI surface kinds; version is
        // retained as audit data but is not part of coverage.
        if !manifest.capabilities.iter().all(|capability| {
            grant
                .capabilities
                .iter()
                .any(|name| name == &capability.name.to_string())
        }) {
            return false;
        }
        let Ok(value) = serde_json::to_value(&manifest.contributes) else {
            return false;
        };
        let Some(ui) = value.get("ui").and_then(Value::as_object) else {
            return true;
        };
        ["activity", "panelTabs", "settings", "status"]
            .into_iter()
            .all(|kind| {
                ui.get(kind).and_then(Value::as_array).is_none_or(|items| {
                    items.is_empty() || grant.surfaces.iter().any(|surface| surface == kind)
                })
            })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::parse_manifest;

    #[test]
    fn default_and_grant_coverage_match_strategy() {
        let manifest = parse_manifest(serde_json::json!({"id":"fx-good","version":"1.0.0","publisher":"fixture","host":"^1","capabilities":[{"name":"log"}]})).unwrap();
        let empty = PluginsConfig::default();
        assert_eq!(empty.policy.mode, "open");
        assert!(!empty.grant_covers(&manifest));
        let configured: PluginsConfig = serde_json::from_value(
            serde_json::json!({"installed":{"fx-good":{"version":"0.9.0","capabilities":["log"]}}}),
        )
        .unwrap();
        assert!(configured.grant_covers(&manifest));
    }
}
