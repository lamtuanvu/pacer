//! Opaque, call-local host sessions bound to a selected provider generation.
use crate::{AuthorityError, CallAuthority, HostOperationResource};
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSnapshot {
    pub alias: String,
    pub host_fingerprint: String,
    pub caller_generation: String,
    pub provider_generation: String,
    pub provider_process: u32,
}

#[derive(Debug, Error)]
pub enum HostLeaseError {
    #[error(transparent)]
    Authority(#[from] AuthorityError),
    #[error("host session is unknown or retired")]
    Retired,
    #[error("host provider changed during call")]
    Changed,
    #[error("host session capacity exceeded")]
    Capacity,
}

struct Lease {
    snapshot: ProviderSnapshot,
    busy: bool,
}
pub struct HostLeaseBroker {
    issued: HashMap<String, ProviderSnapshot>,
    leases: HashMap<String, Lease>,
    issued_count: usize,
}

impl HostLeaseBroker {
    /// Captured only from host configuration and the selected provider process.
    pub fn new(issued: impl IntoIterator<Item = ProviderSnapshot>) -> Self {
        Self {
            issued: issued.into_iter().map(|p| (p.alias.clone(), p)).collect(),
            leases: HashMap::new(),
            issued_count: 0,
        }
    }
    pub fn open(
        &mut self,
        authority: &CallAuthority,
        alias: &str,
    ) -> Result<String, HostLeaseError> {
        authority.granted("hosts")?;
        if self.leases.len() >= 4 || self.issued_count >= 64 {
            return Err(HostLeaseError::Capacity);
        }
        let snapshot = self
            .issued
            .get(alias)
            .ok_or(HostLeaseError::Retired)?
            .clone();
        let handle = Uuid::new_v4().to_string();
        self.leases.insert(
            handle.clone(),
            Lease {
                snapshot,
                busy: false,
            },
        );
        self.issued_count += 1;
        Ok(handle)
    }
    pub fn run(
        &mut self,
        authority: &mut CallAuthority,
        handle: &str,
        current: &ProviderSnapshot,
        request: &HostOperationResource,
    ) -> Result<(), HostLeaseError> {
        authority.granted("hosts")?;
        let lease = self.leases.get_mut(handle).ok_or(HostLeaseError::Retired)?;
        if lease.busy {
            return Err(HostLeaseError::Capacity);
        }
        if &lease.snapshot != current
            || current.alias != request.alias
            || current.host_fingerprint != request.host_fingerprint
        {
            self.leases.remove(handle);
            return Err(HostLeaseError::Changed);
        }
        authority.consume_host(request)?;
        lease.busy = true;
        Ok(())
    }
    pub fn finish(&mut self, handle: &str) -> Result<(), HostLeaseError> {
        let lease = self.leases.get_mut(handle).ok_or(HostLeaseError::Retired)?;
        lease.busy = false;
        Ok(())
    }
    pub fn close(&mut self, handle: &str) -> Result<(), HostLeaseError> {
        self.leases.remove(handle).ok_or(HostLeaseError::Retired)?;
        Ok(())
    }
    pub fn snapshot(&self, handle: &str) -> Result<&ProviderSnapshot, HostLeaseError> {
        self.leases
            .get(handle)
            .map(|lease| &lease.snapshot)
            .ok_or(HostLeaseError::Retired)
    }
    pub fn revoke(&mut self) {
        self.leases.clear();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::CallResources;
    use std::time::{Duration, Instant};
    #[test]
    fn session_is_opaque_one_use_and_bound_to_generation() {
        let provider = ProviderSnapshot {
            alias: "remote".into(),
            host_fingerprint: "fingerprint".into(),
            caller_generation: "caller-1".into(),
            provider_generation: "provider-1".into(),
            provider_process: 7,
        };
        let op = HostOperationResource {
            alias: "remote".into(),
            host_fingerprint: "fingerprint".into(),
            script: "STATUS".into(),
            args: vec!["one".into()],
            timeout_ms: 1000,
            max_bytes: 1024,
        };
        let mut a = CallAuthority::new(
            CallResources {
                hosts: vec![op.clone()],
                ..Default::default()
            },
            ["hosts".into()],
            Instant::now() + Duration::from_secs(1),
        );
        let mut leases = HostLeaseBroker::new([provider.clone()]);
        let handle = leases.open(&a, "remote").unwrap();
        let mut changed = provider.clone();
        changed.provider_generation = "provider-2".into();
        assert!(matches!(
            leases.run(&mut a, &handle, &changed, &op),
            Err(HostLeaseError::Changed)
        ));
        assert!(matches!(
            leases.run(&mut a, &handle, &provider, &op),
            Err(HostLeaseError::Retired)
        ));
        let handle = leases.open(&a, "remote").unwrap();
        leases.run(&mut a, &handle, &provider, &op).unwrap();
        leases.finish(&handle).unwrap();
        assert!(leases.run(&mut a, &handle, &provider, &op).is_err());
    }
}
