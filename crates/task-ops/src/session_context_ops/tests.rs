#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use std::collections::HashMap;

const TASK: &str = "t-20261107-120000-abcd";
const DRAFT: &str = "00000000-0000-4000-8000-000000000001";
const NOW: f64 = 1_700_000_000.0;

fn home(task: Option<Value>) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let pacer_home = dir.path().to_path_buf();
    let mut store = TaskStore::open(&pacer_home).unwrap();
    if let Some(task) = task {
        store.insert(&task, NOW).unwrap();
    }
    let ctx = Ctx::with(pacer_home.clone(), pacer_home, HashMap::new(), NOW);
    (dir, ctx)
}

fn conversation(extra: Value) -> Value {
    let mut task = json!({
        "id": TASK,
        "rev": 4,
        "brief": {"goal": "Talk", "repo": "/tmp/r"},
        "state": "running",
        "createdAt": NOW,
        "attempts": [],
        "timeoutS": 60,
        "interactionMode": "conversation",
    });
    for (key, value) in extra.as_object().unwrap() {
        task[key] = value.clone();
    }
    task
}

fn call(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    context(ctx, &params)
}

fn seed(ctx: &Ctx, sql: &str) {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    attachments::ensure_schema(&mut store).unwrap();
    store.connection().unwrap().execute_batch(sql).unwrap();
}

#[test]
fn params_follow_zod_issue_text() {
    let (_dir, ctx) = home(None);
    let message = |params: Value| call(&ctx, params).unwrap_err().message;
    assert_eq!(
        message(json!(null)),
        "id: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message(json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        message(json!({"id": 1})),
        "id: Invalid input: expected string, received number"
    );
    assert_eq!(
        message(json!({"id": "a b"})),
        "id: Invalid string: must match pattern /^[A-Za-z0-9_-]{1,128}$/"
    );
}

#[test]
fn refuses_unknown_and_non_conversation_tasks() {
    let (_dir, ctx) = home(Some(conversation(json!({"interactionMode": "headless"}))));
    let unknown = call(&ctx, json!({"id": "request"})).unwrap_err();
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        (Code::UnknownTask, "unknown task request")
    );
    let headless = call(&ctx, json!({"id": TASK})).unwrap_err();
    assert_eq!(headless.code, Code::NotAllowed);
}

#[test]
fn enforcement_identity_is_refused_before_params() {
    let (_dir, mut ctx) = home(None);
    ctx.env.insert("PACER_ENFORCEMENT_TOKEN".into(), "x".into());
    assert_eq!(call(&ctx, json!(5)).unwrap_err().code, Code::NotAllowed);
}

#[test]
fn conversation_without_draft_omits_draft_id() {
    let (_dir, ctx) = home(Some(conversation(json!({}))));
    let result = call(&ctx, json!({"id": TASK})).unwrap();
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        r#"{"attachments":[],"rev":4}"#
    );
}

#[test]
fn lists_ready_draft_attachments() {
    let (_dir, ctx) = home(Some(conversation(json!({"sessionDraftId": DRAFT}))));
    seed(
        &ctx,
        &format!(
            "INSERT INTO attachment_drafts VALUES('{DRAFT}',{NOW},'{TASK}');
             INSERT INTO attachments VALUES('a1','{DRAFT}','b','n.txt','text/plain',3,'{TASK}','ready');"
        ),
    );
    let result = call(&ctx, json!({"id": TASK})).unwrap();
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        format!(
            r#"{{"draftId":"{DRAFT}","attachments":[{{"id":"a1","name":"n.txt","mime":"text/plain","size":3}}],"rev":4}}"#
        )
    );
}

#[test]
fn missing_or_expired_draft_is_not_found() {
    let (_dir, ctx) = home(Some(conversation(json!({"sessionDraftId": DRAFT}))));
    let missing = call(&ctx, json!({"id": TASK})).unwrap_err();
    assert_eq!(missing.code, Code::NotFound);
    seed(
        &ctx,
        &format!(
            "INSERT INTO attachment_drafts VALUES('{DRAFT}',{},NULL);",
            NOW - 86_400.0
        ),
    );
    assert_eq!(
        call(&ctx, json!({"id": TASK})).unwrap_err().message,
        "Attachment draft expired or does not exist"
    );
}
