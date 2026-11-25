#![allow(clippy::unwrap_used)]
//! Integration tests for `testTask` (`src/test_task.rs`) driven through the
//! real bundled plugin. Covers the ready path (git code 0 + opencode code 0 +
//! hello.txt) and every not_working branch (git failure / timeout / bad
//! opencode exit-code / missing file), plus the exact spawn environment merge
//! including `OPENCODE_CONFIG_CONTENT` and `secretEnv` secretRefs.

mod support;

use pacer_plugin::testing::Harness;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

use support::{base_fs_answers, hello, plugin, InMemoryFs};

const REPO: &str = "/tmp/endpoint-repo";

/// Input for `endpoint.test`, mirroring the TS `TestInput`.
fn test_params(
    pacer_home: &str,
    runner_model: &str,
    checked_at: &str,
    config_ref: Option<&str>,
) -> Value {
    let mut p = json!({
        "pacerHome": pacer_home,
        "account": {
            "name": "acme", "baseUrl": "https://acme.example", "keyRef": "ref-1",
            "models": []
        },
        "accounts": [],
        "runner": { "id": "opencode", "model": runner_model },
        "repository": REPO,
        "env": { "BASE": "1" },
        "checkedAt": checked_at
    });
    if let Some(c) = config_ref {
        p["configRef"] = json!(c);
    }
    p
}

/// Register process.spawn answers. `git` → `git_res`, `opencode` → `opcode_res`.
/// Records every opencode spawn env. Returns an Arc to inspect the opencode env.
fn spawn_answers(
    h: &mut Harness,
    git_res: Value,
    opencode_res: Value,
    opencode_envs: Arc<Mutex<Vec<Value>>>,
) {
    let opencode_envs = opencode_envs.clone();
    let opencode_res = opencode_res.clone();
    h.on_capability("capability.process.spawn", move |p| {
        let argv = p.get("argv").and_then(Value::as_array).cloned().unwrap_or_default();
        if argv.first().and_then(Value::as_str) == Some("git") {
            Ok(git_res.clone())
        } else if argv.first().and_then(Value::as_str) == Some("opencode") {
            opencode_envs.lock().unwrap().push(p.get("env").cloned().unwrap_or(Value::Null));
            Ok(opencode_res.clone())
        } else {
            Ok(json!({ "code": 1, "timedOut": false }))
        }
    });
}

#[tokio::test]
async fn ready_path_returns_checked_at_and_merges_env() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    // hello.txt must be present for the fs.read at the end.
    state
        .lock()
        .unwrap()
        .files
        .insert(format!("{REPO}/hello.txt"), "ok".to_string());
    let opencode_envs = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    spawn_answers(
        &mut h,
        json!({ "code": 0, "timedOut": false }),
        json!({ "code": 0, "timedOut": false, "stdout": "", "stderr": "" }),
        opencode_envs.clone(),
    );

    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "2026-01-01", Some("cfg-1")))
        .await
        .unwrap();
    assert_eq!(r["state"], json!("ready"));
    assert_eq!(r["checked_at"], json!("2026-01-01"));

    // The opencode spawn must carry the input env, then launch env, then
    // OPENCODE_CONFIG_CONTENT secretRef, then secretEnv secretRef.
    let envs = opencode_envs.lock().unwrap();
    assert_eq!(envs.len(), 1);
    let env = envs[0].as_object().unwrap();
    assert_eq!(env["BASE"], json!("1"));
    assert_eq!(
        env["OPENCODE_CONFIG"],
        json!("/home/u/.pacer/opencode/opencode.json")
    );
    assert_eq!(env["OPENCODE_CONFIG_CONTENT"], json!({ "secretRef": "cfg-1" }));
    assert_eq!(env["PACER_KEY_ACME"], json!({ "secretRef": "ref-1" }));
    drop(envs);
    h.close().await;
}

#[tokio::test]
async fn git_failure_is_not_working() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let opencode_envs = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    // git exits non-zero.
    spawn_answers(
        &mut h,
        json!({ "code": 1, "timedOut": false }),
        json!({ "code": 0, "timedOut": false }),
        opencode_envs.clone(),
    );
    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
        .await
        .unwrap();
    assert_eq!(r["state"], json!("not_working"));
    assert_eq!(r["detail"], json!("test task failed: could not create test git repo"));
    assert!(opencode_envs.lock().unwrap().is_empty(), "opencode must not run when git fails");
    h.close().await;
}

#[tokio::test]
async fn git_timeout_is_not_working() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let opencode_envs = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    spawn_answers(
        &mut h,
        json!({ "code": 0, "timedOut": true }),
        json!({ "code": 0, "timedOut": false }),
        opencode_envs.clone(),
    );
    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
        .await
        .unwrap();
    assert_eq!(r["state"], json!("not_working"));
    assert_eq!(r["detail"], json!("test task failed: could not create test git repo"));
    h.close().await;
}

#[tokio::test]
async fn opencode_timeout_is_not_working() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    spawn_answers(
        &mut h,
        json!({ "code": 0, "timedOut": false }),
        json!({ "code": 0, "timedOut": true }),
        Arc::new(Mutex::new(Vec::new())),
    );
    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
        .await
        .unwrap();
    assert_eq!(r["state"], json!("not_working"));
    assert_eq!(r["detail"], json!("test task failed: test task timed out"));
    h.close().await;
}

#[tokio::test]
async fn opencode_bad_exit_uses_stderr_stdout_then_fallback() {
    for (stderr, stdout, expected) in [
        (Some("boom"), Some("hi"), "boom"),
        (Some(""), Some("hi"), "hi"),
        (None, None, "test task exited 3"),
    ] {
        let state = Arc::new(Mutex::new(InMemoryFs::default()));
        let mut h = Harness::start(plugin(), hello()).await;
        base_fs_answers(&mut h, state.clone());
        let mut opencode = json!({ "code": 3, "timedOut": false });
        if let Some(s) = stderr {
            opencode["stderr"] = json!(s);
        }
        if let Some(s) = stdout {
            opencode["stdout"] = json!(s);
        }
        spawn_answers(
            &mut h,
            json!({ "code": 0, "timedOut": false }),
            opencode,
            Arc::new(Mutex::new(Vec::new())),
        );
        let r = h
            .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
            .await
            .unwrap();
        assert_eq!(r["state"], json!("not_working"));
        assert_eq!(r["detail"], json!(format!("test task failed: {expected}")));
        h.close().await;
    }
}

#[tokio::test]
async fn missing_hello_file_is_not_working() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    // No hello.txt seeded → fs.read returns missing.
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    spawn_answers(
        &mut h,
        json!({ "code": 0, "timedOut": false }),
        json!({ "code": 0, "timedOut": false }),
        Arc::new(Mutex::new(Vec::new())),
    );
    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
        .await
        .unwrap();
    assert_eq!(r["state"], json!("not_working"));
    assert_eq!(
        r["detail"],
        json!("test task failed: test task did not create hello.txt containing exactly: ok")
    );
    h.close().await;
}

#[tokio::test]
async fn wrong_hello_content_is_not_working() {
    let state = Arc::new(Mutex::new(InMemoryFs::default()));
    state
        .lock()
        .unwrap()
        .files
        .insert(format!("{REPO}/hello.txt"), "not ok".to_string());
    let mut h = Harness::start(plugin(), hello()).await;
    base_fs_answers(&mut h, state.clone());
    spawn_answers(
        &mut h,
        json!({ "code": 0, "timedOut": false }),
        json!({ "code": 0, "timedOut": false }),
        Arc::new(Mutex::new(Vec::new())),
    );
    let r = h
        .call("endpoint.test", test_params("/home/u/.pacer", "gpt-5", "t", None))
        .await
        .unwrap();
    assert_eq!(r["detail"], json!("test task failed: test task did not create hello.txt containing exactly: ok"));
    h.close().await;
}