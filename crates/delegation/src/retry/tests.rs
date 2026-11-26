#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSupervisor, RunnerSpawn};
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const STRATEGY: &str = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nexecution:\n  launch_mode: headless\n";

struct FakeSpawn;
impl RunnerSpawn for FakeSpawn {
    fn launch(&self, _: &Ctx, _: &str, _: Option<&str>) -> Result<Option<u32>, CoreError> {
        Ok(Some(4242))
    }
}

fn fixture() -> (TempDir, Ctx, Runtime, String) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    std::fs::write(pacer_home.join("strategy.yaml"), STRATEGY).unwrap();
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo = std::fs::canonicalize(repo).unwrap();
    let ctx = Ctx::with(home, pacer_home, Default::default(), 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(FakeSpawn),
        supervisor: Arc::new(NoSupervisor),
    };
    (dir, ctx, runtime, repo.to_str().unwrap().to_owned())
}

fn seed(ctx: &Ctx, id: &str, repo: &str, state: &str) {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    store
        .insert(
            &json!({
                "id": id, "rev": 1, "createdAt": ctx.now,
                "brief": {"goal": "g", "repo": repo},
                "title": "g", "state": state, "attempts": [],
                "kind": null, "source": "planner", "timeoutS": 600,
                "requestedExecutor": "codex",
            }),
            ctx.now,
        )
        .unwrap();
}

#[tokio::test]
async fn a_failed_task_retries_with_a_new_task_linked_to_the_parent() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261119-000000-abcd";
    seed(&ctx, id, &repo, "failed");
    let reply = retry_task(&ctx, &runtime, id, RetryInput::default())
        .await
        .unwrap();
    assert!(reply["retry"]["task_id"].as_str().is_some());
    assert_eq!(reply["of"]["state"], json!("failed"));
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let parent = store.read(id).unwrap().unwrap();
    assert!(parent["retriedBy"].as_str().is_some());
    let tasks = store.list_active_and_recent(0.0).unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn retry_all_skips_a_running_id_and_retries_a_failed_id() {
    let (_dir, ctx, runtime, repo) = fixture();
    seed(&ctx, "t-20261119-000000-abcd", &repo, "failed");
    seed(&ctx, "t-20261119-000000-beef", &repo, "running");
    seed(&ctx, "t-20261119-000000-cafe", &repo, "queued");
    {
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        store
            .update_current("t-20261119-000000-beef", ctx.now, |t| {
                t["retriedBy"] = json!("t-20261119-000000-cafe");
                Ok(())
            })
            .unwrap();
    }
    let reply = retry_all(
        &ctx,
        &runtime,
        &[
            "t-20261119-000000-abcd".into(),
            "t-20261119-000000-beef".into(),
        ],
        None,
        false,
    )
    .await
    .unwrap();
    assert_eq!(reply["retried"].as_array().unwrap().len(), 1);
    // A running task is not refused by the store but its retry is blocked by the
    // active-attempt check; retry_all reports it individually.
    assert_eq!(reply["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(reply["skipped"][0]["id"], json!("t-20261119-000000-beef"));
}

#[tokio::test]
async fn an_unknown_id_is_refused() {
    let (_dir, ctx, runtime, _repo) = fixture();
    let error = retry_task(
        &ctx,
        &runtime,
        "t-20261119-000000-abcd",
        RetryInput::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::UnknownTask);
}

#[tokio::test]
async fn a_wrong_revision_is_a_conflict() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261119-000000-abcd";
    seed(&ctx, id, &repo, "failed");
    let error = retry_task(
        &ctx,
        &runtime,
        id,
        RetryInput {
            expect_rev: Some(9),
            ..RetryInput::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "task changed");
}

#[tokio::test]
async fn ancestors_are_collected_in_sorted_order() {
    let (_dir, ctx, _runtime, repo) = fixture();
    seed(&ctx, "t-20261119-000000-0001", &repo, "failed");
    seed(&ctx, "t-20261119-000000-0002", &repo, "failed");
    {
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        store
            .update_current("t-20261119-000000-0002", ctx.now, |t| {
                t["retryOf"] = json!("t-20261119-000000-0001");
                Ok(())
            })
            .unwrap();
    }
    assert_eq!(
        ancestors(&ctx, "t-20261119-000000-0002"),
        vec![
            "t-20261119-000000-0001".to_owned(),
            "t-20261119-000000-0002".to_owned(),
        ]
    );
}
