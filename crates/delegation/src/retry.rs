//! Native `task.retry` and `task.retry_all`.
//!
//! Port of `retryTask` (`src/core/tasks.ts:383-508`), `retry` (:511-513) and the
//! op-level `task.retry`/`task.retry_all` handlers (`src/api/ops.ts:520-558`).
//! A retry takes the desktop-update launch lease, then the `retry-{id}` lock and
//! the ancestor `clean-{id}` locks in sorted order before admitting a new task
//! through the native delegate path. Managed work without `work::retry_work`
//! returns the TypeScript refusal for this slice.
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
use pacer_lifecycle::work_node_exists;
use pacer_store::{TaskStore, is_task_id};
use serde_json::{Value, json};

use crate::delegate;
use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

/// Fields of `task.retry` after the operation schema has validated them.
#[derive(Debug, Clone, Default)]
pub struct RetryInput {
    pub executor: Option<String>,
    pub from_panel: bool,
    pub feedback: Option<String>,
    pub expect_rev: Option<i64>,
    pub answer_text: Option<String>,
    pub fresh_from_run_branch: bool,
}

impl RetryInput {
    pub fn from_params(params: &Value) -> Self {
        Self {
            executor: params
                .get("executor")
                .and_then(Value::as_str)
                .map(str::to_owned),
            from_panel: params.get("from_panel").and_then(Value::as_bool).unwrap_or(false),
            feedback: params
                .get("feedback")
                .and_then(Value::as_str)
                .map(str::to_owned),
            expect_rev: params
                .get("expect_rev")
                .and_then(Value::as_i64),
            // `answer_text` is not a `task.retry` field; only `answer_task`
            // supplies it directly when it falls back to an answer retry.
            answer_text: None,
            fresh_from_run_branch: false,
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

fn check_rev(task: &Value, expect: Option<i64>) -> Result<(), CoreError> {
    if let Some(expect) = expect
        && task.get("rev").and_then(Value::as_i64) != Some(expect)
    {
        return Err(conflict("task changed"));
    }
    Ok(())
}

/// Ancestor ids of `id` following `retryOf`, as an ordered, deduplicated set.
fn ancestors(ctx: &Ctx, id: &str) -> Vec<String> {
    let mut store = match TaskStore::open(&ctx.pacer_home) {
        Ok(store) => store,
        Err(_) => return Vec::new(),
    };
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Some(id.to_owned());
    while let Some(current) = cursor {
        if !seen.insert(current.clone()) {
            break;
        }
        let next = store
            .read(&current)
            .ok()
            .flatten()
            .and_then(|task| {
                task.get("retryOf")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        ids.push(current);
        cursor = next;
    }
    ids.sort();
    ids
}

fn managed(ctx: &Ctx, id: &str) -> bool {
    TaskStore::open(&ctx.pacer_home)
        .ok()
        .and_then(|mut store| work_node_exists(&mut store, id))
        .unwrap_or(false)
}

/// Re-delegates a stored brief. The reply matches the op's
/// `{ retry: summarizeTask, of: summarizeTask }`.
pub async fn retry_task(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    input: RetryInput,
) -> Result<Value, CoreError> {
    if !is_task_id(id) {
        return Err(unknown(id));
    }
    if managed(ctx, id) {
        // B2-11's `work::retry_work` is not part of this slice; TypeScript's op
        // refuses managed ids that are not human-started roots.
        return Err(not_allowed(
            "Use dispatch.retry with a requestId and revision for managed work",
        ));
    }
    let lease = delegate::begin_work(ctx, id, &format!("Retrying task {id}"))?;
    // Serialize same-key decisions before taking the sorted ancestor clean locks.
    let session_lock = LockOptions {
        stale: Duration::from_secs(600),
        ..LockOptions::default()
    };
    let result = with_lock_async(ctx, &format!("retry-{id}"), session_lock, || {
        retry_locked(ctx, runtime, id, &input)
    })
    .await
    .map_err(|e| conflict(format!("Workspace admission is busy: {e}")))?;
    delegate::finish_unlaunched_work(ctx, Some(&lease));
    result
}

fn retry_locked<'a>(
    ctx: &'a Ctx,
    runtime: &'a Runtime,
    id: &'a str,
    input: &'a RetryInput,
) -> Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>> {
    Box::pin(async move {
        let locks = ancestors(ctx, id);
        let prepared = with_clean_locks(ctx, &locks, 0, || prepare(ctx, runtime, id, input));
        prepared
            .await
            .map_err(|e| conflict(format!("Workspace admission is busy: {e}")))?
    })
}

fn with_clean_locks<'a, F, Fut, T>(
    ctx: &'a Ctx,
    locks: &'a [String],
    index: usize,
    f: F,
) -> Pin<Box<dyn Future<Output = Result<T, pacer_foundation::lock::LockError>> + Send + 'a>>
where
    F: FnOnce() -> Fut + Send + 'a,
    Fut: Future<Output = T> + Send + 'a,
    T: Send + 'a,
{
    Box::pin(async move {
        if index < locks.len() {
            let name = format!("clean-{}", locks[index]);
            let nested = with_lock_async(ctx, &name, LockOptions::default(), || {
                with_clean_locks(ctx, locks, index + 1, f)
            })
            .await?;
            nested
        } else {
            Ok(f().await)
        }
    })
}

fn prepare<'a>(
    ctx: &'a Ctx,
    runtime: &'a Runtime,
    id: &'a str,
    input: &'a RetryInput,
) -> impl Future<Output = Result<Value, CoreError>> + Send + 'a {
    async move {
        let origin;
        let params;
        let before;
        {
            let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
            let prepared = store
                .with_task_lock(id, |locked| {
                    let task = locked.read()?;
                    check_rev(&task, input.expect_rev).map_err(StoreWrap)?;
                    let answering = input.answer_text.is_some();
                    if answering
                        && (task.get("state").and_then(Value::as_str) != Some("needs_input")
                            || task.get("question").is_none()
                            || task.pointer("/question/answer").is_some()
                            || task.get("retriedBy").is_some())
                    {
                        return Err(StoreWrap(conflict("task is not waiting for an answer")));
                    }
                    let executor = if answering {
                        task.pointer("/result/executor")
                            .or_else(|| task.get("executor"))
                            .or_else(|| task.pointer("/attempts/-1/executor"))
                            .or_else(|| task.get("requestedExecutor"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    } else {
                        input.executor.clone()
                    };
                    if answering && executor.is_none() {
                        return Err(StoreWrap(invalid("task has no executor to answer on")));
                    }
                    if let Some(prior) = task
                        .get("retriedBy")
                        .and_then(Value::as_str)
                        .and_then(|retry| store_read(&ctx.pacer_home, retry))
                    {
                        if matches!(
                            prior.get("state").and_then(Value::as_str),
                            Some("queued") | Some("running")
                        ) {
                            return Err(StoreWrap(conflict(format!(
                                "{} already has an active retry {}",
                                id,
                                task["retriedBy"].as_str().unwrap_or_default()
                            ))));
                        }
                    }
                    Ok((task, executor))
                })
                .map_err(|e: StoreWrap| e.0)?;
            before = prepared.0.clone();
            origin = before
                .get("origin")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let answer_base = if input.answer_text.is_some() {
                answer_base(&before)
            } else {
                None
            };
            params = build_params(&ctx.pacer_home, &before, input, prepared.1.as_deref(), answer_base.as_deref());
        }

        let created = delegate::delegate(ctx, runtime, &params, origin.as_deref()).await?;
        let new_id = created
            .get("task_id")
            .and_then(Value::as_str)
            .ok_or_else(|| conflict("Retry delegate did not consume its admitted commit"))?
            .to_owned();

        let (child, parent) = link_retry(ctx, id, &new_id, input)?;
        append_retry_activity(ctx, &child);
        Ok(json!({
            "retry": delegate::summarize(&child),
            "of": delegate::summarize(&parent),
        }))
    }
}

/// A wrapper that turns a `CoreError` into something `with_task_lock` can carry.
struct StoreWrap(CoreError);
impl From<pacer_store::StoreError> for StoreWrap {
    fn from(e: pacer_store::StoreError) -> Self {
        match e {
            pacer_store::StoreError::UnknownTask(id) => StoreWrap(unknown(&id)),
            other => StoreWrap(internal(other.to_string())),
        }
    }
}

fn store_read(pacer_home: &std::path::Path, id: &str) -> Option<Value> {
    TaskStore::open(pacer_home).ok()?.read(id).ok().flatten()
}

/// Resolve the asking executor's current worktree HEAD, as `retryTask` does
/// (`src/core/tasks.ts:398-409`), so an answer retry starts from its own commit.
fn answer_base(task: &Value) -> Option<String> {
    let worktree = [
        task.pointer("/result/worktree"),
        task.get("worktree"),
        task.pointer("/run/workdir"),
    ]
    .into_iter()
    .filter_map(|value| value.and_then(Value::as_str))
    .find(|path| path.starts_with('/'))?;
    let output = std::process::Command::new("git")
        .args(["-C", worktree, "rev-parse", "--verify", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (head.len() == 40 && head.bytes().all(|b| b.is_ascii_hexdigit())).then_some(head)
}

fn build_params(
    pacer_home: &std::path::Path,
    task: &Value,
    input: &RetryInput,
    executor: Option<&str>,
    answer_base: Option<&str>,
) -> Value {
    let mut brief = task.get("brief").cloned().unwrap_or_else(|| json!({}));
    // An answer retry records the question/answer pair on the new brief, as
    // `retryTask` does (`src/core/tasks.ts:456`).
    if let Some(answer) = &input.answer_text {
        let question = task
            .pointer("/question/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let qa = brief.as_object_mut().map(|object| object.entry("qa").or_insert_with(|| json!([])));
        if let Some(qa) = qa
            && let Some(items) = qa.as_array_mut()
        {
            items.push(json!({"q": question, "a": answer}));
        }
    }
    if let Some(feedback) = input.feedback.as_ref().filter(|text| !text.trim().is_empty()) {
        let existing = brief.get("feedback").and_then(Value::as_str).unwrap_or_default();
        let joined = if existing.is_empty() {
            feedback.clone()
        } else {
            format!("{existing}\n\n{feedback}")
        };
        brief["feedback"] = json!(joined);
    }
    if let Some(base) = answer_base {
        brief["base"] = json!(base);
    }
    let goal = brief
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let repo = brief
        .get("repo")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| goal.split(['.', '\n']).next().unwrap_or(&goal).trim().to_owned());
    let mut params = json!({
        "goal": goal,
        "repo": repo,
        "title": title,
        "brief": brief,
        "source": task.get("source").cloned().unwrap_or_else(|| json!("planner")),
    });
    if let Some(kind) = task.get("kind").and_then(Value::as_str) {
        params["kind"] = json!(kind);
    }
    if let Some(executor) = executor {
        params["executor"] = json!(executor);
    }
    if let Some(difficulty) = task.get("difficulty") {
        params["difficulty"] = difficulty.clone();
    }
    if let Some(model) = task.get("model") {
        params["model"] = model.clone();
    }
    if let Some(worktree) = task.pointer("/placement/requested") {
        params["worktree"] = worktree.clone();
    }
    if task.pointer("/interactive") == Some(&json!(true)) {
        params["interactive"] = json!(true);
    }
    if let Some(group) = task.get("group") {
        params["group"] = group.clone();
    }
    let timeout_min = task
        .get("timeoutS")
        .and_then(Value::as_f64)
        .map(|seconds| seconds / 60.0)
        .unwrap_or(30.0);
    params["timeout_min"] = json!(timeout_min);
    let _ = pacer_home;
    params
}

fn link_retry(
    ctx: &Ctx,
    id: &str,
    new_id: &str,
    input: &RetryInput,
) -> Result<(Value, Value), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    store
        .with_task_lock(id, |locked| {
            let parent = locked.read()?;
            locked.update(parent["rev"].as_i64().unwrap_or(0), ctx.now, |t| {
                t["retriedBy"] = json!(new_id);
                if let Some(answer) = &input.answer_text {
                    t["question"]["answer"] = json!(answer);
                    t["question"]["answeredAt"] = json!(ctx.now);
                }
            })?;
            Ok(())
        })
        .map_err(|e: StoreWrap| e.0)?;
    let updated_new = store
        .update_current(new_id, ctx.now, |t| {
            t["retryOf"] = json!(id);
            if input.from_panel {
                t["fromPanel"] = json!(true);
            }
            Ok(())
        })
        .map_err(|e| internal(e.to_string()))?;
    let parent = store
        .read(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(|| unknown(id))?;
    Ok((updated_new, parent))
}

fn append_retry_activity(ctx: &Ctx, task: &Value) {
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let executor = task
        .get("executor")
        .or_else(|| task.get("requestedExecutor"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let _ = pacer_store::append_activity(
        ctx,
        json!({
            "kind": "retry",
            "level": "info",
            "text": format!("Delegated “{title}” to {executor}"),
            "taskId": task.get("id").and_then(Value::as_str).unwrap_or_default(),
        }),
    );
}

/// `task.retry_all`: retries each id in order and reports individual skips.
pub async fn retry_all(
    ctx: &Ctx,
    runtime: &Runtime,
    ids: &[String],
    executor: Option<&str>,
    from_panel: bool,
) -> Result<Value, CoreError> {
    let mut retried = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let input = RetryInput {
            executor: executor.map(str::to_owned),
            from_panel,
            ..RetryInput::default()
        };
        match retry_task(ctx, runtime, id, input).await {
            Ok(reply) => retried.push(json!({"of": reply["of"], "retry": reply["retry"]})),
            Err(error) => {
                let reason = if error.code == Code::Conflict {
                    "retry already running".to_owned()
                } else {
                    error.message.clone()
                };
                skipped.push(json!({"id": id, "reason": reason}));
            }
        }
    }
    Ok(json!({"retried": retried, "skipped": skipped}))
}
