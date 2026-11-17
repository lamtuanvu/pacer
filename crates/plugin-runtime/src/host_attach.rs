//! Host provider attach for flag-on [`crate::ProcessOwner`] (P4d-9).

use crate::{OwnerError, SharedOwner};
use pacer_plugin_capabilities::{HostProvider, NativeHosts};
use pacer_plugin_host::{BrokerError, ProviderSnapshot};
use serde_json::Value;
use std::collections::HashMap;

/// Core-sealed host provider row for one configured alias.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostAttachSnapshot {
    pub snapshot: ProviderSnapshot,
    pub provider_id: String,
}

pub(crate) struct OwnerHostProvider {
    owner: SharedOwner,
    provider_id: String,
    snapshots: HashMap<String, ProviderSnapshot>,
}

impl OwnerHostProvider {
    fn new(owner: SharedOwner, attach: &[HostAttachSnapshot]) -> Self {
        let provider_id = attach
            .first()
            .map(|row| row.provider_id.clone())
            .unwrap_or_default();
        let snapshots = attach
            .iter()
            .map(|row| (row.snapshot.alias.clone(), row.snapshot.clone()))
            .collect();
        Self {
            owner,
            provider_id,
            snapshots,
        }
    }

    /// Direct JSON-RPC to the provider child for `hostRunner.*` (bypasses its
    /// capability broker), without holding the owner while it answers.
    async fn invoke_provider(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        let lane = {
            let guard = self.owner.lock().await;
            if let Some(expected) = self.snapshots.values().next() {
                let current_pid = guard.find_plugin(&self.provider_id);
                if expected.provider_process != 0 && current_pid != Some(expected.provider_process)
                {
                    return Err(BrokerError::HostLease("provider changed".into()));
                }
            }
            guard.lane_for_call(&self.provider_id).map(|(lane, _)| lane)
        };
        let lane = lane.map_err(|error| BrokerError::HostLease(error.to_string()))?;
        let expires = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        let _turn = lane
            .exclusive(expires)
            .await
            .map_err(|error| BrokerError::HostLease(error.to_string()))?;
        let left = expires.saturating_duration_since(tokio::time::Instant::now());
        lane.process()
            .request(method, params, left, None)
            .await
            .map_err(|error| BrokerError::HostLease(OwnerError::from(error).to_string()))
    }
}

impl HostProvider for OwnerHostProvider {
    fn snapshot(&self, alias: &str) -> Option<ProviderSnapshot> {
        self.snapshots.get(alias).cloned()
    }

    async fn invoke(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        match method {
            "hostRunner.open" | "hostRunner.run" | "hostRunner.close" => {
                self.invoke_provider(method, params).await
            }
            _ => Err(BrokerError::Invalid("method")),
        }
    }
}

pub(crate) fn native_hosts_for_attach(
    owner: SharedOwner,
    attach: &[HostAttachSnapshot],
) -> NativeHosts<OwnerHostProvider> {
    let issued = attach.iter().map(|row| row.snapshot.clone());
    NativeHosts::new(OwnerHostProvider::new(owner, attach), issued)
}
