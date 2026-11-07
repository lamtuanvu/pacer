//! Capability broker sessions for a native [`crate::ProcessOwner`].
//!
//! Reuses `pacer-plugin-host::{CapabilityBroker, NativeRead, NativeWrite,
//! NativeProcess, NativeHttp}`. Unscoped methods (`capability.log`,
//! `capability.config.get`) are answered locally from the sealed hello. Scoped
//! native modules answer when Core issues call-scoped [`CallResources`] (P4d-7).
//! P4d-8 wires observation bootstrap (`tasks.read` / `events.subscribe`) when
//! Core seals it. P4d-9 attaches Core-sealed host provider snapshots for
//! `hosts` when issued. P4d-10 attaches Core-sealed Orca attempt/live resources
//! through [`NativeOrca`] when issued. P4d-12 attaches Core-sealed
//! `executorClaim` through [`NativeRun`] when issued.

use crate::executor_attach::{ExecutorAttachPlan, ExecutorCallContext, issue_executor};
use crate::host_attach::{HostAttachSnapshot, native_hosts_for_attach};
use crate::orca_attach::{
    FixtureOrcaSession, OrcaAttach, OrcaAttachPlan, bind_orca_fixture, bind_process_owner_orca,
    orca_sidecar_call,
};
use crate::worktree_attach::{WorktreeAttachPlan, WorktreeCallContext, issue_worktree};
use pacer_plugin_host::{
    AuthorityError, BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
    CredentialBindings, HostProvider, NativeHosts, NativeHttp, NativeProcess, NativeRun,
    ObservationCall, ObservationGeneration, OrcaAttemptResource, ParsedManifest, ProviderSnapshot,
    ReadContext, TaskProjection, parse_manifest,
};

const ORCA_PROVIDER: &str = "pacer-exec-orca";
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

/// The capability a method needs when Core answers it on the call's bridge
/// connection: usage state Core keeps, and file reads under a Core planner
/// borrow or a Codex log directory, which the native read broker does not serve.
pub fn core_capability(method: &str) -> Option<&'static str> {
    match method {
        "capability.usage.state.begin"
        | "capability.usage.state.readChunk"
        | "capability.usage.state.release" => Some("usage.state"),
        "capability.fs.read"
        | "capability.fs.list"
        | "capability.fs.stat"
        | "capability.fs.readRange" => Some("fs.read"),
        _ => None,
    }
}

/// A plugin capability request Core answers on the bridge connection of its call.
pub type CoreRequest = (String, Value, oneshot::Sender<Result<Value, Value>>);
/// Sender half the bridge connection drains while the sealed call is pending.
pub type CoreForward = mpsc::Sender<CoreRequest>;

/// Core-sealed process context for issued commands (flag-off `prepareSpawnAuthority`).
#[derive(Clone, Debug, Default)]
pub struct ProcessContext {
    /// `ACCOUNT_HOME` of the call; Codex live commands must name it as `CODEX_HOME`.
    pub account_home: Option<String>,
    /// Core's minimal environment for commands issued without their own environment.
    pub environment: HashMap<String, String>,
}

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

enum HostSidecar {
    Process(NativeHosts<crate::host_attach::OwnerHostProvider>),
    Fixture(NativeHosts<FixtureHostProvider>),
}

struct SessionEffect {
    local: LocalHostEffect,
    hosts: Option<HostSidecar>,
    orca: Option<OrcaAttach>,
    run: Option<NativeRun>,
}

impl SessionEffect {
    fn new(local: LocalHostEffect) -> Self {
        Self {
            local,
            hosts: None,
            orca: None,
            run: None,
        }
    }

    fn bind_run(&mut self, run: NativeRun) {
        self.run = Some(run);
    }

    fn bind_process_owner_hosts(
        &mut self,
        owner: crate::SharedOwner,
        attach: &[HostAttachSnapshot],
    ) -> Result<(), CapabilitySessionError> {
        if attach.is_empty() {
            return Ok(());
        }
        self.hosts = Some(HostSidecar::Process(native_hosts_for_attach(owner, attach)));
        Ok(())
    }

    fn bind_hosts_fixture(
        &mut self,
        provider: FixtureHostProvider,
        snapshots: impl IntoIterator<Item = ProviderSnapshot>,
    ) {
        self.hosts = Some(HostSidecar::Fixture(NativeHosts::new(provider, snapshots)));
    }

    fn bind_orca(&mut self, attach: OrcaAttach) {
        self.orca = Some(attach);
    }
}

impl CapabilityEffect for SessionEffect {
    fn owns_lifecycle(&self, method: &str, plugin_id: &str, scopes: &[String]) -> bool {
        if let Some(run) = &self.run {
            return CapabilityEffect::owns_lifecycle(run, method, plugin_id, scopes);
        }
        false
    }

    fn native_host_sessions(&self) -> bool {
        self.hosts.is_some()
    }

    fn provider_snapshot(&self, alias: &str) -> Option<ProviderSnapshot> {
        match &self.hosts {
            Some(HostSidecar::Process(native)) => native.provider_snapshot(alias),
            Some(HostSidecar::Fixture(native)) => native.provider_snapshot(alias),
            None => None,
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        if method.starts_with("capability.hosts.") {
            match &mut self.hosts {
                Some(HostSidecar::Process(native)) => native.call(method, params).await,
                Some(HostSidecar::Fixture(native)) => native.call(method, params).await,
                None => Err(BrokerError::Invalid("no host provider")),
            }
        } else if method.starts_with("capability.orca.") {
            match &mut self.orca {
                Some(native) => orca_sidecar_call(native, method, params).await,
                None => Err(BrokerError::Invalid("no Orca owner")),
            }
        } else if method.starts_with("capability.process.")
            && matches!(
                method,
                "capability.process.claimRun"
                    | "capability.process.startRun"
                    | "capability.process.stopRun"
                    | "capability.process.inspectRun"
                    | "capability.process.pollRun"
                    | "capability.process.readRunOutput"
                    | "capability.process.completeReportedRun"
            )
        {
            match &mut self.run {
                Some(native) => native.call(method, params).await,
                None => Err(BrokerError::Invalid("no executor run owner")),
            }
        } else {
            self.local.call(method, params).await
        }
    }
}

/// Library fixture for host attach proofs (P4d-9).
pub struct FixtureHostProvider {
    snapshot: ProviderSnapshot,
    stdout: String,
}

impl FixtureHostProvider {
    pub fn new(snapshot: ProviderSnapshot, stdout: impl Into<String>) -> Self {
        Self {
            snapshot,
            stdout: stdout.into(),
        }
    }
}

impl HostProvider for FixtureHostProvider {
    fn snapshot(&self, alias: &str) -> Option<ProviderSnapshot> {
        (self.snapshot.alias == alias).then(|| self.snapshot.clone())
    }

    async fn invoke(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        match method {
            "hostRunner.open" => Ok(json!({"session": "fixture-provider-session"})),
            "hostRunner.run" => {
                if params.get("script").and_then(Value::as_str) != Some("PROBE") {
                    return Err(BrokerError::Invalid("script"));
                }
                Ok(json!({
                    "code": 0,
                    "stdout": self.stdout,
                    "stderr": "",
                    "timedOut": false,
                }))
            }
            "hostRunner.close" => Ok(json!({"ok": true})),
            _ => Err(BrokerError::Invalid("method")),
        }
    }
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
    effect: SessionEffect,
    observation: Option<ObservationState>,
    pending_host_attach: Vec<HostAttachSnapshot>,
    pending_orca: Option<OrcaAttachPlan>,
    pending_worktree: Option<WorktreeAttachPlan>,
    pending_executor: Option<ExecutorAttachPlan>,
    declared: Vec<String>,
    core: Option<(CoreForward, HashSet<String>)>,
}

impl PluginCapabilitySession {
    pub fn new(broker: CapabilityBroker, effect: LocalHostEffect) -> Self {
        Self {
            broker,
            effect: SessionEffect::new(effect),
            observation: None,
            pending_host_attach: Vec::new(),
            pending_orca: None,
            pending_worktree: None,
            pending_executor: None,
            declared: Vec::new(),
            core: None,
        }
    }

    /// Forward the Core-sealed `methods` (each one [`core_capability`] admits)
    /// to the Core that issued this call instead of the native broker.
    pub fn bind_core(&mut self, core: CoreForward, methods: HashSet<String>) {
        self.core = Some((core, methods));
    }

    pub fn broker_mut(&mut self) -> &mut CapabilityBroker {
        &mut self.broker
    }

    pub fn effect_mut(&mut self) -> &mut LocalHostEffect {
        &mut self.effect.local
    }

    pub fn bind_process_owner_hosts(
        &mut self,
        owner: crate::SharedOwner,
    ) -> Result<(), CapabilitySessionError> {
        if self.pending_host_attach.is_empty() {
            return Ok(());
        }
        let attach = std::mem::take(&mut self.pending_host_attach);
        self.effect.bind_process_owner_hosts(owner, &attach)
    }

    /// Attach a test [`HostProvider`] fixture (library tests only).
    pub fn bind_hosts_fixture(
        &mut self,
        provider: FixtureHostProvider,
        snapshots: impl IntoIterator<Item = ProviderSnapshot>,
    ) {
        self.pending_host_attach.clear();
        self.effect.bind_hosts_fixture(provider, snapshots);
    }

    pub fn bind_process_owner_orca(
        &mut self,
        owner: crate::SharedOwner,
    ) -> Result<(), CapabilitySessionError> {
        let Some(plan) = self.pending_orca.take() else {
            return Ok(());
        };
        self.effect
            .bind_orca(bind_process_owner_orca(owner, &plan)?);
        Ok(())
    }

    /// Attach a test Orca session fixture (library tests only).
    pub fn bind_orca_fixture(
        &mut self,
        home: &std::path::Path,
        grant: OrcaAttemptResource,
        fixture: FixtureOrcaSession,
    ) -> Result<(), CapabilitySessionError> {
        self.pending_orca = None;
        self.effect
            .bind_orca(bind_orca_fixture(home, ORCA_PROVIDER, grant, fixture)?);
        Ok(())
    }

    pub async fn bind_process_owner_worktree(&mut self) -> Result<(), CapabilitySessionError> {
        let Some(plan) = self.pending_worktree.take() else {
            return Ok(());
        };
        let worktree = issue_worktree(&plan).await?;
        self.broker.attach_worktree(worktree);
        Ok(())
    }

    pub fn bind_process_owner_executor(&mut self) -> Result<(), CapabilitySessionError> {
        let Some(plan) = self.pending_executor.take() else {
            return Ok(());
        };
        let deadline = self.broker.authority().deadline();
        let run = issue_executor(&plan, deadline)?;
        self.effect.bind_run(run);
        Ok(())
    }

    pub async fn answer(
        &mut self,
        method: &str,
        params: Value,
        metadata: Option<Value>,
    ) -> Result<Value, Value> {
        if matches!(
            method,
            "capability.tasks.read" | "capability.tasks.list" | "capability.events.subscribe"
        ) {
            return self.answer_observation(method, params, metadata).await;
        }
        if let Some(capability) = core_capability(method) {
            let sealed = self
                .core
                .as_ref()
                .is_some_and(|(_, methods)| methods.contains(method));
            if sealed {
                return self.answer_by_core(method, capability, params).await;
            }
            if capability == "usage.state" {
                return Err(json!({
                    "code": -32000,
                    "message": "usage state was not issued for this call",
                    "data": {"code": "capability_denied"}
                }));
            }
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

    /// Core re-checks the declaration, grant, params and issued resources with its flag-off broker.
    async fn answer_by_core(
        &mut self,
        method: &str,
        capability: &str,
        params: Value,
    ) -> Result<Value, Value> {
        let refuse = |code: &str, message: String| json!({"code": -32000, "message": message, "data": {"code": code}});
        if !self.declared.iter().any(|name| name == capability) {
            return Err(refuse(
                "capability_denied",
                format!("plugin did not declare {capability}"),
            ));
        }
        let authority = self.broker.authority();
        if let Err(error) = authority.granted(capability) {
            return Err(refuse("capability_denied", error.to_string()));
        }
        let deadline = authority.deadline();
        let Some((core, _)) = &self.core else {
            return Err(refuse(
                "capability_denied",
                format!("{method} was not issued for this call"),
            ));
        };
        let (reply, answer) = oneshot::channel();
        if core.send((method.to_owned(), params, reply)).await.is_err() {
            return Err(refuse(
                "plugin_unavailable",
                "the calling Core hung up".into(),
            ));
        }
        match tokio::time::timeout_at(deadline.into(), answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(refuse(
                "plugin_unavailable",
                "the calling Core did not answer".into(),
            )),
            Err(_) => Err(refuse(
                "plugin_timeout",
                format!("{method} passed its capability deadline"),
            )),
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
        self.effect.local.take_logs()
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
    host_snapshots: &[HostAttachSnapshot],
    process: &ProcessContext,
) -> Result<CapabilityBroker, CapabilitySessionError> {
    if !resources.reads.is_empty() {
        broker = broker
            .with_native_read(&resources.reads)
            .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
    }
    if !resources.commands.is_empty() {
        let process = NativeProcess::prepare_account(
            &resources.commands,
            selected,
            &process.environment,
            process.account_home.as_deref(),
        )
        .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
        broker = broker.with_native_process(process);
    }
    if resources.http.is_some() {
        let http = NativeHttp::new(CredentialBindings::default())
            .map_err(|error| CapabilitySessionError::Native(error.to_string()))?;
        broker = broker.with_native_http(http);
    }
    if !host_snapshots.is_empty() {
        broker = broker.with_hosts(host_snapshots.iter().map(|row| row.snapshot.clone()));
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
        None,
        None,
        None,
        None,
    )
}

/// Core-sealed home + optional Orca status pin for ProcessOwner attach (P4d-10).
#[derive(Clone, Debug)]
pub struct OrcaCallContext {
    pub home: std::path::PathBuf,
    pub status_executable: Option<String>,
    pub status_env: HashMap<String, String>,
}

/// Call-scoped session: Core-issued [`CallResources`] attach native fs/process/http.
///
/// `grants` overrides hello grants when Core seals a call-authority response;
/// otherwise hello grants are reused.
#[allow(clippy::too_many_arguments)]
pub fn session_for_call(
    hello: &Value,
    resources: CallResources,
    grants: Option<Vec<String>>,
    lifetime: Duration,
    observation: Option<ObservationBootstrap>,
    host_attach: Option<&[HostAttachSnapshot]>,
    orca_context: Option<OrcaCallContext>,
    worktree_context: Option<WorktreeCallContext>,
    executor_context: Option<ExecutorCallContext>,
) -> Result<PluginCapabilitySession, CapabilitySessionError> {
    session_for_call_in(
        hello,
        resources,
        grants,
        lifetime,
        observation,
        host_attach,
        orca_context,
        worktree_context,
        executor_context,
        &ProcessContext::default(),
    )
}

/// [`session_for_call`] with the Core-sealed [`ProcessContext`] for issued commands.
#[allow(clippy::too_many_arguments)]
pub fn session_for_call_in(
    hello: &Value,
    resources: CallResources,
    grants: Option<Vec<String>>,
    lifetime: Duration,
    observation: Option<ObservationBootstrap>,
    host_attach: Option<&[HostAttachSnapshot]>,
    orca_context: Option<OrcaCallContext>,
    worktree_context: Option<WorktreeCallContext>,
    executor_context: Option<ExecutorCallContext>,
    process: &ProcessContext,
) -> Result<PluginCapabilitySession, CapabilitySessionError> {
    let (manifest, hello_grants, features, config) = hello_parts(hello)?;
    let grants = grants.unwrap_or(hello_grants);
    let (resources, selected) = normalize_commands(resources)?;
    let host_rows = host_attach.unwrap_or_default();
    if !resources.hosts.is_empty() && host_rows.is_empty() {
        return Err(CapabilitySessionError::Native(
            "hosts resources require Core-sealed hostSnapshots".into(),
        ));
    }
    if !host_rows.is_empty() && !grants.iter().any(|g| g == "hosts") {
        return Err(CapabilitySessionError::Native(
            "hostSnapshots require hosts grant".into(),
        ));
    }
    let orca_granted = grants.iter().any(|g| g == "orca");
    if (resources.orca_attempt.is_some() || resources.orca_live.is_some()) && !orca_granted {
        return Err(CapabilitySessionError::Native(
            "orca resources require orca grant".into(),
        ));
    }
    if resources.orca_attempt.is_some() && manifest.id.as_str() != ORCA_PROVIDER {
        return Err(CapabilitySessionError::Native(
            "orcaAttempt requires the Orca executor provider".into(),
        ));
    }
    let worktree_granted = grants.iter().any(|g| g == "worktree");
    if resources.worktree.is_some() && !worktree_granted {
        return Err(CapabilitySessionError::Native(
            "worktree resources require worktree grant".into(),
        ));
    }
    if resources.worktree.is_some() && worktree_context.is_none() {
        return Err(CapabilitySessionError::Native(
            "worktree resources require Core-sealed worktreeContext".into(),
        ));
    }
    if resources.executor_claim.is_some() && !grants.iter().any(|g| g == "process.spawn") {
        return Err(CapabilitySessionError::Native(
            "executorClaim resources require process.spawn grant".into(),
        ));
    }
    if resources.executor_claim.is_some() && executor_context.is_none() {
        return Err(CapabilitySessionError::Native(
            "executorClaim resources require Core-sealed executorContext".into(),
        ));
    }
    let authority =
        CallAuthority::new(resources.clone(), grants.clone(), Instant::now() + lifetime);
    let declared = manifest
        .capabilities
        .iter()
        .filter_map(|capability| {
            serde_json::to_value(capability.name)
                .ok()
                .and_then(|name| name.as_str().map(str::to_owned))
        })
        .collect();
    let broker = attach_natives(
        CapabilityBroker::new(manifest.clone(), authority, features.clone()),
        &resources,
        &selected,
        host_rows,
        process,
    )?;
    let mut session = PluginCapabilitySession::new(broker, LocalHostEffect::new(config));
    session.declared = declared;
    session.pending_host_attach = host_rows.to_vec();
    if resources.orca_attempt.is_some() || resources.orca_live.is_some() {
        let ctx = orca_context.ok_or_else(|| {
            CapabilitySessionError::Native("orca resources require Core-sealed orcaContext".into())
        })?;
        session.pending_orca = Some(OrcaAttachPlan {
            attempt: resources.orca_attempt.clone(),
            live: resources.orca_live.clone(),
            status_executable: ctx.status_executable,
            status_env: ctx.status_env,
            plugin_id: manifest.id.to_string(),
            home: ctx.home,
        });
    }
    if let (Some(grant), Some(ctx)) = (resources.worktree.clone(), worktree_context) {
        session.pending_worktree = Some(WorktreeAttachPlan {
            grant,
            context: ctx,
        });
    }
    if let (Some(grant), Some(ctx)) = (resources.executor_claim.clone(), executor_context) {
        session.pending_executor = Some(ExecutorAttachPlan {
            grant,
            context: ctx,
        });
    }
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
/// Parse optional Core-sealed host provider snapshots from `call_authority`.
pub fn host_snapshots_from_value(
    value: &Value,
) -> Result<Vec<HostAttachSnapshot>, CapabilitySessionError> {
    let Some(raw) = value.get("hostSnapshots") else {
        return Ok(Vec::new());
    };
    let items = raw
        .as_array()
        .ok_or(CapabilitySessionError::Malformed("hostSnapshots array"))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let alias = item
            .get("alias")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(CapabilitySessionError::Malformed("hostSnapshots alias"))?
            .to_owned();
        let host_fingerprint = item
            .get("hostFingerprint")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(CapabilitySessionError::Malformed(
                "hostSnapshots hostFingerprint",
            ))?
            .to_owned();
        let caller_generation = item
            .get("callerGeneration")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(CapabilitySessionError::Malformed(
                "hostSnapshots callerGeneration",
            ))?
            .to_owned();
        let provider_generation = item
            .get("providerGeneration")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(CapabilitySessionError::Malformed(
                "hostSnapshots providerGeneration",
            ))?
            .to_owned();
        let provider_process = item
            .get("providerProcess")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let provider_id = item
            .get("providerId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(CapabilitySessionError::Malformed(
                "hostSnapshots providerId",
            ))?
            .to_owned();
        out.push(HostAttachSnapshot {
            snapshot: ProviderSnapshot {
                alias,
                host_fingerprint,
                caller_generation,
                provider_generation,
                provider_process,
            },
            provider_id,
        });
    }
    Ok(out)
}

/// Parse optional Core-sealed Orca attach context from `call_authority`.
pub fn orca_context_from_value(
    value: &Value,
) -> Result<Option<OrcaCallContext>, CapabilitySessionError> {
    let Some(raw) = value.get("orcaContext") else {
        return Ok(None);
    };
    let home = raw
        .get("home")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(CapabilitySessionError::Malformed("orcaContext home"))?
        .into();
    let status_executable = raw
        .get("statusExecutable")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let mut status_env = HashMap::new();
    if let Some(object) = raw.get("env").and_then(Value::as_object) {
        for (key, value) in object {
            if let Some(text) = value.as_str() {
                status_env.insert(key.clone(), text.to_owned());
            }
        }
    }
    Ok(Some(OrcaCallContext {
        home,
        status_executable,
        status_env,
    }))
}

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
