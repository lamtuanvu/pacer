#![allow(clippy::unwrap_used)]
//! Remote admission and START release (M2 R2/R3/R6) through the trusted direct path.
use pacer_plugin_runtime::{
    AuthorityError, BrokerError, NativeGit, NativeSsh, RemoteHost, RemoteOperation,
    RemoteTransport, SshConfig, WorkLease,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering::SeqCst},
        mpsc,
    },
    time::{Duration, Instant},
};

const ID: &str = "t-20261103-074231-96bf";
const START_DENIED: &str = "configured remote start changed or was not issued";
const NATIVE_DENIED: &str = "host command identity, input or output changed";
const FAKE_SSH: &str = r##"#!/usr/bin/env python3
import os,re,shlex,sys,time,json
fx=os.environ['FIXTURE_ROOT']
open(os.path.join(fx,'executions'),'a').write('exec\n')
mode=open(os.path.join(fx,'mode')).read().strip()
words=shlex.split(sys.argv[-1]);program=words[2];args=words[4:]
nonce=re.findall(r'__PACER_DONE__=([a-f0-9-]{36})',program)
data=sys.stdin.buffer.read()
start=len(args)>2 and args[2]=='pipe'
if start:
    session=[a.split('=',1)[1] for a in args if a.startswith('PACER_COMPLETION_NONCE=')]
    json.dump({'nonce':session,'receipt':nonce,'stdin':len(data),'args':args},open(os.path.join(fx,'start.json'),'w'))
if mode=='exit255': sys.exit(255)
if mode=='ready-sleep':
    open(os.path.join(fx,'ready.tmp'),'w').write(str(os.getpid()))
    os.rename(os.path.join(fx,'ready.tmp'),os.path.join(fx,'ready'))
    end=time.time()+30
    while time.time()<end: time.sleep(0.02)
    sys.exit(0)
if mode=='flip': open(os.path.join(fx,'flip'),'w').write('1')
if mode=='receipt-chmod': os.chmod(open(os.path.join(fx,'admission-dir')).read(),0o755)
body='pid=4242\n' if start else 'code=0\nkilled=0\n'
receipt='' if mode=='noreceipt' else '\n__PACER_DONE__='+nonce[0]+'\n'
sys.stdout.write('__PACER_BEGIN__\n'+body+receipt)
"##;

fn oracle(rows: Value, home: &Path) -> Vec<Value> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("bun")
        .arg("test/fixtures/remote-start-oracle.ts")
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home)
        .env("PACER_HOME", home)
        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!({ "rows": rows }).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
/// Exact normalized HostCfg bytes from actual `parseHosts` (no reduced fingerprint).
fn hosts() -> &'static (String, String, String) {
    static HOSTS: OnceLock<(String, String, String)> = OnceLock::new();
    HOSTS.get_or_init(|| {
        let home = Owned::new("pacer-remote-host-config");
        let out = oracle(
            json!([
                {"name":"configured","mode":"host-config","host":{"ssh":"fixture-host","session":"recording"}},
                {"name":"paused","mode":"host-config","host":{"ssh":"fixture-host","session":"recording","paused":true}},
                {"name":"full","mode":"host-config","host":{"ssh":"fixture-host","session":"full"}},
            ]),
            &home.0,
        );
        let text = |i: usize| out[i]["json"].as_str().unwrap().to_owned();
        assert_eq!(
            serde_json::from_str::<Value>(&text(0)).unwrap(),
            json!({"alias":"box","ssh":"fixture-host","repos":{},"maxTasks":2,"accounts":{},"session":"recording","paused":false})
        );
        (text(0), text(1), text(2))
    })
}
fn configured() -> String {
    hosts().0.clone()
}

struct Owned(PathBuf);
impl Owned {
    fn new(prefix: &str) -> Self {
        let p = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

type Act = Arc<dyn Fn(usize) -> String + Send + Sync>;
struct Fx {
    root: PathBuf,
    home: PathBuf,
    fx: PathBuf,
    repo: PathBuf,
    ssh: PathBuf,
    calls: Arc<AtomicUsize>,
    before: Value,
    c0: u32,
}
impl Drop for Fx {
    fn drop(&mut self) {
        use sha2::{Digest, Sha256};
        // NativeSsh::prepare's fallback control directory for this long owned home.
        let control = PathBuf::from(format!(
            "/tmp/pacer-ssh-{}-{}",
            nix::unistd::Uid::current(),
            &format!(
                "{:x}",
                Sha256::digest(self.home.as_os_str().as_encoded_bytes())
            )[..16]
        ));
        if self
            .home
            .join("ssh")
            .join(format!("cm-{}", "f".repeat(40)))
            .as_os_str()
            .len()
            >= 104
        {
            let _ = fs::remove_dir(control);
        }
        let _ = fs::set_permissions(
            self.home.join("desktop-updates"),
            fs::Permissions::from_mode(0o700),
        );
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fx {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("pacer-remote-admission-{}", uuid::Uuid::new_v4()));
        dir(&root);
        let root = fs::canonicalize(root).unwrap();
        let home = root.join("home");
        let fx = root.join("fx");
        dir(&home);
        dir(&fx);
        dir(&home.join("runs"));
        dir(&home.join("runs").join(ID));
        dir(&home.join("runs").join(ID).join("1"));
        let repo = root.join("repo");
        dir(&repo);
        assert!(
            Command::new("/usr/bin/git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .env_clear()
                .env("HOME", &root)
                .status()
                .unwrap()
                .success()
        );
        let ssh = root.join("fake-ssh");
        fs::write(&ssh, FAKE_SSH).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(fx.join("mode"), "ok").unwrap();
        fs::write(
            fx.join("admission-dir"),
            home.join("desktop-updates").to_str().unwrap(),
        )
        .unwrap();
        let mut f = Self {
            root,
            home,
            fx,
            repo,
            ssh,
            calls: Arc::new(AtomicUsize::new(0)),
            before: Value::Null,
            c0: 0,
        };
        f.seed_unrelated();
        f
    }
    fn database(&self) -> PathBuf {
        self.home.join("desktop-updates/admission.sqlite")
    }
    fn state(&self) -> Value {
        let db = rusqlite::Connection::open_with_flags(
            self.database(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let raw: String = db
            .query_row("SELECT state FROM admission WHERE id=1", [], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn commits(&self) -> u32 {
        fs::read(self.database())
            .ok()
            .filter(|b| b.len() >= 28)
            .map_or(0, |b| u32::from_be_bytes([b[24], b[25], b[26], b[27]]))
    }
    fn write_state(&self, state: &Value) {
        let mut db = rusqlite::Connection::open(self.database()).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute(
            "UPDATE admission SET state=? WHERE id=1",
            [state.to_string()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    /// U1 (same incarnation) and U2 (foreign owner), with the +1 counter calibration.
    fn seed_unrelated(&mut self) {
        WorkLease::begin(&self.home, "unrelated-task", "Unrelated session").unwrap();
        let journal: String = rusqlite::Connection::open(self.database())
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal, "delete");
        let mut state = self.state();
        state["leases"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":uuid::Uuid::new_v4().to_string(),
            "blocker":{"kind":"task","id":"foreign","label":"Foreign"},
            "owner":uuid::Uuid::new_v4().to_string(),"process":null,"state":"pending"}));
        let c = self.commits();
        self.write_state(&state);
        assert_eq!(self.commits(), c + 1, "header change counter calibration");
        self.recalibrate();
    }
    fn recalibrate(&mut self) {
        self.before = self.state();
        self.c0 = self.commits();
    }
    fn mode(&self, mode: &str) {
        fs::write(self.fx.join("mode"), mode).unwrap();
    }
    fn executions(&self) -> usize {
        fs::read_to_string(self.fx.join("executions"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }
    fn delta(&self) -> u32 {
        self.commits() - self.c0
    }
    fn ssh_env(&self) -> HashMap<String, String> {
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), self.root.to_str().unwrap().into()),
            ("FIXTURE_ROOT".into(), self.fx.to_str().unwrap().into()),
        ])
    }
    fn transport_with(&self, executable: &Path, deadline: Instant, act: Act) -> RemoteTransport {
        let ssh = NativeSsh::prepare(
            &self.home,
            SshConfig {
                alias: "box".into(),
                target: "fixture-host".into(),
                fingerprint: configured(),
            },
            executable.to_str().unwrap(),
            self.ssh_env(),
        )
        .unwrap();
        let git = NativeGit::prepare(
            &self.root,
            &self.repo,
            "/usr/bin/git",
            &HashMap::from([
                ("PATH".into(), std::env::var("PATH").unwrap()),
                ("HOME".into(), self.root.to_str().unwrap().into()),
            ]),
        )
        .unwrap();
        let calls = self.calls.clone();
        RemoteTransport::new(&self.home, ssh, git, deadline, move || {
            act(calls.fetch_add(1, SeqCst) + 1)
        })
    }
    fn transport(&self, deadline: Instant, act: Act) -> RemoteTransport {
        self.transport_with(&self.ssh, deadline, act)
    }
    fn calls(&self) -> usize {
        self.calls.load(SeqCst)
    }
    fn remote(&self) -> String {
        format!("/remote/.pacer-remote/runs/{ID}/1")
    }
    fn local(&self) -> String {
        self.home
            .join("runs")
            .join(ID)
            .join("1")
            .to_str()
            .unwrap()
            .into()
    }
    fn stop(&self) -> Value {
        json!({"taskId":ID,"intent":{"hostFingerprint":configured(),"alias":"box"},
            "run":{"remoteDir":self.remote()},"extra":{"graceMs":1000}})
    }
    fn start(&self, launch: Value) -> Value {
        self.start_at(&self.remote(), "/remote/work", launch)
    }
    fn start_at(&self, remote: &str, workdir: &str, launch: Value) -> Value {
        json!({"taskId":ID,"intent":{"hostFingerprint":configured(),"alias":"box","attempt":1},
            "run":{"host":"box","mode":"new","remoteDir":remote,"dir":self.local(),"workdir":workdir,"attempt":1},
            "launch":launch})
    }
    fn admission(&self) -> Option<Value> {
        fs::read(Path::new(&self.local()).join("admission.json"))
            .ok()
            .map(|b| serde_json::from_slice(&b).unwrap())
    }
    /// Rows added since `before`; U1 and U2 must remain value-equal.
    fn added(&self) -> Vec<Value> {
        let after = self.state();
        let before = self.before["leases"].as_array().unwrap();
        for row in before {
            assert!(
                after["leases"].as_array().unwrap().contains(row),
                "unrelated lease changed: {row}"
            );
        }
        after["leases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| !before.contains(l))
            .cloned()
            .collect()
    }
    fn assert_equal(&self) {
        assert_eq!(self.state(), self.before);
    }
}
fn fingerprint() -> Act {
    Arc::new(|_| configured())
}
fn op_row(row: &Value, op: &str) {
    assert_eq!(row["blocker"]["kind"], "operation");
    assert_eq!(
        row["blocker"]["label"],
        format!("Remote {op} operation on box")
    );
    assert_ne!(row["blocker"]["id"], row["id"]);
    assert!(uuid::Uuid::parse_str(row["blocker"]["id"].as_str().unwrap()).is_ok());
    assert_eq!(row["process"], Value::Null);
    assert_eq!(row["state"], "pending");
}
fn session_row(f: &Fx, row: &Value, remote: &str) {
    use sha2::{Digest, Sha256};
    assert_eq!(row["blocker"]["kind"], "session");
    assert_eq!(
        row["blocker"]["id"],
        format!("{:x}", Sha256::digest(format!("box:{remote}").as_bytes()))
    );
    assert_eq!(row["blocker"]["label"], "Remote session on box");
    assert_eq!(row["runDir"], f.local());
    assert_eq!(row["remote"], json!({"host":"box","dir":remote}));
}
fn by_kind<'a>(rows: &'a [Value], kind: &str) -> Vec<&'a Value> {
    rows.iter()
        .filter(|r| r["blocker"]["kind"] == kind)
        .collect()
}
fn native_denied(e: &BrokerError) -> bool {
    matches!(e, BrokerError::Authority(AuthorityError::Denied(m)) if m == NATIVE_DENIED)
}
/// `Image::check` denial raised by the tracked SSH pin validation in `argv`.
fn image_denied(e: &BrokerError) -> bool {
    matches!(e, BrokerError::Authority(AuthorityError::Denied(m)) if m == "provider command image or context changed")
}
fn start_denied(e: &BrokerError) -> bool {
    matches!(e, BrokerError::Authority(AuthorityError::Denied(m)) if m == START_DENIED)
}
fn soon() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
fn launch() -> Value {
    json!({"argv":["agent"],"env":{},"stdin":""})
}
fn wait_until(at: Instant) {
    while Instant::now() < at {
        std::thread::sleep(Duration::from_millis(5));
    }
}
/// Null-signal probe until `ESRCH`. Awaits between probes so the current-thread
/// runtime keeps polling Tokio's orphan reaper; a zombie leader still counts as present.
async fn group_gone(pgid: i32) {
    use nix::{errno::Errno, sys::signal::killpg, unistd::Pid};
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        match killpg(Pid::from_raw(pgid), None) {
            Err(Errno::ESRCH) => return,
            _ if Instant::now() > until => panic!("owned group {pgid} survived"),
            _ => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    }
}
#[tokio::test]
async fn a_stop_receipt_releases_its_operation() {
    let f = Fx::new();
    let mut t = f.transport(soon(), fingerprint());
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await.unwrap();
    assert_eq!(r, json!({"code":0,"killed":false}));
    f.assert_equal();
    assert_eq!((f.delta(), f.calls(), f.executions()), (2, 4, 1));
}

#[tokio::test]
async fn b_lock_held_past_deadline_is_classified_by_the_post_begin_check() {
    let f = Fx::new();
    let (locked_tx, locked_rx) = mpsc::channel();
    let (pre_tx, pre_rx) = mpsc::channel::<()>();
    let database = f.database();
    let deadline_cell: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let holder_deadline = deadline_cell.clone();
    let holder = std::thread::spawn(move || {
        let db = rusqlite::Connection::open(&database).unwrap();
        db.busy_timeout(Duration::ZERO).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let read = || {
            let b = fs::read(&database).unwrap();
            u32::from_be_bytes([b[24], b[25], b[26], b[27]])
        };
        let c0 = read();
        locked_tx.send(c0).unwrap();
        let d = loop {
            if let Some(d) = *holder_deadline.lock().unwrap() {
                break d;
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        pre_rx
            .recv_timeout((d + Duration::from_secs(3)).saturating_duration_since(Instant::now()))
            .unwrap();
        wait_until(d + Duration::from_millis(20));
        let c1 = read();
        db.execute_batch("ROLLBACK").unwrap();
        (c0, c1)
    });
    let c0 = locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let d = Instant::now() + Duration::from_millis(1500);
    *deadline_cell.lock().unwrap() = Some(d);
    let pre = Mutex::new(Some(pre_tx));
    let act: Act = Arc::new(move |n| {
        if n == 2
            && let Some(tx) = pre.lock().unwrap().take()
        {
            tx.send(()).unwrap();
        }
        configured()
    });
    let mut t = f.transport(d, act);
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    let (c0h, c1) = holder.join().unwrap();
    assert_eq!(c0h, c0);
    assert_eq!(c1, c0, "begin committed while the lock was held");
    assert!(matches!(r, Err(BrokerError::Timeout)), "{r:?}");
    f.assert_equal();
    assert_eq!(f.commits() - c0, 2);
    assert_eq!(f.calls(), 3);
}

#[tokio::test]
async fn c_post_begin_host_change_releases_the_operation() {
    let f = Fx::new();
    let act: Act = Arc::new(|n| if n == 3 { "other".into() } else { configured() });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    f.assert_equal();
    assert_eq!((f.delta(), f.calls(), f.executions()), (2, 3, 0));
}

#[tokio::test]
async fn d_e_dispatched_failures_retain_the_operation() {
    for (mode, effect) in [("exit255", true), ("noreceipt", false)] {
        let f = Fx::new();
        f.mode(mode);
        let mut t = f.transport(soon(), fingerprint());
        let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
        if effect {
            assert!(
                matches!(&r, Err(BrokerError::Effect(m)) if m == "SSH connection failed"),
                "{r:?}"
            );
        } else {
            assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
        }
        let added = f.added();
        assert_eq!(added.len(), 1, "{mode}");
        op_row(&added[0], "stop");
        assert_eq!(f.delta(), 1, "{mode}");
    }
}

#[tokio::test]
async fn f_receipt_releases_before_post_run_revalidation() {
    let f = Fx::new();
    f.mode("flip");
    let flip = f.fx.join("flip");
    let act: Act = Arc::new(move |n| {
        if n == 4 && flip.exists() {
            "other".into()
        } else {
            configured()
        }
    });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    f.assert_equal();
    assert_eq!((f.delta(), f.calls()), (2, 4));
}

#[tokio::test]
async fn g_spawn_call_error_is_dispatched_and_retained() {
    let f = Fx::new();
    let absent = f.root.join("absent-ssh");
    fs::write(&absent, "#!/nonexistent-pacer-fixture/interpreter\n").unwrap();
    fs::set_permissions(&absent, fs::Permissions::from_mode(0o700)).unwrap();
    let mut t = f.transport_with(&absent, soon(), fingerprint());
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    let added = f.added();
    assert_eq!(added.len(), 1);
    op_row(&added[0], "stop");
    assert_eq!((f.delta(), f.calls()), (1, 3));
    // Not proof of non-dispatch; recorded only.
    assert_eq!(f.executions(), 0);
}

#[tokio::test]
async fn h_pre_dispatch_finish_error_wins_and_retains() {
    let f = Fx::new();
    let d = Instant::now() + Duration::from_millis(1000);
    let updates = f.home.join("desktop-updates");
    let act: Act = Arc::new(move |n| {
        if n == 3 {
            fs::set_permissions(&updates, fs::Permissions::from_mode(0o755)).unwrap();
            wait_until(d);
        }
        configured()
    });
    let mut t = f.transport(d, act);
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    fs::set_permissions(
        f.home.join("desktop-updates"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let added = f.added();
    assert_eq!(added.len(), 1);
    op_row(&added[0], "stop");
    assert_eq!((f.delta(), f.calls(), f.executions()), (1, 3, 0));
}

#[tokio::test]
async fn i_receipt_finish_error_wins_and_retains() {
    let f = Fx::new();
    f.mode("receipt-chmod");
    let mut t = f.transport(soon(), fingerprint());
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    fs::set_permissions(
        f.home.join("desktop-updates"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let added = f.added();
    assert_eq!(added.len(), 1);
    op_row(&added[0], "stop");
    assert_eq!((f.delta(), f.calls(), f.executions()), (1, 3, 1));
}

#[tokio::test]
async fn j_start_success_keeps_session_and_releases_operation() {
    let f = Fx::new();
    let mut t = f.transport(soon(), fingerprint());
    let r = t
        .invoke(RemoteOperation::Start, &f.start(launch()))
        .await
        .unwrap();
    assert_eq!(r, json!({"pid":4242}));
    let added = f.added();
    assert_eq!(added.len(), 1);
    session_row(&f, &added[0], &f.remote());
    let session = added[0]["id"].as_str().unwrap();
    let start: Value = serde_json::from_slice(&fs::read(f.fx.join("start.json")).unwrap()).unwrap();
    assert_eq!(start["nonce"], json!([session]));
    assert_ne!(start["receipt"][0], session);
    assert_eq!(
        f.admission().unwrap(),
        json!({"lease":session,"host":"box","remoteDir":f.remote()})
    );
    assert_eq!((f.delta(), f.calls(), f.executions()), (4, 5, 1));
}

#[tokio::test]
async fn k_env_key_precheck_precedes_admission_like_typescript() {
    let f = Fx::new();
    let mut t = f.transport(soon(), fingerprint());
    let r = t
        .invoke(
            RemoteOperation::Start,
            &f.start(json!({"argv":["agent"],"env":{"1A":"x"},"stdin":""})),
        )
        .await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    f.assert_equal();
    assert_eq!((f.delta(), f.calls()), (0, 1));
    assert!(f.admission().is_none());
    let ts = &oracle(
        json!([{"name":"k","mode":"start","env":{"1A":"x"}}]),
        &Owned::new("pacer-remote-oracle").0,
    )[0];
    assert_eq!(ts["admissionJson"], json!({"kind":"absent"}));
    assert_eq!(ts["leases"], json!([]));
    assert!(
        ts["error"]
            .as_str()
            .unwrap()
            .starts_with("invalid environment key")
    );
}

#[tokio::test]
async fn l_reservation_wins_over_invalid_start_like_typescript() {
    let mut f = Fx::new();
    let mut state = f.state();
    state["reservation"] = json!("txn");
    f.write_state(&state);
    f.recalibrate();
    let long = "a".repeat(1025);
    let mut t = f.transport(soon(), fingerprint());
    let r = t
        .invoke(
            RemoteOperation::Start,
            &f.start(json!({"argv":[long],"env":{},"stdin":""})),
        )
        .await;
    let reserved = "Desktop update maintenance is reserved";
    assert!(
        matches!(&r, Err(BrokerError::Effect(m)) if m == reserved),
        "{r:?}"
    );
    f.assert_equal();
    assert_eq!(f.delta(), 0);
    assert!(f.admission().is_none());
    let ts = &oracle(
        json!([{"name":"l","mode":"start","reservation":"txn","argv":[long]}]),
        &Owned::new("pacer-remote-oracle").0,
    )[0];
    assert_eq!(ts["error"], reserved);
    assert_eq!(ts["admissionJson"], json!({"kind":"absent"}));
}

/// Typed-valid rows that the actual issuer rejects (non-full constructor host).
fn m_rows() -> Vec<(&'static str, Value, Value)> {
    let tail = format!("/.pacer-remote/runs/{ID}/1");
    let env10: serde_json::Map<String, Value> =
        (0..10).map(|i| (format!("K{i}"), json!("v"))).collect();
    let room =
        52_428_800 - include_str!("../../plugin-execution/src/native_run/wrapper.sh").len() - 16;
    vec![
        (
            "argv-1025",
            json!({"argv":["a".repeat(1025)],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "emoji-513",
            json!({"argv":["\u{1F600}".repeat(513)],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "env-1023",
            json!({"argv":["x"],"env":{"K":"v".repeat(1023)},"stdin":""}),
            json!({}),
        ),
        (
            "count-26",
            json!({"argv":(0..9).map(|i| format!("a{i}")).collect::<Vec<_>>(),"env":env10,"stdin":""}),
            json!({}),
        ),
        (
            "argv-empty",
            json!({"argv":[],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "argv-tab",
            json!({"argv":["a\tb"],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "argv-nul",
            json!({"argv":["a\0b"],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "env-newline",
            json!({"argv":["x"],"env":{"K":"a\nb"},"stdin":""}),
            json!({}),
        ),
        (
            "argv-del",
            json!({"argv":["a\u{7f}b"],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "remote-ls",
            launch(),
            json!({"remote":format!("/re\u{2028}mote{tail}")}),
        ),
        (
            "remote-cr",
            launch(),
            json!({"remote":format!("/re\rmote{tail}")}),
        ),
        (
            "remote-tab",
            launch(),
            json!({"remote":format!("/re\tmote{tail}")}),
        ),
        (
            "remote-double",
            launch(),
            json!({"remote":format!("/x/{tail}")}),
        ),
        ("workdir-double", launch(), json!({"workdir":"/a//b"})),
        (
            "input-over",
            json!({"argv":["x"],"env":{},"stdin":"s".repeat(room + 1)}),
            json!({}),
        ),
        ("host-paused", launch(), json!({"paused":true})),
        (
            "remote-attempt-01",
            launch(),
            json!({"remote":format!("/remote/.pacer-remote/runs/{ID}/01")}),
        ),
        (
            "remote-wrong-task",
            launch(),
            json!({"remote":"/remote/.pacer-remote/runs/t-19000101-000000-abcd/1"}),
        ),
        // `run.attempt` 1 against remote attempt 2; the TS row seeds it explicitly.
        (
            "run-attempt-mismatch",
            launch(),
            json!({"remote":format!("/remote/.pacer-remote/runs/{ID}/2"),"runAttempt":1}),
        ),
    ]
}

#[tokio::test]
async fn m_typed_valid_issuance_rejections_leave_stale_admission_and_match_typescript() {
    let mut ts_rows = vec![];
    for (name, launch, over) in m_rows() {
        let f = Fx::new();
        let remote = over["remote"].as_str().map_or(f.remote(), str::to_owned);
        let workdir = over["workdir"].as_str().unwrap_or("/remote/work");
        let paused = over["paused"] == true;
        let act: Act = Arc::new(move |n| {
            if n == 2 && paused {
                hosts().1.clone()
            } else {
                configured()
            }
        });
        let mut payload = f.start_at(&remote, workdir, launch.clone());
        if let Some(n) = over.get("runAttempt") {
            payload["run"]["attempt"] = n.clone();
        }
        let mut t = f.transport(soon(), act);
        let r = t.invoke(RemoteOperation::Start, &payload).await;
        assert!(r.as_ref().is_err_and(start_denied), "{name}: {r:?}");
        f.assert_equal();
        assert_eq!((f.delta(), f.calls(), f.executions()), (3, 2, 0), "{name}");
        let stale = f.admission().unwrap();
        assert!(
            !f.state()["leases"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l["id"] == stale["lease"]),
            "{name}"
        );
        let mut env = launch["env"].as_object().unwrap().clone();
        env.insert("PACER_ROLE".into(), json!("executor"));
        env.insert("PACER_TASK_ID".into(), json!("<ID>"));
        let mut row = json!({"name":name,"mode":"start","argv":launch["argv"],"env":env,
            "stdin":launch["stdin"],"remoteDir":remote.replace(ID, "<ID>"),"workdir":workdir});
        if paused {
            row["host"] = json!({"ssh":"box-ssh","session":"recording","paused":true});
        }
        if let Some(n) = over.get("runAttempt") {
            row["runAttempt"] = n.clone();
        }
        ts_rows.push(row);
    }
    let names: Vec<_> = ts_rows.iter().map(|r| r["name"].clone()).collect();
    for (ts, name) in oracle(Value::Array(ts_rows), &Owned::new("pacer-remote-oracle").0)
        .iter()
        .zip(names)
    {
        assert_eq!(ts["name"], name);
        assert_eq!(ts["error"], START_DENIED, "{name}: {ts}");
        assert_eq!(
            ts["admissionJson"],
            json!({"kind":"file","leaseFinished":true}),
            "{name}"
        );
        assert_eq!(ts["leases"], json!([]), "{name}");
    }
}

#[tokio::test]
async fn full_host_mismatch_is_issuer_only_typescript_evidence_plus_native_rejection() {
    let f = Fx::new();
    let act: Act = Arc::new(|n| {
        if n == 2 {
            hosts().2.clone()
        } else {
            configured()
        }
    });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(r.as_ref().is_err_and(start_denied), "{r:?}");
    f.assert_equal();
    assert_eq!((f.delta(), f.executions()), (3, 0));
    let ts = oracle(
        json!([
            {"name":"full","mode":"issue","host":{"ssh":"box-ssh","session":"full"},
             "env":{"PACER_ROLE":"executor","PACER_TASK_ID":"<ID>"}},
            {"name":"recording","mode":"issue","env":{"PACER_ROLE":"executor","PACER_TASK_ID":"<ID>"}},
        ]),
        &Owned::new("pacer-remote-oracle").0,
    );
    assert_eq!(ts[0]["issuer"], false);
    assert_eq!(ts[1]["issuer"], true);
}

#[tokio::test]
async fn accepted_r6_rows_match_the_actual_issuer() {
    let tail = format!("/.pacer-remote/runs/{ID}/1");
    let env10: serde_json::Map<String, Value> =
        (0..10).map(|i| (format!("K{i}"), json!("v"))).collect();
    let rows = vec![
        (
            "count-25",
            json!({"argv":(0..8).map(|i| format!("a{i}")).collect::<Vec<_>>(),"env":env10,"stdin":""}),
            json!({}),
        ),
        (
            "argv-1024",
            json!({"argv":["a".repeat(1024)],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "emoji-512",
            json!({"argv":["\u{1F600}".repeat(512)],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "env-1022",
            json!({"argv":["x"],"env":{"K":"v".repeat(1022)},"stdin":""}),
            json!({}),
        ),
        (
            "argv-separators",
            json!({"argv":["a\u{80}\u{85}\u{2028}\u{2029}\u{feff}b"],"env":{},"stdin":""}),
            json!({}),
        ),
        (
            "remote-nel",
            launch(),
            json!({"remote":format!("/re\u{85}mote{tail}")}),
        ),
        ("workdir-trailing", launch(), json!({"workdir":"/a/b/"})),
        ("workdir-ls", launch(), json!({"workdir":"/a\u{2028}b"})),
    ];
    let mut ts_rows = vec![];
    for (name, launch, over) in &rows {
        let f = Fx::new();
        let remote = over["remote"].as_str().map_or(f.remote(), str::to_owned);
        let workdir = over["workdir"].as_str().unwrap_or("/remote/work");
        let mut t = f.transport(soon(), fingerprint());
        let r = t
            .invoke(
                RemoteOperation::Start,
                &f.start_at(&remote, workdir, launch.clone()),
            )
            .await;
        assert_eq!(r.unwrap(), json!({"pid":4242}), "{name}");
        assert_eq!(f.executions(), 1, "{name}");
        let mut env = launch["env"].as_object().unwrap().clone();
        env.insert("PACER_ROLE".into(), json!("executor"));
        env.insert("PACER_TASK_ID".into(), json!("<ID>"));
        ts_rows.push(
            json!({"name":name,"mode":"issue","argv":launch["argv"],"env":env,
            "stdin":launch["stdin"],"remoteDir":remote.replace(ID, "<ID>"),"workdir":workdir}),
        );
    }
    for ts in oracle(Value::Array(ts_rows), &Owned::new("pacer-remote-oracle").0) {
        assert_eq!(ts["issuer"], true, "{ts}");
    }
}

#[tokio::test]
async fn n_native_only_malformed_typed_defaults_are_preserved() {
    for launch in [
        json!({"argv":["x"],"env":[],"stdin":""}),
        json!({"argv":["x"],"env":7,"stdin":""}),
        json!({"argv":["x"],"env":{},"stdin":7}),
    ] {
        let f = Fx::new();
        let mut t = f.transport(soon(), fingerprint());
        let r = t
            .invoke(RemoteOperation::Start, &f.start(launch.clone()))
            .await;
        assert_eq!(r.unwrap(), json!({"pid":4242}), "{launch}");
        assert_eq!(f.executions(), 1);
        if launch["stdin"] == 7 {
            let start: Value =
                serde_json::from_slice(&fs::read(f.fx.join("start.json")).unwrap()).unwrap();
            let wrapper = include_str!("../../plugin-execution/src/native_run/wrapper.sh");
            assert_eq!(start["stdin"], wrapper.len() + 16);
        }
    }
    for launch in [
        json!({"argv":["x"],"env":{"K":7},"stdin":""}),
        json!({"argv":[7],"env":{},"stdin":""}),
    ] {
        let f = Fx::new();
        let mut t = f.transport(soon(), fingerprint());
        let r = t
            .invoke(RemoteOperation::Start, &f.start(launch.clone()))
            .await;
        assert!(r.as_ref().is_err_and(native_denied), "{launch}: {r:?}");
        f.assert_equal();
        assert_eq!(f.delta(), 3);
        assert!(f.admission().is_some());
    }
    let f = Fx::new();
    let mut t = f.transport(soon(), fingerprint());
    let r = t
        .invoke(
            RemoteOperation::Start,
            &f.start(json!({"argv":"x","env":{},"stdin":""})),
        )
        .await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    f.assert_equal();
    assert_eq!(f.delta(), 0);
}

#[tokio::test]
async fn o_admission_write_failure_releases_like_typescript() {
    let f = Fx::new();
    let blocker = Path::new(&f.local()).join("admission.json");
    dir(&blocker);
    let mut t = f.transport(soon(), fingerprint());
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(r.is_err());
    f.assert_equal();
    assert_eq!((f.delta(), f.executions()), (3, 0));
    assert!(blocker.is_dir());
    let ts = &oracle(
        json!([{"name":"o","mode":"start-write-failure"}]),
        &Owned::new("pacer-remote-oracle").0,
    )[0];
    assert_eq!(
        ts["admissionJson"],
        json!({"kind":"directory","leaseFinished":true})
    );
    assert_eq!(ts["leases"], json!([]));
}

#[tokio::test]
async fn p_staged_finish_error_wins_over_issuance_denial() {
    // Native fault injection; TS precedence is source control flow (run-io.ts:94).
    let f = Fx::new();
    let updates = f.home.join("desktop-updates");
    let act: Act = Arc::new(move |n| {
        if n == 2 {
            fs::set_permissions(&updates, fs::Permissions::from_mode(0o755)).unwrap();
            hosts().1.clone()
        } else {
            configured()
        }
    });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    fs::set_permissions(
        f.home.join("desktop-updates"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let added = f.added();
    assert_eq!(added.len(), 1);
    session_row(&f, &added[0], &f.remote());
    assert_eq!(f.admission().unwrap()["lease"], added[0]["id"]);
    assert_eq!((f.delta(), f.calls(), f.executions()), (2, 2, 0));
}

#[tokio::test]
async fn q_q2_session_is_retained_after_sent() {
    let f = Fx::new();
    let d = Instant::now() + Duration::from_millis(1000);
    let act: Act = Arc::new(move |n| {
        if n == 4 {
            wait_until(d);
        }
        configured()
    });
    let mut t = f.transport(d, act);
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(matches!(r, Err(BrokerError::Timeout)), "{r:?}");
    let added = f.added();
    assert_eq!(added.len(), 1);
    session_row(&f, &added[0], &f.remote());
    assert_eq!((f.delta(), f.calls(), f.executions()), (4, 4, 0));

    let f = Fx::new();
    let act: Act = Arc::new(|n| if n == 3 { "other".into() } else { configured() });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
    let added = f.added();
    assert_eq!(added.len(), 1);
    session_row(&f, &added[0], &f.remote());
    assert_eq!(f.delta(), 2);
}

#[tokio::test]
async fn r_s_dispatched_start_failures_retain_session_and_operation() {
    for mode in ["exit255", "receipt-chmod"] {
        let f = Fx::new();
        f.mode(mode);
        let mut t = f.transport(soon(), fingerprint());
        let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
        if mode == "receipt-chmod" {
            assert!(r.as_ref().is_err_and(native_denied), "{r:?}");
            fs::set_permissions(
                f.home.join("desktop-updates"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        } else {
            assert!(r.is_err());
        }
        let added = f.added();
        assert_eq!(added.len(), 2, "{mode}");
        session_row(&f, by_kind(&added, "session")[0], &f.remote());
        op_row(by_kind(&added, "operation")[0], "start");
        assert_eq!(f.delta(), 3, "{mode}");
    }
}

#[tokio::test]
async fn t_timeout_retains_session_and_operation_and_reaps_the_group() {
    let f = Fx::new();
    f.mode("ready-sleep");
    let mut t = f.transport(Instant::now() + Duration::from_secs(2), fingerprint());
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(matches!(r, Err(BrokerError::Timeout)), "{r:?}");
    let pgid: i32 = fs::read_to_string(f.fx.join("ready"))
        .unwrap()
        .parse()
        .unwrap();
    let added = f.added();
    assert_eq!(added.len(), 2);
    session_row(&f, by_kind(&added, "session")[0], &f.remote());
    op_row(by_kind(&added, "operation")[0], "start");
    assert_eq!(f.delta(), 3);
    group_gone(pgid).await;
}

#[tokio::test]
async fn u_cancel_after_ready_retains_both_leases() {
    let f = Fx::new();
    f.mode("ready-sleep");
    let mut t = f.transport(soon(), fingerprint());
    let payload = f.start(launch());
    let ready = f.fx.join("ready");
    {
        let invoke = t.invoke(RemoteOperation::Start, &payload);
        tokio::pin!(invoke);
        let poll = async {
            let until = Instant::now() + Duration::from_secs(10);
            while !ready.exists() {
                assert!(Instant::now() < until, "child never became ready");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::select! {
            r = &mut invoke => panic!("invoke completed first: {r:?}"),
            () = poll => {}
        }
    }
    let pgid: i32 = fs::read_to_string(&ready).unwrap().parse().unwrap();
    group_gone(pgid).await;
    let added = f.added();
    assert_eq!(added.len(), 2);
    session_row(&f, by_kind(&added, "session")[0], &f.remote());
    op_row(by_kind(&added, "operation")[0], "start");
    assert_eq!(f.delta(), 3);
}

#[test]
fn v_first_poll_admits_both_leases_before_any_await() {
    let f = Fx::new();
    f.mode("ready-sleep");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut t = f.transport(soon(), fingerprint());
        let payload = f.start(launch());
        let mut invoke = Box::pin(t.invoke(RemoteOperation::Start, &payload));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(invoke.as_mut().poll(&mut cx).is_pending());
        drop(invoke);
        let added = f.added();
        assert_eq!(added.len(), 2);
        session_row(&f, by_kind(&added, "session")[0], &f.remote());
        op_row(by_kind(&added, "operation")[0], "start");
        assert_eq!(f.delta(), 3);
        // Teardown only, with the runtime still polled. Cancellation can precede
        // readiness: a ready file gives an owned PID whose group must reach ESRCH,
        // while its absence proves neither spawn nor no spawn and checks nothing.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if let Ok(pid) = fs::read_to_string(f.fx.join("ready")) {
            group_gone(pid.parse().unwrap()).await;
        }
    });
}

#[tokio::test]
async fn w_w2_tracked_undispatched_arm_releases_the_operation() {
    let f = Fx::new();
    let image = Arc::new(Mutex::new(Some(Fx::clone_paths(&f))));
    let inject = image.clone();
    let act: Act = Arc::new(move |n| {
        if n == 3
            && let Some(paths) = inject.lock().unwrap().take()
        {
            replace_paths(&paths);
        }
        configured()
    });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Stop, &f.stop()).await;
    assert!(r.as_ref().is_err_and(image_denied), "{r:?}");
    assert!(f.fx.join("injected").exists());
    f.assert_equal();
    assert_eq!((f.delta(), f.calls(), f.executions()), (2, 3, 0));

    let f = Fx::new();
    let image = Arc::new(Mutex::new(Some(Fx::clone_paths(&f))));
    let act: Act = Arc::new(move |n| {
        if n == 4
            && let Some(paths) = image.lock().unwrap().take()
        {
            replace_paths(&paths);
        }
        configured()
    });
    let mut t = f.transport(soon(), act);
    let r = t.invoke(RemoteOperation::Start, &f.start(launch())).await;
    assert!(r.as_ref().is_err_and(image_denied), "{r:?}");
    assert!(f.fx.join("injected").exists());
    let added = f.added();
    assert_eq!(added.len(), 1);
    session_row(&f, &added[0], &f.remote());
    assert_eq!((f.delta(), f.calls(), f.executions()), (4, 4, 0));
}

struct Paths {
    root: PathBuf,
    ssh: PathBuf,
    fx: PathBuf,
}
impl Fx {
    fn clone_paths(f: &Fx) -> Paths {
        Paths {
            root: f.root.clone(),
            ssh: f.ssh.clone(),
            fx: f.fx.clone(),
        }
    }
}
fn replace_paths(p: &Paths) {
    let next = p.root.join("fake-ssh.next");
    fs::write(&next, format!("{FAKE_SSH}\n# replaced\n")).unwrap();
    fs::set_permissions(&next, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(&next, &p.ssh).unwrap();
    fs::write(p.fx.join("injected"), "image replaced").unwrap();
}
