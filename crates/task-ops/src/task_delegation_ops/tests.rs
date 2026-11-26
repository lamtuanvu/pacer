#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;
use tempfile::{TempDir, tempdir};

const MISSING: &str = "t-20261119-000000-abcd";

fn ctx_with(env: &[(&str, &str)]) -> (TempDir, Ctx) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    let env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ctx = Ctx::with(home, pacer_home, env, 10.0);
    (dir, ctx)
}

fn message(ctx: &Ctx, op: &str, params: Value) -> String {
    admit(ctx, op, &params).unwrap_err().message
}

fn insert(ctx: &Ctx, id: &str, patch: Value) {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let mut task = json!({
        "id": id, "rev": 1, "brief": {"goal": "g", "repo": "/r"}, "state": "running",
        "createdAt": 1.0, "attempts": [], "timeoutS": 60, "requestedExecutor": null,
    });
    for (key, value) in patch.as_object().unwrap() {
        task[key] = value.clone();
    }
    store.insert(&task, 1.0).unwrap();
}

#[test]
fn the_enforcement_identity_is_refused_before_the_params() {
    let (_dir, ctx) = ctx_with(&[("PACER_ENFORCEMENT_TOKEN", "pet_x")]);
    for op in DELEGATION_OPS {
        assert_eq!(
            message(&ctx, op, json!("not an object")),
            "Enforcement identity only reports a native child denial"
        );
    }
}

#[test]
fn grant_holders_are_refused_natively() {
    let (_dir, assistant) = ctx_with(&[("PACER_ASSISTANT_GRANT", "pag_bad")]);
    for op in DELEGATION_OPS {
        assert_eq!(
            message(&assistant, op, json!({})),
            "Invalid assistant grant"
        );
    }
    let (_dir, work) = ctx_with(&[("PACER_WORK_GRANT", "pwg_x")]);
    for op in DELEGATION_OPS {
        assert_eq!(message(&work, op, json!({})), "Invalid work grant");
    }
}

#[test]
fn issues_follow_schema_key_order() {
    let (_dir, ctx) = ctx_with(&[]);
    assert_eq!(
        message(&ctx, "task.delegate", json!({})),
        "goal: Invalid input: expected string, received undefined; \
         repo: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message(
            &ctx,
            "task.delegate",
            json!({"grant": 1, "goal": "", "repo": "r", "title": "   ", "difficulty": "hard"})
        ),
        "difficulty: Invalid option: expected one of \"simple\"|\"standard\"|\"complex\"; \
         title: Too small: expected string to have >=1 characters; \
         goal: Too small: expected string to have >=1 characters; \
         grant: Invalid input: expected boolean, received number"
    );
    assert_eq!(
        message(&ctx, "task.retry_all", json!({"ids": [1, ""]})),
        "ids.0: Invalid input: expected string, received number; \
         ids.1: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        message(&ctx, "doctor.fix.delegate", json!({"check": ""})),
        "check: Too small: expected string to have >=1 characters; \
         scope: Invalid option: expected one of \"fix\"|\"investigate\""
    );
    assert_eq!(
        message(&ctx, "task.retry", json!([1])),
        "params: Invalid input: expected object, received array"
    );
}

#[test]
fn inputs_only_core_can_validate_stay_with_core() {
    let (_dir, ctx) = ctx_with(&[]);
    for (op, params) in [
        ("task.delegate", json!({"base": "main"})),
        ("task.delegate", json!({"messaging": 1})),
        ("task.delegate", json!({"goal": "", "timeout_min": 1.5})),
        ("task.answer", json!({"id": "", "expect_rev": 1e300})),
        (
            "task.retry",
            json!({"id": "", "expect_rev": 9_007_199_254_740_993_u64}),
        ),
    ] {
        assert_eq!(
            admit(&ctx, op, &params).unwrap(),
            Admission::Core,
            "{params}"
        );
    }
}

#[test]
fn executors_cannot_delegate_onward() {
    let (_dir, ctx) = ctx_with(&[("PACER_ROLE", "executor")]);
    for (op, params) in [
        ("task.delegate", json!({"goal": "g", "repo": "/r"})),
        ("task.retry", json!({"id": MISSING})),
        ("task.retry_all", json!({"ids": [MISSING]})),
        ("doctor.fix.delegate", json!({"check": "c", "scope": "fix"})),
    ] {
        assert_eq!(message(&ctx, op, params), EXECUTOR_DELEGATE_ERROR);
    }
    assert_eq!(
        message(&ctx, "task.answer", json!({"id": MISSING, "text": "a"})),
        "executors cannot delegate onward"
    );
}

#[test]
fn only_ids_that_cannot_name_a_task_are_answered_natively() {
    let (_dir, ctx) = ctx_with(&[]);
    assert_eq!(
        message(&ctx, "task.retry", json!({"id": "nope"})),
        "unknown task nope"
    );
    assert_eq!(
        message(&ctx, "task.answer", json!({"id": "nope", "text": "a"})),
        "unknown task nope"
    );
    // A well-formed id takes Core's work lease before it is found missing.
    for (op, params) in [
        ("task.retry", json!({"id": MISSING})),
        ("task.answer", json!({"id": MISSING, "text": "a"})),
        ("task.retry_all", json!({"ids": ["nope", MISSING]})),
    ] {
        assert_eq!(admit(&ctx, op, &params).unwrap(), Admission::Core);
    }
    assert_eq!(
        admit(&ctx, "task.retry_all", &json!({"ids": ["b", "a", "b"]})).unwrap(),
        Admission::Native(json!({"retried": [], "skipped": [
            {"id": "b", "reason": "unknown task b"},
            {"id": "a", "reason": "unknown task a"},
        ]}))
    );
}

#[test]
fn managed_work_stays_with_core() {
    let (_dir, ctx) = ctx_with(&[("PACER_ROLE", "executor")]);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    store
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TABLE work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
               depth INTEGER NOT NULL, options TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]');
             INSERT INTO work_nodes VALUES('t-20261119-000000-abcd',NULL,'t-20261119-000000-abcd',0,'{}','[]');",
        )
        .unwrap();
    assert_eq!(
        admit(&ctx, "task.answer", &json!({"id": MISSING, "text": "a"})).unwrap(),
        Admission::Core
    );
}

#[test]
fn an_answer_longer_than_its_utf16_limit_is_refused() {
    let (_dir, ctx) = ctx_with(&[]);
    assert_eq!(
        message(
            &ctx,
            "task.answer",
            json!({"id": MISSING, "text": "😀".repeat(1001)})
        ),
        "answer must contain 1–2000 characters"
    );
}

#[test]
fn ask_is_for_the_asking_executor_of_a_running_task() {
    let (_dir, planner) = ctx_with(&[]);
    assert_eq!(
        message(&planner, "task.ask", json!({"id": MISSING, "text": "q"})),
        "pacer ask works only inside a delegated task"
    );
    let (_dir, ctx) = ctx_with(&[("PACER_ROLE", "executor"), ("PACER_TASK_ID", MISSING)]);
    assert_eq!(
        message(&ctx, "task.ask", json!({"id": MISSING, "text": "q"})),
        format!("unknown task {MISSING}")
    );
    insert(&ctx, MISSING, json!({"question": {"text": "q", "at": 1.0}}));
    assert_eq!(
        message(&ctx, "task.ask", json!({"id": MISSING, "text": "q"})),
        "already asked; stop and wait for the answer"
    );
}

#[test]
fn ask_admits_a_running_task_and_refuses_a_settled_one() {
    let running = "t-20261119-000000-aaaa";
    let (_dir, ctx) = ctx_with(&[("PACER_ROLE", "executor"), ("PACER_TASK_ID", running)]);
    insert(&ctx, running, json!({}));
    assert_eq!(
        admit(&ctx, "task.ask", &json!({"id": running, "text": "q"})).unwrap(),
        Admission::Core
    );
    let settled = "t-20261119-000000-bbbb";
    let (_dir, ctx) = ctx_with(&[("PACER_ROLE", "executor"), ("PACER_TASK_ID", settled)]);
    insert(&ctx, settled, json!({"state": "done"}));
    assert_eq!(
        message(&ctx, "task.ask", json!({"id": settled, "text": "q"})),
        "task is not running"
    );
}
