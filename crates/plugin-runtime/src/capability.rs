//! Capability broker sessions for a native [`crate::ProcessOwner`].
//!
//! Reuses `pacer-plugin-host::{CapabilityBroker, NativeRead, NativeWrite,
//! NativeProcess, NativeHttp}`. Unscoped methods (`capability.log`,
//! `capability.config.get`) are answered locally from the sealed hello. Scoped
//! native modules answer when the caller attaches resources; otherwise the
//! broker denies them. Lifecycle / hosts / orca / observations stay refused
//! until a later slice issues Core-owned authority.

use pacer_plugin_host::{
    AuthorityError, BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
    ParsedManifest, parse_manifest,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CapabilitySessionError {
    #[error("capability session hello is malformed: {0}")]
    Malformed(&'static str),
    #[error("capability session manifest: {0}")]
    Manifest(String),
}

/// Local effects for hello-sealed unscoped capabilities. Scoped native modules
/// short-circuit inside [`CapabilityBroker`] before this effect runs.
pub struct LocalHostEffect {
    config: Value,
    logs: Vec<(String, String)>,
}

impl LocalHostEffect {
    pub fn new(config: Value) -> Self {
        Self {
            config,
            logs: Vec::new(),
        }
    }

    pub fn take_logs(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.logs)
    }

    pub fn config(&self) -> &Value {
        &self.config
    }
}

impl CapabilityEffect for LocalHostEffect {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        match method {
            "capability.log" => {
                let level = params
                    .get("level")
                    .and_then(Value::as_str)
                    .ok_or(BrokerError::Invalid("log level"))?;
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or(BrokerError::Invalid("log message"))?;
                self.logs.push((level.into(), message.into()));
                Ok(json!({"ok": true}))
            }
            "capability.config.get" => Ok(json!({"config": self.config.clone()})),
            _ => Err(
                AuthorityError::Denied(format!("native owner has no effect for {method}")).into(),
            ),
        }
    }
}

/// One plugin's broker + local effect. ProcessOwner answers `capability.*`
/// through this while a parent call is pending.
pub struct PluginCapabilitySession {
    broker: CapabilityBroker,
    effect: LocalHostEffect,
}

impl PluginCapabilitySession {
    pub fn new(broker: CapabilityBroker, effect: LocalHostEffect) -> Self {
        Self { broker, effect }
    }

    pub fn broker_mut(&mut self) -> &mut CapabilityBroker {
        &mut self.broker
    }

    pub fn effect_mut(&mut self) -> &mut LocalHostEffect {
        &mut self.effect
    }

    pub async fn answer(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        match self.broker.handle(method, params, &mut self.effect).await {
            Ok(value) => Ok(value),
            Err(error) => {
                let code = match &error {
                    BrokerError::Authority(_) => "capability_denied",
                    BrokerError::Invalid(_) => "invalid_input",
                    BrokerError::Timeout => "plugin_timeout",
                    _ => "capability_denied",
                };
                Err(json!({
                    "code": -32000,
                    "message": error.to_string(),
                    "data": {"code": code}
                }))
            }
        }
    }

    pub fn take_logs(&mut self) -> Vec<(String, String)> {
        self.effect.take_logs()
    }
}

/// Build a session from the sealed `plugin.hello` params Core put on spawn_spec.
/// Empty [`CallResources`]: native fs/process/http modules are not attached until
/// a later slice can issue call-scoped resources from Core.
pub fn session_from_hello(
    hello: &Value,
    lifetime: Duration,
) -> Result<PluginCapabilitySession, CapabilitySessionError> {
    let manifest_value = hello
        .get("manifest")
        .cloned()
        .ok_or(CapabilitySessionError::Malformed("missing manifest"))?;
    let manifest: ParsedManifest = parse_manifest(manifest_value)
        .map_err(|error| CapabilitySessionError::Manifest(error.to_string()))?;
    let grants = hello
        .get("grants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let features = hello
        .get("features")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let config = hello.get("config").cloned().unwrap_or_else(|| json!({}));
    let authority = CallAuthority::new(CallResources::default(), grants, Instant::now() + lifetime);
    let broker = CapabilityBroker::new(manifest, authority, features);
    Ok(PluginCapabilitySession::new(
        broker,
        LocalHostEffect::new(config),
    ))
}
