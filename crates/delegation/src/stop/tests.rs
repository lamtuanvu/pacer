#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor, PluginCalls};
use pacer_foundation::api::OpFuture;
use pacer_lifecycle::AdmissionState;
use pacer_store::TaskStore;
use std::sync::{Arc, Mutex};
use tempfile::{TempDir, tempdir};

/// A `PluginCalls` double that records the method/params it was asked to call.
struct Recording {
    providers: Vec<String>,
    calls: Mutex<Vec<(String, Value)>>,
}

impl PluginCalls for Recording {
    fn providers(&self, _: &Ctx, method: &str) -> Vec<String> {
        if method.starts_with("executor.") || method == "host.stop" {
            self.providers.clone()
        } else {
            Vec::new()
        }
    }
    fn call<'a>(
        &'a self,
        _: &'a Ctx,
        plugin: &'a str,
        method: &'a str,
        params: Value,
        _: Duration,
    ) -> OpFuture<'a> {
        self.calls
            .lock()
            .unwrap()
            .push((format!("{plugin}:{method}"), params));
        Box::pin(async { Ok(json!({"ok": true})) })
    }
}

fn recording_runtime(providers: &[&str]) -> (Runtime, Arc<Recording>) {
    let recording = Arc::new(Recording {
        providers: providers.iter().map(|s| (*s).to_owned()).collect(),
        calls: Mutex::new(Vec::new()),
    });
    (
        Runtime {
            plugins: recording.clone(),
            spawn: Arc::new(NoSpawn),
            supervisor: Arc::new(NoSupervisor),
        },
        recording,
    )
}

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
                "brief": {"goal": "Stop me", "repo": "/repo"},
                "state": state,
                "attempts": [],
                "timeoutS": 60,
            }),
            ctx.now,
        )
        .unwrap();
}

#[tokio::test]
async fn stop_task_settles_a_queued_task() {
    let (_dir, ctx, runtime) = fixture();
    seed(&ctx, "t-20261106-000000-abcd", "queued");
    let reply = stop_task(
        &ctx,
        &runtime,
        "t-20261106-000000-abcd",
        StopOptions { signal: false, expect_rev: Some(1) },
    )
    .await
    .unwrap();
    assert_eq!(reply["state"], "stopped");
    assert_eq!(reply["result"]["report"], "stopped before an executor ran");
}

#[tokio::test]
async fn stop_task_marks_a_running_provider_pending() {
    let (_dir, ctx, runtime) = fixture();
    seed(&ctx, "t-20261106-000000-abcd", "running");
    TaskStore::open(&ctx.pacer_home)
        .unwrap()
        .update("t-20261106-000000-abcd", 1, ctx.now, |task| {
            task["executorProvider"] = json!("pacer-exec-direct");
        })
        .unwrap();
    let reply = stop_task(
        &ctx,
        &runtime,
        "t-20261106-000000-abcd",
        StopOptions { signal: false, expect_rev: None },
    )
    .await
    .unwrap();
    assert_eq!(reply["state"], "running");
    assert_eq!(reply["stop_pending"]["reason"], "user");
}

#[tokio::test]
async fn stop_work_stops_the_root_and_its_children() {
    let (_dir, ctx, runtime) = fixture();
    let root = "t-20261106-000000-0001";
    let a = "t-20261106-000000-0002";
    let b = "t-20261106-000000-0003";
    for id in [root, a, b] {
        seed(&ctx, id, "queued");
    }
    // Apply the dispatch schema (creates `work_nodes`) then seed the tree.
    drop(AdmissionState::open(&ctx.pacer_home).unwrap());
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let db = store.connection().unwrap();
    for (id, parent) in [(root, None), (a, Some(root)), (b, Some(root))] {
        let parent = parent.unwrap_or(id);
        let _ = db.execute(
            "INSERT OR IGNORE INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES (?1,?2,?3,0,'{}','[]')",
            rusqlite::params![id, if parent == id { None::<&str> } else { Some(parent) }, root],
        );
    }
    drop(store);

    stop_work(&ctx, &runtime, root, None).await.unwrap();
    for id in [root, a, b] {
        let task = TaskStore::open(&ctx.pacer_home).unwrap().read(id).unwrap().unwrap();
        assert_eq!(task["state"], "stopped", "{id} should be stopped");
    }
}

#[tokio::test]
async fn stop_writes_a_task_settled_activity() {
    let (_dir, ctx, runtime) = fixture();
    let id = "t-20261106-000000-0005";
    seed(&ctx, id, "queued");
    stop_task(&ctx, &runtime, id, StopOptions { signal: false, expect_rev: None })
        .await
        .unwrap();
    let log = std::fs::read_to_string(ctx.pacer_home.join("state/activity.jsonl")).unwrap();
    let lines: Vec<Value> = log.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert!(lines.iter().any(|line| line["kind"] == "task_settled"
        && line["taskId"] == json!(id)
        && line["text"].as_str().is_some_and(|text| text.contains("Stopped"))));
}

#[test]
fn only_starting_or_running_agent_sessions_hold_a_wait() {
    let (_dir, ctx, _runtime) = fixture();
    let mut store = pacer_store::TaskStore::open(&ctx.pacer_home).unwrap();
    let db = store.connection().unwrap();
    db.execute_batch(
        "CREATE TABLE agent_sessions(id TEXT PRIMARY KEY, task TEXT, record TEXT); \
         INSERT INTO agent_sessions VALUES('s-1','t-1','{\"state\":\"running\"}'); \
         INSERT INTO agent_sessions VALUES('s-2','t-2','{\"state\":\"ended\"}');",
    )
    .unwrap();
    assert!(active_agent_sessions(db, "t-1"));
    assert!(!active_agent_sessions(db, "t-2"));
}

#[tokio::test]
async fn stop_issues_live_worker_release_through_plugin_calls() {
    let (_dir, ctx, _runtime) = fixture();
    let id = "t-20261106-000000-0006";
    seed(&ctx, id, "needs_input");
    TaskStore::open(&ctx.pacer_home)
        .unwrap()
        .update(id, 1, ctx.now, |task| {
            task["live"] = json!(true);
            task["executorProvider"] = json!("pacer-exec-orca");
            task["attempts"] = json!([{"executor": "pacer-exec-orca", "startedAt": ctx.now, "endedAt": ctx.now}]);
        })
        .unwrap();
    let (runtime, recording) = recording_runtime(&["pacer-exec-orca"]);
    stop_task(&ctx, &runtime, id, StopOptions { signal: true, expect_rev: None })
        .await
        .unwrap();
    let calls = recording.calls.lock().unwrap().clone();
    assert!(calls.iter().any(|(method, params)| method == "pacer-exec-orca:executor.stop"
        && params["taskId"] == json!(id)
        && params["graceMs"] == 0));
}

#[tokio::test]
async fn stop_issues_remote_host_stop_through_plugin_calls() {
    let (_dir, ctx, _runtime) = fixture();
    let id = "t-20261106-000000-0007";
    seed(&ctx, id, "queued");
    TaskStore::open(&ctx.pacer_home)
        .unwrap()
        .update(id, 1, ctx.now, |task| {
            task["run"] = json!({"host": "devbox", "remoteDir": "/tmp/remote"});
        })
        .unwrap();
    let (runtime, recording) = recording_runtime(&["pacer-ssh"]);
    stop_task(&ctx, &runtime, id, StopOptions { signal: true, expect_rev: None })
        .await
        .unwrap();
    let calls = recording.calls.lock().unwrap().clone();
    assert!(calls.iter().any(|(method, params)| method == "pacer-ssh:host.stop"
        && params["host"] == "devbox"
        && params["remoteDir"] == "/tmp/remote"));
}
