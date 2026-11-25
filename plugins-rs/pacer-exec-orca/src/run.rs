//! The #461 terminal-worker attempt, sequenced over host-issued Orca effects
//! (M3 C5). Port of `plugins/pacer-exec-orca/index.ts:55-105` (`runOrca`,
//! `supervise`).
//!
//! Fallback is chosen only before a worker can exist; an uncertain start is
//! looked up a bounded number of times and never retried or replaced.

use std::future::Future;
use std::pin::Pin;

use pacer_plugin::{CancellationToken, Ctx, HandlerResult, Host, PluginError};
use serde_json::{Value, json};

use crate::input::RunInput;
use crate::map::{map_failed_start, map_wait};

/// A pause between uncertain-start lookups; tests inject a fake clock.
pub trait Clock: Send + Sync {
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
}

/// The production clock: `tokio::time::sleep` (mirrors `Bun.sleep`).
pub struct TokioClock;

impl Clock for TokioClock {
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(async move { tokio::time::sleep(std::time::Duration::from_millis(ms)).await })
    }
}

/// The singleton message for an attempt cancelled before it calls the host.
const CANCELLED: &str = "Orca attempt was cancelled; the host settles its effects";

/// A capability call whose params start with `{taskId, attempt}` and then merge
/// `extra`, failing early when the attempt is cancelled (`call` in index.ts).
async fn call(
    host: &Host,
    cancel: &CancellationToken,
    task_id: &str,
    attempt: i64,
    method: &str,
    extra: Value,
) -> Result<Value, PluginError> {
    if cancel.is_cancelled() {
        return Err(PluginError::new("plugin_unavailable", CANCELLED));
    }
    let mut params = json!({ "taskId": task_id, "attempt": attempt });
    if let Some(object) = extra.as_object() {
        for (key, value) in object {
            params[key] = value.clone();
        }
    }
    host.call(method, params).await
}

/// A worker the host started ready, or one that failed to start ready.
struct Started {
    dispatch_id: String,
    state: Option<String>,
    stage: Option<String>,
    failed_stage: Option<String>,
    last_error: Option<String>,
}

/// The `capability.orca.start` result.
enum Start {
    Started(Started),
    Refused { code: String, message: String },
    Uncertain,
}

fn parse_started(v: &Value) -> Started {
    Started {
        dispatch_id: v
            .get("dispatchId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        state: v.get("state").and_then(Value::as_str).map(String::from),
        stage: v.get("stage").and_then(Value::as_str).map(String::from),
        failed_stage: v
            .get("failedStage")
            .and_then(Value::as_str)
            .map(String::from),
        last_error: v.get("lastError").and_then(Value::as_str).map(String::from),
    }
}

fn parse_start(v: &Value) -> Start {
    match v.get("kind").and_then(Value::as_str) {
        Some("refused") => Start::Refused {
            code: v
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        },
        Some("uncertain") => Start::Uncertain,
        _ => Start::Started(parse_started(v)),
    }
}

fn started_value(s: &Started) -> Value {
    json!({
        "dispatchId": s.dispatch_id,
        "state": s.state,
        "stage": s.stage,
        "failedStage": s.failed_stage,
        "lastError": s.last_error,
    })
}

/// The `#461` fallback disposition. `reason` is omitted (as `undefined` would
/// be) when the host gave none.
fn fallback(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({ "orca": { "fallback": { "reason": reason } } }),
        None => json!({ "orca": { "fallback": {} } }),
    }
}

/// Abandon the attempt and report the abandon answer's reason as a fallback.
async fn abandon(
    host: &Host,
    cancel: &CancellationToken,
    task_id: &str,
    attempt: i64,
    reason: &str,
) -> Result<Value, PluginError> {
    let answer = call(
        host,
        cancel,
        task_id,
        attempt,
        "capability.orca.abandon",
        json!({ "reason": reason }),
    )
    .await?;
    Ok(fallback(answer.get("reason").and_then(Value::as_str)))
}

/// Supervise a started worker (or an attached live worker): wait, settle, and
/// finish, keeping an interactive lane's needs-input worker alive.
async fn supervise(
    host: &Host,
    cancel: &CancellationToken,
    task_id: &str,
    attempt: i64,
    interactive: bool,
    started: Option<Started>,
) -> Result<Value, PluginError> {
    let (mapped, launch_broken, keep_alive) = match &started {
        Some(started) if started.state.as_deref() != Some("ready") => {
            let (mapped, broken) = map_failed_start(&started_value(started));
            (mapped, broken, false)
        }
        _ => {
            let waited = call(
                host,
                cancel,
                task_id,
                attempt,
                "capability.orca.wait",
                json!({}),
            )
            .await?;
            let mapped = map_wait(&waited);
            let keep_alive = interactive
                && waited.get("kind").and_then(Value::as_str) == Some("settled")
                && waited.get("state").and_then(Value::as_str) == Some("needs_input");
            (mapped, None, keep_alive)
        }
    };
    if !keep_alive {
        call(
            host,
            cancel,
            task_id,
            attempt,
            "capability.orca.settle",
            json!({
                "settled": mapped.get("settled").cloned().unwrap_or(Value::Bool(false)),
            }),
        )
        .await?;
    }
    let mut finish = json!({});
    if let Some(object) = mapped.as_object() {
        for (key, value) in object {
            finish[key] = value.clone();
        }
    }
    finish["keepAlive"] = json!(keep_alive);
    if let Some(broken) = launch_broken {
        finish["launchBroken"] = json!(broken);
    }
    call(
        host,
        cancel,
        task_id,
        attempt,
        "capability.orca.finish",
        finish,
    )
    .await
}

/// Run one Orca terminal-worker attempt (`runOrca`), returning the disposition
/// the planner should record.
pub async fn run_orca(input: RunInput, ctx: &Ctx, clock: &dyn Clock) -> HandlerResult {
    let task_id = input.task.id;
    let attempt = input.attempt;
    let interactive = input.orca.session.as_deref() == Some("interactive");

    let live = call(
        &ctx.host,
        &ctx.cancel,
        &task_id,
        attempt,
        "capability.orca.liveAnswer",
        json!({}),
    )
    .await?;
    match live.get("kind").and_then(Value::as_str) {
        Some("fallback") => {
            return Ok(fallback(live.get("reason").and_then(Value::as_str)));
        }
        Some("attached") => {
            return supervise(&ctx.host, &ctx.cancel, &task_id, attempt, interactive, None).await;
        }
        _ => {}
    }

    let prepared = call(
        &ctx.host,
        &ctx.cancel,
        &task_id,
        attempt,
        "capability.orca.prepare",
        json!({}),
    )
    .await?;
    let prepared_ok = prepared.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !prepared_ok {
        let reason = prepared.get("reason").and_then(Value::as_str);
        let refused = prepared
            .get("refuse")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok(if refused {
            json!({ "orca": { "refused": { "reason": reason.unwrap_or_default() } } })
        } else {
            fallback(reason)
        });
    }

    let placed = call(
        &ctx.host,
        &ctx.cancel,
        &task_id,
        attempt,
        "capability.orca.place",
        json!({}),
    )
    .await?;
    if !placed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let reason = placed
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return abandon(&ctx.host, &ctx.cancel, &task_id, attempt, reason).await;
    }

    let terminal = call(
        &ctx.host,
        &ctx.cancel,
        &task_id,
        attempt,
        "capability.orca.terminal",
        json!({}),
    )
    .await?;
    if !terminal.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let reason = terminal
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return abandon(&ctx.host, &ctx.cancel, &task_id, attempt, reason).await;
    }

    let start = call(
        &ctx.host,
        &ctx.cancel,
        &task_id,
        attempt,
        "capability.orca.start",
        json!({}),
    )
    .await?;
    match parse_start(&start) {
        Start::Refused { code, message } => {
            abandon(
                &ctx.host,
                &ctx.cancel,
                &task_id,
                attempt,
                &format!("orca worker-start refused ({code}: {message})"),
            )
            .await
        }
        Start::Uncertain => {
            let mut found = false;
            for index in 0..3 {
                if index > 0 {
                    clock.sleep(5000).await;
                }
                let lookup = call(
                    &ctx.host,
                    &ctx.cancel,
                    &task_id,
                    attempt,
                    "capability.orca.lookup",
                    json!({}),
                )
                .await?;
                if lookup.get("kind").and_then(Value::as_str) == Some("found") {
                    found = true;
                    break;
                }
            }
            if !found {
                return call(
                    &ctx.host,
                    &ctx.cancel,
                    &task_id,
                    attempt,
                    "capability.orca.unstarted",
                    json!({}),
                )
                .await;
            }
            let adopted = call(
                &ctx.host,
                &ctx.cancel,
                &task_id,
                attempt,
                "capability.orca.adopt",
                json!({}),
            )
            .await?;
            supervise(
                &ctx.host,
                &ctx.cancel,
                &task_id,
                attempt,
                interactive,
                Some(parse_started(&adopted)),
            )
            .await
        }
        Start::Started(started) => {
            supervise(
                &ctx.host,
                &ctx.cancel,
                &task_id,
                attempt,
                interactive,
                Some(started),
            )
            .await
        }
    }
}
