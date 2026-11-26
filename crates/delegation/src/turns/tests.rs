use super::{is_closed, turn_blocked, turn_capable};
use pacer_foundation::Ctx;
use pacer_store::{TaskStore, messages};
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, Ctx, TaskStore) {
    let dir = tempfile::tempdir().expect("temp dir");
    let home = dir.path().to_path_buf();
    let ctx = Ctx::with(home.clone(), home.clone(), Default::default(), 1_800_000_000.0);
    let mut store = TaskStore::open(&home).expect("store");
    messages::ensure_schema(&mut store).expect("message schema");
    (dir, ctx, store)
}

fn task(id: &str, state: &str, patch: impl FnOnce(&mut Value)) -> Value {
    let mut t = json!({
        "id": id, "state": state, "rev": 1, "attempts": [], "brief": {"goal": "g", "repo": "/tmp/repo"},
        "kind": null,
    });
    patch(&mut t);
    t
}

#[test]
fn queued_task_blocks_a_turn() {
    let (_dir, ctx, mut store) = fixture();
    let t = task("t-1", "queued", |_| {});
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("queued"));
}

#[test]
fn running_task_blocks_a_turn() {
    let (_dir, ctx, mut store) = fixture();
    let t = task("t-2", "running", |_| {});
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("queued"));
}

#[test]
fn closed_task_blocks_a_turn() {
    let (_dir, ctx, mut store) = fixture();
    let t = task("t-3", "done", |t| {
        t["msgClosed"] = json!(true);
    });
    assert!(is_closed(&t));
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("closed"));
}

#[test]
fn a_settled_task_without_a_session_blocks_a_turn() {
    let (_dir, ctx, mut store) = fixture();
    messages::insert(
        &mut store,
        &messages::NewMessage {
            task_id: Some("t-4"),
            root_id: "task:t-4",
            from: "human",
            to: "task:t-4",
            kind: "message",
            body: "hi",
            reply_to: None,
            request_id: None,
            held: false,
        },
        ctx.now,
    )
    .expect("pending message");
    let t = task("t-4", "done", |_| {});
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("no_session"));
}

#[test]
fn a_pending_turn_needs_a_capable_session() {
    let (_dir, ctx, mut store) = fixture();
    let t = task("t-5", "done", |t| {
        t["pendingTurn"] = json!({"id": "t-5#1.1", "executor": "codex", "at": 1_800_000_000.0});
        t["run"] = json!({"executor": "codex"});
        t["result"] = json!({"backend": "direct", "worktree": "/tmp/worktree"});
    });
    assert!(turn_capable(&ctx, &t));
    // No pending message yet: the turn waits in the queue.
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("queued"));
}

#[test]
fn a_conversation_task_without_a_live_session_is_unavailable() {
    let (_dir, ctx, mut store) = fixture();
    let t = task("t-6", "done", |t| {
        t["interactionMode"] = json!("conversation");
    });
    assert_eq!(turn_blocked(&ctx, &mut store, Some(&t)).expect("blocked"), Some("live_unavailable"));
}
