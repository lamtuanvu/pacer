#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor};
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const ID: &str = "t-20261119-000000-abcd";

fn fixture(state: &str, role: Option<&str>) -> (TempDir, Ctx, Runtime) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    let mut env = std::collections::HashMap::new();
    if let Some(role) = role {
        env.insert("PACER_ROLE".into(), role.into());
    }
    let ctx = Ctx::with(home, pacer_home, env, 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NoSpawn),
        supervisor: Arc::new(NoSupervisor),
    };
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = json!({
        "id": ID, "rev": 1, "createdAt": ctx.now,
        "brief": {"goal": "g", "repo": ctx.home.to_str().unwrap()},
        "state": state, "attempts": [], "source": "planner",
    });
    store.insert(&task, ctx.now).unwrap();
    (dir, ctx, runtime)
}

#[tokio::test]
async fn an_executor_cannot_answer() {
    let (_dir, ctx, runtime) = fixture("needs_input", Some("executor"));
    let error = answer_task(&ctx, &runtime, ID, "a", None).await.unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "executors cannot delegate onward");
}

#[tokio::test]
async fn an_answer_over_2000_units_is_refused() {
    let (_dir, ctx, runtime) = fixture("needs_input", None);
    let error = answer_task(&ctx, &runtime, ID, &"😀".repeat(1001), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(error.message, "answer must contain 1–2000 characters");
}

#[tokio::test]
async fn an_unknown_task_is_refused() {
    let (_dir, ctx, runtime) = fixture("needs_input", None);
    let error = answer_task(&ctx, &runtime, "t-20261119-000000-beef", "a", None)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::UnknownTask);
}

#[tokio::test]
async fn a_managed_task_without_a_session_is_refused() {
    let (_dir, ctx, runtime) = fixture("done", None);
    {
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        store
            .connection()
            .unwrap()
            .execute_batch(
                "CREATE TABLE work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]');
                 INSERT INTO work_nodes VALUES('t-20261119-000000-abcd',NULL,'t-20261119-000000-abcd',0,'{}','[]');",
            )
            .unwrap();
    }
    let error = answer_task(&ctx, &runtime, ID, "a", None).await.unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(
        error.message,
        "Use dispatch.answer with a requestId and revision for managed work"
    );
}

#[tokio::test]
async fn a_stale_revision_is_a_conflict() {
    let (_dir, ctx, runtime) = fixture("needs_input", None);
    let error = answer_task(&ctx, &runtime, ID, "a", Some(99)).await.unwrap_err();
    assert_eq!(error.code, Code::Conflict);
}

#[test]
fn a_builtin_task_without_an_interactive_run_is_not_live() {
    let (_dir, ctx, _runtime) = fixture("needs_input", None);
    let store_read = {
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        store.read(ID).unwrap().unwrap()
    };
    assert!(!direct_input_available(&store_read));
}
