#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSupervisor, RunnerSpawn, PluginCalls};
use std::collections::HashMap;
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const STRATEGY: &str = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nexecution:\n  launch_mode: headless\n";

struct FakeSpawn;
impl RunnerSpawn for FakeSpawn {
    fn launch(&self, _: &Ctx, _: &str, _: Option<&str>) -> Result<Option<u32>, CoreError> {
        Ok(Some(4242))
    }
}

struct VetoPlugins;
impl PluginCalls for VetoPlugins {
    fn providers(&self, _: &Ctx, method: &str) -> Vec<String> {
        if method == "policy.before" {
            vec!["policy-fixture".into()]
        } else {
            Vec::new()
        }
    }
    fn call<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        _: &'a str,
        _: Value,
        _: Duration,
    ) -> pacer_foundation::api::OpFuture<'a> {
        Box::pin(async { Ok(json!({"verdict":"veto","reason":"closed policy denies reviews"})) })
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
    let ctx = Ctx::with(home, pacer_home, HashMap::new(), 1_800_000_000.0);
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
                "brief": {"goal": "Review me", "repo": repo},
                "title": "Review me", "state": state, "attempts": [],
                "kind": "feature", "source": "planner", "timeoutS": 600,
                "requestedExecutor": "codex",
            }),
            ctx.now,
        )
        .unwrap();
    store
        .update_current(id, ctx.now, |t| {
            t["fixtureRev"] = json!(2);
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn accept_records_verdict_label_and_activity() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261120-000000-abcd";
    seed(&ctx, id, &repo, "done");
    let reply = review_task(&ctx, &runtime, id, Verdict::Accept, None, Some("ship it"), None)
        .await
        .unwrap();
    assert_eq!(reply["task"]["review"]["accepted"], true);
    let task = read_task(&ctx, id).unwrap();
    assert_eq!(task["review"]["note"], "ship it");
    assert_eq!(task["resolved"], "reviewed");
    let labels = std::fs::read_to_string(ctx.pacer_home.join("labels.jsonl")).unwrap();
    assert!(labels.contains("task_review"));
    assert!(labels.contains("ship it"));
}

#[tokio::test]
async fn reject_is_a_verdict_too() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261120-000000-beef";
    seed(&ctx, id, &repo, "done");
    let reply = review_task(&ctx, &runtime, id, Verdict::Reject, None, None, None)
        .await
        .unwrap();
    assert_eq!(reply["task"]["review"]["accepted"], false);
}

#[tokio::test]
async fn send_back_with_a_note_retries_when_no_turn_starts() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261120-000000-cafe";
    seed(&ctx, id, &repo, "done");
    let reply = review_task(
        &ctx,
        &runtime,
        id,
        Verdict::SendBack("please handle errors".into()),
        None,
        Some("please handle errors"),
        None,
    )
    .await
    .unwrap();
    assert!(reply["retry"]["id"].as_str().is_some());
    let task = read_task(&ctx, id).unwrap();
    assert_eq!(task["review"]["accepted"], false);
    assert!(task["retriedBy"].as_str().is_some());
    assert!(task["review"]["note"].as_str().unwrap().contains("please handle errors"));
}

#[tokio::test]
async fn retry_verdict_restarts_the_task() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261120-000000-d00d";
    seed(&ctx, id, &repo, "failed");
    let input = RetryInput {
        executor: Some("codex".into()),
        fresh_from_run_branch: true,
        ..RetryInput::default()
    };
    let reply = review_task(&ctx, &runtime, id, Verdict::Retry(input), None, None, None)
        .await
        .unwrap();
    assert!(reply["retry"]["id"].as_str().is_some());
}

#[tokio::test]
async fn closed_policy_veto_denies_a_review() {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    std::fs::write(
        pacer_home.join("strategy.yaml"),
        "planner: claude-code\nplugins:\n  policy:\n    mode: closed\nproviders:\n  claude-code: {}\n",
    )
    .unwrap();
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo = std::fs::canonicalize(repo).unwrap();
    let ctx = Ctx::with(home, pacer_home, HashMap::new(), 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(VetoPlugins),
        spawn: Arc::new(FakeSpawn),
        supervisor: Arc::new(NoSupervisor),
    };
    let id = "t-20261120-000000-face";
    seed(&ctx, id, repo.to_str().unwrap(), "done");
    let error = review_task(&ctx, &runtime, id, Verdict::Accept, None, None, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert!(error.message.contains("closed policy denies"));
    assert!(read_task(&ctx, id).unwrap().get("review").is_none());
}

#[tokio::test]
async fn managed_work_review_is_native() {
    let (_dir, ctx, runtime, repo) = fixture();
    let id = "t-20261120-000000-aaaa";
    seed(&ctx, id, &repo, "done");
    {
        let mut state = AdmissionState::open(&ctx.pacer_home).unwrap();
        state.register(id, &json!({"kind":"feature","difficulty":"simple"}), None, ctx.now).unwrap();
    }
    let reply = review_work(&ctx, &runtime, id, true, Some("looks good"), Some(2))
        .await
        .unwrap();
    assert_eq!(reply["task"]["review"]["accepted"], true);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = store.connection().unwrap();
    let events: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM work_events WHERE task_id=?1 AND kind='work.reviewed'",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(events, 1);
}
