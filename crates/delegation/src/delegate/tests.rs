#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor};
use pacer_store::TaskStore;
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const STRATEGY: &str = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nmessaging:\n  grants: {}\n";

fn fixture() -> (TempDir, Ctx, Runtime, String) {
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
    (dir, ctx, runtime, repo.to_str().unwrap().to_owned())
}

fn seed_task(ctx: &Ctx, id: &str, repo: &str, request_id: &str) {
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    store
        .insert(
            &json!({
                "id": id,
                "rev": 1,
                "createdAt": ctx.now,
                "brief": {"goal": "g", "repo": repo},
                "state": "queued",
                "attempts": [],
                "requestId": request_id,
            }),
            ctx.now,
        )
        .unwrap();
}

#[tokio::test]
async fn the_same_request_id_returns_the_same_task() {
    let (_dir, ctx, runtime, repo) = fixture();
    seed_task(&ctx, "t-20261119-000000-abcd", &repo, "req-1");
    let reply = delegate(
        &ctx,
        &runtime,
        &json!({"goal": "g", "repo": repo, "request_id": "req-1"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(reply["task_id"], json!("t-20261119-000000-abcd"));
}

#[tokio::test]
async fn a_different_brief_for_the_same_request_id_is_a_conflict() {
    let (_dir, ctx, runtime, repo) = fixture();
    seed_task(&ctx, "t-20261119-000000-abcd", &repo, "req-1");
    let error = delegate(
        &ctx,
        &runtime,
        &json!({"goal": "different", "repo": repo, "request_id": "req-1"}),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "request_id was already used for a different brief");
}

#[tokio::test]
async fn an_unknown_executor_is_refused_before_a_task_is_created() {
    let (_dir, ctx, runtime, repo) = fixture();
    let error = delegate(
        &ctx,
        &runtime,
        &json!({"goal": "g", "repo": repo, "executor": "not-configured"}),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    assert!(store.list_live().unwrap().is_empty());
}

#[test]
fn strict_candidate_skip_reports_the_first_unready_candidate() {
    let ready = json!({"runners": {"codex": {}}});
    assert!(strict_candidate_skip(&ready, &json!({})).is_none());

    let disabled = json!({
        "runners": {
            "codex": {"enabled": false, "unavailableReason": "not installed"},
            "claude-code": {"enabled": false, "unavailableReason": "not signed in"},
        }
    });
    let skip = strict_candidate_skip(&disabled, &json!({})).unwrap();
    assert_eq!(skip["reason"], json!("unavailable"));
    assert!(skip["detail"].as_str().unwrap().contains("codex"));

    let skip = strict_candidate_skip(
        &json!({"runners": {"codex": {"enabled": false}}}),
        &json!({"executor": "codex"}),
    )
    .unwrap();
    assert!(skip["detail"].as_str().unwrap().contains("codex"));
}

#[tokio::test]
async fn a_task_stays_queued_when_spawn_is_unavailable() {
    let (_dir, ctx, runtime, repo) = fixture();
    let reply = delegate(&ctx, &runtime, &json!({"goal": "g", "repo": repo}), None)
        .await
        .unwrap();
    assert_eq!(reply["state"], json!("queued"));
    let id = reply["task_id"].as_str().unwrap().to_owned();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = store.read(&id).unwrap().unwrap();
    assert_eq!(task["state"], json!("queued"));
}
