use pacer_plugin_protocol::Manifest;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// Parsed snapshot of the shared `plugins:` strategy section.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PluginsConfig {
    pub policy: Policy,
    pub disabled: Vec<String>,
    pub installed: HashMap<String, PluginGrant>,
    pub config: HashMap<String, HashMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct Policy {
    pub mode: String,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            mode: "open".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct PluginGrant {
    pub version: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub surfaces: Vec<String>,
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

#[allow(clippy::result_large_err)]
pub fn read_config(
    ctx: &pacer_foundation::Ctx,
) -> Result<serde_json::Value, pacer_foundation::api::CoreError> {
    match pacer_config::strategy::load_strategy(&ctx.pacer_home) {
        Ok(s) => Ok(s["plugins"].clone()),
        Err(pacer_config::strategy::StrategyError::Missing(_)) => Ok(
            serde_json::json!({"policy":{"mode":"open"},"disabled":[],"installed":{},"config":{}}),
        ),
        Err(e) => Err(crate::private::error(e)),
    }
}
#[allow(clippy::result_large_err)]
pub fn edit_config(
    ctx: &pacer_foundation::Ctx,
    id: &str,
    disabled: Option<bool>,
    grant: Option<Option<serde_json::Value>>,
) -> Result<(), pacer_foundation::api::CoreError> {
    use serde_json::json;
    crate::private::locked(ctx, "plugins", |ctx| {
        let cfg = read_config(ctx)?;
        let (path, _) = pacer_config::strategy::strategy_path(&ctx.pacer_home)
            .map_err(crate::private::error)?;
        crate::private::parents(
            path.parent()
                .ok_or_else(|| crate::private::error("missing strategy parent"))?,
        )?;
        let bytes = crate::private::read(&path, u64::MAX - 1, false)?
            .ok_or_else(|| crate::private::error("strategy disappeared before edit"))?;
        let before = String::from_utf8(bytes).map_err(crate::private::error)?;
        let mut doc = pacer_config::doc::StrategyDoc::new(&before);
        if let Some(disabled) = disabled {
            let mut next = cfg["disabled"].as_array().cloned().unwrap_or_default();
            if disabled {
                if !next.contains(&json!(id)) {
                    next.push(json!(id));
                }
            } else {
                next.retain(|v| v != id);
            }
            if cfg["disabled"] != json!(next) {
                doc.set_in(&[json!("plugins"), json!("disabled")], &json!(next))
                    .map_err(crate::private::error)?;
            }
        }
        if let Some(grant) = grant {
            let key = [json!("plugins"), json!("installed"), json!(id)];
            if let Some(grant) = grant {
                doc.set_in(&key, &grant).map_err(crate::private::error)?;
            } else if cfg["installed"].get(id).is_some() {
                doc.delete_in(&key).map_err(crate::private::error)?;
            }
        }
        if before != doc.as_str() {
            let raw =
                pacer_config::doc::parse_value(doc.as_str()).map_err(crate::private::error)?;
            pacer_config::strategy::validate_strategy(&raw, &path, "default")
                .map_err(crate::private::error)?;
            if std::fs::read_to_string(&path).map_err(crate::private::error)? != before {
                return Err(pacer_foundation::api::CoreError::new(
                    pacer_foundation::api::Code::Conflict,
                    "strategy changed during edit",
                ));
            }
            crate::private::write(&path, doc.as_str().as_bytes())?;
        }
        Ok(())
    })
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
