#![allow(clippy::unwrap_used)]
use super::*;
use pacer_store::messages;

const ID: &str = "t-20261119-000000-abcd";

fn fixture(state: &str, env_role: Option<&str>, own: Option<&str>) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    let mut env = std::collections::HashMap::new();
    if let Some(role) = env_role {
        env.insert("PACER_ROLE".into(), role.into());
    }
    if let Some(own) = own {
        env.insert("PACER_TASK_ID".into(), own.into());
    }
    let ctx = Ctx::with(home, pacer_home, env, 1_800_000_000.0);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let mut task = json!({
        "id": ID,
        "rev": 1,
        "createdAt": ctx.now,
        "brief": {"goal": "g", "repo": ctx.home.to_str().unwrap()},
        "state": state,
        "attempts": [],
        "origin": format!("task:t-20261119-000000-0001"),
    });
    if state == "needs_input" {
        task["question"] = json!({"text": "first", "at": 1.0});
    }
    store.insert(&task, ctx.now).unwrap();
    (dir, ctx)
}

#[test]
fn a_question_is_recorded_and_the_parent_is_notified() {
    let (_dir, ctx) = fixture("running", Some("executor"), Some(ID));
    // Give the task a parent so the question message has a recipient.
    let parent_id = "t-20261119-000000-0001";
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    store
        .insert(
            &json!({
                "id": parent_id, "rev": 1, "createdAt": ctx.now,
                "brief": {"goal": "parent", "repo": ctx.home.to_str().unwrap()},
                "state": "running", "attempts": [],
            }),
            ctx.now,
        )
        .unwrap();
    drop(store);

    let updated = ask_task(&ctx, ID, "which db?").unwrap();
    assert_eq!(updated["question"]["text"], json!("which db?"));
    assert_eq!(updated["question"]["at"], json!(ctx.now));

    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let thread = messages::thread(&mut store, ID, None, None).unwrap();
    let question = thread
        .iter()
        .find(|m| m["kind"] == json!("question") && m["from"] == json!(format!("task:{ID}")))
        .unwrap();
    assert_eq!(question["body"], json!("which db?"));
    assert_eq!(question["to"], json!(format!("task:{parent_id}")));
}

#[test]
fn a_second_ask_is_refused() {
    let (_dir, ctx) = fixture("needs_input", Some("executor"), Some(ID));
    let error = ask_task(&ctx, ID, "again").unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "already asked; stop and wait for the answer");
}

#[test]
fn a_settled_task_cannot_be_asked() {
    let (_dir, ctx) = fixture("done", Some("executor"), Some(ID));
    let error = ask_task(&ctx, ID, "late").unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "task is not running");
}

#[test]
fn only_the_task_own_executor_can_ask() {
    let (_dir, ctx) = fixture("running", Some("executor"), Some("t-20261119-000000-0001"));
    let error = ask_task(&ctx, ID, "not mine").unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "pacer ask works only inside a delegated task");
}

#[test]
fn a_question_over_1000_units_is_refused() {
    let (_dir, ctx) = fixture("running", Some("executor"), Some(ID));
    let error = ask_task(&ctx, ID, &"😀".repeat(501)).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
}
