//! The direct process effect and the `executor.stop` / `executor.sessionState`
//! points (M3 C10). Port of `plugins/pacer-exec-direct/index.ts:159-212`.
//!
//! The direct effect spawns an exact issued process (optionally detached through
//! `capability.process.startRun`), reads the first output chunk by handle when a
//! handle is returned, and reports done/failed with a bounded report. The
//! `spawnResult` parse and the `stop`/`sessionState` param parses are code-only
//! `internal` paths, matching zod.

use std::sync::LazyLock;

use pacer_plugin::js::{self, slice_utf16};
use pacer_plugin::{HandlerResult, PluginError};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::input::{self, EffectRun, Task};

fn internal() -> PluginError {
    PluginError::new("internal", "invalid params")
}

/// `z.uuid()` regex (see `input::uuid_regex`): version 1-8, variant `[89ab]`,
/// or the nil / max UUID.
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(input::uuid_regex()).unwrap_or_else(|e| panic!("the uuid regex must be valid: {e}"))
});

fn is_uuid(s: &str) -> bool {
    UUID_RE.is_match(s)
}

/// `spawnResult`: `code` safe int, `timedOut` bool, `stderr?` string,
/// `output? { stdout uuid, stderr uuid }`, and either `stderr` or `output`.
struct SpawnResult {
    code: i64,
    timed_out: bool,
    stderr: Option<String>,
    output: Option<(String, String)>,
}

/// `spawnResult.parse` (boundary): returns `None` for a malformed spawn
/// result, mapping to an `internal` error at the call site.
fn parse_spawn_result(v: &Value) -> Option<SpawnResult> {
    let obj = v.as_object()?;
    if !input::keys_are_exactly(obj, &["code", "timedOut", "stderr", "output"])
        && !input::keys_are_exactly(obj, &["code", "timedOut", "stderr"])
        && !input::keys_are_exactly(obj, &["code", "timedOut", "output"])
    {
        return None;
    }
    let code = js::safe_integer(obj.get("code")?)?;
    let timed_out = obj.get("timedOut")?.as_bool()?;
    let stderr = obj
        .get("stderr")
        .and_then(Value::as_str)
        .map(String::from);
    let output = match obj.get("output") {
        None => None,
        Some(v) => {
            let o = v.as_object()?;
            if !input::keys_are_exactly(o, &["stdout", "stderr"]) {
                return None;
            }
            let stdout = o.get("stdout")?.as_str()?;
            let stderr_ref = o.get("stderr")?.as_str()?;
            if !is_uuid(stdout) || !is_uuid(stderr_ref) {
                return None;
            }
            Some((stdout.to_owned(), stderr_ref.to_owned()))
        }
    };
    // refine: either `stderr` or `output` must be present.
    if stderr.is_none() && output.is_none() {
        return None;
    }
    Some(SpawnResult {
        code,
        timed_out,
        stderr,
        output,
    })
}

/// `executor.run` for the direct effect (`index.ts:161-194`).
pub async fn run_direct(input: EffectRun, ctx: &pacer_plugin::Ctx) -> HandlerResult {
    let effect = input.effect;
    if effect.detached {
        let launched = ctx
            .host
            .call(
                "capability.process.startRun",
                json!({
                    "task": task_json(&input.task),
                    "attempt": input.attempt,
                    "runDir": 1,
                }),
            )
            .await?;
        if ctx.cancel.is_cancelled() {
            return Err(PluginError::new(
                "plugin_unavailable",
                "executor call was cancelled after launch; inspect run directory",
            ));
        }
        let pid = launched.get("pid").and_then(Value::as_i64).unwrap_or(0);
        return Ok(json!({
            "status": "launched",
            "pid": pid,
            "report": "detached wrapper started",
        }));
    }
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor call was cancelled",
        ));
    }
    let mut env = Map::new();
    if let Some(base) = &effect.env {
        for (k, v) in base {
            env.insert(k.clone(), v.clone());
        }
    }
    if let Some(secret) = &effect.secret_env {
        for (k, ref_) in secret {
            env.insert(
                k.clone(),
                json!({ "secretRef": ref_.as_str().unwrap_or_default() }),
            );
        }
    }
    let mut spawn_params = Map::new();
    spawn_params.insert("argv".to_string(), json!(effect.argv));
    spawn_params.insert("cwd".to_string(), json!(effect.cwd));
    spawn_params.insert("env".to_string(), Value::Object(env));
    spawn_params.insert("timeoutMs".to_string(), json!(effect.timeout_ms));
    if let Some(stdin) = &effect.stdin {
        spawn_params.insert("stdin".to_string(), json!(stdin));
    }
    let answer = ctx
        .host
        .call("capability.process.spawn", Value::Object(spawn_params))
        .await?;
    let result = parse_spawn_result(&answer).ok_or_else(internal)?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor call was cancelled",
        ));
    }
    let mut stderr = result.stderr.unwrap_or_default();
    if let Some((_, stderr_handle)) = &result.output {
        let chunk = ctx
            .host
            .call(
                "capability.process.outputChunk",
                json!({
                    "handle": stderr_handle,
                    "offset": 0,
                    "length": 1024,
                }),
            )
            .await?;
        let base64 = chunk
            .get("base64")
            .and_then(Value::as_str)
            .unwrap_or_default();
        stderr = String::from_utf8_lossy(&js::base64::decode_lenient(base64)).into_owned();
    }
    let status = if result.code == 0 && !result.timed_out {
        "done"
    } else {
        "failed"
    };
    let report = if result.timed_out {
        "local process timed out".to_string()
    } else if result.code == 0 {
        "local process exited successfully".to_string()
    } else {
        format!(
            "local process exited {}: {}",
            result.code,
            slice_utf16(&stderr, 0, Some(1024))
        )
    };
    Ok(json!({
        "status": status,
        "exitCode": result.code,
        "report": report,
    }))
}

/// The `task` object the detached start forwards (`{ id, rev }`).
fn task_json(task: &Task) -> Value {
    json!({ "id": task.id, "rev": task.rev })
}

fn parse_owner(v: &Value) -> Option<(String, i64)> {
    let obj = v.as_object()?;
    if !input::keys_are_exactly(obj, &["taskId", "attempt"]) {
        return None;
    }
    let task_id = obj.get("taskId")?.as_str()?.to_owned();
    let attempt = js::safe_integer(obj.get("attempt")?)?;
    if attempt <= 0 {
        return None;
    }
    Some((task_id, attempt))
}

/// `executor.stop` (`index.ts:195-204`).
pub async fn stop(params: &Value, ctx: &pacer_plugin::Ctx) -> Result<Value, PluginError> {
    let obj = params.as_object().ok_or_else(internal)?;
    if !input::keys_are_exactly(obj, &["taskId", "attempt", "graceMs", "remote"])
        && !input::keys_are_exactly(obj, &["taskId", "attempt", "graceMs"])
    {
        return Err(internal());
    }
    let task_id = obj
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(internal)?;
    let attempt =
        js::safe_integer(obj.get("attempt").ok_or_else(internal)?).ok_or_else(internal)?;
    if attempt <= 0 {
        return Err(internal());
    }
    let grace = js::safe_integer(obj.get("graceMs").ok_or_else(internal)?).ok_or_else(internal)?;
    if !(0..=25_000).contains(&grace) {
        return Err(internal());
    }
    let remote = match obj.get("remote") {
        None => false,
        Some(v) => {
            if v.as_bool() != Some(true) {
                return Err(internal());
            }
            true
        }
    };
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor stop was cancelled",
        ));
    }
    let method = if remote {
        "capability.hosts.stopOwned"
    } else {
        "capability.process.stopRun"
    };
    let result = ctx
        .host
        .call(
            method,
            json!({ "taskId": task_id, "attempt": attempt, "graceMs": grace }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor stop completion is uncertain",
        ));
    }
    Ok(result)
}

/// `executor.sessionState` (`index.ts:205-212`).
pub async fn session_state(params: &Value, ctx: &pacer_plugin::Ctx) -> Result<Value, PluginError> {
    let (task_id, attempt) = parse_owner(params).ok_or_else(internal)?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor inspection was cancelled",
        ));
    }
    let observed = ctx
        .host
        .call(
            "capability.process.inspectRun",
            json!({ "taskId": task_id, "attempt": attempt }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(PluginError::new(
            "plugin_unavailable",
            "executor inspection was cancelled",
        ));
    }
    Ok(json!({
        "state": observed.get("state").cloned().unwrap_or(Value::Null),
        "host": "builtin",
        "handle": Value::Null,
    }))
}

/// `executor.available` (`index.ts:160`).
pub fn available() -> Value {
    json!({ "available": true })
}