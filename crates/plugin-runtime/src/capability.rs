//! Capability broker sessions for a native [`crate::ProcessOwner`].
//!
//! Reuses `pacer-plugin-host::{CapabilityBroker, NativeRead, NativeWrite,
//! NativeProcess, NativeHttp}`. Unscoped methods (`capability.log`,
//! `capability.config.get`) are answered locally from the sealed hello. Scoped
//! native modules answer when Core issues call-scoped [`CallResources`] (P4d-7).
//! Lifecycle / hosts / orca stay refused until a later slice. P4d-8 wires
//! observation bootstrap (`tasks.read` / `events.subscribe`) when Core seals it;
//! host provider snapshots still require a follow-up attach.

use pacer_plugin_host::{
    AuthorityError, BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
    CredentialBindings, NativeHttp, NativeProcess, ObservationCall, ObservationGeneration,
    ParsedManifest, ReadContext, TaskProjection, parse_manifest,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CapabilitySessionError {
    #[error("capability session hello is malformed: {0}")]
    Malformed(&'static str),
    #[error("capability session manifest: {0}")]
    Manifest(String),
    #[error("capability session resources: {0}")]
    Resources(String),
    #[error("capability session native attach: {0}")]
    Native(String),
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

struct ListFixtureProjection;

impl TaskProjection for ListFixtureProjection {
    fn authorize(
        &self,
        _context: &ReadContext,
        method: &str,
        _params: &serde_json::Value,
    ) -> Result<(), BrokerError> {
        if method == "capability.tasks.list" {
            Ok(())
        } else {
            Err(BrokerError::Authority(AuthorityError::Denied(
                "task projection fixture supports list only".into(),
            )))
        }
    }

    async fn project(
        &mut self,
        _context: ReadContext,
        method: &str,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value, BrokerError> {
        if method == "capability.tasks.list" {
            Ok(json!({"tasks": []}))
        } else {
            Err(BrokerError::Authority(AuthorityError::Denied(
                "task projection fixture supports list only".into(),
            )))
        }
    }
}

struct ObservationState {
    generation: ObservationGeneration,
    call: ObservationCall,
    projection: ListFixtureProjection,
}

/// Core-sealed observation bootstrap for one plugin call (P4d-8).
pub struct ObservationBootstrap {
    pub call_token: String,
    pub bootstrap: bool,
    pub context: ReadContext,
}

/// One plugin's broker + local effect. ProcessOwner answers `capability.*`
/// through this while a parent call is pending.
pub struct PluginCapabilitySession {
    broker: CapabilityBroker,
    effect: LocalHostEffect,
    observation: Option<ObservationState>,
}

impl PluginCapabilitySession {
    pub fn new(broker: CapabilityBroker, effect: LocalHostEffect) -> Self {
        Self {
            broker,
            effect,
            observation: None,
        }
    }

    pub fn broker_mut(&mut self) -> &mut CapabilityBroker {
        &mut self.broker
    }

    pub fn effect_mut(&mut self) -> &mut LocalHostEffect {
        &mut self.effect
    }

    pub async fn answer(
        &mut self,
        method: &str,
        params: Value,
        metadata: Option<Value>,
    ) -> Result<Value, Value> {
        if matches!(
            method,
            "capability.tasks.read"
                | "capability.tasks.list"
                | "capability.events.subscribe"
        ) {
            return self.answer_observation(method, params, metadata).await;
        }
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

    async fn answer_observation(
        &mut self,
        method: &str,
        params: Value,
        metadata: Option<Value>,
    ) -> Result<Value, Value> {
        let Some(state) = &mut self.observation else {
            return Err(json!({
                "code": -32000,
                "message": "observation owner or transport was not issued",
                "data": {"code": "capability_denied"}
            }));
        };
        let request = json!({
            "id": 1,
            "_meta": metadata.unwrap_or_else(|| json!({})),
        });
        let result = if method == "capability.events.subscribe" {
            state
                .generation
                .subscribe(&params, &request, Some(&state.call), 0)
        } else {
            state
                .generation
                .read(
                    method,
                    params,
                    &request,
                    Some(&state.call),
                    &mut state.projection,
                )
                .await
        };
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let code = match &error {
                    BrokerError::Authority(_) => "capability_denied",
                    BrokerError::Invalid(_) => "invalid_input",
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

fn hello_parts(
    hello: &Value,
) -> Result<(ParsedManifest, Vec<String>, Vec<String>, Value), CapabilitySessionError> {
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
    Ok((manifest, grants, features, config))
}

/// Core seals absolute argv[0]; NativeProcess requires bare names + selected pins.
fn normalize_commands(
    mut resources: CallResources,
) -> Result<(CallResources, HashMap<String, String>), CapabilitySessionError> {
    let mut selected = HashMap::new();
    if resources.commands.is_empty() {
        return Ok((resources, selected));
    }
    let mut commands = Vec::with_capacity(resources.commands.len());
    for command in resources.commands.drain(..) {
        let Some(exe) = command.argv.first() else {
            return Err(CapabilitySessionError::Native("empty command argv".into()));
        };
        if !Path::new(exe).is_absolute() {
            return Err(CapabilitySessionError::Native(
                "process commands require absolute argv[0] pins from Core".into(),
            ));
        }
        let absolute = exe.clone();
        let name = Path::new(&absolute)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| CapabilitySessionError::Native("command argv[0] file name".into()))?
            .to_owned();
        let mut rewritten = command;
        rewritten.argv[0] = name.clone();
        selected.insert(name, absolute);
        commands.push(rewritten);
    }
    resources.commands = commands;
    Ok((resources, selected))
}

fn attach_natives(
    mut broker: CapabilityBroker,
    resources: &CallResources,
    selected: &HashMap<String, String>,
) -> Result<CapabilityBroker, CapabilitySessionError> {
    if !resources.reads.is_empty() {
        broker = broker
            .with_native_read(&resources.reads)
            .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
    }
    if !resources.commands.is_empty() {
        let process = NativeProcess::prepare(&resources.commands, selected, &HashMap::new())
            .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
        broker = broker.with_native_process(process);
    }
    if resources.http.is_some() {
        let http = NativeHttp::new(CredentialBindings::default())
            .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
        broker = broker.with_native_http(http);
    }
    Ok(broker)
}

/// Build a session from the sealed `plugin.hello` params Core put on spawn_spec.
/// Empty [`CallResources`]: native fs/process/http modules are not attached.
pub fn session_from_hello(
    hello: &Value,
    lifetime: Duration,
) -> Result<PluginCapabilitySession, CapabilitySessionError> {
    session_for_call(
        hello,
        CallResources::default(),
        None,
        lifetime,
        None,
    )
}

/// Call-scoped session: Core-issued [`CallResources`] attach native fs/process/http.
///
/// `grants` overrides hello grants when Core seals a call-authority response;
/// otherwise hello grants are reused.
pub fn session_for_call(
    hello: &Value,
    resources: CallResources,
    grants: Option<Vec<String>>,
    lifetime: Duration,
    observation: Option<ObservationBootstrap>,
) -> Result<PluginCapabilitySession, CapabilitySessionError> {
    let (manifest, hello_grants, features, config) = hello_parts(hello)?;
    let grants = grants.unwrap_or(hello_grants);
    let (resources, selected) = normalize_commands(resources)?;
    let authority = CallAuthority::new(
        resources.clone(),
        grants.clone(),
        Instant::now() + lifetime,
    );
    let broker = attach_natives(
        CapabilityBroker::new(manifest.clone(), authority, features.clone()),
        &resources,
        &selected,
    )?;
    let mut session = PluginCapabilitySession::new(broker, LocalHostEffect::new(config));
    if let Some(bootstrap) = observation {
        let negotiated = features.iter().any(|f| f == "policyObservations");
        let alive = Arc::new(AtomicBool::new(true));
        let check = alive.clone();
        let observation_grants: Vec<String> = grants
            .iter()
            .filter(|g| *g == "tasks.read" || *g == "events.subscribe")
            .cloned()
            .collect();
        let generation = ObservationGeneration::new(
            bootstrap.context,
            manifest,
            observation_grants.clone(),
            negotiated,
            Arc::new(move || check.load(Ordering::SeqCst)),
        );
        let call = ObservationCall::new(
            bootstrap.call_token,
            Instant::now() + lifetime,
            observation_grants,
            bootstrap.bootstrap,
        );
        session.observation = Some(ObservationState {
            generation,
            call,
            projection: ListFixtureProjection,
        });
    }
    Ok(session)
}

/// Parse Core-sealed call-authority `resources` JSON into [`CallResources`].
pub fn call_resources_from_value(value: &Value) -> Result<CallResources, CapabilitySessionError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CapabilitySessionError::Resources(error.to_string()))
}

/// Parse optional Core-sealed observation bootstrap from `call_authority`.
pub fn observation_bootstrap_from_value(
    value: &Value,
) -> Result<Option<ObservationBootstrap>, CapabilitySessionError> {
    let Some(raw) = value.get("observation") else {
        return Ok(None);
    };
    let call_token = raw
        .get("callToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or(CapabilitySessionError::Malformed("observation callToken"))?
        .to_owned();
    let bootstrap = raw
        .get("bootstrap")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let context_value = raw
        .get("readContext")
        .ok_or(CapabilitySessionError::Malformed("observation readContext"))?;
    let home = context_value
        .get("home")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(CapabilitySessionError::Malformed("observation home"))?
        .into();
    let pacer_home = context_value
        .get("pacerHome")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(CapabilitySessionError::Malformed("observation pacerHome"))?
        .into();
    let now = context_value
        .get("now")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Ok(Some(ObservationBootstrap {
        call_token,
        bootstrap,
        context: ReadContext {
            home,
            pacer_home,
            env: HashMap::new(),
            now,
        },
    }))
}
