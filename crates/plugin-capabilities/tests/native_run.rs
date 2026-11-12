#![allow(clippy::unwrap_used)]
use pacer_plugin_capabilities::{NativeRun, RunLaunch};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
struct Fixture {
    root: std::path::PathBuf,
    home: std::path::PathBuf,
    repo: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pacer-run-{}", uuid::Uuid::new_v4()));
        let root = {
            fs::create_dir_all(&root).unwrap();
            fs::canonicalize(root).unwrap()
        };
        let home = root.join("home");
        let repo = root.join("repo");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir(&repo).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let mut store = TaskStore::open(&home).unwrap();
        store.insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"fx-executor","executor":"tool","attempts":[],"brief":{"repo":repo}}),1.0).unwrap();
        Self { root, home, repo }
    }
    fn launch(&self) -> RunLaunch {
        RunLaunch {
            home: self.home.to_string_lossy().into_owned(),
            umask: None,
            keep_color: vec![],
            argv: vec![
                "printf".into(),
                "%s".into(),
                "literal; $(touch forbidden) 😀".into(),
            ],
            executable: fs::canonicalize("/usr/bin/printf")
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            cwd: self.repo.to_string_lossy().into_owned(),
            env: Default::default(),
            stdin: None,
            session: None,
            files: vec![],
        }
    }
    fn owner(&self) -> NativeRun {
        NativeRun::issue(
            &self.home,
            ID,
            "fx-executor",
            "tool",
            1,
            self.launch(),
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap()
    }
    fn task(&self) -> Value {
        TaskStore::open(&self.home)
            .unwrap()
            .read(ID)
            .unwrap()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
const ID: &str = "t-20261102-155709-d07a";
#[tokio::test]
async fn claim_start_poll_output_and_replay_are_owned_and_durable() {
    let f = Fixture::new();
    let mut run = f.owner();
    let p = json!({"taskId":ID,"attempt":1.0});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    assert_eq!(claim["runDir"], 1);
    assert_eq!(
        run.answer("capability.process.claimRun", &p).await.unwrap(),
        claim
    );
    assert!(
        run.answer("capability.process.readRunOutput", &p)
            .await
            .is_err()
    );
    let start = json!({"task":claim["task"],"attempt":1,"runDir":1});
    let started = run
        .answer("capability.process.startRun", &start)
        .await
        .unwrap();
    assert!(started["pid"].as_u64().unwrap() > 1);
    assert!(
        run.answer("capability.process.startRun", &start)
            .await
            .is_err()
    );
    let mut state = Value::Null;
    for _ in 0..100 {
        state = run.answer("capability.process.pollRun", &p).await.unwrap();
        if state["state"] == "exited" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state["exitCode"].as_f64(), Some(0.0));
    assert_eq!(state["state"], "exited");
    let output = run
        .answer("capability.process.readRunOutput", &p)
        .await
        .unwrap();
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(output["stdoutBase64"].as_str().unwrap())
            .unwrap(),
        "literal; $(touch forbidden) 😀".as_bytes()
    );
    let dir = std::path::PathBuf::from(claim["dir"].as_str().unwrap());
    for name in ["pid", "started", "stdout", "stderr", "exit", "run.sh"] {
        assert_eq!(
            fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o077,
            0
        );
    }
    assert_eq!(f.task()["startIntent"]["attempt"], 1);
    assert!(!f.repo.join("forbidden").exists());
}
#[tokio::test]
async fn changed_owner_and_nonempty_crash_claim_never_authorize_launch() {
    let f = Fixture::new();
    let mut run = f.owner();
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    fs::write(
        std::path::Path::new(claim["dir"].as_str().unwrap()).join("foreign"),
        b"x",
    )
    .unwrap();
    assert!(run.answer("capability.process.claimRun", &p).await.is_err());
    let task = f.task();
    TaskStore::open(&f.home)
        .unwrap()
        .update(ID, task["rev"].as_i64().unwrap(), 2.0, |t| {
            t["stopPending"] = json!({"attempt":1})
        })
        .unwrap();
    assert!(
        run.answer(
            "capability.process.startRun",
            &json!({"task":claim["task"],"attempt":1,"runDir":1})
        )
        .await
        .is_err()
    );
    assert!(f.task().get("startIntent").is_none());
}
#[tokio::test]
async fn foreign_identity_parameters_and_directory_swap_are_refused() {
    let f = Fixture::new();
    let mut run = f.owner();
    for p in [
        json!({"taskId":ID,"attempt":9007199254740992u64}),
        json!({"taskId":ID,"attempt":1,"dir":"/tmp/foreign"}),
        json!({"taskId":"t-foreign","attempt":1}),
        json!({"taskId":ID,"attempt":0}),
    ] {
        assert!(run.answer("capability.process.claimRun", &p).await.is_err());
    }
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    let dir = std::path::Path::new(claim["dir"].as_str().unwrap());
    fs::rename(dir, dir.with_extension("old")).unwrap();
    fs::create_dir(dir).unwrap();
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(run.answer("capability.process.pollRun", &p).await.is_err());
}
#[tokio::test]
async fn broker_admits_only_issued_provider_and_declared_command() {
    use pacer_plugin_capabilities::CapabilityBroker;
    use pacer_plugin_host::{CallAuthority, CallResources, parse_manifest};
    let f = Fixture::new();
    let mut run = f.owner();
    let manifest=parse_manifest(json!({"id":"fx-executor","version":"1.0.0","publisher":"fixture","host":">=1.10.0","contributes":{"executor":{"backends":["direct"]}},"capabilities":[{"name":"process.spawn","scopes":["printf"]}]})).unwrap();
    let launch = f.launch();
    let resources: CallResources = serde_json::from_value(json!({"executorClaim":{
        "taskId":ID,"attempt":1,"providerId":"fx-executor","executor":"tool",
        "launch":{"argv":launch.argv,"cwd":launch.cwd,"executable":launch.executable,"env":{}}
    }}))
    .unwrap();
    let authority = CallAuthority::new(
        resources,
        vec!["process.spawn".into()],
        Instant::now() + Duration::from_secs(10),
    );
    let mut broker = CapabilityBroker::new(manifest, authority, vec![]);
    let p = json!({"taskId":ID,"attempt":1});
    assert!(
        broker
            .handle("capability.process.claimRun", p.clone(), &mut run)
            .await
            .is_ok()
    );
    broker.revoke();
    assert!(
        broker
            .handle("capability.process.pollRun", p, &mut run)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn recovered_owner_can_poll_and_read_but_cannot_restart_or_stop_without_a_stop_grant() {
    let f = Fixture::new();
    let mut run = f.owner();
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    let dir = std::path::Path::new(claim["dir"].as_str().unwrap());
    fs::write(dir.join("exit"), "0x0\u{feff}").unwrap();
    fs::write(dir.join("stdout"), "receipt").unwrap();
    let mut observed = NativeRun::resume(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        f.launch(),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        observed
            .answer("capability.process.pollRun", &p)
            .await
            .unwrap()["state"],
        "exited"
    );
    assert!(
        observed
            .answer("capability.process.readRunOutput", &p)
            .await
            .is_ok()
    );
    assert!(
        observed
            .answer(
                "capability.process.stopRun",
                &json!({"taskId":ID,"attempt":1,"graceMs":0})
            )
            .await
            .is_err()
    );
    assert!(
        observed
            .answer(
                "capability.process.startRun",
                &json!({"task":claim["task"],"attempt":1,"runDir":1})
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn exact_stop_grant_signals_only_owned_wrapper_and_requires_recorded_exit() {
    let f = Fixture::new();
    let mut launch = f.launch();
    launch.argv = vec!["sleep".into(), "30".into()];
    launch.executable = fs::canonicalize("/bin/sleep")
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut run = NativeRun::issue(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch.clone(),
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    run.answer(
        "capability.process.startRun",
        &json!({"task":claim["task"],"attempt":1,"runDir":1}),
    )
    .await
    .unwrap();
    let mut stop = NativeRun::resume(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap()
    .with_stop_grant(2000)
    .unwrap();
    assert!(
        stop.answer(
            "capability.process.stopRun",
            &json!({"taskId":ID,"attempt":1,"graceMs":1})
        )
        .await
        .is_err()
    );
    let mut launch = f.launch();
    launch.argv = vec!["sleep".into(), "30".into()];
    launch.executable = fs::canonicalize("/bin/sleep")
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut stop = NativeRun::resume(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap()
    .with_stop_grant(2000)
    .unwrap();
    let result = stop
        .answer(
            "capability.process.stopRun",
            &json!({"taskId":ID,"attempt":1,"graceMs":2000}),
        )
        .await
        .unwrap();
    assert_eq!(result["code"].as_f64(), Some(143.0));
    assert_eq!(result["killed"], false);
}
#[tokio::test]
async fn detached_home_is_host_owned_and_login_umask_is_applied_to_agent_only() {
    let f = Fixture::new();
    let mut launch = f.launch();
    launch.argv = vec!["touch".into(), "agent-output".into()];
    launch.executable = fs::canonicalize("/usr/bin/touch")
        .unwrap()
        .to_string_lossy()
        .into_owned();
    launch.umask = Some("077".into());
    let mut run = NativeRun::issue(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    run.answer(
        "capability.process.startRun",
        &json!({"task":claim["task"],"attempt":1,"runDir":1}),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if run.answer("capability.process.pollRun", &p).await.unwrap()["state"] == "exited" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        fs::metadata(f.repo.join("agent-output"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn fixed_native_wrapper_matches_the_authoritative_typescript_bytes() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let output = std::process::Command::new("bun")
        .args([
            "-e",
            "import{WRAPPER_SH}from './src/supervisor/wrapper.ts';process.stdout.write(WRAPPER_SH)",
        ])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        output.stdout,
        include_bytes!("../src/native_run/wrapper.sh")
    );
}
#[tokio::test]
async fn interactive_terminal_report_is_verified_and_receipt_is_one_use() {
    let f = Fixture::new();
    let session = f.root.join("session");
    fs::write(&session,"#!/usr/bin/env python3\nimport sys,os,json\nos.umask(0o077)\nd=sys.argv[-1]\nopen(d+'/started','w').write('1')\nopen(d+'/child','w').write(str(os.getpid()))\nopen(d+'/report.json','w').write(json.dumps({'status':'done','summary':'\\x1bCompleted','at':1}))\nopen(d+'/exit','w').write('0')\n").unwrap();
    fs::set_permissions(&session, fs::Permissions::from_mode(0o700)).unwrap();
    let mut launch = f.launch();
    launch.session = Some("interactive".into());
    launch
        .env
        .insert("PATH".into(), std::env::var("PATH").unwrap());
    let mut run = NativeRun::issue(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap()
    .with_session_launcher(session.to_str().unwrap(), vec!["_session".into()])
    .unwrap();
    let p = json!({"taskId":ID,"attempt":1});
    let claim = run.answer("capability.process.claimRun", &p).await.unwrap();
    run.answer(
        "capability.process.startRun",
        &json!({"task":claim["task"],"attempt":1,"runDir":1}),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if run.answer("capability.process.pollRun", &p).await.unwrap()["state"] == "exited" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut store = TaskStore::open(&f.home).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 2.0, |t| {
            t["startIntent"]["attempt"] = json!(2)
        })
        .unwrap();
    assert!(
        run.answer("capability.process.completeReportedRun", &p)
            .await
            .is_err()
    );
    let task = store.read(ID).unwrap().unwrap();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 2.0, |t| {
            t["startIntent"]["attempt"] = json!(1)
        })
        .unwrap();
    let completed = run
        .answer("capability.process.completeReportedRun", &p)
        .await
        .unwrap();
    assert_eq!(completed["summary"], "Completed");
    assert_eq!(completed["exitCode"].as_f64(), Some(0.0));
    assert_eq!(f.task()["executorReportReceipt"]["summary"], "Completed");
    assert!(
        run.answer("capability.process.completeReportedRun", &p)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn persisted_inspection_does_not_require_the_old_executable_to_still_exist() {
    let f = Fixture::new();
    let mut run = f.owner();
    let p = json!({"taskId":ID,"attempt":1});
    run.answer("capability.process.claimRun", &p).await.unwrap();
    let mut launch = f.launch();
    launch.executable = f
        .root
        .join("missing-executable")
        .to_string_lossy()
        .into_owned();
    let mut observed = NativeRun::resume(
        &f.home,
        ID,
        "fx-executor",
        "tool",
        1,
        launch,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        observed
            .answer("capability.process.inspectRun", &p)
            .await
            .unwrap()["state"],
        "uncertain"
    );
}
