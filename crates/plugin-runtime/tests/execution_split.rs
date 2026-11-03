#![allow(clippy::unwrap_used)]
use pacer_plugin_execution as lower;
use pacer_plugin_runtime as upper;
use pacer_store::TaskStore;
use serde_json::Value;
use std::collections::HashMap;

type Preflight<E> = fn(&str, &str) -> Result<(String, u64), E>;

fn bound<H: upper::RemoteHost>() {}

#[test]
fn runtime_facade_reexports_execution_types() {
    let x: Option<lower::NativeGit> = None;
    let _: Option<upper::NativeGit> = x;
    let x: Option<lower::VerifiedBundle> = None;
    let _: Option<upper::VerifiedBundle> = x;
    let x: Option<lower::NativeRemote<lower::RemoteTransport>> = None;
    let _: Option<upper::NativeRemote<upper::RemoteTransport>> = x;
    let x: Option<lower::RemoteIntent> = None;
    let _: Option<upper::RemoteIntent> = x;
    let x: Option<lower::RemoteOperation> = None;
    let _: Option<upper::RemoteOperation> = x;
    let x: Option<lower::NativeRun> = None;
    let _: Option<upper::NativeRun> = x;
    let x: Option<lower::RunLaunch> = None;
    let _: Option<upper::RunLaunch> = x;
    let x: Option<lower::RunLaunchFile> = None;
    let _: Option<upper::RunLaunchFile> = x;
    let x: Option<lower::NativeWorktree> = None;
    let _: Option<upper::NativeWorktree> = x;
    let x: Option<lower::RemoteTransport> = None;
    let _: Option<upper::RemoteTransport> = x;
    let x: Option<lower::native_run::directory::RunDirectory> = None;
    let _: Option<upper::native_run::directory::RunDirectory> = x;
    bound::<lower::RemoteTransport>();
}

#[test]
fn runtime_facade_reexports_execution_functions() {
    let _: fn(&Value) -> Result<i64, lower::BrokerError> = upper::native_run::rev;
    let _: fn() -> f64 = upper::native_run::now;
    let _: fn(&str) -> Result<HashMap<String, String>, lower::BrokerError> =
        upper::native_git::facts;
    let _: fn(&mut TaskStore, &str, &Value) -> Result<Value, lower::BrokerError> =
        upper::native_git::transfer_owner;
    let _: Preflight<lower::BrokerError> = upper::native_git::remote_preflight;
    let _: Preflight<upper::BrokerError> = lower::remote_preflight;
}

#[test]
fn execution_shares_capability_broker_error() {
    let error: lower::BrokerError = pacer_store::StoreError::Conflict.into();
    let error: upper::BrokerError = error;
    let error: pacer_plugin_capabilities::BrokerError = error;
    assert!(
        matches!(error, lower::BrokerError::Authority(lower::AuthorityError::Denied(ref reason))
        if reason == "executor run owner or source changed")
    );
}
