//! Runtime tests for the Rust port of `service.ts` (`DesktopUpdateRuntime`,
//! PR B7-DA5). These transcribe the maintainer-binding scenarios from
//! `test/api-desktop-update.test.ts`: a full check → download → restart
//! (commits via the adapter install), late native discovery retrying
//! verification, notification outages retaining update controls, scheduled
//! coordination failure recovering with fresh proof and restart consent, and
//! a failed install not revoking another installation's controls.
//!
//! The composition a top-level `pacer_serve` service would provide is
//! replaced here by a scripted `FakeAuthority` (native surface) and an
//! auto-scripting `PipeFactory` that, for each adapter command, replays the
//! frames a verified helper would: hello, a terminal frame, then clean EOF.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::result_large_err,
    clippy::too_many_arguments,
    clippy::type_complexity
)]
use pacer_desktop_update::adapter::{
    AdapterError, NativeSessionRef, PipeFactory, VerifiedPipe, encode_frame,
};
use pacer_desktop_update::policy::{RestartRequest, UpdateRequest};
use pacer_desktop_update::runtime::{
    DesktopUpdateDeps, DesktopUpdateRuntime, Install, NativeAuthority, NativeSession,
    ProcessIdentity,
};
use pacer_foundation::api::CoreError;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;

const VERSION: (&str, &str, &str) = ("1.0.0", "dev.pacer.desktop", "aarch64");

/// Mirrors the TS fixture candidate (`test/api-desktop-update.test.ts`):
/// version 1.1.0 for a 1.0.0 install, matching the private helper frame
/// schema (`check_candidate`: version/arch/sha256/signature/url/
/// protocolMajors/rollbackCompatible/notes only, all valid).
fn candidate() -> Value {
    json!({
        "version": "1.1.0",
        "arch": "aarch64",
        "sha256": "a".repeat(64),
        "signature": "private-signature",
        "url": "https://example.invalid/private-archive",
        "protocolMajors": [3],
        "rollbackCompatible": true,
        "notes": "New release",
    })
}

fn install(id: &str, ownership: &str, version: &str, home: &std::path::Path) -> Install {
    Install {
        id: id.to_string(),
        app_path: format!("/tmp/{id}.app"),
        bundle_id: "dev.pacer.desktop".to_string(),
        owner_uid: 501,
        arch: "aarch64".to_string(),
        pacer_home: home.to_string_lossy().to_string(),
        port: 7433,
        service_label: "com.pacer.serve".to_string(),
        ownership: ownership.to_string(),
        version: version.to_string(),
    }
}

fn session(install: Install) -> NativeSession {
    let boot = "boot".to_string();
    NativeSession {
        installation: install,
        desktop_client_id: "native-desktop".to_string(),
        session_id: "native".to_string(),
        boot_id: boot.clone(),
        desktop: ProcessIdentity {
            pid: 101,
            boot_id: boot.clone(),
            birth: "1:1".to_string(),
        },
        service: ProcessIdentity {
            pid: 102,
            boot_id: boot.clone(),
            birth: "1:2".to_string(),
        },
        alive: Arc::new(AtomicBool::new(true)),
        closed: Arc::new(tokio::sync::Notify::new()),
    }
}

fn bind(command: &Value, sequence: u64, extra: Value) -> Value {
    let mut m = Map::new();
    for k in [
        "schema",
        "commandId",
        "installationId",
        "transactionId",
        "revision",
        "nonce",
    ] {
        m.insert(
            k.to_string(),
            command.get(k).unwrap_or(&Value::Null).clone(),
        );
    }
    m.insert("sequence".into(), json!(sequence));
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            m.insert(k.clone(), v.clone());
        }
    }
    Value::Object(m)
}

fn avec(entries: &[(&str, Value)]) -> Value {
    let mut m = Map::new();
    for (k, v) in entries {
        m.insert(k.to_string(), v.clone());
    }
    Value::Object(m)
}

/// Records the adapter commands the runtime issued (for "no repeated work"
/// assertions) and the published statuses.
#[derive(Clone, Default)]
struct Trace {
    commands: Arc<Mutex<Vec<String>>>,
    publications: Arc<Mutex<Vec<Value>>>,
}

/// A pipe that, on the first read after the command frame is written,
/// replays `hello`, then a terminal sequence for the command, then EOF.
struct FakePipe {
    command: Option<Value>,
    out: Value,
    armed: bool,
    done: bool,
    trace: Trace,
    steps: std::collections::VecDeque<Vec<u8>>,
}

impl FakePipe {
    fn new(out: Value, trace: Trace) -> Self {
        FakePipe {
            command: None,
            out,
            armed: false,
            done: false,
            trace,
            steps: Default::default(),
        }
    }
    fn seed(&mut self) {
        let cmd = self.command.clone().expect("command sent before reads");
        // The helper echoes the bind's `transactionId` as `reservationId`
        // (the adapter's `prepared` check at adapter.rs requires them equal).
        let tx = cmd.get("transactionId").cloned().unwrap_or(Value::Null);
        let hello = avec(&[
            ("kind", json!("hello")),
            ("version", json!(VERSION.0)),
            ("bundleId", json!(VERSION.1)),
            ("arch", json!(VERSION.2)),
        ]);
        let script: Vec<Value> = match cmd
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "check" => vec![
                hello,
                avec(&[("kind", json!("checked")), ("candidate", candidate())]),
            ],
            "download" => vec![
                hello,
                avec(&[
                    ("kind", json!("downloaded")),
                    ("candidate", candidate()),
                    ("downloadedBytes", json!(10)),
                    ("totalBytes", json!(10)),
                ]),
            ],
            // install / recover: hello, prepared, authorized, outcome, EOF.
            _ => vec![
                hello,
                avec(&[
                    ("kind", json!("prepared")),
                    ("reservationId", tx.clone()),
                    ("journalSha256", "a".repeat(64).into()),
                ]),
                avec(&[
                    ("kind", json!("authorized")),
                    ("reservationId", tx.clone()),
                    ("journalSha256", "a".repeat(64).into()),
                ]),
                avec(&[("kind", json!("outcome")), ("outcome", self.out.clone())]),
            ],
        };
        for (i, frame) in script.into_iter().enumerate() {
            self.steps
                .push_back(encode_frame(&bind(&cmd, i as u64, frame)).unwrap());
        }
    }
}

impl VerifiedPipe for FakePipe {
    fn identity(&self) -> (&str, &str, &str) {
        VERSION
    }
    fn send(
        &mut self,
        frame: &[u8],
    ) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + '_>> {
        let value: Value = serde_json::from_slice(&frame[4..]).unwrap();
        let name = value
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string);
        if name.is_some() {
            self.command = Some(value);
            if let Some(n) = name {
                self.trace.commands.lock().unwrap().push(n);
            }
        }
        Box::pin(async { Ok(()) })
    }
    fn recv(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Option<Vec<u8>>>> + Send + '_>> {
        if !self.armed {
            self.seed();
            self.armed = true;
        }
        if self.done {
            return Box::pin(async { Ok(None) });
        }
        if let Some(bytes) = self.steps.pop_front() {
            return Box::pin(async move { Ok(Some(bytes)) });
        }
        self.done = true;
        Box::pin(async { Ok(None) })
    }
    fn abort(&mut self) {}
}

/// A factory that opens an auto-scripting pipe producing `committed`
/// installs.
#[derive(Clone)]
struct FakePipes {
    trace: Trace,
}

impl PipeFactory for FakePipes {
    fn open(
        &self,
        _session: &NativeSessionRef,
    ) -> Pin<Box<dyn Future<Output = Result<Box<dyn VerifiedPipe>, AdapterError>> + Send + '_>>
    {
        let pipe = Box::new(FakePipe::new(json!("committed"), self.trace.clone()))
            as Box<dyn VerifiedPipe>;
        Box::pin(async move { Ok(pipe) })
    }
}

/// A scriptable native surface. `set_reverify` toggles a global default and
/// `fail_reverify_for` overrides a single installation, mirroring the TS
/// scenarios' temporary `reverify` monkey-patches.
struct FakeAuthority {
    sessions: Arc<Mutex<Vec<NativeSession>>>,
    reverify: Mutex<bool>,
    fail_ids: Arc<Mutex<HashSet<String>>>,
}

impl FakeAuthority {
    fn new(sessions: Vec<NativeSession>) -> Self {
        FakeAuthority {
            sessions: Arc::new(Mutex::new(sessions)),
            reverify: Mutex::new(true),
            fail_ids: Arc::new(Mutex::new(HashSet::new())),
        }
    }
    fn set_reverify(&self, ok: bool) {
        *self.reverify.lock().unwrap() = ok;
    }
    fn fail_reverify_for(&self, id: &str, fail: bool) {
        let mut set = self.fail_ids.lock().unwrap();
        if fail {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
    }
    fn set_sessions(&self, sessions: Vec<NativeSession>) {
        *self.sessions.lock().unwrap() = sessions;
    }
}

impl NativeAuthority for FakeAuthority {
    fn sessions(&self) -> Vec<NativeSession> {
        self.sessions.lock().unwrap().clone()
    }
    fn subscribe(
        &self,
        _on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Option<Box<dyn Fn() + Send + Sync>> {
        None
    }
    fn reverify(
        &self,
        session: &NativeSession,
    ) -> Pin<Box<dyn Future<Output = Result<(), CoreError>> + Send + '_>> {
        let ok = *self.reverify.lock().unwrap()
            && !self
                .fail_ids
                .lock()
                .unwrap()
                .contains(&session.installation.id);
        Box::pin(async move {
            if ok {
                Ok(())
            } else {
                Err(CoreError::new(
                    pacer_foundation::api::Code::NotAllowed,
                    "not verified",
                ))
            }
        })
    }
    fn authorize_install(
        &self,
        _session: &NativeSession,
        _record: &Value,
        _prepared: &Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, CoreError>> + Send + '_>> {
        Box::pin(async { Ok(true) })
    }
    fn verify_install_outcome(
        &self,
        _session: &NativeSession,
        _record: &Value,
        _outcome: &str,
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

struct Harness {
    runtime: Arc<DesktopUpdateRuntime>,
    authority: Arc<FakeAuthority>,
    trace: Trace,
    _home: TempDir,
}

fn harness(home: TempDir, sessions: Vec<NativeSession>) -> Harness {
    let trace = Trace::default();
    let authority = Arc::new(FakeAuthority::new(sessions));
    let pipes = Arc::new(FakePipes {
        trace: trace.clone(),
    });
    let now_s = pacer_foundation::ctx::unix_now() as u64 as f64;
    let now_ms = now_s * 1000.0;
    let deps = DesktopUpdateDeps {
        native: authority.clone(),
        factory: Some(pipes),
        now_s,
        now_ms,
        boot_id: "boot".to_string(),
        publish: Some(Box::new({
            let trace = trace.clone();
            move |v: &Value| {
                trace.publications.lock().unwrap().push(v.clone());
            }
        })),
        random: Some(0.0),
        capabilities: ["check", "download", "install", "recover"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        reserve_deadline: Duration::from_secs(30),
    };
    let runtime = DesktopUpdateRuntime::with_deps(home.path(), deps);
    Harness {
        runtime,
        authority,
        trace,
        _home: home,
    }
}

async fn settle(r: &Arc<DesktopUpdateRuntime>) {
    for _ in 0..10 {
        let _ = r.tick().await;
        tokio::task::yield_now().await;
    }
}

fn managed(home: &std::path::Path, id: &str, version: &str) -> NativeSession {
    session(install(id, "managed", version, home))
}

fn actions(st: &Value) -> Vec<Value> {
    st.get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
fn phase(st: &Value) -> &str {
    st.get("phase").and_then(Value::as_str).unwrap_or_default()
}
fn error_code(st: &Value) -> Option<&str> {
    st.pointer("/error/code").and_then(Value::as_str)
}

/// `request(id)` mirrors the TS fixture: `expectRevision` is always the
/// current persisted revision of the target installation, never a hardcoded
/// value, so a request following `start`-time reconciliation uses the
/// post-start revision.
fn request_for(st: &Value, installation_id: &str, request_id: &str) -> UpdateRequest {
    let revision = st.get("revision").and_then(Value::as_u64).unwrap_or(0);
    UpdateRequest {
        installation_id: installation_id.to_string(),
        request_id: request_id.to_string(),
        expect_revision: revision,
    }
}

/// `ready()` mirrors the TS `fixture().ready()`: start, check, settle,
/// then an explicit download when the automatic download was opted out.
async fn ready(r: &Arc<DesktopUpdateRuntime>) {
    r.start().await.unwrap();
    let mut st = r.status("desktop").unwrap();
    if !actions(&st).contains(&json!("check")) {
        return;
    }
    r.check(request_for(&st, "desktop", "check")).await.unwrap();
    settle(r).await;
    st = r.status("desktop").unwrap();
    if phase(&st) != "ready" {
        r.download(request_for(&st, "desktop", "download"))
            .await
            .unwrap();
        settle(r).await;
    }
}

fn restart(id: &str, request_id: &str, revision: u64, version: &str) -> RestartRequest {
    RestartRequest {
        installation_id: id.to_string(),
        request_id: request_id.to_string(),
        expect_revision: revision,
        version: version.to_string(),
        client_id: "native-desktop".to_string(),
    }
}

// TS "automatic download reaches ready; public restart derives the verified
// native client and commits after outcome proof" (lines 253-260): `ready()`
// reaches `ready`, and a restart with the current revision reserves,
// installs through the adapter and commits after the outcome proof.
#[tokio::test]
async fn automatic_download_reaches_ready_and_restart_commits() {
    let home = TempDir::new().unwrap();
    let d_root = home.path().to_owned();
    let f = harness(home, vec![managed(&d_root, "desktop", "1.0.0")]);
    ready(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    assert_eq!(phase(&st), "ready", "ready() must reach ready");
    let revision = st.get("revision").and_then(Value::as_u64).unwrap_or(0);
    f.runtime
        .restart(restart("desktop", "restart", revision, "1.1.0"))
        .await
        .unwrap();
    settle(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    assert_eq!(phase(&st), "complete", "install must commit");
    assert_eq!(error_code(&st), None);
    // Publication equality: the `desktop.update` entity is published for the
    // whole check → download → restart journey, reaching `ready` before the
    // terminal `complete` (times normalized out of the assertion).
    let pub_phases: Vec<String> = f
        .trace
        .publications
        .lock()
        .unwrap()
        .iter()
        .filter_map(|v| v.get("phase").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert!(!pub_phases.is_empty(), "desktop.update must be published");
    let i_ready = pub_phases
        .iter()
        .position(|p| p == "ready")
        .expect("publishes a ready (downloadable) state");
    let i_complete = pub_phases
        .iter()
        .position(|p| p == "complete")
        .expect("publishes the committed state");
    assert!(
        i_ready < i_complete,
        "ready must be published before complete"
    );
    let cmds = f.trace.commands.lock().unwrap().clone();
    assert!(cmds.contains(&"check".to_string()));
    assert!(cmds.contains(&"download".to_string()));
    assert!(cmds.contains(&"install".to_string()));
    assert!(!cmds.contains(&"recover".to_string()));
}

// TS "late native discovery retries failed verification without enabling
// mutations" (lines 71-87): with no native session an operation is refused;
// once discovered, a failing reverify still rejects `check` with
// `not_allowed` and runs no adapters; a later reverify success re-enables
// the check action and exactly one check is issued.
#[tokio::test]
async fn late_native_discovery_retries_failed_verification() {
    let home = TempDir::new().unwrap();
    let f = harness(home, vec![]);
    f.runtime.start().await.unwrap();
    // No native session yet. Late discovery with reverify failing yields no
    // actions and refuses check.
    f.authority
        .set_sessions(vec![managed(f._home.path(), "desktop", "1.0.0")]);
    f.authority.set_reverify(false);
    f.runtime.tick().await.unwrap();
    let st = f.runtime.status("desktop").unwrap();
    assert!(
        actions(&st).is_empty(),
        "no actions while verification fails"
    );
    let err = f
        .runtime
        .check(request_for(&st, "desktop", "unverified"))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        pacer_foundation::api::Code::NotAllowed,
        "check must be refused while unverified"
    );
    assert!(f.trace.commands.lock().unwrap().is_empty());
    // A later reverify success re-enables the check action and one check runs.
    f.authority.set_reverify(true);
    f.runtime.tick().await.unwrap();
    let st = f.runtime.status("desktop").unwrap();
    assert!(actions(&st).contains(&json!("check")));
    f.runtime
        .check(request_for(&st, "desktop", "verified"))
        .await
        .unwrap();
    settle(&f.runtime).await;
    let cmds = f.trace.commands.lock().unwrap().clone();
    assert_eq!(cmds.iter().filter(|c| c.as_str() == "check").count(), 1);
}

// TS "scheduled coordination failure recovers with fresh proof and fresh
// restart consent" (lines 108-132): a scheduled observation failure marks
// `coordination_failed`, refuses further operations, and a fresh reverify
// restores `ready` and restart consent; a fresh restart then re-runs install
// exactly once to `complete`.
#[tokio::test]
async fn coordination_failure_recovers_with_fresh_restart_consent() {
    let home = TempDir::new().unwrap();
    let sessions = vec![managed(home.path(), "desktop", "1.0.0")];
    let f = harness(home, sessions);
    ready(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    let revision = st.get("revision").and_then(Value::as_u64).unwrap_or(0);
    f.runtime
        .restart(restart("desktop", "restart", revision, "1.1.0"))
        .await
        .unwrap();
    // Force the scheduled observation to fail.
    f.authority.set_reverify(false);
    f.runtime.tick().await.unwrap();
    let st = f.runtime.status("desktop").unwrap();
    assert_eq!(error_code(&st), Some("coordination_failed"));
    assert!(actions(&st).is_empty());
    let err = f
        .runtime
        .check(request_for(&st, "desktop", "unsafe-check"))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        pacer_foundation::api::Code::NotAllowed,
        "check must be refused during coordination_failed"
    );
    // Fresh verification restores ready and restart consent.
    f.authority.set_reverify(true);
    f.runtime.tick().await.unwrap();
    settle(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    assert_eq!(error_code(&st), None);
    assert_eq!(phase(&st), "ready", "fresh proof must restore ready");
    assert!(
        actions(&st).contains(&json!("restart")),
        "restart consent restored"
    );
    // A fresh restart with fresh consent re-runs install exactly once.
    let revision = st.get("revision").and_then(Value::as_u64).unwrap_or(0);
    let installs_before = f
        .trace
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "install")
        .count();
    f.runtime
        .restart(restart("desktop", "fresh-restart", revision, "1.1.0"))
        .await
        .unwrap();
    settle(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    assert_eq!(phase(&st), "complete");
    let cmds = f.trace.commands.lock().unwrap().clone();
    let installs = cmds.iter().filter(|c| c.as_str() == "install").count();
    assert_eq!(
        installs,
        installs_before + 1,
        "fresh restart must re-run install exactly once"
    );
}

// TS "a failed installation does not revoke another installation's
// controls" (lines 153-170): only the failing installation loses its
// actions while the other keeps `check` and can still reach `ready`.
#[tokio::test]
async fn failed_install_does_not_revoke_another_installations_controls() {
    let home = TempDir::new().unwrap();
    let sessions = vec![
        managed(home.path(), "desktop", "1.0.0"),
        session(install("other-desktop", "managed", "1.0.0", home.path())),
    ];
    let f = harness(home, sessions);
    ready(&f.runtime).await;
    // Bring "desktop" to ready too (both reach ready via ready() against
    // "desktop"; the check action exists on the other installation).
    let st = f.runtime.status("desktop").unwrap();
    let revision = st.get("revision").and_then(Value::as_u64).unwrap_or(0);
    f.runtime
        .restart(restart("desktop", "restart", revision, "1.1.0"))
        .await
        .unwrap();
    // Fail verification only for "desktop".
    f.authority.fail_reverify_for("desktop", true);
    f.runtime.tick().await.unwrap();
    settle(&f.runtime).await;
    let st = f.runtime.status("desktop").unwrap();
    assert!(
        actions(&st).is_empty(),
        "failing installation keeps no actions"
    );
    let st = f.runtime.status("other-desktop").unwrap();
    assert!(
        actions(&st).contains(&json!("check")),
        "other installation keeps its own controls"
    );
    // The other installation can still check and reach ready.
    f.runtime
        .check(request_for(&st, "other-desktop", "other-check"))
        .await
        .unwrap();
    settle(&f.runtime).await;
    let st = f.runtime.status("other-desktop").unwrap();
    assert_eq!(
        phase(&st),
        "ready",
        "other installation still reaches ready"
    );
}
