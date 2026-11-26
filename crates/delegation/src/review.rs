//! Native `task.review` and managed-work review.
//!
//! Port of `review` (`src/core/tasks.ts:217-321`) and `taskReviewAfterStore`
//! (`src/api/task-review-bridge.ts:38-61`). The store CAS stays in
//! `pacer_lifecycle::record_review_verdict`; this module owns the surrounding
//! policy, label, activity, message, retry and cleanup effects so no verdict
//! needs a TypeScript round trip.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    lock::{LockOptions, with_lock_async},
};
use pacer_lifecycle::{AdmissionState, TASK_KINDS, record_review_verdict};
use pacer_read_model::tasks::task_data;
use pacer_store::{TaskStore, append_activity, is_task_id, messages, publish};
use serde_json::{Map, Value, json};

use crate::delegate;
use crate::retry::{RetryInput, retry_task};
use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

/// The four verdicts `task.review` accepts.
#[derive(Debug, Clone)]
pub enum Verdict {
    Accept,
    Reject,
    /// Review feedback is delivered as a message that resumes the task's own
    /// session. Falls back to a retry when no turn can start.
    SendBack(String),
    /// Restart the task on the requested executor from its run branch.
    Retry(RetryInput),
}

impl Verdict {
    /// Parse a validated `task.review` verdict from its operation parameters.
    pub fn from_params(params: &Value) -> Result<Self, CoreError> {
        match params.get("verdict").and_then(Value::as_str) {
            Some("accept") => Ok(Self::Accept),
            Some("reject") => Ok(Self::Reject),
            Some("send_back") => {
                let note = params
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if note.is_empty() {
                    return Err(invalid("send_back requires a note"));
                }
                Ok(Self::SendBack(note))
            }
            Some("retry") => {
                let executor = params
                    .get("executor")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if executor.is_empty() {
                    return Err(invalid("retry requires an executor"));
                }
                let mut input = RetryInput::from_params(params);
                input.executor = Some(executor);
                input.fresh_from_run_branch = true;
                Ok(Self::Retry(input))
            }
            other => Err(invalid(format!(
                "verdict: Invalid option: expected one of \"accept\"|\"reject\"|\"send_back\"|\"retry\", received \"{}\"",
                other.unwrap_or("undefined")
            ))),
        }
    }

    fn accepted(&self) -> bool {
        matches!(self, Self::Accept)
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
            Self::SendBack(_) => "send_back",
            Self::Retry(_) => "retry",
        }
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

fn unknown(id: &str) -> CoreError {
    CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}

fn str_field<'a>(task: &'a Value, pointer: &str) -> Option<&'a str> {
    task.pointer(pointer).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn task_title(task: &Value) -> String {
    task.get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let goal = task.pointer("/brief/goal").and_then(Value::as_str).unwrap_or_default();
            let first = goal.split(['.', '\n']).next().unwrap_or(goal).trim();
            let mut clipped: String = first.chars().take(57).collect();
            if first.chars().count() > 57 {
                clipped.push('…');
            }
            clipped
        })
}

fn executor_name(task: &Value, executor: Option<&str>) -> String {
    executor
        .map(str::to_owned)
        .or_else(|| str_field(task, "/result/executor").map(str::to_owned))
        .or_else(|| {
            task.get("attempts")
                .and_then(Value::as_array)
                .and_then(|attempts| attempts.last())
                .and_then(|attempt| attempt.get("executor"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| str_field(task, "/requestedExecutor").map(str::to_owned))
        .unwrap_or_else(|| "unknown executor".to_owned())
}

fn read_task(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    store
        .read(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(|| unknown(id))
}

fn task_rev(task: &Value) -> i64 {
    task.get("rev").and_then(Value::as_i64).unwrap_or(0)
}

/// `policySummary` (`src/plugins/policy.ts:78`): only the closed mode matters to
/// admission; a missing strategy means open, as in TypeScript.
fn policy_closed(ctx: &Ctx) -> bool {
    let Ok(text) = std::fs::read_to_string(ctx.pacer_home.join("strategy.yaml")) else {
        return false;
    };
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        return value.pointer("/plugins/policy/mode").and_then(Value::as_str) == Some("closed");
    }
    let mut in_plugins = false;
    let mut in_policy = false;
    for line in text.lines() {
        if line.starts_with(' ') {
            let trimmed = line.trim();
            if in_plugins && !trimmed.starts_with('-') && trimmed.starts_with("policy:") {
                in_policy = true;
                continue;
            }
            if in_policy && trimmed.starts_with("mode:") {
                return trimmed.split_once(':').is_some_and(|(_, value)| value.trim() == "closed");
            }
            continue;
        }
        in_plugins = line.trim_end() == "plugins:";
        in_policy = false;
    }
    false
}

/// Installed policy plugins from the strategy config. Used for fail-closed
/// admission when the host has no provider table yet (B0b prerequisite).
fn installed_policy_plugins(ctx: &Ctx) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(ctx.pacer_home.join("strategy.yaml")) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Some(installed) = value.pointer("/plugins/installed").and_then(Value::as_object) {
            for (id, entry) in installed {
                if entry.get("policy") != Some(&Value::Bool(false)) {
                    ids.push(id.clone());
                }
            }
        }
        ids.sort();
        return ids;
    }
    let mut in_installed = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "installed:" {
            in_installed = true;
            continue;
        }
        if !line.starts_with(' ') && trimmed.ends_with(':') {
            in_installed = false;
        }
        if in_installed && trimmed.ends_with(':') && !trimmed.starts_with('-') {
            let id = trimmed.trim_end_matches(':');
            if !id.is_empty() {
                ids.push(id.to_owned());
            }
        }
    }
    ids.sort();
    ids
}

/// `applyPolicy("review")` (`src/plugins/policy.ts:84`). Policy calls happen
/// outside every task lock; in closed mode a veto or a failing plugin denies.
async fn apply_review_policy(
    ctx: &Ctx,
    runtime: &Runtime,
    task: &Value,
    verdict: &Verdict,
    kind: Option<&str>,
    note: Option<&str>,
    executor: Option<&str>,
) -> Result<(), CoreError> {
    let providers = runtime.plugins.providers(ctx, "policy.before");
    let closed = policy_closed(ctx);
    if providers.is_empty() {
        // Closed mode never admits a review it cannot authorize. TypeScript
        // refuses when a granted policy plugin cannot be verified; the native
        // host has no provider table until B0b, so fail closed here too.
        if closed {
            let contributor = installed_policy_plugins(ctx).into_iter().find(|id| {
                let manifest = ctx
                    .pacer_home
                    .join("plugins")
                    .join(id)
                    .join("pacer-plugin.json");
                std::fs::read_to_string(manifest)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|value| value.pointer("/contributes/policy").cloned())
                    .is_some()
            });
            if let Some(id) = contributor {
                let reason = format!("Granted plugin {id} cannot be verified (policy provider unavailable)");
                let _ = append_activity(
                    ctx,
                    json!({
                        "kind": "policy", "level": "warn", "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                        "text": format!("plugin {id}: review: {reason}"),
                    }),
                );
                return Err(not_allowed(reason).hint(format!("plugin {id}")));
            }
        }
        return Ok(());
    }
    let id = task.get("id").and_then(Value::as_str).unwrap_or_default();
    let resolved_kind = kind
        .map(str::to_owned)
        .or_else(|| task.get("kind").and_then(Value::as_str).map(str::to_owned));
    let mut input = json!({
        "taskId": id,
        "revision": task_rev(task),
        "state": task.get("state").cloned().unwrap_or(Value::Null),
        "verdict": verdict.name(),
        "kind": resolved_kind.map(Value::String).unwrap_or(Value::Null),
    });
    if let Some(note) = note {
        input["note"] = json!(note);
    }
    if let Some(executor) = executor {
        input["executor"] = json!(executor);
    }
    let envelope = json!({"decision": "review", "input": input});
    for plugin in providers {
        let call = runtime
            .plugins
            .call(ctx, &plugin, "policy.before", envelope.clone(), Duration::from_secs(3))
            .await;
        let response = match call {
            Ok(response) => response,
            Err(error) if closed => {
                return Err(not_allowed(error.message).hint(format!("plugin {plugin}")));
            }
            Err(_) => continue,
        };
        match response.get("verdict").and_then(Value::as_str) {
            Some("veto") => {
                let reason = response
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Policy vetoed decision");
                if closed {
                    let _ = append_activity(
                        ctx,
                        json!({
                            "kind": "policy", "level": "warn", "taskId": id,
                            "text": format!("plugin {plugin}: review: {reason}"),
                        }),
                    );
                    return Err(not_allowed(reason).hint(format!("plugin {plugin}")));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// `appendLabel` (`src/tasks/labels.ts`): ground-truth labels are an append-only
/// JSONL file under the pacer home.
fn append_label(ctx: &Ctx, mut label: Map<String, Value>) {
    let _ = std::fs::create_dir_all(&ctx.pacer_home);
    label.insert("ts".into(), json!(ctx.now));
    let line = serde_json::to_string(&Value::Object(label)).unwrap_or_default();
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ctx.pacer_home.join("labels.jsonl"))
    {
        let _ = writeln!(file, "{line}");
    }
}

fn task_activity(ctx: &Ctx, task: &Value, text: String, source: Option<&str>) {
    let mut activity = json!({
        "kind": "verdict",
        "level": "info",
        "text": text,
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
    });
    if let Some(repo) = str_field(task, "/repo").or_else(|| str_field(task, "/brief/repo")) {
        activity["repo"] = json!(repo);
    }
    if let Some(executor) = str_field(task, "/result/executor")
        .or_else(|| str_field(task, "/executor"))
        .or_else(|| {
            task.get("attempts")
                .and_then(Value::as_array)
                .and_then(|attempts| attempts.last())
                .and_then(|attempt| attempt.get("executor"))
                .and_then(Value::as_str)
        })
        .or_else(|| str_field(task, "/requestedExecutor"))
    {
        activity["executor"] = json!(executor);
    }
    if let Some(host) = str_field(task, "/run/host") {
        activity["host"] = json!(host);
    }
    if let Some(source) = source {
        activity["source"] = json!(source);
    }
    let _ = append_activity(ctx, activity);
}

/// `recheckAfterAccept` (`src/api/ops.ts:219-225`). The doctor rerun is a host
/// effect; when no plugin claims it, record an honest "did not run" result so
/// clients still see a boolean recheck outcome.
async fn recheck_after_accept(ctx: &Ctx, runtime: &Runtime, id: &str) {
    let task = read_task(ctx, id).unwrap_or(Value::Null);
    let Some(name) = str_field(&task, "/diagnosticCheck").map(str::to_owned) else {
        return;
    };
    let mut outcome = json!({
        "passed": false,
        "level": Value::Null,
        "detail": "The check did not run. Run pacer doctor to see what it depends on.",
    });
    let providers = runtime.plugins.providers(ctx, "diagnostic.recheck");
    if let Some(plugin) = providers.first() {
        if let Ok(result) = runtime
            .plugins
            .call(
                ctx,
                plugin,
                "diagnostic.recheck",
                json!({"taskId": id, "name": name}),
                Duration::from_secs(30),
            )
            .await
        {
            if let Some(passed) = result.get("passed").and_then(Value::as_bool) {
                outcome["passed"] = json!(passed);
            }
            if let Some(level) = result.get("level") {
                outcome["level"] = level.clone();
            }
            if let Some(detail) = result.get("detail").and_then(Value::as_str) {
                outcome["detail"] = json!(detail);
            }
        }
    }
    outcome["at"] = json!(ctx.now);
    let passed = outcome["passed"].as_bool().unwrap_or(false);
    let mut store = match TaskStore::open(&ctx.pacer_home) {
        Ok(store) => store,
        Err(_) => return,
    };
    let _ = store.update_current(id, ctx.now, |task| {
        task["diagnosticRecheck"] = outcome.clone();
        Ok(())
    });
    let _ = append_activity(
        ctx,
        json!({
            "kind": "config",
            "level": if passed { "info" } else { "warn" },
            "text": if passed {
                format!("Fixed and rechecked · {name}")
            } else {
                format!("Still failing after fix · {name}")
            },
            "taskId": id,
        }),
    );
}

fn publish_task(ctx: &Ctx, task: &Value) {
    let event = json!({"type":"task","data": task_data(task, &|_| false)});
    let report = publish(ctx, &[event]);
    for error in report.errors {
        eprintln!("pacer: task.review publication failed: {error}");
    }
}

/// `record` in `review` (`src/core/tasks.ts:256-270`): the single guarded
/// verdict commit, followed by the bridge's labels and activity line.
fn record(
    ctx: &Ctx,
    id: &str,
    verdict: &Verdict,
    kind: Option<&str>,
    note: Option<&str>,
    expected_rev: i64,
) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let task = record_review_verdict(
        &mut store,
        id,
        verdict.accepted(),
        kind,
        note,
        Some(expected_rev as f64),
        ctx.now,
    )
    .map_err(map_record_error)?;

    let accepted = verdict.accepted();
    let mut label = Map::new();
    label.insert("type".into(), json!("task_review"));
    label.insert("task_id".into(), json!(id));
    label.insert("accepted".into(), json!(accepted));
    label.insert(
        "kind".into(),
        task.get("kind").cloned().unwrap_or(Value::Null),
    );
    label.insert("note".into(), note.map(str::to_owned).map(Value::String).unwrap_or(Value::Null));
    label.insert(
        "executor".into(),
        task.get("result")
            .and_then(|result| result.get("executor"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    append_label(ctx, label);

    let resumed = ctx.env.get("PACER_CALLER_RESUME").is_some_and(|value| value == id);
    let goal = task_title(&task);
    let executor = match verdict {
        Verdict::Retry(input) => input.executor.as_deref(),
        Verdict::SendBack(_) => None,
        _ => None,
    };
    let text = match verdict {
        Verdict::Accept => format!("Accepted “{goal}”"),
        Verdict::SendBack(_) => format!("Sent “{goal}” back to {}", executor_name(&task, executor)),
        _ => format!("Rejected “{goal}”"),
    };
    let text = if resumed {
        format!("{text} (resumed caller session)")
    } else {
        text
    };
    task_activity(ctx, &task, text, resumed.then_some("resumed-caller"));
    Ok(task)
}

fn map_record_error(error: pacer_lifecycle::RecordReviewError) -> CoreError {
    use pacer_lifecycle::RecordReviewError as E;
    match error {
        E::InvalidInput(message) => invalid(message),
        E::UnknownTask(id) => unknown(&id),
        E::Conflict { message, task } => {
            let mut err = conflict(message);
            if !task.is_null() {
                let mut data = Map::new();
                data.insert("task".into(), task_data(&task, &|_| false));
                err = err.data(data);
            }
            err
        }
        E::Store(error) => internal(error.to_string()),
    }
}

fn view(task: &Value) -> Value {
    task_data(task, &|_| false)
}

/// `continueWithMessage` (`src/core/tasks.ts:202-215`) with a review-feedback
/// message. Returns `Ok(None)` when the supervisor could not start a turn.
async fn continue_review_message(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    note: &str,
    expect_rev: i64,
) -> Result<Option<Value>, CoreError> {
    let (rev, root) = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let task = store
            .read(id)
            .map_err(|e| internal(e.to_string()))?
            .ok_or_else(|| unknown(id))?;
        if task_rev(&task) != expect_rev {
            return Err(conflict("task changed"));
        }
        let to = format!("task:{id}");
        let root = messages::root_of(&mut store, &to).map_err(|e| internal(e.to_string()))?;
        (task_rev(&task), root)
    };
    let request_id = format!("sendback:{id}:{rev}");
    let (message, duplicate, mid) = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let (message, duplicate) = messages::insert(
            &mut store,
            &messages::NewMessage {
                task_id: Some(id),
                root_id: &root,
                from: "human",
                to: &format!("task:{id}"),
                kind: "message",
                body: &format!("Review feedback: {note}"),
                reply_to: None,
                request_id: Some(&request_id),
                held: false,
            },
            ctx.now,
        )
        .map_err(|e| internal(e.to_string()))?;
        let mid = message.get("id").and_then(Value::as_str).map(str::to_owned);
        (message, duplicate, mid)
    };
    if duplicate {
        return Ok(Some(view(&read_task(ctx, id)?)));
    }
    publish(
        ctx,
        &[json!({"type":"entity","data":{"kind":"message","id":message["id"],"value":message}})],
    );
    match runtime.supervisor.tick(ctx, id).await {
        Ok(_) => Ok(Some(view(&read_task(ctx, id)?))),
        Err(_) => {
            if let Ok(mut store) = TaskStore::open(&ctx.pacer_home)
                && let Some(mid) = mid.as_deref()
            {
                let _ = messages::mark_read(&mut store, &format!("task:{id}"), &[mid], ctx.now);
            }
            Ok(None)
        }
    }
}

fn valid_kind(kind: Option<&str>) -> Result<(), CoreError> {
    match kind {
        None => Ok(()),
        Some(kind) if TASK_KINDS.contains(&kind) => Ok(()),
        Some(kind) => Err(invalid(format!("unknown kind \"{kind}\""))),
    }
}

/// `review` (`src/core/tasks.ts:217-321`) for an unmanaged task.
pub async fn review_task(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    verdict: Verdict,
    kind: Option<&str>,
    note: Option<&str>,
    expect_state: Option<&str>,
) -> Result<Value, CoreError> {
    if id.is_empty() || utf16_len(id) > 128 {
        return Err(invalid("id: Invalid input: expected string length 1–128"));
    }
    if !is_task_id(id) {
        return Err(unknown(id));
    }
    valid_kind(kind)?;

    let initial = {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        store
            .with_task_lock(id, |locked| {
                let task = locked.read()?;
                let state = task.get("state").and_then(Value::as_str).unwrap_or_default();
                if !matches!(state, "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input")
                    || expect_state.is_some_and(|expected| expected != state)
                {
                    return Err(StoreWrap(conflict("task state changed").data({
                        let mut data = Map::new();
                        data.insert("task".into(), view(&task));
                        data
                    })));
                }
                Ok(task)
            })
            .map_err(|e: StoreWrap| e.0)?
    };
    let executor = match &verdict {
        Verdict::Retry(input) => input.executor.as_deref(),
        Verdict::SendBack(_) => str_field(&initial, "/result/executor")
            .or_else(|| {
                initial
                    .get("attempts")
                    .and_then(Value::as_array)
                    .and_then(|attempts| attempts.last())
                    .and_then(|attempt| attempt.get("executor"))
                    .and_then(Value::as_str)
            })
            .or_else(|| str_field(&initial, "/requestedExecutor")),
        _ => None,
    };
    if matches!(verdict, Verdict::SendBack(_)) && executor.is_none() {
        return Err(invalid("task has no executor to send back to"));
    }
    if let Verdict::SendBack(note) = &verdict
        && utf16_len(note) > 2000
    {
        return Err(invalid("feedback must contain at most 2000 characters"));
    }

    apply_review_policy(ctx, runtime, &initial, &verdict, kind, note, executor).await?;
    let lease = delegate::begin_work(ctx, id, "Reviewing task")?;
    let result = review_committed(ctx, runtime, id, &initial, verdict, kind, note).await;
    if result.is_err() {
        delegate::finish_unlaunched_work(ctx, Some(&lease));
    }
    result
}

async fn review_committed(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    initial: &Value,
    verdict: Verdict,
    kind: Option<&str>,
    note: Option<&str>,
) -> Result<Value, CoreError> {
    let rev = task_rev(initial);
    match verdict {
        Verdict::SendBack(ref feedback) => {
            let current = read_task(ctx, id)?;
            if task_rev(&current) == rev && can_continue(&current) {
                if let Some(task) =
                    continue_review_message(ctx, runtime, id, feedback, rev).await?
                {
                    let recorded = record(ctx, id, &verdict, kind, Some(feedback), task_rev(&current))?;
                    publish_task(ctx, &recorded);
                    return Ok(json!({"task": view(&recorded), "retry": task}));
                }
                if managed(ctx, id) {
                    return Err(conflict(
                        "The work could not continue its session; use dispatch.retry with feedback",
                    ));
                }
            }
            let mut input = RetryInput {
                executor: executor_name(&current, None).into(),
                feedback: Some(feedback.clone()),
                expect_rev: Some(rev),
                ..RetryInput::default()
            };
            if input.executor.as_deref() == Some("unknown executor") {
                input.executor = str_field(&current, "/requestedExecutor").map(str::to_owned);
            }
            retry_and_record(ctx, runtime, id, Verdict::SendBack(feedback.clone()), kind, input)
                .await
        }
        Verdict::Retry(input) => retry_and_record(ctx, runtime, id, Verdict::Retry(input.clone()), kind, input).await,
        verdict => {
            let task = record(ctx, id, &verdict, kind, note, rev)?;
            if verdict.accepted() {
                recheck_after_accept(ctx, runtime, id).await;
            }
            crate::cleanup::auto_clean_task(ctx, runtime, id).await;
            publish_task(ctx, &task);
            Ok(json!({"task": view(&task)}))
        }
    }
}

async fn retry_and_record(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    verdict: Verdict,
    kind: Option<&str>,
    mut input: RetryInput,
) -> Result<Value, CoreError> {
    input.expect_rev = input.expect_rev.or(Some(
        TaskStore::open(&ctx.pacer_home)
            .ok()
            .and_then(|mut store| store.read(id).ok().flatten())
            .as_ref()
            .map(task_rev)
            .unwrap_or(0),
    ));
    let reply = retry_task(ctx, runtime, id, input).await?;
    let parent = read_task(ctx, id)?;
    let note = match &verdict {
        Verdict::SendBack(note) => Some(note.as_str()),
        _ => None,
    };
    let recorded = record(ctx, id, &verdict, kind, note, task_rev(&parent))?;
    publish_task(ctx, &recorded);
    let retry_id = reply["retry"]["task_id"].as_str().unwrap_or_default();
    let retry = TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| store.read(retry_id).ok().flatten())
        .unwrap_or_else(|| reply["retry"].clone());
    Ok(json!({"task": view(&recorded), "retry": view(&retry)}))
}

fn can_continue(task: &Value) -> bool {
    let executor = str_field(task, "/run/executor").or_else(|| str_field(task, "/result/executor"));
    executor.is_some()
        && str_field(task, "/run/host").is_none()
        && task
            .pointer("/result/backend")
            .and_then(Value::as_str)
            .map_or(true, |backend| backend == "direct")
}

fn managed(ctx: &Ctx, id: &str) -> bool {
    TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| pacer_lifecycle::work_node_exists(&mut store, id))
        .unwrap_or(false)
}

struct StoreWrap(CoreError);
impl From<pacer_store::StoreError> for StoreWrap {
    fn from(error: pacer_store::StoreError) -> Self {
        match error {
            pacer_store::StoreError::UnknownTask(id) => StoreWrap(unknown(&id)),
            other => StoreWrap(internal(other.to_string())),
        }
    }
}

fn work_root(ctx: &Ctx, id: &str) -> Result<String, CoreError> {
    let mut state = AdmissionState::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let work = state
        .work(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(|| CoreError::new(Code::UnknownTask, "Unknown work"))?;
    work.get("rootId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| internal("work node has no root"))
}

fn append_work_review(ctx: &Ctx, id: &str, task: &Value, accepted: bool, note: Option<&str>, provenance: &str) {
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let Ok(db) = store.connection() else {
        return;
    };
    let attempt = task
        .get("attempts")
        .and_then(Value::as_array)
        .and_then(|attempts| attempts.last());
    let attempt_no = task.get("attempts").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    let at = task.get("review").and_then(|review| review.get("at")).and_then(Value::as_f64).unwrap_or(ctx.now);
    let row = json!({
        "taskId": id,
        "attempt": attempt_no,
        "repo": str_field(task, "/brief/repo").unwrap_or_default(),
        "kind": task.get("kind").cloned().unwrap_or(Value::Null),
        "difficulty": task.get("difficulty").and_then(Value::as_str).unwrap_or("standard"),
        "runner": attempt.and_then(|a| a.get("executor")).and_then(Value::as_str).unwrap_or_default(),
        "model": attempt.and_then(|a| a.get("actualModel")).cloned().unwrap_or(Value::Null),
        "settings": attempt.and_then(|a| a.get("dispatchSettingsHash")).and_then(Value::as_str).unwrap_or("legacy-unknown"),
        "accepted": accepted,
        "durationS": Value::Null,
        "usagePct": Value::Null,
        "at": at,
        "provenance": provenance,
    });
    let _ = db.execute(
        "INSERT OR REPLACE INTO work_reviews(task_id,attempt,at,provenance,data) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![id, attempt_no as i64, at, provenance, row.to_string()],
    );
    let detail = json!({
        "accepted": accepted,
        "provenance": provenance,
        "note": note.map(|note| Value::String(note.chars().take(2000).collect())).unwrap_or(Value::Null),
    });
    let _ = db.execute(
        "INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,task_id,?1,'work.reviewed',?2 FROM work_nodes WHERE task_id=?3",
        rusqlite::params![at, detail.to_string(), id],
    );
}

fn sync_dependent_waits(ctx: &Ctx, root: &str, id: &str) {
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let Ok(db) = store.connection() else {
        return;
    };
    let mut statement = match db.prepare("SELECT task_id,dependencies FROM work_nodes WHERE root_id=?1") {
        Ok(statement) => statement,
        Err(_) => return,
    };
    let rows: Vec<(String, String)> = statement
        .query_map([root], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()
        .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default();
    drop(statement);
    let mut seen = HashSet::new();
    for (dependent, dependencies) in rows {
        if !seen.insert(dependent.clone()) {
            continue;
        }
        let depends = serde_json::from_str::<Vec<String>>(&dependencies).unwrap_or_default();
        if depends.contains(&id.to_owned()) {
            let _ = db.execute(
                "UPDATE work_waits SET started_at=NULL,total_seconds=COALESCE(total_seconds,0) WHERE task_id=?1 AND kind='dependency'",
                rusqlite::params![dependent],
            );
        }
    }
}

/// `reviewWork` (`src/core/work.ts:119-135`): managed work reviews take the
/// `work-review-{root}` lock and additionally record learning evidence and a
/// `work.reviewed` event.
pub async fn review_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    accepted: bool,
    note: Option<&str>,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    let root = work_root(ctx, id)?;
    let current = read_task(ctx, id)?;
    if let Some(expected) = expect_rev
        && task_rev(&current) != expected
    {
        return Err(conflict("Work revision changed; reload before reviewing"));
    }
    if truthy(current.get("review")) {
        return Err(conflict("Work was already reviewed"));
    }
    let verdict = if accepted {
        Verdict::Accept
    } else {
        Verdict::Reject
    };
    let lock_name = format!("work-review-{root}");
    let options = LockOptions {
        stale: Duration::from_secs(600),
        ..LockOptions::default()
    };
    let ctx_ref = ctx;
    let runtime_ref = runtime;
    let id_ref = id;
    let note_ref = note;
    let result = with_lock_async(ctx, &lock_name, options, || {
        review_work_locked(ctx_ref, runtime_ref, id_ref, &verdict, note_ref, expect_rev)
    })
    .await
    .map_err(|e| conflict(format!("Work review lock busy: {e}")))?;
    if let Ok(task) = &result {
        let provenance = if ctx.env.contains_key("PACER_WORK_GRANT") {
            "requesting-agent"
        } else {
            "human"
        };
        append_work_review(ctx, id, task, accepted, note, provenance);
        sync_dependent_waits(ctx, &root, id);
    }
    result
}

fn review_work_locked<'a>(
    ctx: &'a Ctx,
    runtime: &'a Runtime,
    id: &'a str,
    verdict: &'a Verdict,
    note: Option<&'a str>,
    expect_rev: Option<i64>,
) -> Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>> {
    Box::pin(async move {
        let current = read_task(ctx, id)?;
        if expect_rev.is_some_and(|expected| task_rev(&current) != expected) {
            return Err(conflict("Work revision changed; reload before reviewing"));
        }
        review_task(ctx, runtime, id, verdict.clone(), None, note, None).await
    })
}
