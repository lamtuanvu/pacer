#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

fn ctx(env: &[(&str, &str)]) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let vars: HashMap<String, String> = env
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().join(".pacer"),
        vars.into_iter().collect(),
        1_000.0,
    );
    (dir, ctx)
}

fn message(op: &str, params: Value) -> String {
    let (_dir, ctx) = ctx(&[]);
    admit(&ctx, op, &params).unwrap_err().message
}

#[test]
fn issues_follow_schema_order() {
    assert_eq!(
        message(
            "session.agent.end",
            json!({"task_id": "t", "id": "x", "expect_rev": 0, "q": 1})
        ),
        "id: Invalid UUID; expect_rev: Too small: expected number to be >0; params: Unrecognized key: \"q\""
    );
    assert_eq!(
        message("session.file.read", json!({"id": "t", "attempt": "1"})),
        "attempt: Invalid input: expected number, received string; reference: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message("session.draft.create", json!([1])),
        "params: Invalid input: expected object, received array"
    );
}

#[test]
fn workspace_union_reports_the_selected_branch() {
    let issue = |workspace: Value| {
        let text = message("session.create", json!({ "workspace": workspace }));
        text.split("; ")
            .find(|part| part.starts_with("workspace"))
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        issue(json!({})),
        "workspace.mode: Invalid discriminator value. Expected 'new' | 'current'"
    );
    assert_eq!(
        issue(json!({"mode": "new"})),
        "workspace.base: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        issue(json!({"mode": "current", "path": ""})),
        "workspace.path: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        issue(json!(1)),
        "workspace: Invalid input: expected object, received number"
    );
}

#[test]
fn uuid_matches_zod_positions() {
    assert!(valid_draft_uuid("123e4567-e89b-12d3-a456-426614174000"));
    assert!(valid_draft_uuid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
    assert!(!valid_draft_uuid("123e4567-e89b-02d3-a456-426614174000"));
    assert!(!valid_draft_uuid("123e4567-e89b-12d3-c456-426614174000"));
    // A non-placeholder hyphen would break Zod's anchored pattern; the shared helper
    // still rejects a bad version nibble or a non-placeholder non-hex character.
    assert!(!valid_draft_uuid("123e4567_e89b-12d3-a456-426614174000"));
    // A sixth group breaks Zod's strict 8-4-4-4-12 shape (the attachment draft's
    // trailing extra chunk here is `-4174000`), so it must be rejected too.
    assert!(!valid_draft_uuid("123e4567-e89b-12d3-a456-4266-4174000"));
}

#[test]
fn inputs_zod_reads_differently_stay_forwarded() {
    let (_dir, plain) = ctx(&[]);
    let forwarded =
        |op: &str, params: Value| session_lifecycle_stays_forwarded(&plain, op, &params);
    assert!(forwarded(
        "session.end",
        json!({"id": "t", "expect_rev": 1.5})
    ));
    assert!(forwarded(
        "session.end",
        json!({"id": "t", "expect_rev": 9_007_199_254_740_992_u64})
    ));
    assert!(forwarded("session.agent.list", json!({"b": 1, "a": 2})));
    assert!(forwarded("session.agent.list", json!({"1": 1})));
    assert!(forwarded(
        "session.create",
        json!({"attachments": vec!["x"; 21]})
    ));
    assert!(!forwarded(
        "session.end",
        json!({"id": "t", "expect_rev": 2})
    ));
    assert!(!forwarded("session.agent.list", json!({"a": 1})));
    assert!(!forwarded("task.get", json!({"__proto__": 1})));
    let (_dir, granted) = ctx(&[("PACER_ASSISTANT_GRANT", "pag_x")]);
    assert!(session_lifecycle_stays_forwarded(
        &granted,
        "task.session",
        &json!({"id": "t"})
    ));
}

#[test]
fn enforcement_identity_is_refused_before_the_schema() {
    let (_dir, ctx) = ctx(&[("PACER_ENFORCEMENT_TOKEN", "pet_x")]);
    let error = admit(&ctx, "session.create", &json!("bad")).unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
}

#[test]
fn draft_create_writes_a_v4_draft() {
    let (_dir, ctx) = ctx(&[]);
    let Admission::Native(reply) = admit(&ctx, "session.draft.create", &Value::Null).unwrap()
    else {
        panic!("draft creation is native");
    };
    let id = reply["id"].as_str().unwrap();
    assert!(valid_draft_uuid(id));
    assert_eq!(id.as_bytes()[14], b'4');
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    assert_eq!(
        attachments::draft_attachments(&mut store, id, ctx.now).unwrap(),
        Some(Vec::new())
    );
}

#[test]
fn record_refusals_need_a_task() {
    let (_dir, ctx) = ctx(&[]);
    let end = admit(
        &ctx,
        "session.end",
        &json!({"id": "not-a-task", "expect_rev": 1}),
    )
    .unwrap_err();
    assert_eq!(
        (end.code, end.message.as_str()),
        (Code::UnknownTask, "unknown task not-a-task")
    );
    let read = admit(
        &ctx,
        "session.file.read",
        &json!({"id": "not-a-task", "attempt": 1, "reference": "a"}),
    )
    .unwrap_err();
    assert_eq!(
        (read.code, read.message.as_str()),
        (Code::UnknownTask, "Session not found")
    );
    assert_eq!(
        admit(&ctx, "task.session", &json!({"id": "not-a-task"})).unwrap(),
        Admission::Core
    );
}
