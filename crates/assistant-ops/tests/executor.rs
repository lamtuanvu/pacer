//! The executor backend: a turn is answered by spawning the host-built
//! ask-mode command (`opencode acp`) with the grant bound only as a secret
//! env value, and the reply judge of `assistant.selftest`.
//!
//! The bundled reply plugin is not exercised — the `ReplyRunner` that the
//! front door would install is replaced by a runner that, like the native
//! plugin host, reads `params.executor.command` and spawns a fake `opencode`
//! on PATH. The fake obeys ask mode: it reports shell/read/webfetch as
//! denied and a pacer tool as completed, so the canary judge passes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_assistant_ops::assistant_ops::{
    live,
    run_turn::{self, ReplyRunner},
    selftest,
    tools::ReadOps,
    turn,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{TaskStore, assistant};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

const NOW: f64 = 1_700_000_000.0;

/// The turn state is process-wide; keep these cases from racing each other.
static TEST_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct FakeReads;
impl ReadOps for FakeReads {
    fn read<'a>(&'a mut self, _ctx: &'a Ctx, op: &'a str, _params: Value) -> OpFuture<'a> {
        Box::pin(async move {
            Ok(match op {
                "snapshot.get" => {
                    json!({"snapshot":{"counts":{"open":0},"attention":[],"mode":"normal"}})
                }
                _ => json!({}),
            })
        })
    }
}

/// A reply runner that spawns the fake `opencode` from `params.executor`
/// and returns its ACP reply, the way the native plugin host routes an
/// executor turn's `assistant.reply` call to the real CLI.
struct ExecutorRunner {
    spawns: Arc<AtomicUsize>,
    fake_bin: PathBuf,
    sessions_seen: Arc<Mutex<Vec<String>>>,
}

impl ReplyRunner for ExecutorRunner {
    fn reads(&self) -> Box<dyn ReadOps> {
        Box::new(FakeReads)
    }

    fn reply<'a>(
        &'a self,
        _ctx: &'a Ctx,
        params: Value,
        _tools: Arc<live::TurnTools>,
        _cancel: tokio::sync::watch::Receiver<bool>,
        _deadline: Duration,
    ) -> OpFuture<'a> {
        let spawns = self.spawns.clone();
        let fake_bin = self.fake_bin.clone();
        let sessions_seen = self.sessions_seen.clone();
        Box::pin(async move {
            spawns.fetch_add(1, Ordering::SeqCst);
            let executor = params.get("executor").cloned().unwrap_or_default();
            let command = executor.get("command").cloned().unwrap_or_default();
            let argv: Vec<String> = command
                .get("argv")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let program = argv.first().cloned().unwrap_or_default();
            let cwd = command
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let stdin = command
                .get("stdin")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let mut child_env: Vec<(String, String)> = command
                .get("env")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                        .collect()
                })
                .unwrap_or_default();
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if message.contains("check your tools") {
                child_env.push(("FAKE_OPENCODE_CANARY".into(), "1".into()));
            }
            if let Some(session) = params.get("session").and_then(Value::as_str) {
                sessions_seen.lock().unwrap().push(session.to_owned());
                child_env.push(("FAKE_OPENCODE_RESUME".into(), "1".into()));
            }
            let mut cmd = tokio::process::Command::new(&program);
            if argv.len() > 1 {
                cmd.args(&argv[1..]);
            }
            cmd.current_dir(&cwd)
                .env_clear()
                .envs(child_env.iter().cloned())
                .env("HOME", "/")
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", fake_bin.display()),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = cmd
                .spawn()
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            if let Some(mut child_stdin) = child.stdin.take() {
                let _ = child_stdin.write_all(stdin.as_bytes()).await;
                drop(child_stdin);
            }
            let output = child
                .wait_with_output()
                .await
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_owned();
            eprintln!(
                "[executor] program={program:?} argv={argv:?} cwd={cwd:?} args_len={} child_env_has_PATH={} canary={} resumed={} stdout={stdout:?} status={:?}",
                argv.len(),
                child_env.iter().any(|(k, _)| k == "PATH"),
                message.contains("check your tools"),
                params.get("session").is_some(),
                output.status
            );
            let line = stdout
                .lines()
                .last()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .ok_or_else(|| {
                    CoreError::new(Code::Internal, "fake opencode emitted no ACP line")
                })?;
            Ok(json!({
                "message": line.get("text").cloned().unwrap_or(Value::String(String::new())),
                "session": line.get("session").cloned(),
                "tools": line.get("tools").cloned().unwrap_or(Value::Array(vec![])),
                "usage": line.get("usage").cloned().unwrap_or_default()
            }))
        })
    }
}

/// The fake `opencode`: reports a version, and in `acp` mode answers from
/// the env. For a canary it emits the tool evidence passed in `canary_line`;
/// for a resumed turn it keeps the previous session.
fn write_fake_opencode_with_canary(dir: &Path, canary_line: &str) -> PathBuf {
    let bin = dir.join("fakebin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = bin.join("opencode");
    let body = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "opencode v0.0.0-executor-fake"
  exit 0
fi
if [ "$1" = "acp" ]; then
  cat > /dev/null
  if [ "$FAKE_OPENCODE_CANARY" = "1" ]; then
    echo '__CANARY__'
  elif [ "$FAKE_OPENCODE_RESUME" = "1" ]; then
    echo '{"acp":true,"text":"Resumed fixture answer.","session":"abc2","tools":[],"usage":{"input":7,"output":3,"coverage":"measured"}}'
  else
    echo '{"acp":true,"text":"Fixture answer.","session":"abc","tools":[],"usage":{"input":5,"output":2,"coverage":"measured"}}'
  fi
  exit 0
fi
echo '{"error":"unknown mode"}' >&2
exit 1
"#;
    std::fs::write(&script, body.replace("__CANARY__", canary_line)).unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    bin
}

/// A fake that obeys ask mode: the forbidden tools were attempted and denied.
fn write_fake_opencode(dir: &Path) -> PathBuf {
    write_fake_opencode_with_canary(
        dir,
        r#"{"acp":true,"text":"canary complete","tools":[{"tool":"shell","status":"denied"},{"tool":"read","status":"denied"},{"tool":"webfetch","status":"denied"},{"tool":"pacer_snapshot","status":"completed"}],"usage":{"input":1,"output":1,"coverage":"measured"}}"#,
    )
}

/// A fake that breaks ask mode: the shell command completed instead of denied.
fn write_violating_fake_opencode(dir: &Path) -> PathBuf {
    write_fake_opencode_with_canary(
        dir,
        r#"{"acp":true,"text":"canary complete","tools":[{"tool":"shell","status":"completed"},{"tool":"pacer_snapshot","status":"completed"}],"usage":{"input":1,"output":1,"coverage":"measured"}}"#,
    )
}

fn ctx(dir: &Path, bin: &Path) -> Ctx {
    let mut env = HashMap::new();
    env.insert(
        "PATH".to_owned(),
        format!("{}:/usr/bin:/bin", bin.display()),
    );
    env.insert("HOME".to_owned(), dir.display().to_string());
    Ctx::with(dir.to_path_buf(), dir.to_path_buf(), env, NOW)
}

fn configure(dir: &Path) {
    std::fs::write(
        dir.join("strategy.yaml"),
        "accounts:\n  claude: {kind: claude}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: \"http://127.0.0.1:1/v1\", key: none, models: [{id: m1, name: Model One, context: 1000, output: 100, tools: true}]}}\nplanner: claude-code#claude\nrunners: {\"opencode#ep\": {model: m1}}\nrouting: [{default: [opencode#ep]}]\n",
    )
    .unwrap();
    let mut store = TaskStore::open(dir).unwrap();
    let db = assistant::database(&mut store).unwrap();
    assert!(matches!(
        assistant::write_settings(
            db,
            Some("opencode#ep".into()),
            Some("ep".into()),
            Some("executor".into()),
            None,
            None,
            1
        )
        .unwrap(),
        assistant::SettingsWrite::Saved(_)
    ));
}

fn ask(extra: Value) -> Value {
    let mut params = json!({"text": (extra.get("text").and_then(Value::as_str).unwrap_or("What is running?")).to_owned(), "scope": json!({"kind":"dispatch"}), "requestId": (extra.get("requestId").and_then(Value::as_str).unwrap_or("turn-1")).to_owned()});
    if let Some(map) = extra.as_object() {
        for (key, value) in map {
            params[key.clone()] = value.clone();
        }
    }
    params
}

async fn settled(ctx: &Ctx, turn_id: &str) -> Value {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = assistant::database(&mut store).unwrap();
    for _ in 0..300 {
        if let Some(turn) = assistant::turn(db, turn_id).unwrap()
            && turn["state"].as_str() != Some("running")
        {
            return turn;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("turn {turn_id} never settled");
}

/// A reply runner bound to this test's (live) fake `opencode` directory.
/// Each case installs its own runner under `serial()` so `assistant.selftest`
/// reaches the same fake opencode while this case's temp dir is alive; a
/// process-wide cache would hold the first case's bin path after its temp dir
/// was deleted.
fn executor_runner(bin: &Path) -> Arc<ExecutorRunner> {
    let runner = Arc::new(ExecutorRunner {
        spawns: Arc::new(AtomicUsize::new(0)),
        fake_bin: bin.to_path_buf(),
        sessions_seen: Arc::new(Mutex::new(Vec::new())),
    });
    let dyn_runner = Arc::clone(&runner) as Arc<dyn ReplyRunner>;
    turn::set_runner(dyn_runner);
    runner
}

#[tokio::test]
async fn an_executor_turn_spawns_the_fake_opencode_and_stores_the_answer() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_opencode(dir.path());
    let runner = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    let started = run_turn::ask(&ctx, ask(json!({})), runner.clone())
        .await
        .unwrap();
    let turn_id = started["turnId"].as_str().unwrap();
    let turn = settled(&ctx, turn_id).await;
    if turn["state"] != json!("done") {
        panic!(
            "turn ended in {:?} with error {:?}",
            turn["state"], turn["error"]
        );
    }
    assert_eq!(turn["state"], json!("done"));
    assert_eq!(turn["answer"], json!("Fixture answer."));
    assert_eq!(turn["usage"]["input"], json!(5));
    assert_eq!(turn["usage"]["output"], json!(2));
    assert_eq!(turn["usage"]["coverage"], json!("measured"));
    // The ask-mode command was really spawned.
    assert_eq!(runner.spawns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_executor_turn_resumes_the_backend_session() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_opencode(dir.path());
    let runner = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    // First turn creates the backend session.
    let first = run_turn::ask(&ctx, ask(json!({"requestId": "turn-1"})), runner.clone())
        .await
        .unwrap();
    settled(&ctx, first["turnId"].as_str().unwrap()).await;
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = assistant::database(&mut store).unwrap();
    let resumed = assistant::read_backend_session(db, first["conversationId"].as_str().unwrap())
        .unwrap()
        .expect("a backend session must be stored after an executor turn");
    assert_eq!(resumed["handle"], json!("abc"));
    assert_eq!(resumed["backend"], json!("executor"));
    // Second turn resumes the same conversation: it carries the stored
    // session into the spawn and answers resumed.
    let second = run_turn::ask(
        &ctx,
        ask(json!({
            "requestId": "turn-2",
            "conversationId": first["conversationId"].clone()
        })),
        runner.clone(),
    )
    .await
    .unwrap();
    let turn = settled(&ctx, second["turnId"].as_str().unwrap()).await;
    assert_eq!(turn["answer"], json!("Resumed fixture answer."));
    assert_eq!(runner.sessions_seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn assistant_selftest_runs_the_canary_through_the_fake_opencode() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_opencode(dir.path());
    let _ = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    let record = selftest::assistant_selftest(&ctx, json!({"account": "ep", "model": "m1"}))
        .await
        .unwrap();
    assert_eq!(record["passed"], json!(true), "{record}");
    // The status gate reflects the freshly passing check.
    let (ok, reason, _live) = selftest::self_test_status(
        &ctx,
        "ep",
        pacer_assistant_ops::assistant_ops::ask_mode::AskAdapter::Opencode,
    );
    assert!(
        ok,
        "status must pass right after a passing check: {reason:?}"
    );
}

#[tokio::test]
async fn a_passing_selftest_record_is_written_with_private_permissions() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_opencode(dir.path());
    let _ = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    let record = selftest::assistant_selftest(&ctx, json!({"account": "ep"}))
        .await
        .unwrap();
    assert_eq!(record["passed"], json!(true), "{record}");
    assert_eq!(record["version"], json!("opencode v0.0.0-executor-fake"));
    let file = dir.path().join("state").join("assistant-selftest.json");
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["ep"], record);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn a_selftest_agent_that_runs_the_shell_command_records_the_typescript_reason() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_violating_fake_opencode(dir.path());
    let _ = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    let record = selftest::assistant_selftest(&ctx, json!({"account": "ep"}))
        .await
        .unwrap();
    assert_eq!(record["passed"], json!(false), "{record}");
    assert_eq!(
        record["reason"],
        json!("a tool other than pacer's ran: shell")
    );
    let (ok, reason, live_tools) = selftest::self_test_status(
        &ctx,
        "ep",
        pacer_assistant_ops::assistant_ops::ask_mode::AskAdapter::Opencode,
    );
    assert!(!ok);
    assert_eq!(
        reason.as_deref(),
        Some("ep failed the ask-mode check: a tool other than pacer's ran: shell")
    );
    assert!(!live_tools);
}

#[tokio::test]
async fn an_executor_turn_after_a_passed_check_streams_the_fake_answer() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_opencode(dir.path());
    let runner = executor_runner(&bin);
    configure(dir.path());
    let ctx = ctx(dir.path(), &bin);
    let check = selftest::assistant_selftest(&ctx, json!({"account": "ep"}))
        .await
        .unwrap();
    assert_eq!(check["passed"], json!(true), "{check}");
    let started = run_turn::ask(&ctx, ask(json!({})), runner.clone())
        .await
        .unwrap();
    let turn_id = started["turnId"].as_str().unwrap();
    let mut frames = live::subscribe(turn_id).unwrap();
    let mut done = None;
    for _ in 0..200 {
        match tokio::time::timeout(Duration::from_millis(100), frames.recv()).await {
            Ok(Some(frame)) if frame.get("done").is_some() => {
                done = Some(frame["done"].clone());
                break;
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    assert_eq!(done, Some(json!({"state":"done"})));
    let turn = settled(&ctx, turn_id).await;
    assert_eq!(turn["state"], json!("done"));
    assert_eq!(turn["answer"], json!("Fixture answer."));
}
