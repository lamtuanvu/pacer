//! `testTask`, a port of `plugins/pacer-endpoints/test-task.ts`. Runs a git
//! repo bootstrap and an opencode build against the managed endpoint, then
//! verifies the disposable hello file. Disposable directory identity and exact
//! commands are issued by the host via `capability.process.spawn` /
//! `capability.fs.read`.

use crate::launch_env::launch_env;
use crate::path::join;
use pacer_plugin::{Host, PluginError};
use serde_json::{Map, Value, json};

const PROMPT: &str = "Create a file named hello.txt containing exactly: ok";

/// `testTask(host, input)` in test-task.ts:8.
pub async fn test_task(host: &Host, input: &Value) -> Result<Value, PluginError> {
    match run(host, input).await {
        Ok(checked_at) => Ok(json!({ "state": "ready", "checked_at": checked_at })),
        Err(detail) => Ok(json!({
            "state": "not_working",
            "detail": format!("test task failed: {detail}"),
        })),
    }
}

async fn run(host: &Host, input: &Value) -> Result<String, String> {
    let launch = launch_env(host, input).await.map_err(|e| e.to_string())?;
    let repository = input.get("repository").and_then(Value::as_str).unwrap_or("");
    let input_env = input.get("env").cloned().unwrap_or(Value::Object(Map::new()));

    let git = host
        .call(
            "capability.process.spawn",
            json!({
                "argv": ["git", "init", "-q", repository],
                "cwd": repository,
                "env": input_env,
                "timeoutMs": 10_000,
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    let git_ok = git.get("code").and_then(Value::as_i64) == Some(0)
        && !git.get("timedOut").and_then(Value::as_bool).unwrap_or(false);
    if !git_ok {
        return Err("could not create test git repo".to_string());
    }

    let env = build_env(input, &launch);
    let model = input
        .get("runner")
        .and_then(|r| r.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let result = host
        .call(
            "capability.process.spawn",
            json!({
                "argv": [
                    "opencode", "run", "--standalone", "--agent", "build",
                    "-m", model, "--auto", "--title", "pacer endpoint-test", PROMPT,
                ],
                "cwd": repository,
                "env": env,
                "timeoutMs": 120_000,
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    if result.get("timedOut").and_then(Value::as_bool).unwrap_or(false) {
        return Err("test task timed out".to_string());
    }
    let code = result.get("code").and_then(Value::as_i64);
    if code != Some(0) {
        let stderr = result.get("stderr").and_then(Value::as_str).map(str::trim);
        let stdout = result.get("stdout").and_then(Value::as_str).map(str::trim);
        let fallback = format!("test task exited {}", code.unwrap_or_default());
        let detail = stderr
            .filter(|s| !s.is_empty())
            .or_else(|| stdout.filter(|s| !s.is_empty()))
            .unwrap_or(&fallback);
        return Err(detail.to_string());
    }

    let file = host
        .call(
            "capability.fs.read",
            json!({ "path": join(repository, "hello.txt") }),
        )
        .await
        .map_err(|e| e.to_string())?;
    if file.get("text").and_then(Value::as_str) != Some("ok") {
        return Err("test task did not create hello.txt containing exactly: ok".to_string());
    }
    let checked_at = input
        .get("checkedAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(checked_at)
}

/// Build the spawn environment: `input.env`, then `launch.env`, then
/// `OPENCODE_CONFIG_CONTENT`, then each `launch.secretEnv` entry as
/// `{ "secretRef": … }` (test-task.ts:13).
fn build_env(input: &Value, launch: &Value) -> Value {
    let mut env: Map<String, Value> = Map::new();
    let mut merge = |map: &Map<String, Value>| {
        for (k, v) in map {
            env.insert(k.clone(), v.clone());
        }
    };
    merge(input.get("env").and_then(Value::as_object).unwrap_or(&Map::new()));
    if let Some(launch_map) = launch.get("env").and_then(Value::as_object) {
        merge(launch_map);
    }
    if let Some(config_ref) = input.get("configRef").and_then(Value::as_str) {
        env.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            json!({ "secretRef": config_ref }),
        );
    }
    if let Some(secret_env) = launch.get("secretEnv").and_then(Value::as_object) {
        for (name, secret_ref) in secret_env {
            env.insert(
                name.clone(),
                json!({ "secretRef": secret_ref.as_str().unwrap_or_default() }),
            );
        }
    }
    Value::Object(env)
}