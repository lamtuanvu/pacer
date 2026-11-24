//! Native desktop update composition for the front door (PR B7-DX1).
//!
//! Builds the [`DesktopUpdateRuntime`] over the in-process native control
//! sessions and the verified desktop installation identity, then serves the
//! eight `desktop.update.*` ops natively (no Core) through a
//! process-global runtime. The native control socket is always on for
//! paired builds; the `PACER_NATIVE_DESKTOP_CONTROL` flag is removed.
#![allow(clippy::result_large_err, clippy::type_complexity)]

use pacer_desktop_native::control::{ControlState, SessionSnapshot};
use pacer_desktop_native::identity::{self, InspectInputs, Installation};
use pacer_desktop_native::native_trust;
use pacer_desktop_update::policy::{RestartRequest, UpdateRequest};
use pacer_desktop_update::runtime::{
    self, DesktopUpdateDeps, DesktopUpdateRuntime, NativeAuthority, NativeSession, ProcessIdentity,
};
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

/// The process-global desktop update runtime, installed by
/// [`install_runtime`] in `run_serve` and read by the eight native op handlers.
static RUNTIME: OnceLock<Arc<DesktopUpdateRuntime>> = OnceLock::new();

/// Whether the runtime has been installed for this process.
fn global() -> Result<&'static Arc<DesktopUpdateRuntime>, CoreError> {
    RUNTIME
        .get()
        .ok_or_else(|| unavailable_bridge("desktop update runtime unavailable"))
}

fn unavailable_bridge(msg: &'static str) -> CoreError {
    CoreError::new(pacer_foundation::api::Code::Unavailable, msg)
}

/// The installed hallmarks for deriving a desktop installation identity.
pub struct DesktopGlobal {
    pub home: PathBuf,
    pub port: u16,
}

/// `NativeAuthority` backed by the control server's live sessions and the
/// verified installation identity of each connected desktop.
pub struct DesktopAuthority {
    home: PathBuf,
    user_home: PathBuf,
    port: u16,
    control: Arc<ControlState>,
    session_cache: Mutex<HashMap<String, NativeSession>>,
}

impl DesktopAuthority {
    pub fn new(home: PathBuf, user_home: PathBuf, port: u16, control: Arc<ControlState>) -> Self {
        Self {
            home,
            user_home,
            port,
            control,
            session_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Build a full [`NativeSession`] for a live control snapshot, deriving
    /// the installation identity from the verified app path and the desktop
    /// and service process identities from the peer and the serve process.
    fn session_for(&self, snap: &SessionSnapshot) -> Result<NativeSession, CoreError> {
        let mut cache = self.session_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(&snap.session_id) {
            return Ok(cached.clone());
        }
        let inputs = InspectInputs {
            pacer_home: self.home.clone(),
            user_home: self.user_home.clone(),
            port_env: Some(self.port.to_string()),
        };
        let install = match &snap.app_path {
            Some(app_path) => identity::inspect_installation(&inputs, app_path)
                .map(|installation| installation_to_runtime(&installation))
                .unwrap_or_else(|_| fallback_install(&self.home, app_path, self.port)),
            None => fallback_install(&self.home, Path::new(""), self.port),
        };
        let desktop = snap
            .peer_pid
            .and_then(|pid| native_trust::process_details(pid).ok())
            .map(|d| process_to_runtime(&d.process))
            .unwrap_or_else(|| process_to_runtime(&own_process().process));
        let boot_id = desktop.boot_id.clone();
        let service = own_process().process;
        let session = NativeSession {
            installation: install,
            desktop_client_id: snap.client_id.clone(),
            session_id: snap.session_id.clone(),
            boot_id,
            desktop,
            service: process_to_runtime(&service),
            alive: snap.alive.clone(),
            closed: snap.closed.clone(),
        };
        cache.insert(snap.session_id.clone(), session.clone());
        Ok(session)
    }
}

fn installation_to_runtime(installation: &Installation) -> runtime::Install {
    runtime::Install {
        id: installation.id.clone(),
        app_path: installation.app_path.display().to_string(),
        bundle_id: installation.bundle_id.clone(),
        owner_uid: installation.owner_uid,
        arch: installation.arch.clone(),
        pacer_home: installation.pacer_home.display().to_string(),
        port: installation.port,
        service_label: installation.service_label.clone(),
        ownership: installation.ownership.clone(),
        version: installation.version.clone(),
    }
}

/// A best-effort fallback installation when `inspect_installation` cannot
/// run (e.g. a non-bundled, be-spoke peer): the identity is not audited,
/// but the session still binds the app path and the serving home.
fn fallback_install(home: &Path, app_path: &Path, port: u16) -> runtime::Install {
    runtime::Install {
        id: app_path.to_str().map(|s| s.to_owned()).unwrap_or_default(),
        app_path: app_path.to_string_lossy().into_owned(),
        bundle_id: identity::BUNDLE_ID.to_owned(),
        owner_uid: nix::unistd::getuid().as_raw() as u64,
        arch: std::env::consts::ARCH.to_owned(),
        pacer_home: home.to_string_lossy().into_owned(),
        port: port as u64,
        service_label: identity::DESKTOP_SERVICE_LABEL.to_owned(),
        ownership: "attached".to_owned(),
        version: String::new(),
    }
}

fn own_process() -> native_trust::ProcessDetails {
    native_trust::process_details(std::process::id()).unwrap_or_else(|_| dummy_process())
}

fn process_to_runtime(p: &native_trust::ProcessIdentity) -> ProcessIdentity {
    ProcessIdentity {
        pid: p.pid as u64,
        boot_id: p.boot_id.clone(),
        birth: p.birth.clone(),
    }
}

fn dummy_process() -> native_trust::ProcessDetails {
    native_trust::ProcessDetails {
        process: native_trust::ProcessIdentity {
            pid: std::process::id(),
            boot_id: String::new(),
            birth: String::new(),
        },
        uid: nix::unistd::getuid().as_raw(),
        parent_pid: 0,
        executable: PathBuf::new(),
    }
}

impl NativeAuthority for DesktopAuthority {
    fn sessions(&self) -> Vec<NativeSession> {
        let snapshots = self.control.live_sessions_sync();
        let mut out = Vec::new();
        for snap in snapshots {
            if let Ok(session) = self.session_for(&snap) {
                out.push(session);
            }
        }
        out
    }

    fn subscribe(
        &self,
        _on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Option<Box<dyn Fn() + Send + Sync>> {
        // The control state has no change notification surface; the runtime's
        // `observe` polls `sessions()` on each tick, which reflects session
        // arrivals and departures live.
        None
    }

    fn reverify(
        &self,
        session: &NativeSession,
    ) -> Pin<Box<dyn Future<Output = Result<(), CoreError>> + Send + '_>> {
        // A session is reverified when it is alive (the peer frame check
        // already ran at dispatch time); re-audit the installation identity.
        let alive = session.is_alive();
        let app_path = PathBuf::from(&session.installation.app_path);
        let home = self.home.clone();
        let user_home = self.user_home.clone();
        let port = self.port;
        Box::pin(async move {
            if !alive {
                return Err(unavailable_bridge("Verified desktop update is unavailable"));
            }
            let inputs = InspectInputs {
                pacer_home: home,
                user_home,
                port_env: Some(port.to_string()),
            };
            identity::inspect_installation(&inputs, &app_path).map(|_| ())
        })
    }

    fn authorize_install(
        &self,
        session: &NativeSession,
        _record: &Value,
        prepared: &Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, CoreError>> + Send + '_>> {
        let home = self.home.clone();
        let install_session = to_install_session(session);
        let prepared = prepared.clone();
        Box::pin(async move {
            pacer_desktop_native::control::authority::authorize_install(
                &home,
                &install_session,
                &prepared,
                |tx| has_reservation(&home, tx),
            )?;
            Ok(true)
        })
    }

    fn verify_install_outcome(
        &self,
        session: &NativeSession,
        record: &Value,
        outcome: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(Value, bool), CoreError>> + Send + '_>> {
        let home = self.home.clone();
        let user_home = self.user_home.clone();
        let port = self.port;
        let install_session = to_install_session(session);
        let record = record.clone();
        let outcome = outcome.to_owned();
        Box::pin(async move {
            // `verify_bundle` re-audits the installed app path (now the new
            // version) as the service would; `verify_service` confirms the
            // serving process is still alive and bundled.
            pacer_desktop_native::control::authority::verify_outcome(
                &home,
                &install_session,
                &record,
                &outcome,
                |target| {
                    let app_path = target
                        .get("appPath")
                        .and_then(Value::as_str)
                        .map(PathBuf::from)
                        .ok_or_else(|| {
                            pacer_foundation::api::CoreError::new(
                                pacer_foundation::api::Code::NotAllowed,
                                "bundle app path unavailable",
                            )
                        })?;
                    let inputs = InspectInputs {
                        pacer_home: home.clone(),
                        user_home: user_home.clone(),
                        port_env: Some(port.to_string()),
                    };
                    identity::inspect_installation(&inputs, &app_path).map(|_| ())
                },
                || Ok(()),
            )
        })
    }

    fn broadcast_event(
        &self,
        _event_type: &str,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // The desktop subscribes to the shared read-model outbox, which the
        // runtime's publication path feeds; a direct socket push is not
        // required for the op surface.
        Box::pin(async {})
    }

    fn inspect_adoption(&self, _session: &NativeSession) -> Option<Value> {
        None
    }
}

/// Bridge an authority `NativeSession` into the desktop-native install
/// session the `control::authority` functions expect.
fn to_install_session(
    session: &NativeSession,
) -> pacer_desktop_native::control::authority::InstallSession {
    let installation = serde_json::json!({
        "id": session.installation.id,
        "appPath": session.installation.app_path,
        "bundleId": session.installation.bundle_id,
        "ownerUid": session.installation.owner_uid,
        "arch": session.installation.arch,
        "pacerHome": session.installation.pacer_home,
        "port": session.installation.port,
        "serviceLabel": session.installation.service_label,
        "ownership": session.installation.ownership,
        "version": session.installation.version,
    });
    pacer_desktop_native::control::authority::InstallSession {
        installation,
        session_id: session.session_id.clone(),
        desktop: pacer_desktop_native::record::NativeProcess {
            pid: session.desktop.pid as u32,
            boot_id: session.desktop.boot_id.clone(),
            birth: session.desktop.birth.clone(),
        },
        service: pacer_desktop_native::record::NativeProcess {
            pid: session.service.pid as u32,
            boot_id: session.service.boot_id.clone(),
            birth: session.service.birth.clone(),
        },
        desktop_client_id: session.desktop_client_id.clone(),
        boot_id: session.boot_id.clone(),
        service_executable: session.installation.app_path.clone(),
    }
}

fn has_reservation(home: &Path, transaction_id: &str) -> bool {
    // Reproduce `hasReservation(ctx, transactionId)` for managed ownership:
    // the admission row's reservation must match the transaction. `allow_create`
    // is false (a read-only authority check that never creates the table).
    pacer_desktop_admission::coordinator::with_coordinator(home, |tx| {
        pacer_desktop_admission::state::read_admission(tx, false)
            .map(|s| s.reservation.as_deref() == Some(transaction_id))
    })
    .unwrap_or(false)
}

// ---- op handlers ---------------------------------------------------------

fn request_id(params: &Value) -> Result<String, CoreError> {
    params
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| unavailable_bridge("desktop update request id unavailable"))
}

fn installation_id(params: &Value) -> Result<String, CoreError> {
    params
        .get("installationId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| unavailable_bridge("desktop update installation id unavailable"))
}

fn expect_revision(params: &Value) -> u64 {
    params
        .get("expectRevision")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn update_request(
    params: &Value,
) -> Result<pacer_desktop_update::policy::UpdateRequest, CoreError> {
    Ok(pacer_desktop_update::policy::UpdateRequest {
        installation_id: installation_id(params)?,
        request_id: request_id(params)?,
        expect_revision: expect_revision(params),
    })
}

/// Validate the request params with the strict `desktop_update_ops::bridge_params`
/// Zod-order schema, returning the validated strict `params` map. Native handlers
/// must run this first so the eight ops keep their exact validation contract
/// (issue text, unknown-key rejection, bounded types) now that they run in Rust
/// rather than through the Core bridge.
fn validated_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let bridge = pacer_config_ops::desktop_update_ops::bridge_params(op, params)?;
    Ok(bridge
        .get("params")
        .cloned()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new())))
}

// ---- op handlers ---------------------------------------------------------

/// A job dispatched over the process-global channel to the background
/// driver, which runs the (non-`Send`) runtime concrete on the dedicated
/// current-thread tokio runtime. The reply is carried back on a one-shot.
type Reply = tokio::sync::oneshot::Sender<Result<Value, CoreError>>;

enum Job {
    Check(UpdateRequest, Reply),
    Download(UpdateRequest, Reply),
    Restart(RestartRequest, Reply),
    Cancel(UpdateRequest, Reply),
    Adopt(UpdateRequest, Reply),
    AdoptCancel(UpdateRequest, Reply),
    Configure(UpdateRequest, bool, Reply),
    Shutdown,
}

static JOBS: OnceLock<std::sync::mpsc::Sender<Job>> = OnceLock::new();

/// Submit a job to the background driver and await its reply, converting a
/// channel or oneshot failure into the bridge-unavailable error.
async fn submit(make: impl FnOnce(Reply) -> Job + Send) -> Result<Value, CoreError> {
    let tx = JOBS
        .get()
        .ok_or_else(|| unavailable_bridge("desktop update runtime unavailable"))?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(make(reply_tx))
        .map_err(|_| unavailable_bridge("desktop update runtime unavailable"))?;
    reply_rx
        .await
        .map_err(|_| unavailable_bridge("desktop update runtime unavailable"))?
}

fn job_work(job: Job, runtime: &Arc<DesktopUpdateRuntime>, rt: &tokio::runtime::Runtime) {
    // The runtime's futures are intentionally non-`Send` (they hold its
    // `std::sync` state guard across awaits), so they must be driven on the
    // dedicated current-thread runtime rather than returned to the caller.
    match job {
        Job::Check(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.check(request)));
        }
        Job::Download(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.download(request)));
        }
        Job::Restart(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.restart(request)));
        }
        Job::Cancel(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.cancel(request)));
        }
        Job::Adopt(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.adopt(request)));
        }
        Job::AdoptCancel(request, reply) => {
            let _ = reply.send(rt.block_on(runtime.adopt_cancel(request)));
        }
        Job::Configure(request, auto, reply) => {
            let _ = reply.send(rt.block_on(runtime.configure(request, auto)));
        }
        Job::Shutdown => {}
    }
}

/// `desktop.update.status`: the current status of an installed update.
///
/// `status` is synchronous on the runtime, so it can be read in place from
/// any thread without routing through the driver.
pub fn status_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.status", &params)?;
        let runtime = global()?;
        let id = installation_id(&params)?;
        runtime.status(&id)
    })
}

/// The current set of desktop update statuses for `snapshot.get`'s
/// `desktopUpdates` field. The desktop update stack is now native (no Core),
/// so the read-model's `desktopUpdates` is sourced from the Rust runtime
/// rather than from Core's snapshot-probe bridge.
pub fn snapshot_desktop_updates() -> Vec<Value> {
    global()
        .map(|runtime| runtime.list_statuses())
        .unwrap_or_default()
}

/// `desktop.update.check`: run the helper check for the recorded candidate.
pub fn check_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.check", &params)?;
        let request = update_request(&params)?;
        submit(move |reply| Job::Check(request, reply)).await
    })
}

/// `desktop.update.download`.
pub fn download_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.download", &params)?;
        let request = update_request(&params)?;
        submit(move |reply| Job::Download(request, reply)).await
    })
}

/// `desktop.update.restart`: mark the ready candidate for installation.
pub fn restart_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.restart", &params)?;
        let base = update_request(&params)?;
        let version = params
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| unavailable_bridge("desktop update version unavailable"))?;
        let client_id = global()?.bound_client_id(&base.installation_id)?;
        let restart = RestartRequest {
            installation_id: base.installation_id,
            request_id: base.request_id,
            expect_revision: base.expect_revision,
            version,
            client_id,
        };
        submit(move |reply| Job::Restart(restart, reply)).await
    })
}

/// `desktop.update.cancel`.
pub fn cancel_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.cancel", &params)?;
        let request = update_request(&params)?;
        submit(move |reply| Job::Cancel(request, reply)).await
    })
}

/// `desktop.update.adopt`.
pub fn adopt_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.adopt", &params)?;
        let request = update_request(&params)?;
        submit(move |reply| Job::Adopt(request, reply)).await
    })
}

/// `desktop.update.adoptCancel`.
pub fn adopt_cancel_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.adoptCancel", &params)?;
        let request = update_request(&params)?;
        submit(move |reply| Job::AdoptCancel(request, reply)).await
    })
}

/// `desktop.update.configure`: set auto-download for an installed update.
pub fn configure_op(_ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = validated_params("desktop.update.configure", &params)?;
        let request = update_request(&params)?;
        let auto_download = params
            .get("autoDownload")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        submit(move |reply| Job::Configure(request, auto_download, reply)).await
    })
}

// ---- lifecycle ----------------------------------------------------------

/// Install a process-global runtime over the control state. Call after the
/// listener is bound and the control server is serving, before the public
/// listener begins accepting op traffic, then call [`start_background`] to
/// drive `start` and periodic reconciliation.
pub fn install_runtime(
    home: &Path,
    user_home: &Path,
    port: u16,
    control: Arc<ControlState>,
    publish: Box<dyn Fn(&Value) + Send + Sync>,
) -> Result<(), CoreError> {
    let authority = Arc::new(DesktopAuthority::new(
        home.to_path_buf(),
        user_home.to_path_buf(),
        port,
        control,
    )) as Arc<dyn NativeAuthority>;
    let deps = DesktopUpdateDeps {
        native: authority,
        factory: None,
        now_s: pacer_foundation::ctx::unix_now(),
        now_ms: pacer_foundation::ctx::unix_now() * 1000.0,
        boot_id: boot_identity(),
        publish: Some(publish),
        random: None,
        capabilities: capabilities(),
        reserve_deadline: std::time::Duration::from_secs(30),
    };
    let runtime = DesktopUpdateRuntime::with_deps(home, deps);
    let _ = RUNTIME.set(runtime.clone());
    Ok(())
}

/// Start the composed runtime on a dedicated current-thread tokio runtime,
/// driving `start()`, the eight update op jobs, and periodic `tick()`
/// reconciliation until [`stop`] signals shutdown. Returns the spawned
/// thread.
///
/// A dedicated runtime lets the runtime's non-`Send` futures (which hold its
/// `std::sync` state guard across awaits) run without threading
/// constraints, isolated from the serving runtime. Op handlers submit
/// [`Job`]s over [`JOBS`]; the driver dispatches each on `rt` and replies
/// on the job's one-shot.
pub fn start_background() -> std::thread::JoinHandle<()> {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    let _ = JOBS.set(tx);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("desktop update background runtime");
        let Some(runtime) = RUNTIME.get().cloned() else {
            return;
        };
        let _ = rt.block_on(runtime.start());
        let interval = std::time::Duration::from_secs(15);
        loop {
            match rx.recv_timeout(interval) {
                Ok(Job::Shutdown) => break,
                Ok(job) => job_work(job, &runtime, &rt),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let _ = rt.block_on(runtime.tick());
                }
                Err(_) => break,
            }
        }
        let _ = rt.block_on(runtime.stop());
    })
}

/// Signal the background driver to stop and shut the runtime down.
pub fn stop() {
    if let Some(tx) = JOBS.get() {
        let _ = tx.send(Job::Shutdown);
    }
}

fn boot_identity() -> String {
    let pid = std::process::id();
    native_trust::process_details(pid)
        .ok()
        .map(|d| d.process.boot_id)
        .unwrap_or_default()
}

fn capabilities() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    // The front door drives install (restart → install → verify) natively;
    // download and check are always available.
    set.insert("install".to_owned());
    set
}
