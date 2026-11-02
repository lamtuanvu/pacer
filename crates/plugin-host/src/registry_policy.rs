//! Cheap policy discovery. Runtime PIDs and lazy-start state do not enter the fingerprint.
use crate::{
    BrokerError, PluginState, PluginsConfig, PolicyDetailAccess, PolicyEntry, PolicySnapshot,
    Registry,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
fn fingerprint(value: &Value) -> Result<String, BrokerError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(crate::js_canonical_json(value)?.as_bytes())
    ))
}
impl Registry {
    pub fn mark_bundled(&mut self, id: &str) -> Result<(), crate::RegistryError> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| crate::RegistryError::UnknownPlugin(id.into()))?;
        entry.bundled = true;
        Ok(())
    }
    pub fn policy_context(
        &self,
        config: &PluginsConfig,
        context: &str,
    ) -> Result<(PolicySnapshot, HashMap<String, PolicyDetailAccess>), BrokerError> {
        let mut rows = vec![];
        let mut access = HashMap::new();
        let mut policies = vec![];
        let mut entries: Vec<_> = self.entries.iter().collect();
        entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        for (id, entry) in entries {
            if config.is_disabled(id)
                || (!entry.bundled && !config.grant_covers(&entry.manifest))
                || !entry.manifest.declared_points.contains("policy")
                || !matches!(
                    entry.state,
                    PluginState::Idle
                        | PluginState::Starting
                        | PluginState::Ready
                        | PluginState::Failing
                )
            {
                continue;
            }
            let mut manifest = serde_json::to_value(&entry.manifest.wire)
                .map_err(|_| BrokerError::Invalid("manifest snapshot"))?;
            for point in &entry.manifest.declared_points {
                if manifest["contributes"].get(point).is_none() {
                    manifest["contributes"][point] = json!({});
                }
            }
            let grant = if entry.bundled {
                Value::Null
            } else {
                serde_json::to_value(config.installed.get(id))
                    .map_err(|_| BrokerError::Invalid("grant snapshot"))?
            };
            let row = json!({"id":id,"manifest":manifest,"bundled":entry.bundled,"grant":grant,"config":config.config.get(id).cloned().unwrap_or_default()});
            policies.push(PolicyEntry {
                id: id.clone(),
                generation: fingerprint(&row)?,
            });
            rows.push(row);
            access.insert(
                id.clone(),
                PolicyDetailAccess {
                    manifest: entry.manifest.clone(),
                    granted: if entry.bundled {
                        entry
                            .manifest
                            .capabilities
                            .iter()
                            .map(|c| c.name.to_string())
                            .collect()
                    } else {
                        config
                            .installed
                            .get(id)
                            .map(|g| g.capabilities.clone())
                            .unwrap_or_default()
                    },
                    bundled: entry.bundled,
                    redaction_metadata: entry
                        .features
                        .iter()
                        .any(|f| f == "policyRedactionMetadata"),
                },
            );
        }
        let unavailable = self.policy_unavailable(config);
        let missing: Vec<_> = unavailable
            .iter()
            .map(|(id, reason)| json!({"id":id,"reason":reason}))
            .collect();
        let metadata =
            fingerprint(&json!({"config":config,"policies":rows,"unavailable":missing}))?;
        let fingerprint = fingerprint(&json!({"metadata":metadata,"context":context}))?;
        Ok((
            PolicySnapshot {
                closed: config.policy.mode == "closed",
                fingerprint,
                policies,
                unavailable,
            },
            access,
        ))
    }
}
