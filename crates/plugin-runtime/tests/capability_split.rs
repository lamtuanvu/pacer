#![allow(clippy::unwrap_used)]
use pacer_plugin_capabilities as lower;
use pacer_plugin_runtime as upper;
use serde_json::{Value, json};

struct Noop;
impl upper::CapabilityEffect for Noop {
    async fn call(&mut self, _: &str, params: Value) -> Result<Value, upper::BrokerError> {
        Ok(params)
    }
}
fn lower_effect<E: lower::CapabilityEffect>(_: &mut E) {}

#[tokio::test]
async fn facades_share_capability_types_and_traits() {
    let image: Option<lower::native_process::Image> = None;
    let _: Option<upper::native_process::Image> = image;
    let process: Option<lower::NativeProcess> = None;
    let _: Option<upper::NativeProcess> = process;
    let _: lower::CredentialBindings = upper::CredentialBindings::default();
    let grant = lower::authority::OrcaAttemptResource {
        task_id: "task".into(),
        attempt: 1,
        provider_id: lower::authority::ORCA_PROVIDER.into(),
        executor: "codex".into(),
        session: "session".into(),
    };
    let grant: upper::native_orca::OrcaAttemptResource = grant;
    let _: upper::OrcaAttemptResource = grant;
    let live: Option<lower::OrcaLiveResource> = None;
    let _: Option<upper::native_orca::OrcaLiveResource> = live;
    let error: lower::BrokerError = pacer_store::StoreError::Conflict.into();
    assert!(
        matches!(error,upper::BrokerError::Authority(upper::AuthorityError::Denied(ref reason)) if reason == "executor run owner or source changed")
    );
    let mut effect = Noop;
    lower_effect(&mut effect);
    lower::CapabilityEffect::retire(&mut effect).await.unwrap();
    assert_eq!(
        upper::CapabilityEffect::call(&mut effect, "noop", json!({"value":1}))
            .await
            .unwrap(),
        json!({"value":1})
    );
}
