#![allow(clippy::unwrap_used)]
use pacer_plugin_host as host;
use serde_json::json;

#[test]
fn store_error_conversion_retains_denial_contract() {
    let error: host::BrokerError = pacer_store::StoreError::Conflict.into();
    assert!(
        matches!(error, host::BrokerError::Authority(host::AuthorityError::Denied(ref reason))
        if reason == "executor run owner or source changed")
    );
    let error: pacer_plugin_runtime::BrokerError = pacer_store::StoreError::InvalidRecord.into();
    let error: host::BrokerError = error;
    assert!(
        matches!(error, host::BrokerError::Authority(host::AuthorityError::Denied(ref reason))
        if reason == "executor run owner or source changed")
    );
}

#[test]
fn native_orca_module_and_root_grants_keep_identity_and_json() {
    let grant = host::OrcaAttemptResource {
        task_id: "task".into(),
        attempt: 1,
        provider_id: "pacer-exec-orca".into(),
        executor: "codex".into(),
        session: "session".into(),
    };
    let grant: host::native_orca::OrcaAttemptResource = grant;
    assert_eq!(
        serde_json::to_value(grant).unwrap(),
        json!({"taskId":"task","attempt":1,"providerId":"pacer-exec-orca","executor":"codex","session":"session"})
    );
    let live = host::native_orca::OrcaLiveResource {
        task_id: "task".into(),
        attempt: 1,
        provider_id: "pacer-exec-orca".into(),
        worker: "worker".into(),
        terminal: "terminal".into(),
        incarnation: None,
        action: "stop".into(),
        why: None,
    };
    let live: host::OrcaLiveResource = live;
    assert_eq!(
        serde_json::to_value(live).unwrap(),
        json!({"taskId":"task","attempt":1,"providerId":"pacer-exec-orca","worker":"worker","terminal":"terminal","incarnation":null,"action":"stop","why":null})
    );
    assert_eq!(host::native_orca::ORCA_PROVIDER, "pacer-exec-orca");
}
