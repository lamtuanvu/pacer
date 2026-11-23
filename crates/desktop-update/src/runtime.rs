//! Desktop update runtime (port of `src/update/desktop/service.ts`).
//!
//! Owns the private `desktop-update` state machine for a verified desktop
//! installation: idempotent check/download through the helper adapter,
//! restart (wait → reserve → install → verify → release), cancellation,
//! auto-download, the background tick loop with backoff and reconciliation,
//! and publication of `desktop.update` entities.
//!
//! The runtime operates over an injected [`NativeAuthority`] (the verified
//! native desktop surface) and a [`PipeFactory`] (the helper byte pipe),
//! mirroring `createDesktopUpdateRuntime` in `service.ts`. All public
//! methods take `&self`; interior state is guarded by a single mutex so the
//! state machine is serialized exactly like the single-threaded TypeScript
//! runtime it ports.
#![allow(
    clippy::result_large_err,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unwrap_used,
    clippy::await_holding_lock
)]
use crate::adapter::{
    AdapterError, AdapterFailure, AdapterOutcome, AdapterRequest, HandoffState,
    NativeSessionRef as PipeSessionRef, PipeFactory, run_adapter_command,
};
use crate::adoption_runtime;
use crate::adoption_state::adoption_pending;
use crate::policy::{self, RestartRequest, UpdateRequest};
use crate::store;
use crate::types::{UpdateRecord, is_valid_identifier, parse_update_record};
use crate::{list_adoptions, read_adoption};
use pacer_desktop_admission::reservation::{Reservation, release_reservation, reserve_idle};
use pacer_foundation::Ctx;
use pacer_foundation::api::{Code, CoreError};
use pacer_update::compare_versions as semver_cmp;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Milliseconds in a day (scheduled check backoff).
pub const DAY_MS: f64 = 86_400_000.0;
/// Message for a nightly helper that predates channels, mirroring
/// `NIGHTLY_HELPER_TOO_OLD` in `service.ts`.
pub const NIGHTLY_HELPER_TOO_OLD: &str =
    "Update the desktop app to support nightly updates, then update again.";

fn unavailable(msg: &'static str, hint: &'static str) -> CoreError {
    CoreError::new(Code::NotAllowed, msg).hint(hint)
}
fn conflict(msg: &'static str, hint: &'static str) -> CoreError {
    CoreError::new(Code::Conflict, msg).hint(hint)
}

fn unavailable_adapter() -> AdapterError {
    AdapterError::new(AdapterFailure::Unavailable, HandoffState::None)
}

fn assert_identifier(value: &str) -> Result<(), CoreError> {
    if is_valid_identifier(value) {
        Ok(())
    } else {
        Err(CoreError::new(Code::InvalidInput, "Invalid identifier"))
    }
}

/// A hardened process identity (`ProcessIdentity` in `types.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u64,
    pub boot_id: String,
    pub birth: String,
}

/// The full desktop installation record (`Installation` in `types.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct Install {
    pub id: String,
    pub app_path: String,
    pub bundle_id: String,
    pub owner_uid: u64,
    pub arch: String,
    pub pacer_home: String,
    pub port: u64,
    pub service_label: String,
    pub ownership: String,
    pub version: String,
}

impl Install {
    fn as_policy(&self) -> policy::Installation {
        policy::Installation {
            id: self.id.clone(),
            version: self.version.clone(),
            ownership: self.ownership.clone(),
        }
    }
    fn from_target(target: &Value) -> Install {
        Install {
            id: target
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            app_path: target
                .get("appPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            bundle_id: target
                .get("bundleId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            owner_uid: target.get("ownerUid").and_then(Value::as_u64).unwrap_or(0),
            arch: target
                .get("arch")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            pacer_home: target
                .get("pacerHome")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            port: target.get("port").and_then(Value::as_u64).unwrap_or(0),
            service_label: target
                .get("serviceLabel")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ownership: target
                .get("ownership")
                .and_then(Value::as_str)
                .unwrap_or("attached")
                .to_string(),
            version: target
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }
    }
    fn as_target(&self) -> Value {
        json!({
            "id": self.id,
            "appPath": self.app_path,
            "bundleId": self.bundle_id,
            "ownerUid": self.owner_uid,
            "arch": self.arch,
            "pacerHome": self.pacer_home,
            "port": self.port,
            "serviceLabel": self.service_label,
            "ownership": self.ownership,
            "version": self.version,
        })
    }
}

/// A verified native desktop session (`VerifiedNativeSession` in
/// `service.ts`). `alive` is a shared flag the composition root flips when
/// the desktop exits; `closed` lets the runtime react to an exit.
#[derive(Clone, Debug)]
pub struct NativeSession {
    pub installation: Install,
    pub desktop_client_id: String,
    pub session_id: String,
    pub boot_id: String,
    pub desktop: ProcessIdentity,
    pub service: ProcessIdentity,
    pub alive: Arc<AtomicBool>,
    pub closed: Arc<tokio::sync::Notify>,
}

impl NativeSession {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// `NativeAuthority`: the verified native desktop surface provided by the
/// composition root. Mirrors `NativeAuthorityProvider` in `service.ts` and
/// `AdoptionNative` in `adoption-service.ts`. The helper pipe is opened by
/// the injected [`PipeFactory`], so the authority only re-verifies identity
/// and authorizes outcomes.
pub trait NativeAuthority: Send + Sync {
    fn sessions(&self) -> Vec<NativeSession>;
    fn subscribe(
        &self,
        on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Option<Box<dyn Fn() + Send + Sync>>;
    fn reverify(
        &self,
        session: &NativeSession,
    ) -> Pin<Box<dyn Future<Output = Result<(), CoreError>> + Send + '_>>;
    fn authorize_install(
        &self,
        session: &NativeSession,
        record: &Value,
        prepared: &Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, CoreError>> + Send + '_>>;
    fn verify_install_outcome(
        &self,
        session: &NativeSession,
        record: &Value,
        outcome: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(Value, bool), CoreError>> + Send + '_>>;
    fn broadcast_event(
        &self,
        event_type: &str,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// Adoption surface; `None` when adoption is not driven by this
    /// composition root.
    fn inspect_adoption(&self, _session: &NativeSession) -> Option<Value> {
        None
    }
    fn authorize_adoption(
        &self,
        _session: &NativeSession,
        _record: &Value,
        _prepared: &Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, CoreError>> + Send + '_>> {
        Box::pin(async { Ok(false) })
    }
    fn verify_adoption_outcome(
        &self,
        _record: &Value,
        _outcome: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(Value, bool), CoreError>> + Send + '_>> {
        Box::pin(async {
            Err(unavailable(
                "Verified desktop service adoption is unavailable",
                "Connect the supported signed desktop to the inspected service.",
            ))
        })
    }
}

/// A no-op native authority for default construction.
struct UnownedNative;
impl NativeAuthority for UnownedNative {
    fn sessions(&self) -> Vec<NativeSession> {
        Vec::new()
    }
    fn subscribe(
        &self,
        _on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Option<Box<dyn Fn() + Send + Sync>> {
        None
    }
    fn reverify(
        &self,
        _session: &NativeSession,
    ) -> Pin<Box<dyn Future<Output = Result<(), CoreError>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }
    fn authorize_install(
        &self,
        _s: &NativeSession,
        _r: &Value,
        _p: &Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, CoreError>> + Send + '_>> {
        Box::pin(async { Ok(true) })
    }
    fn verify_install_outcome(
        &self,
        _s: &NativeSession,
        _r: &Value,
        _o: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(Value, bool), CoreError>> + Send + '_>> {
        Box::pin(async { Ok((Value::Object(Default::default()), true)) })
    }
    fn broadcast_event(
        &self,
        _event_type: &str,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Checking,
    Downloading,
    Reserved,
    Recovering,
}

#[derive(Clone)]
struct Active {
    previous: Option<Value>,
    phase: Phase,
    cancel: Cancel,
}

/// Cancellation token shared between the runtime and a running helper pipe.
#[derive(Clone)]
struct Cancel(Arc<AtomicBool>);

impl Cancel {
    fn new() -> Self {
        Cancel(Arc::new(AtomicBool::new(false)))
    }
    fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct RecoveryAttempt {
    transaction_id: String,
    count: u64,
    retry_at: Option<f64>,
}

/// Interior mutable state of the desktop update runtime.
struct State {
    known: HashMap<String, Install>,
    watched: HashMap<String, String>,
    active: HashMap<String, Active>,
    waiting_sessions: HashMap<String, String>,
    next_check: HashMap<String, f64>,
    failures: HashMap<String, u64>,
    initialized: HashSet<String>,
    coordination_errors: HashSet<String>,
    delivery_errors: HashSet<String>,
    pending_publications: HashMap<String, Value>,
    recovery_attempts: HashMap<String, RecoveryAttempt>,
    unsubscribe: Option<Box<dyn Fn() + Send + Sync>>,
    started: bool,
    stopped: bool,
    runtime_error: bool,
}

impl State {
    fn new() -> Self {
        State {
            known: HashMap::new(),
            watched: HashMap::new(),
            active: HashMap::new(),
            waiting_sessions: HashMap::new(),
            next_check: HashMap::new(),
            failures: HashMap::new(),
            initialized: HashSet::new(),
            coordination_errors: HashSet::new(),
            delivery_errors: HashSet::new(),
            pending_publications: HashMap::new(),
            recovery_attempts: HashMap::new(),
            unsubscribe: None,
            started: false,
            stopped: false,
            runtime_error: false,
        }
    }
}

/// `DesktopUpdateRuntime` (port of `service.ts`, `createDesktopUpdateRuntime`).
pub struct DesktopUpdateRuntime {
    home: PathBuf,
    native: Arc<dyn NativeAuthority>,
    factory: Option<Arc<dyn PipeFactory>>,
    publish: Option<Box<dyn Fn(&Value) + Send + Sync>>,
    jitter: f64,
    g_now: f64,
    g_mono: f64,
    boot_id: String,
    capabilities: HashSet<String>,
    reserve_deadline: std::time::Duration,
    adoption: adoption_runtime::AdoptionRuntime,
    state: Arc<Mutex<State>>,
}

/// `DesktopUpdateDeps`: injection points mirroring `service.ts`'s second
/// argument to `createDesktopUpdateRuntime`.
pub struct DesktopUpdateDeps {
    pub native: Arc<dyn NativeAuthority>,
    pub factory: Option<Arc<dyn PipeFactory>>,
    pub now_s: f64,
    pub now_ms: f64,
    pub boot_id: String,
    pub publish: Option<Box<dyn Fn(&Value) + Send + Sync>>,
    pub random: Option<f64>,
    pub capabilities: HashSet<String>,
    pub reserve_deadline: std::time::Duration,
}

impl Default for DesktopUpdateDeps {
    fn default() -> Self {
        DesktopUpdateDeps {
            native: Arc::new(UnownedNative),
            factory: None,
            now_s: pacer_foundation::ctx::unix_now(),
            now_ms: pacer_foundation::ctx::unix_now() * 1000.0,
            boot_id: String::new(),
            publish: None,
            random: None,
            capabilities: HashSet::new(),
            reserve_deadline: std::time::Duration::from_secs(30),
        }
    }
}

impl DesktopUpdateRuntime {
    /// `createDesktopUpdateRuntime` for a pacer home with default deps.
    pub fn new(home: impl Into<PathBuf>) -> Arc<Self> {
        Self::with_deps(home, DesktopUpdateDeps::default())
    }

    /// Build with full dependency overrides.
    pub fn with_deps(home: impl Into<PathBuf>, deps: DesktopUpdateDeps) -> Arc<Self> {
        let jitter = deps.random.unwrap_or(1.0).clamp(0.0, 1.0) * 3_600_000.0;
        let home: PathBuf = home.into();
        let adoption = adoption_runtime::AdoptionRuntime::new(
            deps.native.clone(),
            deps.factory.clone(),
            deps.boot_id.clone(),
            deps.capabilities.clone(),
            deps.reserve_deadline,
            home.clone(),
        );
        Arc::new(DesktopUpdateRuntime {
            home,
            native: deps.native.clone(),
            factory: deps.factory,
            publish: deps.publish,
            jitter,
            g_now: deps.now_s,
            g_mono: deps.now_ms,
            boot_id: deps.boot_id,
            capabilities: deps.capabilities,
            reserve_deadline: deps.reserve_deadline,
            adoption,
            state: Arc::new(Mutex::new(State::new())),
        })
    }

    // ---- record / status ---------------------------------------------------

    fn record_value(&self, id: &str) -> Option<Value> {
        store::read_update(&self.home, id)
            .ok()
            .flatten()
            .map(UpdateRecord::into_value)
    }

    fn installed(&self, id: &str, st: &State) -> Result<Install, CoreError> {
        if let Some(k) = st.known.get(id) {
            return Ok(k.clone());
        }
        if let Some(adopted) = read_adoption(&self.home, id)?
            .and_then(|a| a.get("authority").and_then(|a| a.get("target")).cloned())
            .map(|t| Install::from_target(&t))
        {
            return Ok(adopted);
        }
        Err(unavailable(
            "Verified desktop update is unavailable",
            "Connect the supported signed desktop to the inspected service.",
        ))
    }

    fn live_session(&self, id: &str, st: &State) -> Option<NativeSession> {
        if !st.known.contains_key(id) {
            return None;
        }
        self.native
            .sessions()
            .into_iter()
            .find(|s| s.installation.id == id && s.is_alive() && s.boot_id == self.boot_id)
    }

    fn status_internal(&self, id: &str, st: &State) -> Result<Value, CoreError> {
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        let installation = self.installed(id, st)?;
        let mut status = policy::update_status(&installation.as_policy(), &value)?;
        let adopted = read_adoption(&self.home, id)?;
        let session = self.live_session(id, st);
        let current_adoption = match &session {
            Some(s)
                if (adopted.as_ref().is_none_or(|a| !adoption_pending(a)))
                    && self.adoption.capable()
                    && s.installation.ownership == "attached" =>
            {
                self.native.inspect_adoption(s)
            }
            _ => None,
        };
        let source = current_adoption
            .clone()
            .or_else(|| adopted.clone().and_then(|a| a.get("authority").cloned()));
        if let Some(source) = source {
            let authority = &source;
            let phase = adopted
                .as_ref()
                .and_then(|a| a.get("phase"))
                .and_then(Value::as_str)
                .unwrap_or("available");
            let revision = adopted
                .as_ref()
                .and_then(|a| a.get("revision"))
                .and_then(Value::as_u64)
                .unwrap_or_else(|| value.get("revision").and_then(Value::as_u64).unwrap_or(0));
            let resulting = adopted
                .as_ref()
                .and_then(|a| a.get("resultingInstallationId"))
                .cloned()
                .unwrap_or(Value::Null);
            let blockers = adopted
                .as_ref()
                .and_then(|a| a.get("blockers"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            let error = adopted
                .as_ref()
                .and_then(|a| a.get("error"))
                .cloned()
                .unwrap_or(Value::Null);
            let obj = status.as_object_mut().unwrap();
            obj.insert(
                "adoption".into(),
                json!({
                    "phase": phase,
                    "revision": revision,
                    "previousInstallationId": id,
                    "resultingInstallationId": resulting,
                    "currentServiceExecutable": authority.get("oldServiceExecutable"),
                    "replacementServiceExecutable": authority.get("newServiceExecutable"),
                    "serviceLabel": authority.get("target").and_then(|t| t.get("serviceLabel")),
                    "port": authority.get("target").and_then(|t| t.get("port")),
                    "blockers": blockers,
                    "error": error,
                }),
            );
        }
        if let Some(adopted) = adopted
            && adoption_pending(&adopted)
        {
            let obj = status.as_object_mut().unwrap();
            obj.insert(
                "actions".into(),
                if adopted.get("phase").and_then(Value::as_str) == Some("waiting") {
                    json!(["adoptCancel"])
                } else {
                    json!([])
                },
            );
            return Ok(status);
        }
        if st.runtime_error || st.coordination_errors.contains(id) {
            let obj = status.as_object_mut().unwrap();
            obj.insert("actions".into(), json!([]));
            obj.insert("error".into(), json!({
                "code": "coordination_failed",
                "message": "Desktop update paused. Rechecking the connection and saved update state.",
                "hint": "Pacer will retry automatically. If this persists, quit and reopen Pacer; keep update recovery files in place.",
            }));
            return Ok(status);
        }
        if st.delivery_errors.contains(id) && status.get("error").is_none_or(|e| e.is_null()) {
            let obj = status.as_object_mut().unwrap();
            obj.insert(
                "error".into(),
                json!({
                    "code": "notification_failed",
                    "message": "Update status notifications are delayed. Retrying automatically.",
                    "hint": "Update controls are still available.",
                }),
            );
            return Ok(status);
        }
        if !st.initialized.contains(id) {
            let obj = status.as_object_mut().unwrap();
            obj.insert("actions".into(), json!([]));
            return Ok(status);
        }
        if st.stopped || self.live_session(id, st).is_none() {
            let value2 = self.record_value(id).unwrap_or_else(|| initial_record(id));
            let actions = if value2.get("phase").and_then(Value::as_str) == Some("waiting") {
                json!(["cancel"])
            } else {
                json!([])
            };
            let obj = status.as_object_mut().unwrap();
            obj.insert("actions".into(), actions);
            return Ok(status);
        }
        Ok(status)
    }

    /// `status`.
    pub fn status(&self, id: &str) -> Result<Value, CoreError> {
        let st = self.state.lock().unwrap();
        self.status_internal(id, &st)
    }

    /// `listStatuses`.
    pub fn list_statuses(&self) -> Vec<Value> {
        let st = self.state.lock().unwrap();
        let mut ids: Vec<String> = st.known.keys().cloned().collect();
        for a in list_adoptions(&self.home).unwrap_or_default() {
            if let Some(id) = a.get("installationId").and_then(Value::as_str)
                && !ids.iter().any(|x| x == id)
            {
                ids.push(id.to_string());
            }
        }
        ids.into_iter()
            .filter_map(|id| self.status_internal(&id, &st).ok())
            .collect()
    }

    /// `boundClientId`.
    pub fn bound_client_id(&self, id: &str) -> Result<String, CoreError> {
        let st = self.state.lock().unwrap();
        Ok(self.require_session(id, &st)?.desktop_client_id)
    }

    fn require_session(&self, id: &str, st: &State) -> Result<NativeSession, CoreError> {
        if !st.initialized.contains(id) || st.coordination_errors.contains(id) {
            return Err(unavailable(
                "Verified desktop update is unavailable",
                "Connect the supported signed desktop to the inspected service.",
            ));
        }
        self.live_session(id, st).ok_or_else(|| {
            unavailable(
                "Verified desktop update is unavailable",
                "Connect the supported signed desktop to the inspected service.",
            )
        })
    }

    // ---- publication -------------------------------------------------------

    fn persist(&self, st: &mut State, next: Value) -> Result<Value, CoreError> {
        let expect = next.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let recording = parse_update_record(&next)
            .map_err(|_| CoreError::new(Code::InvalidInput, "Invalid desktop update state"))?;
        store::write_update(&self.home, recording, Some(expect))?;
        let id = next
            .get("installationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let saved = store::read_update(&self.home, &id)
            .map_err(|_| CoreError::new(Code::NotAllowed, "Cannot access desktop update state"))?
            .map(UpdateRecord::into_value)
            .unwrap_or(next);
        self.emit(st, &id);
        Ok(saved)
    }

    fn emit(&self, st: &mut State, id: &str) {
        if let Ok(status) = self.status_internal(id, st) {
            self.deliver(st, id, status);
        }
    }

    fn deliver(&self, st: &mut State, id: &str, mut status: Value) {
        if status.pointer("/error/code").and_then(Value::as_str) == Some("notification_failed")
            && let Some(obj) = status.as_object_mut()
        {
            obj.remove("error");
        }
        let pending_now = st.pending_publications.get(id).cloned();
        if pending_now.as_ref().map(|p| p == &status).unwrap_or(false) {
            return; // already staged with the same snapshot; nothing new
        }
        st.pending_publications
            .insert(id.to_string(), status.clone());
        let publish = self.publish.as_ref();
        if let Some(publish) = publish {
            if st
                .pending_publications
                .get(id)
                .map(|p| p == &status)
                .unwrap_or(false)
            {
                publish(&status);
                st.delivery_errors.remove(id);
                if st
                    .pending_publications
                    .get(id)
                    .map(|p| p == &status)
                    .unwrap_or(false)
                {
                    st.pending_publications.remove(id);
                }
            }
        } else {
            st.delivery_errors.remove(id);
            if st
                .pending_publications
                .get(id)
                .map(|p| p == &status)
                .unwrap_or(false)
            {
                st.pending_publications.remove(id);
            }
        }
    }

    fn failed(&self, st: &mut State, id: &str) {
        st.coordination_errors.insert(id.to_string());
        st.initialized.remove(id);
        self.emit(st, id);
    }

    // ---- request commit ----------------------------------------------------

    fn commit_request(
        &self,
        st: &mut State,
        request: &UpdateRequest,
        action: &str,
        params: &Value,
        change: impl FnOnce(&Value) -> Value,
    ) -> Result<Option<Value>, CoreError> {
        let current = self
            .record_value(&request.installation_id)
            .unwrap_or_else(|| initial_record(&request.installation_id));
        if policy::replay_request(&current, request, action, params)?.is_some() {
            return Ok(Some(current));
        }
        let next = change(&current);
        let next = policy::remember_request(next, request, action, params)?;
        match self.persist(st, next) {
            Ok(_) => Ok(None),
            Err(e) if e.code == Code::Conflict => {
                let fresh = self
                    .record_value(&request.installation_id)
                    .unwrap_or_else(|| initial_record(&request.installation_id));
                if policy::replay_request(&fresh, request, action, params)?.is_some() {
                    Ok(Some(fresh))
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    fn pending_phase(value: &Value) -> bool {
        matches!(
            value.get("phase").and_then(Value::as_str),
            Some(
                "waiting"
                    | "reserved"
                    | "installing"
                    | "verifying"
                    | "rolling-back"
                    | "recovery-failed"
            )
        )
    }

    fn release(&self, st: &State, id: &str, tx: &Option<String>) {
        if let Some(tx) = tx
            && self
                .installed(id, st)
                .map(|i| i.ownership == "managed")
                .unwrap_or(false)
        {
            let _ = release_reservation(
                &self.home,
                &Reservation {
                    owner: Some(tx.clone()),
                    reserved: true,
                    blockers: vec![],
                },
            );
        }
    }

    fn reserve(&self, tx: &str) -> Result<Reservation, CoreError> {
        reserve_idle(&self.home, tx, self.reserve_deadline)
            .map_err(|_| conflict("Desktop reservation failed", ""))
    }

    fn reset_after_network(&self, value: &Value, previous: &Value) -> Value {
        let ready = previous.get("phase").and_then(Value::as_str) == Some("ready");
        let mut next = value.clone();
        next["phase"] = json!(if ready { "ready" } else { "idle" });
        next["candidate"] = previous.get("candidate").cloned().unwrap_or(Value::Null);
        next["downloadedBytes"] = json!(if ready {
            previous.get("downloadedBytes").cloned().unwrap_or(json!(0))
        } else {
            json!(0)
        });
        next["totalBytes"] = json!(if ready {
            previous.get("totalBytes").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        });
        next["error"] = Value::Null;
        next
    }

    fn superseded(&self, e: &CoreError) -> bool {
        e.code == Code::Conflict || e.code == Code::NotAllowed
    }

    fn ctx(&self) -> Ctx {
        let mut env = std::env::vars().collect::<HashMap<_, _>>();
        env.insert("PACER_HOME".to_string(), self.home.display().to_string());
        Ctx::with(self.home.clone(), self.home.clone(), env, self.g_now)
    }

    async fn verified(&self, st: &State, id: &str) -> Result<NativeSession, CoreError> {
        let session = self.require_session(id, st)?;
        self.native.reverify(&session).await?;
        Ok(session)
    }

    // ---- check / download --------------------------------------------------

    /// `check`: run the helper adapter's `check` command and record the
    /// offered candidate.
    pub async fn check(&self, request: UpdateRequest) -> Result<Value, CoreError> {
        let mut st = self.state.lock().unwrap();
        self.start_network(&mut st, request, "check", false).await
    }

    /// `download`: run the helper adapter's `download` command for the
    /// recorded candidate.
    pub async fn download(&self, request: UpdateRequest) -> Result<Value, CoreError> {
        let mut st = self.state.lock().unwrap();
        self.start_network(&mut st, request, "download", false)
            .await
    }

    fn start_network<'a>(
        &'a self,
        st: &'a mut State,
        request: UpdateRequest,
        command: &'a str,
        automatic: bool,
    ) -> Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>> {
        let id = request.installation_id.clone();
        if automatic
            && !self.record_value(&id).is_some_and(|v| {
                v.get("autoDownload")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        {
            return Box::pin(async move { self.status_internal(&id, st) });
        }
        if command == "check" && !policy::checks_enabled(&self.ctx()) {
            return Box::pin(async move {
                Err(CoreError::new(
                    Code::NotAllowed,
                    "Update checking is disabled",
                ))
            });
        }
        Box::pin(async move {
            if !self.capabilities.contains(command) {
                return Err(unavailable(
                    "Verified desktop update is unavailable",
                    "Verified desktop update is unavailable",
                ));
            }
            let session = self.verified(st, &id).await?;
            let _ = session;
            let mut previous: Option<Value> = None;
            let committed = self.commit_request(st, &request, command, &json!({}), |current| {
                let mut next = current.clone();
                if command == "download" && next.get("candidate").is_none_or(Value::is_null) {
                    return next;
                }
                previous = Some(current.clone());
                next["phase"] = json!(if command == "check" {
                    "checking"
                } else {
                    "downloading"
                });
                next["error"] = Value::Null;
                if command == "download" {
                    next["downloadedBytes"] = json!(0);
                    next["totalBytes"] = Value::Null;
                }
                next
            })?;
            if committed.is_some() {
                return self.status_internal(&id, st);
            }
            let value = self
                .record_value(&id)
                .unwrap_or_else(|| initial_record(&id));
            let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
            let op = Active {
                previous: previous.clone(),
                phase: if command == "check" {
                    Phase::Checking
                } else {
                    Phase::Downloading
                },
                cancel: Cancel::new(),
            };
            let cancel = op.cancel.clone();
            st.active.insert(id.clone(), op);
            let outcome = self
                .run_command(
                    &id,
                    command,
                    revision,
                    value.get("candidate").cloned(),
                    &cancel,
                )
                .await;
            match outcome {
                Ok(outcome) => {
                    self.apply_outcome(st, &id, command, previous.as_ref(), outcome)
                        .await
                }
                Err(e) => {
                    st.active.remove(&id);
                    Err(e)
                }
            }
        })
    }

    async fn run_command(
        &self,
        id: &str,
        command: &str,
        revision: u64,
        candidate: Option<Value>,
        cancel: &Cancel,
    ) -> Result<AdapterOutcome, CoreError> {
        let factory = self.factory.clone();
        let request = match command {
            "check" => AdapterRequest::Check {
                installation_id: id.to_string(),
                revision,
                channel: Some(pacer_update::update_channel(&self.ctx())),
            },
            "download" => AdapterRequest::Download {
                installation_id: id.to_string(),
                revision,
                candidate: candidate
                    .ok_or_else(|| conflict("Desktop update conflict: no candidate", ""))?,
            },
            _ => return Err(unavailable("Verified desktop update is unavailable", "")),
        };
        let Some(factory) = factory else {
            return Err(unavailable("Verified desktop update is unavailable", ""));
        };
        let mut pipe = factory
            .open(&PipeSessionRef::new(id))
            .await
            .map_err(|_| unavailable("Verified desktop update is unavailable", ""))?;
        let outcome = run_adapter_command(&mut *pipe, &request, self.reserve_deadline)
            .await
            .map_err(|e| self.adapter_error_to_core(e, command))?;
        let _ = cancel;
        Ok(outcome)
    }

    fn adapter_error_to_core(
        &self,
        error: crate::adapter::AdapterError,
        command: &str,
    ) -> CoreError {
        if error.before_frames && command == "check" && self.capabilities.contains("check") {
            CoreError::new(Code::NotAllowed, NIGHTLY_HELPER_TOO_OLD)
        } else {
            CoreError::new(
                Code::NotAllowed,
                format!("Desktop update could not be verified: {}", error),
            )
        }
    }

    async fn apply_outcome(
        &self,
        st: &mut State,
        id: &str,
        command: &str,
        previous: Option<&Value>,
        outcome: AdapterOutcome,
    ) -> Result<Value, CoreError> {
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        let previous = previous.cloned().unwrap_or_else(|| initial_record(id));
        if command == "check" {
            let offered = outcome
                .frame
                .get("candidate")
                .cloned()
                .unwrap_or(Value::Null);
            let installed = self.installed(id, st)?;
            let candidate = if !offered.is_null() {
                let arch_match =
                    offered.get("arch").and_then(Value::as_str) == Some(installed.arch.as_str());
                let proto = offered
                    .get("protocolMajors")
                    .and_then(Value::as_array)
                    .is_some_and(|p| p.iter().any(|x| x == &json!(3)));
                let rollback = offered
                    .get("rollbackCompatible")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !arch_match || !proto || !rollback {
                    return Err(CoreError::new(
                        Code::NotAllowed,
                        "Desktop release is incompatible",
                    ));
                }
                let offered_version = offered
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if semver_cmp(offered_version, &installed.version) > 0 {
                    offered
                } else {
                    Value::Null
                }
            } else {
                Value::Null
            };
            let prev_ready_candidate = previous.get("candidate").cloned().unwrap_or(Value::Null);
            let previous_ready = previous.get("phase").and_then(Value::as_str) == Some("ready")
                && prev_ready_candidate == candidate;
            let mut next = value.clone();
            next["candidate"] = candidate.clone();
            next["phase"] = json!(if previous_ready { "ready" } else { "idle" });
            next["checkedAt"] = json!(self.g_now);
            next["error"] = Value::Null;
            next["downloadedBytes"] = json!(if previous_ready {
                previous.get("downloadedBytes").cloned().unwrap_or(json!(0))
            } else {
                json!(0)
            });
            next["totalBytes"] = json!(if previous_ready {
                previous.get("totalBytes").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            });
            self.persist(st, next)?;
            st.failures.remove(id);
            st.next_check
                .insert(id.to_string(), self.g_mono + DAY_MS + self.jitter);
            if !st.stopped {
                let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
                let rev = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
                let auto = value
                    .get("autoDownload")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let cand = value.get("candidate").cloned().unwrap_or(Value::Null);
                let phase = value
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if phase == "idle" && auto && !cand.is_null() && self.live_session(id, st).is_some()
                {
                    let request = UpdateRequest {
                        installation_id: id.to_string(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        expect_revision: rev,
                    };
                    let result = self.start_network(st, request, "download", true).await;
                    let _ = result;
                }
            }
        } else if command == "download" {
            let mut next = value.clone();
            next["phase"] = json!("ready");
            next["candidate"] = outcome
                .frame
                .get("candidate")
                .cloned()
                .unwrap_or(Value::Null);
            next["downloadedBytes"] = outcome
                .frame
                .get("downloadedBytes")
                .cloned()
                .unwrap_or(Value::Null);
            next["totalBytes"] = outcome
                .frame
                .get("totalBytes")
                .cloned()
                .unwrap_or(Value::Null);
            next["error"] = Value::Null;
            self.persist(st, next)?;
        }
        st.active.remove(id);
        self.status_internal(id, st)
    }

    // ---- restart / install -------------------------------------------------

    /// `restart`: place the ready candidate into `waiting` for the native
    /// restart remnant to consume.
    pub async fn restart(&self, request: RestartRequest) -> Result<Value, CoreError> {
        assert_identifier(&request.installation_id)?;
        assert_identifier(&request.client_id)?;
        let mut st = self.state.lock().unwrap();
        if !self.capabilities.contains("install") {
            return Err(unavailable("Verified desktop update is unavailable", ""));
        }
        let session = self.require_session(&request.installation_id, &st)?;
        if request.client_id != session.desktop_client_id {
            return Err(unavailable("Verified desktop update is unavailable", ""));
        }
        let current = self
            .record_value(&request.installation_id)
            .unwrap_or_else(|| initial_record(&request.installation_id));
        let next = policy::request_restart(current, &request, &self.boot_id)?;
        let id = request.installation_id.clone();
        let saved = self.persist(&mut st, next)?;
        if let Some(tx) = saved.get("transactionId").and_then(Value::as_str) {
            st.waiting_sessions
                .insert(tx.to_string(), session.session_id);
        }
        self.status_internal(&id, &st)
    }

    /// `cancel`.
    pub async fn cancel(&self, request: UpdateRequest) -> Result<Value, CoreError> {
        self.operational_sync()?;
        let mut st = self.state.lock().unwrap();
        let id = request.installation_id.clone();
        self.installed(&id, &st)?;
        let current = self
            .record_value(&id)
            .unwrap_or_else(|| initial_record(&id));
        if policy::replay_request(&current, &request, "cancel", &json!({}))?.is_some() {
            return self.status_internal(&id, &st);
        }
        let phase = current
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let next = if phase == "waiting" {
            let next = policy::cancel_restart(current.clone())?;
            policy::remember_request(next, &request, "cancel", &json!({}))?
        } else if matches!(phase, "checking" | "downloading") {
            let op =
                st.active.get(&id).cloned().ok_or_else(|| {
                    conflict("Desktop update conflict: operation is not active", "")
                })?;
            let restored =
                self.reset_after_network(&current, op.previous.as_ref().unwrap_or(&current));
            if let Some(k) = st.active.get(&id) {
                k.cancel.cancel();
            }
            st.active.remove(&id);
            policy::remember_request(restored, &request, "cancel", &json!({}))?
        } else {
            return Err(conflict(
                "Desktop update conflict: cancellation is unavailable",
                "",
            ));
        };
        self.persist(&mut st, next)?;
        self.status_internal(&id, &st)
    }

    /// `configure`.
    pub async fn configure(
        &self,
        request: UpdateRequest,
        auto_download: bool,
    ) -> Result<Value, CoreError> {
        let mut st = self.state.lock().unwrap();
        let id = request.installation_id.clone();
        self.require_session(&id, &st)?;
        let params = json!({ "autoDownload": auto_download });
        self.commit_request(&mut st, &request, "configure", &params, |current| {
            let mut next = current.clone();
            if matches!(
                next.get("phase").and_then(Value::as_str),
                Some("reserved" | "installing" | "verifying" | "rolling-back" | "recovery-failed")
            ) {
                next
            } else {
                next["autoDownload"] = json!(auto_download);
                next
            }
        })?;
        self.status_internal(&id, &st)
    }

    /// `adopt`.
    pub async fn adopt(&self, request: UpdateRequest) -> Result<Value, CoreError> {
        assert_identifier(&request.installation_id)?;
        self.operational_sync()?;
        {
            let st = self.state.lock().unwrap();
            let id = request.installation_id.clone();
            self.installed(&id, &st)?;
        }
        self.adoption
            .adopt(&adoption_runtime::UpdateRequest {
                installation_id: request.installation_id.clone(),
                request_id: request.request_id.clone(),
                expect_revision: request.expect_revision,
            })
            .await?;
        self.status(&request.installation_id)
    }

    /// `adoptCancel`.
    pub async fn adopt_cancel(&self, request: UpdateRequest) -> Result<Value, CoreError> {
        assert_identifier(&request.installation_id)?;
        self.operational_sync()?;
        {
            let st = self.state.lock().unwrap();
            let id = request.installation_id.clone();
            self.installed(&id, &st)?;
        }
        self.adoption
            .cancel(&adoption_runtime::UpdateRequest {
                installation_id: request.installation_id.clone(),
                request_id: request.request_id.clone(),
                expect_revision: request.expect_revision,
            })
            .await?;
        self.status(&request.installation_id)
    }

    fn operational_sync(&self) -> Result<(), CoreError> {
        let st = self.state.lock().unwrap();
        if !st.started || st.stopped || st.runtime_error {
            Err(unavailable("Verified desktop update is unavailable", ""))
        } else {
            Ok(())
        }
    }

    // ---- lifecycle ---------------------------------------------------------

    /// `start`.
    pub async fn start(self: &Arc<Self>) -> Result<(), CoreError> {
        let mut st = self.state.lock().unwrap();
        if st.started {
            return Ok(());
        }
        if st.stopped {
            return Err(unavailable("Verified desktop update is unavailable", ""));
        }
        st.started = true;
        drop(st);
        self.adoption.start();
        self.observe(self.clone()).await?;
        {
            let ids: Vec<String> = self.state.lock().unwrap().known.keys().cloned().collect();
            for id in ids {
                let mut st = self.state.lock().unwrap();
                self.reconcile(&mut st, &id).await?;
            }
        }
        self.adoption.tick().await;
        self.broadcast_ready();
        Ok(())
    }

    fn broadcast_ready(&self) {
        let native = self.native.clone();
        let _ = native;
    }

    /// `stop`.
    pub async fn stop(&self) {
        let mut st = self.state.lock().unwrap();
        if st.stopped {
            return;
        }
        for id in st.known.keys().cloned().collect::<Vec<_>>() {
            self.on_close(&mut st, &id);
        }
        st.stopped = true;
        self.adoption.stop();
        if let Some(u) = st.unsubscribe.take() {
            u();
        }
    }

    /// `tick`: background reconciliation and scheduled checks.
    pub async fn tick(self: &Arc<Self>) -> Result<(), CoreError> {
        let mut st = self.state.lock().unwrap();
        if !st.started || st.stopped {
            return Ok(());
        }
        if st.runtime_error {
            let ids: Vec<String> = st.known.keys().cloned().collect();
            for id in ids {
                st.initialized.remove(&id);
                st.coordination_errors.insert(id);
            }
        }
        drop(st);
        self.observe(self.clone()).await?;
        self.adoption.tick().await;
        let mut st = self.state.lock().unwrap();
        st.runtime_error = false;
        let ids: Vec<String> = st.known.keys().cloned().collect();
        for id in ids {
            if st.active.contains_key(&id) {
                continue;
            }
            if let Ok(adopted) = read_adoption(&self.home, &id)
                && adopted.as_ref().is_some_and(adoption_pending)
            {
                continue;
            }
            if let Some(attempt) = st.recovery_attempts.get(&id).cloned() {
                let pending = self
                    .record_value(&id)
                    .unwrap_or_else(|| initial_record(&id));
                let phase = pending
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let err = pending
                    .get("error")
                    .and_then(|e| e.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(retry_at) = attempt.retry_at
                    && self.g_mono >= retry_at
                    && attempt.transaction_id
                        == pending
                            .get("transactionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    && phase == "recovery-failed"
                    && err == "handoff_uncertain"
                {
                    st.initialized.remove(&id);
                    st.recovery_attempts.insert(
                        id.clone(),
                        RecoveryAttempt {
                            transaction_id: attempt.transaction_id,
                            count: 0,
                            retry_at: None,
                        },
                    );
                }
            }
            // Per-installation attempt: a coordination failure (for example,
            // reverify rejecting a waiting restart's proof during advance)
            // marks the installation with `coordination_failed` and keeps the
            // rest of the tick alive, mirroring the TS `try`/`catch (failed)`
            // for the reconcile-advance stage in `tick`.
            match self.tick_core(&mut st, &id).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(_) => {
                    self.failed(&mut st, &id);
                    continue;
                }
            }
            let value = self
                .record_value(&id)
                .unwrap_or_else(|| initial_record(&id));
            if st.active.contains_key(&id)
                || Self::pending_phase(&value)
                || self.live_session(&id, &st).is_none()
                || !policy::checks_enabled(&self.ctx())
            {
                continue;
            }
            let checked_at = value.get("checkedAt").and_then(Value::as_u64);
            let now = self.g_now as u64;
            if !st.next_check.contains_key(&id) {
                let due = policy::check_due(checked_at, now);
                let when = if due {
                    self.g_mono
                } else {
                    self.g_mono + 86_400.0 * 1000.0
                        - (now as f64 - checked_at.unwrap_or(0) as f64) * 1000.0
                        + self.jitter
                };
                st.next_check.insert(id.clone(), when);
            }
            if self.g_mono >= *st.next_check.get(&id).unwrap_or(&0.0)
                && !st.active.contains_key(&id)
            {
                let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
                let request = UpdateRequest {
                    installation_id: id.clone(),
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expect_revision: revision,
                };
                let result = self.start_network(&mut st, request, "check", false).await;
                if let Err(e) = result
                    && !self.superseded(&e)
                {
                    st.runtime_error = true;
                }
            }
        }
        let pending: Vec<String> = st.pending_publications.keys().cloned().collect();
        for id in pending {
            self.emit(&mut st, &id);
        }
        Ok(())
    }

    /// Observe verified sessions: register known installations and arm the
    /// close watcher for each new session.
    async fn observe(&self, this: Arc<Self>) -> Result<(), CoreError> {
        let sessions = self.native.sessions();
        let mut st = self.state.lock().unwrap();
        for session in sessions {
            let id = session.installation.id.clone();
            if !st.known.contains_key(&id) {
                st.known.insert(id.clone(), session.installation.clone());
            }
            let new_watch = st.watched.get(&id).map(|s| s == &session.session_id) != Some(true);
            if new_watch {
                st.watched.insert(id.clone(), session.session_id.clone());
                observe_close(this.clone(), id, session);
            }
        }
        // Reconcile is done from `start` and `tick`'s per-installation
        // attempt, so an observation failure or a reverify rejection on one
        // installation can be scoped rather than aborting the whole tick.
        Ok(())
    }

    /// A session closed: revoke a waiting restart, or cancel the active
    /// network operation. (`on_close` in `service.ts`.)
    fn on_close(&self, st: &mut State, id: &str) {
        let value = self.record_value(id);
        if let Some(v) = &value {
            if v.get("phase").and_then(Value::as_str) == Some("waiting")
                && let Ok(next) = policy::cancel_restart(v.clone())
                && let Ok(s) = self.persist(st, next)
                && let Some(tx) = s.get("transactionId").and_then(Value::as_str)
            {
                st.waiting_sessions.remove(tx);
            }
            if let Some(op) = st.active.get(id) {
                match op.phase {
                    Phase::Checking | Phase::Downloading => op.cancel.cancel(),
                    _ => {}
                }
            }
        }
    }

    /// Reconcile-then-advance for a single installation within `tick`'s
    /// per-installation attempt. Returns `Ok(true)` when the id is handled
    /// (reconcile adopted it, or a waiting install was advanced) and the
    /// caller should move on; `Ok(false)` when scheduled checks may proceed;
    /// `Err` when coordination failed (for example a rejected reverify while
    /// advancing a waiting restart) so the caller can mark the
    /// installation with `coordination_failed`.
    async fn tick_core(&self, st: &mut State, id: &str) -> Result<bool, CoreError> {
        if self.reconcile(st, id).await? {
            return Ok(true);
        }
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        if value.get("phase").and_then(Value::as_str) == Some("waiting") {
            self.advance_waiting(st, id).await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Reconcile a recorded installation once before it becomes eligible.
    async fn reconcile(&self, st: &mut State, id: &str) -> Result<bool, CoreError> {
        if st.initialized.contains(id) {
            return Ok(false);
        }
        let Some(session) = self.live_session(id, st) else {
            return Ok(true);
        };
        // Discovery can overlap the desktop's short-lived sign-in CLI or a native
        // reconnect. Keep this installation unavailable and retry with fresh
        // proof; an observation failure must not permanently poison the runtime.
        if self.native.reverify(&session).await.is_err() {
            return Ok(true);
        }
        if st.stopped || !self.is_current(&session, st) {
            return Ok(true);
        }
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if phase == "waiting" {
            let next = policy::cancel_restart(value)?;
            let saved = self.persist(st, next)?;
            let tx = saved
                .get("transactionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            self.release(st, id, &tx);
        } else if matches!(phase, "checking" | "downloading") {
            let mut next = value.clone();
            next["phase"] = json!("error");
            next["error"] = json!({
                "code": "interrupted",
                "message": "Desktop update network operation was interrupted",
            });
            self.persist(st, next)?;
        } else if matches!(
            phase,
            "reserved" | "installing" | "verifying" | "rolling-back" | "recovery-failed"
        ) {
            if !self.capabilities.contains("recover") {
                return Err(unavailable("Verified desktop update is unavailable", ""));
            }
            let tx = value
                .get("transactionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let count = st.recovery_attempts.get(id).map(|a| a.count).unwrap_or(0);
            st.recovery_attempts.insert(
                id.to_string(),
                RecoveryAttempt {
                    transaction_id: tx,
                    count,
                    retry_at: None,
                },
            );
        } else if let Some(tx) = value
            .get("transactionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            let phase2 = value
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if (phase2 == "ready" && value.get("requestId").is_none_or(Value::is_null))
                || (phase2 == "error"
                    && value
                        .get("error")
                        .and_then(|e| e.get("code"))
                        .and_then(Value::as_str)
                        == Some("pre_handoff"))
                || phase2 == "complete"
                || phase2 == "restored"
            {
                self.release(st, id, &Some(tx));
            }
        }
        st.initialized.insert(id.to_string());
        st.coordination_errors.remove(id);
        self.emit(st, id);
        Ok(true)
    }

    fn is_current(&self, session: &NativeSession, st: &State) -> bool {
        !session.installation.id.is_empty() && session.is_alive() && !st.stopped
    }

    async fn advance_waiting(&self, st: &mut State, id: &str) -> Result<(), CoreError> {
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        if value.get("phase").and_then(Value::as_str) != Some("waiting") {
            return Ok(());
        }
        let Some(tx) = value
            .get("transactionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Ok(());
        };
        let Some(session) = self.live_session(id, st) else {
            self.on_close(st, id);
            return Ok(());
        };
        let requester_boot = value
            .get("requesterBootId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if requester_boot != self.boot_id
            || value.get("requestedBy").and_then(Value::as_str)
                != Some(session.desktop_client_id.as_str())
            || st.waiting_sessions.get(&tx) != Some(&session.session_id)
        {
            self.on_close(st, id);
            return Ok(());
        }
        self.verified(st, id).await?;
        let installed = self.installed(id, st)?.clone();
        let reservation = if installed.ownership == "attached" {
            Reservation {
                owner: Some(tx.clone()),
                reserved: true,
                blockers: vec![],
            }
        } else {
            self.reserve(&tx)?
        };
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        if value.get("phase").and_then(Value::as_str) != Some("waiting")
            || value.get("transactionId").and_then(Value::as_str) != Some(tx.as_str())
            || self.live_session(id, st).is_none()
        {
            if reservation.reserved {
                self.release(st, id, &Some(tx.clone()));
            }
            if value.get("phase").and_then(Value::as_str) == Some("waiting") {
                self.on_close(st, id);
            }
            return Ok(());
        }
        if !reservation.reserved {
            let blockers_value = serde_json::to_value(&reservation.blockers).unwrap_or_default();
            if value.get("blockers") != Some(&blockers_value) {
                let mut next = value;
                next["blockers"] = blockers_value;
                self.persist(st, next)?;
            }
            return Ok(());
        }
        let mut next = value.clone();
        next["phase"] = json!("reserved");
        next["blockers"] = json!([]);
        if let Err(e) = self.persist(st, next) {
            self.release(st, id, &Some(tx));
            return Err(e);
        }
        self.install(st, id, &session, false).await?;
        Ok(())
    }

    /// `install`: drive the adapter to a terminal outcome, then verify and
    /// release. Ports `install` in `service.ts`.
    async fn install(
        &self,
        st: &mut State,
        id: &str,
        session: &NativeSession,
        recovery: bool,
    ) -> Result<(), CoreError> {
        let previous = self.record_value(id).unwrap_or_else(|| initial_record(id));
        let Some(tx) = previous
            .get("transactionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Ok(());
        };
        if st.active.contains_key(id) {
            return Ok(());
        }
        if recovery {
            let attempt = st.recovery_attempts.get(id);
            let base = if attempt.is_some_and(|a| a.transaction_id == tx) {
                attempt.map(|a| a.count).unwrap_or(0)
            } else {
                0
            };
            st.recovery_attempts.insert(
                id.to_string(),
                RecoveryAttempt {
                    transaction_id: tx.clone(),
                    count: base + 1,
                    retry_at: None,
                },
            );
        }
        if !self
            .capabilities
            .contains(if recovery { "recover" } else { "install" })
        {
            return Err(unavailable("Verified desktop update is unavailable", ""));
        }
        let installed = self.installed(id, st)?.clone();
        let candidate = previous.get("candidate").cloned().unwrap_or(Value::Null);
        let revision = previous
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let op = Active {
            previous: Some(previous.clone()),
            phase: if recovery {
                Phase::Recovering
            } else {
                Phase::Reserved
            },
            cancel: Cancel::new(),
        };
        st.active.insert(id.to_string(), op);
        let request = if recovery {
            AdapterRequest::Recover {
                installation_id: id.to_string(),
                revision,
                transaction_id: tx.clone(),
            }
        } else {
            AdapterRequest::Install {
                installation_id: id.to_string(),
                revision,
                transaction_id: tx.clone(),
                candidate: candidate.clone(),
                target: installed.as_target(),
            }
        };
        match self.run_install_command(id, &request).await {
            Ok(outcome) => {
                self.apply_install_outcome(st, id, session, &tx, candidate, outcome)
                    .await
            }
            Err(e) => self.handle_install_error(st, id, &tx, recovery, e),
        }
    }

    /// Drive the adapter install/recover command through the pipe, keeping the
    /// raw `AdapterError` so the caller can branch on `handoff`.
    async fn run_install_command(
        &self,
        id: &str,
        request: &AdapterRequest,
    ) -> Result<AdapterOutcome, AdapterError> {
        let Some(factory) = self.factory.clone() else {
            return Err(unavailable_adapter());
        };
        let mut pipe = factory
            .open(&PipeSessionRef::new(id))
            .await
            .map_err(|_| unavailable_adapter())?;
        run_adapter_command(&mut *pipe, request, self.reserve_deadline).await
    }

    /// Terminal install outcome handling: verify then commit/restore, or
    /// transition to `recovery-failed` on uncertainty (ports `verifyOutcome`
    /// branches in `service.ts`).
    async fn apply_install_outcome(
        &self,
        st: &mut State,
        id: &str,
        session: &NativeSession,
        tx: &str,
        candidate: Value,
        outcome: AdapterOutcome,
    ) -> Result<(), CoreError> {
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        if value.get("transactionId").and_then(Value::as_str) != Some(tx) {
            return Ok(());
        }
        let outcome_name = outcome
            .frame
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if outcome_name == "recovery-failed" {
            let mut next = value;
            next["phase"] = json!("recovery-failed");
            next["error"] =
                json!({ "code": "recovery_failed", "message": "Desktop recovery requires repair" });
            let _ = self.persist(st, next);
            st.recovery_attempts.remove(id);
            self.failed(st, id);
            return Ok(());
        }
        if outcome_name != "committed" && outcome_name != "restored" {
            self.failed(st, id);
            return Ok(());
        }
        match self
            .native
            .verify_install_outcome(session, &value, &outcome_name)
            .await
        {
            Ok((confirmed, attempted)) => {
                let _ = confirmed;
                if !attempted && outcome_name == "restored" {
                    // Nothing was changed by the helper and the candidate is
                    // not confirmed; leave the record in `waiting` for retry.
                    st.active.remove(id);
                    return Ok(());
                }
                let mut next = value;
                let committed = outcome_name == "committed";
                next["phase"] = json!(if committed { "complete" } else { "restored" });
                next["error"] = Value::Null;
                next["requestId"] = Value::Null;
                next["requestedBy"] = Value::Null;
                next["requesterBootId"] = Value::Null;
                if !committed {
                    next["failedVersion"] =
                        candidate.get("version").cloned().unwrap_or(Value::Null);
                }
                self.persist(st, next)?;
                if committed {
                    // Reflect the confirmed installation.
                    if outcome
                        .frame
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                    {
                        let new_install = Install::from_target(&outcome.frame);
                        st.known.insert(id.to_string(), new_install);
                    }
                }
                st.active.remove(id);
                if committed
                    && self
                        .installed(id, st)
                        .map(|i| i.ownership == "managed")
                        .unwrap_or(false)
                {
                    self.release_reservation_for(st, id, tx);
                }
                st.recovery_attempts.remove(id);
                Ok(())
            }
            Err(_) => {
                let mut next = self.record_value(id).unwrap_or_else(|| initial_record(id));
                next["phase"] = json!("recovery-failed");
                next["error"] = json!({ "code": "handoff_uncertain", "message": "Desktop update requires transaction recovery" });
                let _ = self.persist(st, next);
                self.schedule_recovery(st, id, tx);
                Ok(())
            }
        }
    }

    /// Adapter install/recover error: a pre-handoff rejection becomes an
    /// `error`; any uncertainty schedules a bounded recovery retry.
    fn handle_install_error(
        &self,
        st: &mut State,
        id: &str,
        tx: &str,
        recovery: bool,
        e: AdapterError,
    ) -> Result<(), CoreError> {
        let value = self.record_value(id).unwrap_or_else(|| initial_record(id));
        if value.get("transactionId").and_then(Value::as_str) != Some(tx) {
            return Ok(());
        }
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(phase, "complete" | "restored") {
            return Ok(());
        }
        if !recovery && e.handoff == HandoffState::None {
            let mut next = value;
            next["phase"] = json!("error");
            next["requestId"] = Value::Null;
            next["requestedBy"] = Value::Null;
            next["requesterBootId"] = Value::Null;
            next["error"] = json!({ "code": "pre_handoff", "message": e.to_string() });
            let _ = self.persist(st, next);
            self.release_reservation_for(st, id, tx);
        } else {
            let mut next = value;
            next["phase"] = json!("recovery-failed");
            next["error"] = json!({ "code": "handoff_uncertain", "message": "Desktop update requires transaction recovery" });
            let _ = self.persist(st, next);
            self.schedule_recovery(st, id, tx);
        }
        st.active.remove(id);
        self.failed(st, id);
        Ok(())
    }

    /// Bound the recovery retry (up to 5 attempts, exponential backoff).
    fn schedule_recovery(&self, st: &mut State, id: &str, tx: &str) {
        if let Some(attempt) = st.recovery_attempts.get(id)
            && attempt.count < 5
            && attempt.transaction_id == tx
        {
            let delay = 1000.0 * (2_u64).pow(attempt.count as u32) as f64;
            st.recovery_attempts.insert(
                id.to_string(),
                RecoveryAttempt {
                    transaction_id: tx.to_string(),
                    count: attempt.count,
                    retry_at: Some(self.g_mono + delay),
                },
            );
        }
    }

    fn release_reservation_for(&self, st: &State, id: &str, tx: &str) {
        self.release(st, id, &Some(tx.to_string()));
    }

    /// `adoption.capable` delegate.
    pub fn adoption_capable(&self) -> bool {
        self.adoption.capable()
    }
}

/// Wait for a session's `closed` notifier, then terminate its waiting
/// restart or in-flight operation. Runs on the runtime's executor; the
/// state is shared so no `Arc<Self>` reference is held.
fn observe_close(this: Arc<DesktopUpdateRuntime>, id: String, session: NativeSession) {
    let state = this.state.clone();
    let home = this.home.clone();
    let watcher = session.closed.clone();
    tokio::spawn(async move {
        watcher.notified().await;
        let mut st = state.lock().unwrap();
        if st.stopped {
            return;
        }
        let value = crate::store::read_update(&home, &id)
            .ok()
            .flatten()
            .map(UpdateRecord::into_value);
        if let Some(v) = value
            && v.get("phase").and_then(Value::as_str) == Some("waiting")
        {
            let tx = v
                .get("transactionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Ok(next) = policy::cancel_restart(v) {
                let expect = next.get("revision").and_then(Value::as_u64).unwrap_or(0);
                if let Ok(recording) = parse_update_record(&next) {
                    let _ = crate::store::write_update(&home, recording, Some(expect));
                }
                if let Some(tx) = tx {
                    st.waiting_sessions.remove(&tx);
                }
            }
        }
        if let Some(op) = st.active.get(&id) {
            match op.phase {
                Phase::Checking | Phase::Downloading => op.cancel.cancel(),
                _ => {}
            }
        }
    });
}

fn initial_record(id: &str) -> Value {
    json!({
        "schema": 1,
        "installationId": id,
        "revision": 0,
        "phase": "idle",
        "transactionId": Value::Null,
        "requestId": Value::Null,
        "requestedBy": Value::Null,
        "requesterBootId": Value::Null,
        "autoDownload": true,
        "checkedAt": Value::Null,
        "blockers": [],
        "downloadedBytes": 0,
        "totalBytes": Value::Null,
        "candidate": Value::Null,
        "error": Value::Null,
        "failedVersion": Value::Null,
        "requestHistory": [],
    })
}
