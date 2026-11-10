#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

const ID: &str = "t-20261110-000000-abcd";
const NOW: f64 = 1_000_000.0;

#[derive(Default)]
struct Recorder {
    calls: Vec<Value>,
}

impl Bridge for Recorder {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.calls.push(request.clone());
        Box::pin(async move { Ok(json!({"id": request["id"], "delivered": true})) })
    }
}

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    let env = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect::<HashMap<_, _>>();
    Ctx::with(dir.path().into(), dir.path().join(".pacer"), env, NOW)
}

fn seed(ctx: &Ctx, over: Value) {
    let mut task = json!({
        "id": ID, "rev": 3, "state": "running", "createdAt": NOW - 100.0,
        "brief": {"goal": "g", "repo": "/tmp/repo"}, "attempts": [],
    });
    if let (Value::Object(task), Value::Object(over)) = (&mut task, over) {
        task.extend(over);
    }
    TaskStore::open(&ctx.pacer_home)
        .unwrap()
        .insert(&task, NOW - 100.0)
        .unwrap();
}

async fn send(
    ctx: &Ctx,
    params: Value,
    by: &str,
    bridge: &mut Recorder,
) -> Result<Value, CoreError> {
    task_send(ctx, params, by.to_owned(), bridge).await
}

#[test]
fn params_report_every_zod_issue_in_schema_order() {
    for (params, message) in [
        (
            json!([]),
            "params: Invalid input: expected object, received array",
        ),
        (
            json!({"text": "x"}),
            "id: Invalid input: expected string, received undefined",
        ),
        (
            json!({"id": "", "text": "x".repeat(4001)}),
            "id: Too small: expected string to have >=1 characters; text: Too big: expected string to have <=4000 characters",
        ),
        (
            json!({"id": "a", "text": "x", "force": null}),
            "force: Invalid input: expected boolean, received null",
        ),
        (
            json!({"id": "a", "text": "x", "expect_rev": null}),
            "expect_rev: Invalid input: expected number, received null",
        ),
        (
            json!({"id": "a", "text": "x", "expect_rev": 1.5}),
            "expect_rev: Invalid input: expected int, received number",
        ),
        (
            json!({"id": "a", "text": "x", "expect_rev": 0}),
            "expect_rev: Too small: expected number to be >0",
        ),
        (
            json!({"id": "a", "text": "x", "expect_rev": 9_007_199_254_740_992_u64}),
            "expect_rev: Too big: expected int to be <=9007199254740991",
        ),
        (
            json!({"id": "a", "text": "x", "expect_rev": -1e300}),
            "expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >0",
        ),
    ] {
        let error = parse(&params).err().unwrap();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(error.message, message, "{params}");
    }
    // Zod counts code points, so 4000 emoji pass the schema; `send` then counts UTF-16 units.
    assert!(parse(&json!({"id": "a", "text": "😀".repeat(4000)})).is_ok());
}

#[test]
fn caller_identity_matches_type_script() {
    let dir = tempfile::tempdir().unwrap();
    let cli = ctx(
        &dir,
        &[("USER", "alice"), ("ORCA_TERMINAL_HANDLE", " term_one ")],
    );
    assert_eq!(caller_identity(&cli, None, None), "alice@term_one");
    assert_eq!(
        caller_identity(&cli, Some("app/1.2.0"), None),
        "client:app/1.2.0"
    );
    assert_eq!(
        caller_identity(&cli, Some("app/1.2.0"), Some("w1")),
        "client:app/1.2.0#w1"
    );
    assert_eq!(
        caller_identity(&cli, Some("app"), Some("window-a")),
        "client:app#window-a"
    );
    assert_eq!(
        caller_identity(&cli, Some("Bad/1"), Some("w1")),
        "client:http#w1"
    );
    assert_eq!(caller_identity(&cli, Some("app"), None), "alice@term_one");
    assert_eq!(
        caller_identity(&cli, None, Some("no spaces allowed")),
        "alice@term_one"
    );
    let tmux = ctx(&dir, &[("TMUX_PANE", "%3")]);
    assert_eq!(caller_identity(&tmux, None, None), "planner@%3");
    assert_eq!(
        caller_identity(&ctx(&dir, &[("USER", " ")]), None, None),
        "planner"
    );
}

#[tokio::test]
async fn record_refusals_never_reach_core() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[]);
    seed(&ctx, json!({}));
    let mut bridge = Recorder::default();
    let error = send(
        &ctx,
        json!({"id": "t-20261110-000000-ffff", "text": "hi"}),
        "me",
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (Code::UnknownTask, "unknown task t-20261110-000000-ffff")
    );
    let error = send(
        &ctx,
        json!({"id": "../escape", "text": "hi"}),
        "me",
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::UnknownTask);
    let error = send(&ctx, json!({"id": ID, "text": "   "}), "me", &mut bridge)
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (Code::InvalidInput, "message must contain 1–4000 characters")
    );
    let error = send(
        &ctx,
        json!({"id": ID, "text": "😀".repeat(2001)}),
        "me",
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    let error = send(
        &ctx,
        json!({"id": ID, "text": "hi", "expect_rev": 4}),
        "me",
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (Code::Conflict, "task changed")
    );
    assert_eq!(
        error
            .data
            .as_ref()
            .and_then(|d| d.get("task"))
            .map(|t| t["id"].clone()),
        Some(json!(ID))
    );
    assert!(bridge.calls.is_empty());
}

#[tokio::test]
async fn executors_are_refused_before_the_task_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[("PACER_ROLE", "executor")]);
    let mut bridge = Recorder::default();
    let error = send(&ctx, json!({"id": ID, "text": "hi"}), "me", &mut bridge)
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (
            Code::NotAllowed,
            "executors cannot use pacer send; use pacer ask"
        )
    );
    assert!(bridge.calls.is_empty());
}

#[tokio::test]
async fn a_waiting_or_settled_lane_is_a_conflict() {
    for (over, message) in [
        (
            json!({"state": "needs_input"}),
            format!("task is waiting for an answer; use pacer answer {ID}"),
        ),
        (
            json!({"question": {"text": "A or B?", "at": 1}}),
            format!("task is waiting for an answer; use pacer answer {ID}"),
        ),
        (
            json!({"state": "done"}),
            "task is done, not running".to_owned(),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir, &[]);
        seed(&ctx, over);
        let mut bridge = Recorder::default();
        let error = send(&ctx, json!({"id": ID, "text": "hi"}), "me", &mut bridge)
            .await
            .unwrap_err();
        assert_eq!((error.code, error.message), (Code::Conflict, message));
        assert!(bridge.calls.is_empty());
    }
}

#[tokio::test]
async fn an_answered_question_does_not_block_a_send() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[]);
    seed(
        &ctx,
        json!({"question": {"text": "A or B?", "at": 1, "answer": "B"}}),
    );
    let mut bridge = Recorder::default();
    send(&ctx, json!({"id": ID, "text": "hi"}), "me", &mut bridge)
        .await
        .unwrap();
    assert_eq!(bridge.calls.len(), 1);
}

#[tokio::test]
async fn a_free_lane_forwards_the_send_with_the_caller() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[]);
    seed(&ctx, json!({"driving": {"by": "me", "at": NOW - 5.0}}));
    let mut bridge = Recorder::default();
    let result = send(
        &ctx,
        json!({"id": ID, "text": "go", "expect_rev": 3}),
        "me",
        &mut bridge,
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"id": ID, "delivered": true}));
    assert_eq!(
        bridge.calls,
        [
            json!({"kind": "send", "id": ID, "text": "go", "force": false, "by": "me", "expectRev": 3})
        ]
    );
}

#[tokio::test]
async fn another_callers_lease_is_left_to_cores_locked_check() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[]);
    seed(
        &ctx,
        json!({"driving": {"by": "operator-a", "at": NOW - 12.5}}),
    );
    for force in [false, true] {
        let mut bridge = Recorder::default();
        send(
            &ctx,
            json!({"id": ID, "text": "hi", "force": force}),
            "operator-b",
            &mut bridge,
        )
        .await
        .unwrap();
        assert_eq!(
            bridge.calls,
            [json!({"kind": "send", "id": ID, "text": "hi", "force": force, "by": "operator-b"})]
        );
    }
}

#[tokio::test]
async fn enforcement_identities_are_refused_before_the_params_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let enforced = ctx(&dir, &[("PACER_ENFORCEMENT_TOKEN", "x")]);
    seed(&enforced, json!({}));
    for params in [
        json!({"id": ID, "text": "hi"}),
        json!({"id": "", "text": ""}),
        json!([]),
    ] {
        let mut bridge = Recorder::default();
        let error = send(&enforced, params, "me", &mut bridge)
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            (
                Code::NotAllowed,
                "Enforcement identity only reports a native child denial"
            )
        );
        assert!(bridge.calls.is_empty());
    }
    let empty = ctx(&dir, &[("PACER_ENFORCEMENT_TOKEN", "")]);
    let mut bridge = Recorder::default();
    send(&empty, json!({"id": ID, "text": "hi"}), "me", &mut bridge)
        .await
        .unwrap();
    assert_eq!(bridge.calls.len(), 1);
}

#[tokio::test]
async fn record_refusals_are_decided_under_the_shared_task_lock() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir, &[]);
    seed(&ctx, json!({"state": "done"}));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let home = ctx.pacer_home.clone();
    let writer = std::thread::spawn(move || {
        let mut store = TaskStore::open(&home).unwrap();
        store
            .with_task_lock(ID, |locked| {
                locked_tx.send(()).unwrap();
                go_rx.recv().unwrap();
                locked.update(3, NOW, |t| t["state"] = json!("running"))
            })
            .unwrap();
    });
    locked_rx.recv().unwrap();
    // The send starts while the writer holds the lock, so it must see the writer's change.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        go_tx.send(()).unwrap();
    });
    let mut bridge = Recorder::default();
    send(&ctx, json!({"id": ID, "text": "hi"}), "me", &mut bridge)
        .await
        .unwrap();
    writer.join().unwrap();
    assert_eq!(bridge.calls[0]["kind"], "send");
}
