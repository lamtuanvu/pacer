//! B2-1 parity tests: the gate's exact refusal strings from `src/core/work.ts`.
#![allow(clippy::unwrap_used)]
use super::*;
use pacer_foundation::{Ctx, api::Code};
use pacer_store::TaskStore;
use rusqlite::params;
use serde_json::json;

fn ctx_with(env: &[(&str, &str)], home: &std::path::Path) -> Ctx {
    Ctx {
        home: home.to_path_buf(),
        pacer_home: home.join(".pacer"),
        env: env
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        now: 1_800_000_000.0,
    }
}

/// A valid `pwg_` token shape: `pwg_` + 64 hex chars.
fn token() -> String {
    format!("pwg_{}", "a".repeat(64))
}

/// Build `state/tasks.db` with the `work` schema and seed a running task record, the
/// `work_nodes` rows (root; child with `parent_id = root`) and a `work` grant row for
/// `root` with `hash = token_hash(token)`. `attempts_len` sets the task's `attempts`
/// length. Returns the issued token.
fn seed(
    dir: &std::path::Path,
    root: &str,
    child: &str,
    grant_attempt: i64,
    attempts_len: i64,
    expires: f64,
    revoked: i64,
) -> String {
    let token = token();
    let ctx = ctx_with(&[], dir);
    std::fs::create_dir_all(dir.join(".pacer/state")).unwrap();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = store.connection().unwrap();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_grants(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, \
         attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, \
         kind TEXT NOT NULL DEFAULT 'work', conversation_id TEXT NOT NULL DEFAULT ''); \
         CREATE TABLE IF NOT EXISTS work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, \
         root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL, \
         dependencies TEXT NOT NULL DEFAULT '[]');",
    )
    .unwrap();
    let attempts: Vec<serde_json::Value> = (0..attempts_len).map(|_| json!({})).collect();
    let record = json!({
        "id": root, "rev": 2, "state": "running", "createdAt": 10, "updatedAt": 10,
        "attempts": attempts, "brief": {"goal": format!("goal {root}"), "repo": "/repo"}
    });
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) \
         VALUES(?,?,?,?,?,?,?,?,0)",
        params![
            root,
            2,
            "running",
            10.0,
            10.0,
            Option::<f64>::None,
            Option::<String>::None,
            record.to_string()
        ],
    )
    .unwrap();
    if child != root {
        let child_record = json!({
            "id": child, "rev": 2, "state": "running", "createdAt": 10, "updatedAt": 10,
            "attempts": [], "brief": {"goal": format!("goal {child}"), "repo": "/repo"}
        });
        db.execute(
            "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) \
             VALUES(?,?,?,?,?,?,?,?,0)",
            params![
                child,
                2,
                "running",
                10.0,
                10.0,
                Option::<f64>::None,
                Option::<String>::None,
                child_record.to_string()
            ],
        )
        .unwrap();
    }
    let options = json!({"delegationEnforcement": "strict"});
    db.execute(
        "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)",
        params![root, Option::<String>::None, root, 0, options.to_string(), "[]"],
    )
    .unwrap();
    if child != root {
        db.execute(
            "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)",
            params![child, Some(root.to_string()), root, 1, options.to_string(), "[]"],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO work_grants(hash,task_id,attempt,expires,revoked,kind) VALUES(?,?,?,?,?, 'work')",
        params![token_hash(&token), root, grant_attempt, expires, revoked],
    )
    .unwrap();
    token
}

/// A live grant of `root` with `attempts = attempt - 1`, so `attempt === len + 1`.
fn seed_grant(
    dir: &std::path::Path,
    root: &str,
    child: &str,
    attempt: i64,
    expires: f64,
) -> String {
    seed(dir, root, child, attempt, attempt - 1, expires, 0)
}

/// A grant with `attempts = attempt`, so `attempt` is the wrong attempt.
fn seed_grant_with(
    dir: &std::path::Path,
    id: &str,
    id_alias: &str,
    attempt: i64,
    expires: f64,
    revoked: i64,
) -> String {
    seed(dir, id, id_alias, attempt, attempt, expires, revoked)
}

#[test]
fn assistant_grant_is_refused_before_anything_else() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(
        &[
            ("PACER_ASSISTANT_GRANT", "pag_bad"),
            ("PACER_WORK_GRANT", "pwg_x"),
        ],
        dir.path(),
    );
    let e = authorize_work_operation(&ctx, "msg.inbox", &json!({}), false).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (Code::NotAllowed, "Invalid assistant grant")
    );
}

#[test]
fn enforcement_identity_only_reports_denials() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(&[("PACER_ENFORCEMENT_TOKEN", "pet_x")], dir.path());
    assert_eq!(
        authorize_work_operation(&ctx, "task.stop", &json!({"id": "t"}), false)
            .unwrap_err()
            .message,
        "Enforcement identity only reports a native child denial"
    );
    assert!(
        authorize_work_operation(&ctx, "dispatch.enforcement.denied", &json!({}), false).is_ok()
    );
}

#[test]
fn executor_without_grant_cannot_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(&[("PACER_ROLE", "executor")], dir.path());
    assert_eq!(
        authorize_work_operation(&ctx, "dispatch.tree", &json!({"id": "t"}), true)
            .unwrap_err()
            .message,
        "A scoped work grant is required"
    );
}

#[test]
fn live_grant_scopes_to_subtree() {
    let dir = tempfile::tempdir().unwrap();
    let token = seed_grant(dir.path(), "root1", "child1", 1, 9e12);
    let ctx = ctx_with(&[("PACER_WORK_GRANT", &token)], dir.path());
    assert!(
        authorize_work_operation(&ctx, "dispatch.wait", &json!({"id": "child1"}), true).is_ok()
    );
    assert_eq!(
        authorize_work_operation(&ctx, "dispatch.wait", &json!({"id": "other"}), true)
            .unwrap_err()
            .message,
        "Operation is outside the delegated subtree"
    );
    assert_eq!(
        authorize_work_operation(&ctx, "project.strategy.list", &json!({}), true)
            .unwrap_err()
            .message,
        "Operation is not allowed by this work grant"
    );
    assert_eq!(
        authorize_work_operation(&ctx, "dispatch.wait", &json!({}), true)
            .unwrap_err()
            .message,
        "Task id is required"
    );
}

#[test]
fn expired_revoked_or_wrong_attempt_grants_are_refused() {
    for (attempt, expires, revoked) in [(2, 9e12, 0), (1, 1.0, 0), (1, 9e12, 1)] {
        let dir = tempfile::tempdir().unwrap();
        let token = seed_grant_with(dir.path(), "root1", "root1", attempt, expires, revoked);
        let ctx = ctx_with(&[("PACER_WORK_GRANT", &token)], dir.path());
        assert_eq!(
            authorize_work_grant(&ctx, &token).unwrap_err().message,
            "Expired or revoked work grant"
        );
    }
}

#[test]
fn assistant_grant_turn_binding() {
    let dir = tempfile::tempdir().unwrap();
    // A live `pag_` region: seed an assistant grant row by hand.
    let ctx = ctx_with(&[], dir.path());
    std::fs::create_dir_all(dir.path().join(".pacer/state")).unwrap();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = store.connection().unwrap();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_grants(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, \
         attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, \
         kind TEXT NOT NULL DEFAULT 'work', conversation_id TEXT NOT NULL DEFAULT '');",
    )
    .unwrap();
    let token = format!("pag_{}", "b".repeat(64));
    db.execute(
        "INSERT INTO work_grants(hash,task_id,attempt,expires,revoked,kind,conversation_id) \
         VALUES(?,?,0,?,0,'assistant', 'conv-1')",
        params![token_hash(&token), "turn-1", 9e12],
    )
    .unwrap();
    let ctx = ctx_with(&[("PACER_ASSISTANT_GRANT", &token)], dir.path());
    // assistant.tool for its own turn is allowed (the op body is elsewhere).
    assert!(
        authorize_work_operation(&ctx, "assistant.tool", &json!({"turnId": "turn-1"}), true)
            .is_ok()
    );
    // Anything else answers for nothing.
    assert_eq!(
        authorize_work_operation(&ctx, "dispatch.tree", &json!({"id": "t"}), true)
            .unwrap_err()
            .message,
        "An assistant grant runs assistant.tool only."
    );
    // A different turn is refused before the op body.
    assert_eq!(
        authorize_work_operation(&ctx, "assistant.tool", &json!({"turnId": "turn-2"}), true)
            .unwrap_err()
            .message,
        "This assistant grant belongs to another turn."
    );
}

#[test]
fn executor_review_refusals() {
    let dir = tempfile::tempdir().unwrap();
    // Without a grant, task.review from an executor is refused.
    let ctx = ctx_with(&[("PACER_ROLE", "executor")], dir.path());
    assert_eq!(
        authorize_work_operation(
            &ctx,
            "task.review",
            &json!({"id": "t", "verdict": "accept"}),
            true
        )
        .unwrap_err()
        .message,
        TASK_REVIEW_REFUSAL
    );
    // The planner variants are refused outright.
    let ctx2 = ctx_with(&[("PACER_ROLE", "executor")], dir.path());
    assert_eq!(
        authorize_work_operation(
            &ctx2,
            "task.review",
            &json!({"id": "t", "verdict": "retry"}),
            true
        )
        .unwrap_err()
        .message,
        TASK_REVIEW_VARIANTS_REFUSAL
    );
}

#[test]
fn no_grant_plain_ops_are_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(&[], dir.path());
    // No grant, not an executor: plain reads pass.
    assert!(authorize_work_operation(&ctx, "dispatch.tree", &json!({"id": "t"}), false).is_ok());
    // Executor but not a dispatch op → no grant refusal does not apply.
    let ctx2 = ctx_with(&[("PACER_ROLE", "executor")], dir.path());
    assert!(authorize_work_operation(&ctx2, "task.get", &json!({"id": "t"}), true).is_ok());
}
