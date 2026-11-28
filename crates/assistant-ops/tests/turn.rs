//! Native turn parity goldens. These port the end-to-end cases of
//! `test/assistant-reply.test.ts` that drive a turn against a fake model: the
//! answer frames, the stored turn and usage rows, cards, citations, de-dup,
//! cancellation, the live tool pipeline and grant revocation.
//!
//! The model call itself is injected through `ReplyRunner`; the bundled
//! `assistant.reply` plugin is exercised by its own harness
//! (`crates/assistant-pacer/tests/reply.rs`) against the fake OpenAI server.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_assistant_ops::assistant_ops::{
    live,
    run_turn::{self, ReplyRunner},
    tools::ReadOps,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{TaskStore, assistant, work_grants};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

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
                "snapshot.get" => json!({"snapshot":{"counts":{"open":3},"attention":[],"mode":"normal"}}),
                "assistant.budget" => json!({"mode":"normal","accounts":[]}),
                "task.list" => json!({"tasks":[]}),
                "dispatch.list" => json!({"work":{"tasks":[]}}),
                _ => json!({}),
            })
        })
    }
}

enum Script {
    /// One plain reply.
    Answer(&'static str, i64, i64),
    /// Hold until cancellation, then refuse like a cancelled plugin call.
    UntilCancelled,
    /// Hold until the test releases the gate, then answer.
    WaitGate,
}

struct FakeRunner {
    script: Arc<Mutex<Vec<Script>>>,
    calls: Arc<AtomicUsize>,
    gate: Option<Arc<tokio::sync::Notify>>,
}

impl FakeRunner {
    fn answer(text: &'static str) -> Self {
        Self {
            script: Arc::new(Mutex::new(vec![Script::Answer(text, 10, 3)])),
            calls: Arc::new(AtomicUsize::new(0)),
            gate: None,
        }
    }
    fn gated() -> (Self, Arc<tokio::sync::Notify>) {
        let gate = Arc::new(tokio::sync::Notify::new());
        (
            Self {
                script: Arc::new(Mutex::new(vec![Script::WaitGate])),
                calls: Arc::new(AtomicUsize::new(0)),
                gate: Some(Arc::clone(&gate)),
            },
            gate,
        )
    }

    fn cancellable() -> Self {
        Self {
            script: Arc::new(Mutex::new(vec![Script::UntilCancelled])),
            calls: Arc::new(AtomicUsize::new(0)),
            gate: None,
        }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl ReplyRunner for FakeRunner {
    fn reads(&self) -> Box<dyn ReadOps> {
        Box::new(FakeReads)
    }

    fn reply<'a>(
        &'a self,
        _ctx: &'a Ctx,
        _params: Value,
        _tools: Arc<pacer_assistant_ops::assistant_ops::live::TurnTools>,
        mut cancel: watch::Receiver<bool>,
        _deadline: Duration,
    ) -> OpFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let script = self.script.lock().unwrap().pop().unwrap_or(Script::Answer("fallback", 1, 1));
        let gate = self.gate.clone();
        Box::pin(async move {
            match script {
                Script::Answer(text, input, output) => Ok(json!({
                    "message": text,
                    "usage": {"input":input,"output":output,"coverage":"measured"}
                })),
                Script::WaitGate => {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    Ok(json!({
                        "message": "Fixture answer.",
                        "usage": {"input":10,"output":3,"coverage":"measured"}
                    }))
                }
                Script::UntilCancelled => {
                    let _changed = cancel.changed().await;
                    Err(CoreError::new(Code::PluginTimeout, "Cancelled."))
                }
            }
        })
    }
}

fn ctx(dir: &Path) -> Ctx {
    Ctx::with(
        dir.to_path_buf(),
        dir.to_path_buf(),
        HashMap::new(),
        NOW,
    )
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
        assistant::write_settings(db, Some("opencode#ep".into()), Some("ep".into()), Some("pacer".into()), None, None, 1).unwrap(),
        assistant::SettingsWrite::Saved(_)
    ));
}

fn ask(extra: Value) -> Value {
    let mut params = json!({"text":"What is running?","scope":{"kind":"dispatch"},"requestId":"turn-1"});
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
    for _ in 0..200 {
        if let Some(turn) = assistant::turn(db, turn_id).unwrap()
            && turn["state"].as_str() != Some("running")
        {
            return turn;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("turn {turn_id} never settled");
}

#[tokio::test]
async fn a_turn_streams_its_answer_and_stores_the_row() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let runner = Arc::new(FakeRunner::answer("Fixture answer."));
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
    assert_eq!(done, Some(json!({"state":"done"})), "runner calls {}", runner.calls());
    let turn = settled(&ctx, turn_id).await;
    assert_eq!(turn["state"], json!("done"));
    assert_eq!(turn["answer"], json!("Fixture answer."));
    assert_eq!(turn["usage"]["input"], json!(10));
    assert_eq!(turn["usage"]["output"], json!(3));
    assert_eq!(turn["usage"]["coverage"], json!("measured"));
    assert_eq!(turn["cards"], json!([]));
    assert_eq!(turn["citations"], json!([]));
    // The turn's grant is dead the moment the answer lands.
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = assistant::database(&mut store).unwrap();
    let grant = work_grants::assistant_rows(db).unwrap();
    assert_eq!(grant.len(), 1);
    assert_eq!(grant[0].1, 1, "grant must be revoked at the end of the turn");
}

#[tokio::test]
async fn a_repeated_request_id_gets_the_same_turn() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let runner = Arc::new(FakeRunner::answer("One answer."));
    let (first, repeat) = tokio::join!(
        run_turn::ask(&ctx, ask(json!({})), runner.clone()),
        run_turn::ask(&ctx, ask(json!({})), runner.clone()),
    );
    assert_eq!(first.unwrap(), repeat.unwrap());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(runner.calls(), 1);
}

#[tokio::test]
async fn a_second_question_waits_for_the_first_turn() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let (runner, gate) = FakeRunner::gated();
    let runner = Arc::new(runner);
    let first = run_turn::ask(&ctx, ask(json!({})), runner.clone())
        .await
        .unwrap();
    let conflict = run_turn::ask(&ctx, ask(json!({"requestId":"turn-2"})), runner.clone())
        .await
        .unwrap_err();
    assert_eq!(conflict.code, Code::Conflict);
    assert_eq!(
        conflict.message,
        "The assistant is still answering. Wait for it, or cancel the answer."
    );
    gate.notify_one();
    let _ = settled(&ctx, first["turnId"].as_str().unwrap()).await;
}

#[tokio::test]
async fn cancellation_settles_the_turn_and_closes_its_tools() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let runner = Arc::new(FakeRunner::cancellable());
    let started = run_turn::ask(&ctx, ask(json!({})), runner.clone())
        .await
        .unwrap();
    let turn_id = started["turnId"].as_str().unwrap();
    assert!(live::cancel(&ctx, turn_id));
    assert!(live::cancelled(turn_id));
    let turn = settled(&ctx, turn_id).await;
    assert_eq!(turn["state"], json!("cancelled"));
    assert!(turn["answer"].is_null());
    let closed = run_turn::tool(
        &ctx,
        json!({"turnId":turn_id,"name":"snapshot","params":{}}),
        &mut FakeReads,
    )
    .await
    .unwrap_err();
    assert_eq!(closed.code, Code::NotAllowed);
    assert_eq!(
        closed.message,
        "That assistant turn has ended; its tools are closed."
    );
}

#[tokio::test]
async fn refusal_themes_match_typescript_before_a_turn_starts() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let runner = Arc::new(FakeRunner::answer("not used"));
    for params in [
        json!(null),
        json!({}),
        json!({"text":"","scope":{"kind":"dispatch"},"requestId":"r"}),
        json!({"text":"x","scope":{"kind":"nope"},"requestId":"r"}),
        json!({"text":"x","scope":{"kind":"dispatch","days":91},"requestId":"r"}),
    ] {
        let error = run_turn::ask(&ctx, params, runner.clone()).await.unwrap_err();
        assert_eq!(error.code, Code::InvalidInput, "{error:?}");
    }
    let executor = Ctx {
        env: [("PACER_ROLE".to_owned(), "executor".to_owned())]
            .into_iter()
            .collect(),
        ..ctx.clone()
    };
    let error = run_turn::ask(&executor, ask(json!({})), runner).await.unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
}

#[tokio::test]
async fn a_live_turn_runs_one_tool_through_the_shared_budget() {
    let _guard = serial().await;
    live::reset();
    let dir = tempfile::tempdir().unwrap();
    configure(dir.path());
    let ctx = ctx(dir.path());
    let (runner, gate) = FakeRunner::gated();
    let runner = Arc::new(runner);
    let started = run_turn::ask(&ctx, ask(json!({})), runner.clone())
        .await
        .unwrap();
    let turn_id = started["turnId"].as_str().unwrap();
    for _ in 0..100 {
        if live::tools(turn_id).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let out = run_turn::tool(
        &ctx,
        json!({"turnId":turn_id,"name":"snapshot","params":{}}),
        &mut FakeReads,
    )
    .await
    .unwrap();
    assert_eq!(out["name"], json!("snapshot"));
    assert_eq!(out["ok"], json!(true));
    assert!(
        out["content"]
            .as_str()
            .unwrap()
            .starts_with("<data tool=\"snapshot\">")
    );
    gate.notify_one();
    let turn = settled(&ctx, turn_id).await;
    assert_eq!(turn["state"], json!("done"));
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = assistant::database(&mut store).unwrap();
    let logged: String = db
        .query_row(
            "SELECT tool_calls FROM assistant_turns WHERE id=?",
            [turn_id],
            |row| row.get(0),
        )
        .unwrap();
    let logged: Value = serde_json::from_str(&logged).unwrap();
    assert_eq!(logged.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn stream_frames_have_the_port_shape() {
    let frame = json!({"delta":"hi"});
    assert_eq!(run_turn::frame_kind(&frame), Some("delta"));
    assert_eq!(run_turn::frame_kind(&json!({"status":"Thinking…"})), Some("status"));
    assert_eq!(
        run_turn::frame_kind(&json!({"done":{"state":"done"}})),
        Some("done")
    );
    assert_eq!(run_turn::frame_kind(&json!({"x":1})), None);
}
