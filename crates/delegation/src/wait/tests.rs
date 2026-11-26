#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor};
use pacer_store::TaskStore;
use serde_json::json;
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

fn fixture() -> (TempDir, Ctx, Runtime) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    let ctx = Ctx::with(home, pacer_home, Default::default(), 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NoSpawn),
        supervisor: Arc::new(NoSupervisor),
    };
    (dir, ctx, runtime)
}

fn seed(ctx: &Ctx, id: &str, state: &str) {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    store
        .insert(
            &json!({
                "id": id,
                "rev": 1,
                "createdAt": ctx.now,
                "brief": {"goal": "Wait me", "repo": "/repo"},
                "state": state,
                "attempts": [],
                "timeoutS": 60,
            }),
            ctx.now,
        )
        .unwrap();
}

#[tokio::test]
async fn wait_task_returns_a_settled_task_without_supervision() {
    let (_dir, ctx, runtime) = fixture();
    let id = "t-20261106-000000-0004";
    seed(&ctx, id, "queued");
    TaskStore::open(&ctx.pacer_home)
        .unwrap()
        .update(id, 1, ctx.now, |task| task["state"] = json!("done"))
        .unwrap();
    let reply = wait_task(&ctx, &runtime, id, 1).await.unwrap();
    assert_eq!(reply["state"], "done");
    assert_eq!(reply["task_id"], json!(id));
}

#[tokio::test]
async fn wait_task_reports_unknown_tasks() {
    let (_dir, ctx, runtime) = fixture();
    let error = wait_task(&ctx, &runtime, "t-20261106-000000-miss", 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::UnknownTask);
}
