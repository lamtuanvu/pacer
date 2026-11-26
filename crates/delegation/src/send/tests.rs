#![allow(clippy::unwrap_used)]
use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::{TempDir, tempdir};

const ID: &str = "t-20261119-000000-abcd";

/// Seed a task whose delivery is into a live (Orca) worker, mirroring
/// `src/plugins/executor-orca.ts`: `live.backend` set and no built-in `run.dir`.
/// `path` (when `Some`) is prepended to `PATH` in the `Ctx`, so `live_send`'s
/// `orca` subprocess resolves to the injected fake.
fn live_fixture(oxide: Value, path: Option<PathBuf>) -> (TempDir, Ctx, Runtime) {
    let dir = tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    std::fs::create_dir_all(pacer_home.join("state")).unwrap();
    let mut env = std::collections::HashMap::new();
    if let Some(path) = path {
        let previous = std::env::var_os("PATH").unwrap_or_default();
        env.insert(
            "PATH".to_owned(),
            format!("{}:{}", path.display(), previous.to_string_lossy()),
        );
    }
    let ctx = Ctx::with(home, pacer_home, env, 1_800_000_000.0);
    let runtime = Runtime {
        plugins: Arc::new(NoPlugins),
        spawn: Arc::new(NoSpawn),
        supervisor: Arc::new(NoSupervisor),
    };
    let mut task = json!({
        "id": ID, "rev": 1, "createdAt": ctx.now, "source": "planner",
        "brief": {"goal": "g", "repo": ctx.home.to_str().unwrap()},
        "state": "running", "attempts": [],
        "live": {"backend": "orca", "terminal": "term_one"},
    });
    if let (Value::Object(task), Value::Object(over)) = (&mut task, oxide) {
        task.extend(over);
    }
    TaskStore::open(&ctx.pacer_home).unwrap().insert(&task, ctx.now).unwrap();
    (dir, ctx, runtime)
}

/// A fake `orca` executable that prints `stdout` and exits `status`. Returns the
/// directory on `PATH` that provides it.
fn fake_orca(stdout: &str, status: i32) -> TempDir {
    let dir = tempdir().unwrap();
    let script = dir.path().join("orca");
    // The JSON payload carries no single quotes, so it is safe inside `' … '`.
    std::fs::write(
        &script,
        format!("#!/bin/sh\nprintf '%s' '{stdout}'\nexit {status}\n"),
    )
    .unwrap();
    std::process::Command::new("chmod").arg("+x").arg(&script).status().unwrap();
    dir
}

#[tokio::test]
async fn a_live_refusal_is_unavailable_not_conflict() {
    // Orca answers with an `error`, exactly as `executor-orca.ts` returns
    // `{ ok:false, code:"unavailable", ... }`; the native port must surface
    // the same `Unavailable` code (parity with `send.ts:66-90`).
    let oracle = fake_orca(r#"{"error":"terminal gone"}"#, 0);
    let (_dir, ctx, runtime) = live_fixture(json!({}), Some(oracle.path().to_path_buf()));
    let error = send_to_task(&ctx, &runtime, ID, "go", "me", false, None).await.unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(
        error.message.contains("refused") || error.message.contains("terminal send failed"),
        "message was: {}",
        error.message
    );
}

#[tokio::test]
async fn a_live_refusal_rolls_the_lease_back() {
    let oracle = fake_orca(r#"{"error":"nope"}"#, 0);
    let (_dir, ctx, runtime) = live_fixture(json!({}), Some(oracle.path().to_path_buf()));
    send_to_task(&ctx, &runtime, ID, "go", "me", false, None).await.unwrap_err();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    // The lease we claimed is rolled back on a definite live failure, so no
    // caller is left holding `driving`.
    assert!(
        task.pointer("/driving").is_some_and(|d| d.is_null())
            || task.pointer("/driving").and_then(|d| d.get("by")).is_none()
            || task.pointer("/driving/by").and_then(Value::as_str) != Some("me")
    );
}

#[tokio::test]
async fn a_live_delivery_returns_the_task() {
    // Orca answers the write with `{}` (exit 0) — delivery succeeded: the
    // task is returned and `live` stays put.
    let oracle = fake_orca("{}", 0);
    let (_dir, ctx, runtime) = live_fixture(json!({}), Some(oracle.path().to_path_buf()));
    let task = send_to_task(&ctx, &runtime, ID, "go", "me", false, None).await.unwrap();
    assert_eq!(task["id"], ID);
    assert_eq!(task["state"], "running");
    assert_eq!(
        task.pointer("/live/terminal").and_then(Value::as_str),
        Some("term_one")
    );
}

#[tokio::test]
async fn a_missing_orca_binary_is_unavailable() {
    // No `orca` on `PATH` (a bare candidate dir), so the subprocess cannot
    // spawn: still `Unavailable`, matching the built-in-only refusal path.
    let oracle = tempdir().unwrap();
    let (_dir, ctx, runtime) = live_fixture(json!({}), Some(oracle.path().to_path_buf()));
    let error = send_to_task(&ctx, &runtime, ID, "go", "me", false, None).await.unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(
        error.message.contains("terminal send failed"),
        "message was: {}",
        error.message
    );
}