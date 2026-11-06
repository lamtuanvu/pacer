//! Host provider attach for flag-on [`crate::ProcessOwner`] (P4d-9).

use crate::SharedOwner;
use pacer_plugin_host::{BrokerError, HostProvider, NativeHosts, ProviderSnapshot};
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

    async fn invoke_provider(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        let mut guard = self.owner.lock().await;
        if let Some(expected) = self.snapshots.values().next() {
            let current_pid = guard.find_plugin(&self.provider_id);
            if expected.provider_process != 0 && current_pid != Some(expected.provider_process) {
                return Err(BrokerError::HostLease("provider changed".into()));
            }
        }
        guard
            .call_host_runner(
                &self.provider_id,
                method,
                params,
                std::time::Duration::from_secs(120),
            )
            .await
            .map_err(|error| BrokerError::HostLease(error.to_string()))
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
