#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor};
use pacer_store::TaskStore;
use serde_json::json;
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const STRATEGY: &str = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nmessaging:\n  grants: {}\n";

/// Seed a running parent task with a live `pwg_` work grant whose attempt matches
/// one past the parent's attempt list, mirroring `src/dispatch/work.ts`'s grant
/// resolution. Returns the token.
fn fixture() -> (TempDir, Ctx, Runtime, String, String) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    std::fs::write(pacer_home.join("strategy.yaml"), STRATEGY).unwrap();
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let ctx = Ctx::with(home, pacer_home, Default::default(), 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NoSpawn),
        supervisor: Arc::new(NoSupervisor),
    };

    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = json!({
        "id": "t-20261119-000000-abcd",
        "rev": 1,
        "createdAt": 1_800_000_000.0,
        "kind": "work",
        "state": "running",
        "brief": { "goal": "parent", "repo": repo.to_str().unwrap() },
        "attempts": [],
        "work": {
            "taskId": "t-20261119-000000-abcd",
            "parentId": "t-20261119-000000-abcd",
            "rootId": "t-20261119-000000-abcd",
            "depth": 0,
            "options": {
                "allowDelegation": true,
                "delegationEnforcement": "strict",
                "maxDepth": 3,
                "maxDescendants": 20,
                "maxConcurrent": 4,
                "maxAttempts": 20,
                "priority": 5,
                "requirements": {},
                "preferences": { "models": [], "strengths": [] }
            }
        }
    });
    store.insert(&task, 1_800_000_000.0).unwrap();

    let token = format!("pwg_{}", "a".repeat(64));
    {
        let db = store.connection().unwrap();
        db.execute(
            "CREATE TABLE IF NOT EXISTS work_grants (hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL, kind TEXT NOT NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO work_grants (hash, task_id, attempt, expires, revoked, kind) VALUES (?1, 't-20261119-000000-abcd', 1, 1e18, 0, 'work')",
            [pacer_work::token_hash(&token)],
        )
        .unwrap();
        db.execute(
            "CREATE TABLE IF NOT EXISTS work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, \
             root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL, \
             dependencies TEXT NOT NULL DEFAULT '[]')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO work_nodes (task_id, parent_id, root_id, depth, options, dependencies) VALUES ('t-20261119-000000-abcd', 't-20261119-000000-abcd', 't-20261119-000000-abcd', 0, '{\"allowDelegation\":true, \"delegationEnforcement\":\"strict\", \"maxDepth\":3, \"maxDescendants\":20, \"maxConcurrent\":4, \"maxAttempts\":20, \"priority\":5, \"requirements\":{}, \"preferences\":{\"models\":[],\"strengths\":[]}}', '[]')",
            [],
        )
        .unwrap();
    }

    (dir, ctx, runtime, repo.to_str().unwrap().to_owned(), token)
}

fn granted_ctx(ctx: Ctx, token: &str) -> Ctx {
    let mut env = ctx.env.clone();
    env.insert("PACER_WORK_GRANT".to_string(), token.to_string());
    Ctx { env, ..ctx }
}

#[tokio::test]
async fn child_requires_request_id() {
    let (_dir, ctx, runtime, repo, token) = fixture();
    let ctx = granted_ctx(ctx, &token);
    let err = delegate_child(&ctx, &runtime, &json!({ "goal": "child", "repo": repo }))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::InvalidInput);
    assert_eq!(err.message, "Child delegation requires an idempotency requestId");
}

#[tokio::test]
async fn child_rejects_repo_override() {
    let (_dir, ctx, runtime, _repo, token) = fixture();
    let ctx = granted_ctx(ctx, &token);
    let err = delegate_child(
        &ctx,
        &runtime,
        &json!({ "goal": "child", "repo": "/tmp/other", "requestId": "r" }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, Code::NotAllowed);
    assert_eq!(err.message, "Child work must use its parent's repository");
}

#[tokio::test]
async fn child_allows_empty_repo() {
    let (_dir, ctx, runtime, _repo, token) = fixture();
    let ctx = granted_ctx(ctx, &token);
    // An empty repo string is treated as "not provided" (TS falsy check), so it
    // should pass the repo guard and only reach the idempotency check below.
    let err = delegate_child(&ctx, &runtime, &json!({ "goal": "child", "repo": "" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::InvalidInput);
    assert_eq!(err.message, "Child delegation requires an idempotency requestId");
}

#[tokio::test]
async fn child_work_options_flow_into_the_created_task() {
    let (_dir, ctx, runtime, _repo, token) = fixture();
    let ctx = granted_ctx(ctx, &token);
    let result = delegate_child(
        &ctx,
        &runtime,
        &json!({
            "goal": "child goal",
            "requestId": "child-req-1",
            "options": { "priority": 42, "maxAttempts": 7 }
        }),
    )
    .await
    .expect("granted child delegation should succeed");
    let child_id = result
        .get("task_id")
        .and_then(Value::as_str)
        .expect("delegate_child returns a task_id")
        .to_string();

    // The passed work options must survive into the created child's dispatch
    // (they are not dropped), proving `options -> dispatch` parity with
    // `delegateChild` (`src/core/work.ts:66`). The authoritative copy is the
    // child's `work_nodes` row, where `register` stores work options.
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let opts: Option<String> = {
        let db = store.connection().unwrap();
        db.query_row(
            "SELECT options FROM work_nodes WHERE task_id = ?1",
            [&child_id],
            |row| row.get(0),
        )
        .ok()
    };
    let options: Value =
        serde_json::from_str(&opts.expect("child work node exists")).unwrap();
    assert_eq!(options.pointer("/priority"), Some(&json!(42)));
    assert_eq!(options.pointer("/maxAttempts"), Some(&json!(7)));
    // The parent's options are inherited when the child supplies none: these come
    // from the parent's `work_nodes.options`, not the child request.
    assert_eq!(options.pointer("/allowDelegation"), Some(&json!(true)));
    assert_eq!(options.pointer("/requirements"), Some(&json!({})));
    assert_eq!(options.pointer("/maxConcurrent"), Some(&json!(4)));
    assert_eq!(options.pointer("/priority").map(|_| true), Some(true));
}