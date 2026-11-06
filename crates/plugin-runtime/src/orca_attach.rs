//! Orca capability attach for flag-on [`crate::ProcessOwner`] (P4d-10).

use crate::SharedOwner;
use pacer_plugin_host::{
    BrokerError, CapabilityEffect, NativeOrca, NativeOrcaLive, NativeOrcaStatus,
    OrcaAttemptResource, OrcaLiveControl, OrcaLiveResource, OrcaSessionOwner,
};
use serde_json::Value;
use std::{future::Future, path::Path, pin::Pin, sync::Arc, time::Instant};

/// Core-backed Orca effects during a live plugin call (ProcessOwner → Core IPC).
pub trait OrcaBridge: Send + Sync {
    fn invoke(
        &self,
        plugin_id: &str,
        method: &str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, BrokerError>> + Send + '_>>;
}

pub(crate) struct OwnerOrcaSession {
    owner: SharedOwner,
    plugin_id: String,
    grant: OrcaAttemptResource,
}

impl OrcaSessionOwner for OwnerOrcaSession {
    fn session_id(&self) -> &str {
        &self.grant.session
    }

    fn task_id(&self) -> &str {
        &self.grant.task_id
    }

    fn attempt(&self) -> u64 {
        self.grant.attempt
    }

    fn executor(&self) -> &str {
        &self.grant.executor
    }

    async fn invoke(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        let cap = format!("capability.orca.{method}");
        let bridge = {
            let guard = self.owner.lock().await;
            guard.orca_bridge().cloned()
        };
        let Some(bridge) = bridge else {
            return Err(BrokerError::Invalid("no Orca bridge"));
        };
        bridge.invoke(&self.plugin_id, &cap, params).await
    }
}

pub(crate) struct OwnerOrcaLiveControl {
    owner: SharedOwner,
    plugin_id: String,
    grant: OrcaLiveResource,
}

impl OrcaLiveControl for OwnerOrcaLiveControl {
    async fn release(
        &mut self,
        _worker: &str,
        _terminal: &str,
        _incarnation: Option<&str>,
        _why: &str,
    ) -> Result<(), BrokerError> {
        let bridge = {
            let guard = self.owner.lock().await;
            guard.orca_bridge().cloned()
        };
        let Some(bridge) = bridge else {
            return Err(BrokerError::Invalid("no Orca bridge"));
        };
        let params = serde_json::json!({
            "taskId": self.grant.task_id,
            "attempt": self.grant.attempt,
        });
        bridge
            .invoke(&self.plugin_id, "capability.orca.stop", params)
            .await?;
        Ok(())
    }

    async fn problem(
        &mut self,
        _worker: &str,
        _terminal: &str,
        _incarnation: Option<&str>,
    ) -> Result<Option<String>, BrokerError> {
        let bridge = {
            let guard = self.owner.lock().await;
            guard.orca_bridge().cloned()
        };
        let Some(bridge) = bridge else {
            return Err(BrokerError::Invalid("no Orca bridge"));
        };
        let params = serde_json::json!({
            "taskId": self.grant.task_id,
            "attempt": self.grant.attempt,
        });
        let value = bridge
            .invoke(&self.plugin_id, "capability.orca.sessionState", params)
            .await?;
        if value.get("state").and_then(|s| s.as_str()) == Some("running") {
            Ok(None)
        } else {
            Ok(Some("the worker is no longer running".into()))
        }
    }
}

/// Library fixture session for Orca attach proofs (P4d-10).
pub struct FixtureOrcaSession {
    pub session_id: String,
    pub task_id: String,
    pub attempt: u64,
    pub executor: String,
    pub response: Value,
}

impl OrcaSessionOwner for FixtureOrcaSession {
    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn task_id(&self) -> &str {
        &self.task_id
    }

    fn attempt(&self) -> u64 {
        self.attempt
    }

    fn executor(&self) -> &str {
        &self.executor
    }

    async fn invoke(&mut self, method: &str, _params: Value) -> Result<Value, BrokerError> {
        Ok(json_with_method(method, &self.response))
    }
}

fn json_with_method(method: &str, template: &Value) -> Value {
    if template.is_object() {
        let mut out = template.clone();
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "method".into(),
                method
                    .strip_prefix("capability.orca.")
                    .unwrap_or(method)
                    .into(),
            );
        }
        out
    } else {
        template.clone()
    }
}

pub(crate) enum OrcaAttach {
    Attempt(NativeOrca<OwnerOrcaSession>),
    AttemptFixture(NativeOrca<FixtureOrcaSession>),
    Live(NativeOrcaLive<OwnerOrcaLiveControl>),
    Status(NativeOrcaStatus),
}

pub(crate) struct OrcaAttachPlan {
    pub attempt: Option<OrcaAttemptResource>,
    pub live: Option<OrcaLiveResource>,
    pub status_executable: Option<String>,
    pub status_env: std::collections::HashMap<String, String>,
    pub plugin_id: String,
    pub home: std::path::PathBuf,
}

pub(crate) fn bind_process_owner_orca(
    owner: SharedOwner,
    plan: &OrcaAttachPlan,
) -> Result<OrcaAttach, crate::capability::CapabilitySessionError> {
    let Some(grant) = plan.attempt.clone() else {
        if let Some(live) = plan.live.clone() {
            let control = OwnerOrcaLiveControl {
                owner,
                plugin_id: plan.plugin_id.clone(),
                grant: live.clone(),
            };
            return NativeOrcaLive::new(&plan.home, &plan.plugin_id, live, control)
                .map(OrcaAttach::Live)
                .map_err(|e| crate::capability::CapabilitySessionError::Native(e.to_string()));
        }
        if let Some(exe) = plan.status_executable.as_ref() {
            let deadline = Instant::now() + std::time::Duration::from_secs(20);
            return NativeOrcaStatus::prepare(exe, plan.status_env.clone(), deadline)
                .map(OrcaAttach::Status)
                .map_err(|e| crate::capability::CapabilitySessionError::Native(e.to_string()));
        }
        return Err(crate::capability::CapabilitySessionError::Native(
            "orca attach plan empty".into(),
        ));
    };
    let session = OwnerOrcaSession {
        owner,
        plugin_id: plan.plugin_id.clone(),
        grant: grant.clone(),
    };
    NativeOrca::new(&plan.home, &plan.plugin_id, grant, session)
        .map(OrcaAttach::Attempt)
        .map_err(|e| crate::capability::CapabilitySessionError::Native(e.to_string()))
}

pub(crate) fn bind_orca_fixture(
    home: &Path,
    plugin_id: &str,
    grant: OrcaAttemptResource,
    fixture: FixtureOrcaSession,
) -> Result<OrcaAttach, crate::capability::CapabilitySessionError> {
    NativeOrca::new(home, plugin_id, grant, fixture)
        .map(OrcaAttach::AttemptFixture)
        .map_err(|e| crate::capability::CapabilitySessionError::Native(e.to_string()))
}

pub(crate) async fn orca_sidecar_call(
    sidecar: &mut OrcaAttach,
    method: &str,
    params: Value,
) -> Result<Value, BrokerError> {
    match sidecar {
        OrcaAttach::Attempt(native) => native.call(method, params).await,
        OrcaAttach::AttemptFixture(native) => native.call(method, params).await,
        OrcaAttach::Live(native) => native.call(method, params).await,
        OrcaAttach::Status(native) => native.call(method, params).await,
    }
}

pub type SharedOrcaBridge = Arc<dyn OrcaBridge>;
