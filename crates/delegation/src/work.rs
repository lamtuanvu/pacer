//! Native managed-work lifecycle ops (`src/core/work.ts`): `submitWork`,
//! `delegateChild`, `waitWork`, `stopWork`, `reviewWork`, `retryWork` and
//! `answerWork`.
//!
//! Submit and child route through the native [`delegate`] admission (B3-6)
//! after resolving the request's gate. Wait, stop and review resolve their
//! work-grant scope here and then call the delegation modules that own the
//! effects (`wait::wait_task`, `stop::stop_work`, `review::review_work`).
//! Retry and answer port `restartWork` (`src/core/work.ts:138-266`): the
//! `work-retry-{id}` lock, a creation-admission receipt, an IMMEDIATE CAS
//! update and a detached `_run` launch; a live lane goes to
//! [`crate::answer::answer_live_task`].
#![allow(clippy::result_large_err)]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    lock::{LockOptions, with_lock_async},
};
use pacer_lifecycle::{AdmissionError, AdmissionState, PreparedAdmission};
use pacer_repos::git_read_unmarked;
use pacer_store::TaskStore;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

use crate::delegate::{self, delegate};
use crate::runtime::Runtime;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn not_allowed(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message)
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// True when `parameter` is a value present but nullish (`null`), mirroring
/// TypeScript's `??` right-hand selection in `src/core/work.ts`.
fn is_null_value(v: &Value) -> bool {
    v.is_null()
}

/// Shallow object spread `{...base, ...over}` (`work.ts` `{...caller.options,
/// ...input.options}`): every key present in `over` replaces `base`'s.
fn spread_work_options(base: &Value, over: &Value) -> Value {
    let mut out = base.clone();
    if let (Some(base), Some(over)) = (out.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    out
}

/// Resolve the `dispatch` (work options) object for `dispatch.submit`, port of
/// `submitWork` (`src/core/work.ts:54`):
/// `workOptionsSchema.parse({...input.options, kind: input.kind ?? input.options?.kind})`.
/// The top-level `kind` only wins when non-nullish (TS `??`).
fn submit_dispatch(input: &Value) -> Value {
    let mut dispatch = input.get("options").cloned().unwrap_or_else(|| json!({}));
    if let Some(kind) = input.get("kind")
        && !is_null_value(kind)
    {
        dispatch["kind"] = kind.clone();
    }
    dispatch
}

/// Resolve the `dispatch` (work options) object for `dispatch.child`, port of
/// `delegateChild` (`src/core/work.ts:66`), which computes
/// `{...caller.options, ...input.options}` then conditionally overrides
/// `difficulty`, `model`, `kind`, `requirements` and `preferences` as that
/// function does.
fn child_dispatch(caller_options: &Value, input: &Value) -> Value {
    let input_options = input.get("options").unwrap_or(&Value::Null);
    let mut dispatch = spread_work_options(caller_options, input_options);
    // Top-level `difficulty`/`model` only override when truthy (TS spreads them
    // conditionally); a nullish top-level value must not clobber the parsed one.
    for (key, source) in [("difficulty", input), ("model", input)] {
        if let Some(value) = source.get(key)
            && !value.is_null()
            && value != &json!("")
        {
            dispatch[key] = value.clone();
        }
    }
    // `kind`: top-level `kind` wins over the options kind when non-nullish.
    if let Some(kind) = input.get("kind")
        && !is_null_value(kind)
    {
        dispatch["kind"] = kind.clone();
    }
    // `requirements`/`preferences` fall back to the caller's when the child
    // request did not supply a non-null value.
    for key in ["requirements", "preferences"] {
        let provided = input_options.get(key);
        if provided.is_none_or(is_null_value) {
            if let Some(fallback) = caller_options.get(key) {
                dispatch[key] = fallback.clone();
            }
        }
    }
    dispatch
}

/// The parent's persisted work options. Port of `caller.options` read back
/// through TS's `authorizeWorkGrant` → `getWork`, which returns the **work node**
/// (`src/core/work.ts:36-38`), not the task record. Native parents keep their
/// options in the `work_nodes` table (written by `AdmissionState::register`), so
/// they are read from there, never from the parent's task record (which has no
/// `work` field).
fn caller_options(ctx: &Ctx, task_id: &str) -> Result<Value, CoreError> {
    let mut state = pacer_lifecycle::AdmissionState::open(&ctx.pacer_home)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let work = state
        .work(task_id)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    Ok(work
        .and_then(|node| node.get("options").cloned())
        .unwrap_or_else(|| json!({})))
}

/// `dispatch.submit`: a planner or human submits managed work. Port of
/// `submitWork` (`src/core/work.ts:48-57`). A live scoped work grant turns the
/// submit into child delegation; otherwise the caller must identify a repository
/// and may not be an executor without a grant.
pub async fn submit_work(
    ctx: &Ctx,
    runtime: &Runtime,
    input: &Value,
) -> Result<Value, CoreError> {
    if ctx.env.get("PACER_WORK_GRANT").is_some() {
        return delegate_child(ctx, runtime, input).await;
    }
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(not_allowed("A scoped work grant is required"));
    }
    if input
        .get("repo")
        .and_then(Value::as_str)
        .map(str::is_empty)
        .unwrap_or(true)
    {
        return Err(invalid("Repository is required"));
    }
    let mut call = input.clone();
    call["dispatch"] = submit_dispatch(input);
    delegate(ctx, runtime, &call, Some("planner")).await
}

/// `dispatch.child`: an executor holding a live `pwg_` work grant requests an
/// isolated child. Port of `delegateChild` (`src/core/work.ts:58-110`): the
/// child inherits its parent's repository and is delegated with `workParent`,
/// `worktree: "new"` and an idempotency `request_id` so admission can build the
/// child's subtree and deduplicate replays.
pub async fn delegate_child(
    ctx: &Ctx,
    runtime: &Runtime,
    input: &Value,
) -> Result<Value, CoreError> {
    let token = ctx
        .env
        .get("PACER_WORK_GRANT")
        .ok_or_else(|| not_allowed("A scoped work grant is required"))?;
    let caller = pacer_work::authorize_work_grant(ctx, token)?;
    if input.get("requestId").map(Value::is_null).unwrap_or(true) {
        return Err(invalid("Child delegation requires an idempotency requestId"));
    }

    // The child inherits its parent's repository. Disallow overriding it.
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
    let parent = store
        .read(&caller.task_id)
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?
        .ok_or_else(|| not_allowed("Parent work no longer exists"))?;
    let repo = parent
        .pointer("/brief/repo")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let override_repo = input.get("repo").and_then(Value::as_str);
    if let Some(override_repo) = override_repo
        && !override_repo.is_empty()
        && override_repo != repo
    {
        return Err(not_allowed("Child work must use its parent's repository"));
    }

    let mut call = input.clone();
    call["repo"] = Value::String(repo);
    call["dispatch"] = child_dispatch(&caller_options(ctx, &caller.task_id)?, &call);
    call["workParent"] = Value::String(caller.task_id);
    call["worktree"] = json!("new");
    call["worktree_reason"] = json!("Isolated delegated child work");
    call["source"] = json!("planner");
    delegate(ctx, runtime, &call, Some("planner")).await
}

/// Record the start of a `child` wait for `id` (`setWorkWait`/`beginChildWait`
/// in `src/dispatch/work.ts:148-159`). A nested wait increments the refcount;
/// an idle slot starts a fresh measurement.
fn begin_child_wait(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    let row: Option<(Option<f64>, i64)> = db
        .query_row(
            "SELECT started_at,refs FROM work_waits WHERE task_id=?1 AND kind='child'",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| internal(e.to_string()))?;
    match row {
        None => {
            db.execute(
                "INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?1,'child',?2,0,1)",
                rusqlite::params![id, ctx.now],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
        Some((None, _)) => {
            db.execute(
                "UPDATE work_waits SET started_at=?1,refs=1 WHERE task_id=?2 AND kind='child'",
                rusqlite::params![ctx.now, id],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
        Some((Some(_), refs)) => {
            db.execute(
                "UPDATE work_waits SET refs=?1 WHERE task_id=?2 AND kind='child'",
                rusqlite::params![refs + 1, id],
            )
            .map_err(|e| internal(e.to_string()))?;
        }
    }
    Ok(())
}

/// Close a `child` wait for `id` (`endChildWait` in `src/dispatch/work.ts:161`).
/// A nested wait only drops the refcount; the last waiter accumulates the
/// elapsed time and clears the slot.
fn end_child_wait(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    let row: Option<(Option<f64>, i64)> = db
        .query_row(
            "SELECT started_at,refs FROM work_waits WHERE task_id=?1 AND kind='child'",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| internal(e.to_string()))?;
    let Some((started, refs)) = row else { return Ok(()) };
    if refs <= 0 {
        return Ok(());
    }
    if refs > 1 {
        db.execute(
            "UPDATE work_waits SET refs=?1 WHERE task_id=?2 AND kind='child'",
            rusqlite::params![refs - 1, id],
        )
        .map_err(|e| internal(e.to_string()))?;
        return Ok(());
    }
    let elapsed = started.map(|start| (ctx.now - start).max(0.0)).unwrap_or(0.0);
    db.execute(
        "UPDATE work_waits SET total_seconds=total_seconds+?1,started_at=NULL,refs=0 WHERE task_id=?2 AND kind='child'",
        rusqlite::params![elapsed, id],
    )
    .map_err(|e| internal(e.to_string()))?;
    Ok(())
}

/// `dispatch.wait`: wait for managed work to settle (`waitWork`,
/// `src/core/work.ts:309-315`). A grant holder measures the wait against its
/// own work item, but may never wait on itself; the wait itself belongs to
/// `wait::wait_task`.
pub async fn wait_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    timeout_s: u32,
) -> Result<Value, CoreError> {
    let parent = if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        let caller = pacer_work::authorize_work_grant(ctx, token)?;
        if caller.task_id == id {
            return Err(not_allowed("A work item cannot wait for itself"));
        }
        pacer_work::require_work_scope(ctx, token, id, false)?;
        begin_child_wait(ctx, &caller.task_id)?;
        Some(caller.task_id)
    } else {
        None
    };
    let result = crate::wait::wait_task(ctx, runtime, id, timeout_s).await;
    if let Some(parent) = parent {
        let mut end_ctx = ctx.clone();
        end_ctx.now = now_secs();
        end_child_wait(&end_ctx, &parent)?;
    }
    result
}

/// `dispatch.stop`: stop every non-terminal node in a work tree (`stopWork`,
/// `src/core/work.ts:317-326`). The tree walk and signals belong to
/// `stop::stop_work`; a grant holder must first prove the root is in scope.
pub async fn stop_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        pacer_work::require_work_scope(ctx, token, id, false)?;
    }
    crate::stop::stop_work(ctx, runtime, id, expect_rev).await
}

/// `dispatch.review`: record a verdict on managed work (`reviewWork`,
/// `src/core/work.ts:117-135`). `review::review_work` owns the lock, CAS and
/// evidence; a grant holder may only review a child in its subtree.
pub async fn review_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    accepted: bool,
    note: Option<&str>,
    expect_rev: Option<i64>,
) -> Result<Value, CoreError> {
    if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        pacer_work::require_work_scope(ctx, token, id, true)?;
    }
    crate::review::review_work(ctx, runtime, id, accepted, note, expect_rev).await
}

// ---------------------------------------------------------------------------
// Managed retry and answer (`restartWork`, `src/core/work.ts:138-266`).
// ---------------------------------------------------------------------------

/// Which side of `restartWork` is running: both share the replay ledger,
/// admission and launch, but only `answer` records a q/a pair.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RestartKind {
    Retry,
    Answer,
}

impl RestartKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::Answer => "answer",
        }
    }
}

/// The validated `dispatch.retry` / `dispatch.answer` inputs after the op
/// schema has run (`RetryWorkInput` / `AnswerWorkInput` in `src/core/work.ts`).
#[derive(Clone, serde::Serialize)]
pub struct RestartInput {
    pub expect_rev: i64,
    pub request_id: String,
    pub feedback: Option<String>,
    pub text: Option<String>,
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn unknown_work() -> CoreError {
    CoreError::new(Code::UnknownTask, "Unknown managed work")
}

/// `pidAlive` for a truthy `runnerPid` / `childPid` record value, using
/// `kill -0` (no libc or unsafe), as in `stop::stop_work`.
fn pid_alive(pid: &Value) -> bool {
    let Some(pid) = pid
        .as_i64()
        .or_else(|| pid.as_u64().and_then(|pid| i64::try_from(pid).ok()))
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// The persisted work node (`getWork`), which carries the options and the
/// parent chain, not the task record (`src/core/work.ts:36-38`).
fn work_node(ctx: &Ctx, id: &str) -> Result<Option<Value>, CoreError> {
    let mut state = AdmissionState::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    state.work(id).map_err(|e| internal(e.to_string()))
}

/// `pendingDependencies(ctx, id)` over the shared dispatch schema.
fn pending_dependencies(db: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let text: Option<String> = db
        .query_row(
            "SELECT dependencies FROM work_nodes WHERE task_id=?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| internal(e.to_string()))?;
    let Some(text) = text else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(&text).map_err(|e| internal(e.to_string()))?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}

/// A `boundedGitRead` equivalent for the worktree checks: the bounded git
/// reader in `pacer-repos` keeps the two-second deadline and returns the exit
/// code and stdout rather than throwing.
fn git_read(dir: &str, args: &[&str]) -> Option<(i32, String)> {
    git_read_unmarked(dir, args, Duration::from_secs(10))
}

/// A worktree is isolated when its real path differs from the repository's.
/// `existsSync`/`realpathSync` throw on a missing path, which TypeScript turns
/// into the same conflict as a missing worktree.
fn same_path(a: &str, b: &str) -> bool {
    let canonical = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    canonical(a) == canonical(b)
}

/// Everything `checkRestart` (`src/core/work.ts:170-185`) reads before any
/// write, plus the optional answer worktree base commit.
struct RestartState {
    before: Value,
    work: Value,
    answer_base: Option<String>,
}

/// The task and its work node, read before the live-lane branch decides
/// whether this is an in-place answer or a new attempt.
fn read_work_state(ctx: &Ctx, id: &str) -> Result<(Value, Value), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let before = store
        .read(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(unknown_work)?;
    let work = work_node(ctx, id)?.ok_or_else(unknown_work)?;
    Ok((before, work))
}

/// The first half of `restartWork`: scope, replay, single-flight lock and
/// every eligibility rule TypeScript checks before opening admission.
fn check_restart(
    ctx: &Ctx,
    id: &str,
    kind: RestartKind,
    input: &RestartInput,
) -> Result<RestartState, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let before = store
        .read(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(unknown_work)?;
    let work = work_node(ctx, id)?.ok_or_else(unknown_work)?;
    let options = work.get("options").cloned().unwrap_or_else(|| json!({}));

    if before.get("rev").and_then(Value::as_i64) != Some(input.expect_rev) {
        return Err(conflict("Work revision changed; reload before retrying"));
    }
    let state = before.get("state").and_then(Value::as_str).unwrap_or_default();
    let eligible = ["failed", "partial", "limit", "needs_input", "stopped", "done"];
    let reviewed = before
        .get("review")
        .and_then(|review| review.get("accepted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if before.get("archived").and_then(Value::as_bool).unwrap_or(false)
        || !eligible.contains(&state)
        || reviewed
        || state == "done" && !before.get("review").and_then(|r| r.get("accepted")).is_some_and(|v| v == &Value::Bool(false))
    {
        return Err(conflict("Work is not eligible for another attempt"));
    }
    if state == "stopped" && ctx.env.contains_key("PACER_WORK_GRANT") {
        return Err(not_allowed("Only the owner may restart stopped work"));
    }
    if before.get("runnerPid").is_some_and(pid_alive)
        || before.get("childPid").is_some_and(pid_alive)
    {
        return Err(conflict("Previous executor is still active"));
    }
    let worktree = before
        .get("worktree")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let checkout = worktree
        .as_deref()
        .or_else(|| before.pointer("/result/worktree").and_then(Value::as_str));
    if let Some(worktree) = worktree.as_deref()
        && !Path::new(worktree).exists()
    {
        return Err(conflict("Task worktree is unavailable; restore it before retrying"));
    }
    let options_now = ctx.now;
    if let Some(expires) = options
        .get("expiresAt")
        .and_then(Value::as_f64)
        .filter(|expires| *expires <= options_now)
    {
        let _ = expires;
        return Err(not_allowed("Work deadline has expired"));
    }
    let max_attempts = options
        .get("maxAttempts")
        .and_then(Value::as_u64)
        .unwrap_or(3);
    if before
        .get("attempts")
        .and_then(Value::as_array)
        .is_some_and(|attempts| attempts.len() as u64 >= max_attempts)
    {
        return Err(not_allowed("Managed work attempt limit reached"));
    }
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    if !pending_dependencies(db, id)?.is_empty() {
        return Err(conflict("Required dependencies have not been reviewed"));
    }
    // A stopped ancestor cannot resume child work (`src/core/work.ts:181`).
    let mut parent = work.get("parentId").and_then(Value::as_str).map(str::to_owned);
    let mut seen = std::collections::HashSet::new();
    while let Some(ancestor_id) = parent.take() {
        if !seen.insert(ancestor_id.clone()) {
            break;
        }
        let Some(ancestor) = work_node(ctx, &ancestor_id)? else {
            break;
        };
        let mut ancestor_store =
            TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        if ancestor_store
            .read(&ancestor_id)
            .map_err(|e| internal(e.to_string()))?
            .and_then(|task| task.get("state").and_then(Value::as_str).map(str::to_owned))
            == Some("stopped".to_owned())
        {
            return Err(not_allowed("A stopped ancestor cannot resume child work"));
        }
        parent = ancestor.get("parentId").and_then(Value::as_str).map(str::to_owned);
    }
    if kind == RestartKind::Answer
        && (state != "needs_input"
            || before.get("question").is_none()
            || before.pointer("/question/answer").is_some())
    {
        return Err(conflict("Work is not waiting for an answer"));
    }

    // `git rev-parse --git-common-dir` verifies that an isolated worktree still
    // belongs to its repository (work.ts:189-193).
    let repo = before
        .pointer("/brief/repo")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(worktree) = worktree.as_deref()
        && !worktree.is_empty()
        && !repo.is_empty()
        && !same_path(worktree, repo)
    {
        let args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
        let original = git_read(repo, &args);
        let candidate = git_read(worktree, &args);
        let original = original.and_then(|(code, text)| (code == 0).then_some(text));
        let candidate = candidate.and_then(|(code, text)| (code == 0).then_some(text));
        if original.is_none()
            || candidate.is_none()
            || !same_path(original.unwrap().trim(), candidate.unwrap().trim())
        {
            return Err(conflict("Task worktree no longer belongs to its repository"));
        }
    }

    // An answer starts a new attempt from the asking executor's commit
    // (`src/core/work.ts:195-201`).
    let answer_base = if kind == RestartKind::Answer {
        match checkout {
            Some(dir) if !dir.is_empty() => {
                if !Path::new(dir).exists() {
                    return Err(conflict("Worktree is unavailable for answering"));
                }
                let head = git_read(dir, &["rev-parse", "--verify", "HEAD"])
                    .and_then(|(code, text)| (code == 0).then_some(text));
                let head = head
                    .map(|text| text.trim().to_owned())
                    .filter(|head| head.len() == 40 && head.bytes().all(|b| b.is_ascii_hexdigit()));
                head.ok_or_else(|| {
                    invalid("Cannot read the asking executor's worktree HEAD")
                })?
            }
            _ => String::new(),
        }
        .into()
    } else {
        None
    };
    Ok(RestartState {
        before,
        work,
        answer_base,
    })
}

/// `prepareCreationAdmission` for a restart: a receipt that revalidates the
/// task and work options before the IMMEDIATE transaction. A missing strategy
/// has the same no-policy semantics as TypeScript's `MissingStrategyError`.
fn prepare_restart(
    ctx: &Ctx,
    id: &str,
    kind: RestartKind,
    input: &RestartInput,
    state: &RestartState,
) -> Result<PreparedAdmission, CoreError> {
    let checkout = state
        .before
        .get("worktree")
        .and_then(Value::as_str)
        .or_else(|| state.before.pointer("/result/worktree").and_then(Value::as_str));
    let paths: Vec<PathBuf> = checkout
        .filter(|path| Path::new(path).is_dir())
        .map(PathBuf::from)
        .into_iter()
        .collect();
    let context = || {
        Ok(json!({
            "task": TaskStore::open(&ctx.pacer_home)
                .ok()
                .and_then(|mut store| store.read(id).ok().flatten())
                .unwrap_or(Value::Null),
            "work": work_node(ctx, id).ok().flatten().unwrap_or(Value::Null),
        }))
    };
    let validate = |candidate: &Value| -> Result<(), AdmissionError> {
        let expect_rev = candidate
            .get("expect_rev")
            .and_then(Value::as_i64)
            .unwrap_or(input.expect_rev);
        let candidate_input = RestartInput {
            expect_rev,
            ..input.clone()
        };
        check_restart(ctx, id, kind, &candidate_input)
            .map(|_| ())
            .map_err(|error| AdmissionError(error.message))
    };
    let intent = json!({
        "id": id,
        "kind": kind.as_str(),
        "expect_rev": input.expect_rev,
        "request_id": input.request_id,
        "answer_base": state.answer_base,
    });
    PreparedAdmission::prepare(intent, &paths, None, context, validate, |candidate| {
        Ok(candidate.clone())
    })
    .map_err(|error| conflict(error.0))
}

/// `appendWorkEvent` in `src/dispatch/store.ts`.
fn append_work_event(ctx: &Ctx, task_id: &str, kind: &str, data: &Value) -> Result<(), CoreError> {
    let text = serde_json::to_string(data).map_err(|e| internal(e.to_string()))?;
    if text.len() > 256 * 1024 {
        return Err(CoreError::new(Code::TooLarge, "Work record exceeds 256 KiB"));
    }
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    db.execute(
        "INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,task_id,?1,?2,?3 FROM work_nodes WHERE task_id=?4",
        rusqlite::params![ctx.now, kind, text, task_id],
    )
    .map_err(|e| internal(e.to_string()))?;
    Ok(())
}

/// Turn a `StoreError` into a `CoreError` inside `with_task_lock`.
struct StoreWrap(CoreError);
impl From<pacer_store::StoreError> for StoreWrap {
    fn from(error: pacer_store::StoreError) -> Self {
        match error {
            pacer_store::StoreError::UnknownTask(id) => StoreWrap(unknown_work_for(&id)),
            other => StoreWrap(internal(other.to_string())),
        }
    }
}

fn unknown_work_for(_id: &str) -> CoreError {
    unknown_work()
}

/// `restartWork` (`src/core/work.ts:143-271`), shared by `retryWork` and
/// `answerWork`. The request id is stable per `(kind, requestId)`; the replay
/// ledger makes a repeated call idempotent.
pub async fn restart_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    kind: RestartKind,
    input: RestartInput,
) -> Result<Value, CoreError> {
    if let Some(token) = ctx.env.get("PACER_WORK_GRANT") {
        pacer_work::require_work_scope(ctx, token, id, true)?;
    } else if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(not_allowed("A scoped work grant is required"));
    }
    let valid_request_id = |text: &str| {
        (1..=128).contains(&text.chars().count())
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    if !valid_request_id(&input.request_id) {
        return Err(invalid(
            "A stable request ID of 1–128 letters, digits, dots, dashes or underscores is required",
        ));
    }
    if kind == RestartKind::Answer {
        let len = input.text.as_deref().map(str::chars).map(Iterator::count).unwrap_or(0);
        if len == 0 || len > 2000 {
            return Err(invalid("Answer must contain 1–2000 characters"));
        }
    } else if input
        .feedback
        .as_deref()
        .map(|text| text.chars().count() > 2000)
        .unwrap_or(false)
    {
        return Err(invalid("Feedback must contain at most 2000 characters"));
    }

    let key = pacer_work::token_hash(&format!("{}:{}", kind.as_str(), input.request_id));
    let fingerprint = pacer_work::token_hash(
        &serde_json::to_string(&json!({"kind": kind.as_str(), "input": input}))
            .map_err(|e| internal(e.to_string()))?,
    );
    {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let db = store.connection().map_err(|e| internal(e.to_string()))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS work_retry_requests(task_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY(task_id,key));",
        )
        .map_err(|e| internal(e.to_string()))?;
        let prior: Option<String> = db
            .query_row(
                "SELECT fingerprint FROM work_retry_requests WHERE task_id=?1 AND key=?2",
                rusqlite::params![id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| internal(e.to_string()))?;
        if let Some(prior) = prior {
            if prior != fingerprint {
                return Err(conflict("Request ID was used for different work"));
            }
            return read_summarized(ctx, id);
        }
    }

    let lease = delegate::begin_work(ctx, id, "Restarting managed work")?;
    let result = async {
        let session_lock = LockOptions {
            stale: Duration::from_secs(600),
            ..LockOptions::default()
        };
        with_lock_async(ctx, &format!("work-retry-{id}"), session_lock, || async {
            // The replay check is repeated inside the lock (`work.ts:158-160`).
            {
                let mut store =
                    TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
                let db = store.connection().map_err(|e| internal(e.to_string()))?;
                let prior: Option<String> = db
                    .query_row(
                        "SELECT fingerprint FROM work_retry_requests WHERE task_id=?1 AND key=?2",
                        rusqlite::params![id, key],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| internal(e.to_string()))?;
                if let Some(prior) = prior {
                    if prior != fingerprint {
                        return Err(conflict("Request ID was used for different work"));
                    }
                    return read_summarized(ctx, id);
                }
            }
            // A live lane is typed into the executor's session and keeps the
            // same attempt; TypeScript checks this *before* `checkRestart`
            // (`src/core/work.ts:163-168`), so a running task can be answered.
            if kind == RestartKind::Answer {
                let (before, work) = read_work_state(ctx, id)?;
                if crate::answer::direct_input_available(&before) {
                    if work
                        .get("options")
                        .and_then(|options| options.get("expiresAt"))
                        .and_then(Value::as_f64)
                        .is_some_and(|expires| expires <= ctx.now)
                    {
                        return Err(not_allowed("Work deadline has expired"));
                    }
                    let text = input.text.as_deref().unwrap_or_default();
                    crate::answer::answer_live_task(ctx, id, text, Some(input.expect_rev)).await?;
                    record_replay(
                        ctx,
                        id,
                        &key,
                        &fingerprint,
                        before
                            .get("attempts")
                            .and_then(Value::as_array)
                            .map(Vec::len)
                            .unwrap_or(0) as i64
                            + 1,
                    )?;
                    return read_summarized(ctx, id);
                }
            }

            let state = check_restart(ctx, id, kind, &input)?;

            let mut admission = prepare_restart(ctx, id, kind, &input, &state)?;
            let updated = admission.consume(
                || {
                    Ok(json!({
                        "task": TaskStore::open(&ctx.pacer_home)
                            .ok()
                            .and_then(|mut store| store.read(id).ok().flatten())
                            .unwrap_or(Value::Null),
                        "work": work_node(ctx, id).ok().flatten().unwrap_or(Value::Null),
                    }))
                },
                |_| Ok(()),
                |_authorized| {
                    let commit = || -> Result<Value, CoreError> {
                    let mut store =
                        TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
                    store
                        .with_task_lock(id, |locked| -> Result<Value, StoreWrap> {
                            let current = locked.read()?;
                            if current.get("rev").and_then(Value::as_i64)
                                != Some(input.expect_rev)
                            {
                                return Err(StoreWrap(conflict(
                                    "Work revision changed; reload before retrying",
                                )));
                            }
                            let mut store =
                                TaskStore::open(&ctx.pacer_home).map_err(|e| StoreWrap(internal(e.to_string())))?;
                            let db = store.connection().map_err(|e| StoreWrap(internal(e.to_string())))?;
                            let existing: Option<String> = db
                                .query_row(
                                    "SELECT fingerprint FROM work_retry_requests WHERE task_id=?1 AND key=?2",
                                    rusqlite::params![id, key],
                                    |row| row.get(0),
                                )
                                .optional()
                                .map_err(|e| StoreWrap(internal(e.to_string())))?;
                            if let Some(existing) = existing {
                                if existing != fingerprint {
                                    return Err(StoreWrap(conflict(
                                        "Request ID was used for different work",
                                    )));
                                }
                                return Ok(current);
                            }
                            let attempt = current
                                .get("attempts")
                                .and_then(Value::as_array)
                                .map(Vec::len)
                                .unwrap_or(0) as i64
                                + 1;
                            let old = json!({
                                "state": current.get("state").cloned().unwrap_or(Value::Null),
                                "result": current.pointer("/result/status").cloned().unwrap_or(Value::Null),
                                "review": current.get("review").cloned().unwrap_or(Value::Null),
                                "attempts": attempt - 1,
                            });
                            let rev = current.get("rev").and_then(Value::as_i64).unwrap_or(0);
                            let next = locked.update(rev, ctx.now, |task| {
                                if kind == RestartKind::Answer {
                                    let question = task
                                        .pointer("/question/text")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned();
                                    let qa = task.pointer_mut("/brief/qa").and_then(Value::as_array_mut);
                                    if let Some(qa) = qa {
                                        qa.push(json!({"q": question, "a": input.text.as_deref().unwrap_or_default()}));
                                    } else if let Some(brief) = task.get_mut("brief") {
                                        brief["qa"] = json!([{"q": question, "a": input.text.as_deref().unwrap_or_default()}]);
                                    }
                                    if let Some(base) = &state.answer_base
                                        && !base.is_empty()
                                    {
                                        task["brief"]["base"] = json!(base);
                                    }
                                    task["requestedExecutor"] = task
                                        .pointer("/result/executor")
                                        .or_else(|| task.get("executor"))
                                        .or_else(|| task.pointer("/attempts/-1/executor"))
                                        .cloned()
                                        .unwrap_or(Value::Null);
                                } else if let Some(feedback) = input.feedback.as_deref()
                                    && !feedback.trim().is_empty()
                                {
                                    let existing = task
                                        .pointer("/brief/feedback")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default();
                                    let joined = if existing.is_empty() {
                                        feedback.trim().to_owned()
                                    } else {
                                        format!("{existing}\n\n{}", feedback.trim())
                                    };
                                    task["brief"]["feedback"] = json!(joined);
                                }
                                if task.get("worktree").is_none()
                                    && let Some(worktree) = task.pointer("/result/worktree").cloned()
                                {
                                    task["worktree"] = worktree;
                                }
                                task["state"] = json!("queued");
                                task["queue"] = json!({
                                    "reason": "waiting_retry",
                                    "detail": "Restart requested",
                                    "since": ctx.now,
                                    "position": 1,
                                    "nextAt": ctx.now,
                                });
                                for key in [
                                    "settledAt", "result", "review", "resolved",
                                    "resolutionCheckedAt", "question", "reviewRequest", "run",
                                    "runnerPid", "childPid", "pendingAttempt",
                                    "attemptStartedAt", "progress", "executor", "backend",
                                ] {
                                    if let Some(map) = task.as_object_mut() {
                                        map.remove(key);
                                    }
                                }
                            })?;
                            db.execute(
                                "INSERT INTO work_retry_requests(task_id,key,fingerprint,attempt) VALUES(?1,?2,?3,?4)",
                                rusqlite::params![id, key, fingerprint, attempt],
                            )
                            .map_err(|e| StoreWrap(internal(e.to_string())))?;
                            db.execute(
                                "UPDATE work_grants SET revoked=1 WHERE task_id=?1",
                                rusqlite::params![id],
                            )
                            .map_err(|e| StoreWrap(internal(e.to_string())))?;
                            db.execute(
                                "DELETE FROM work_reservations WHERE task_id=?1",
                                rusqlite::params![id],
                            )
                            .map_err(|e| StoreWrap(internal(e.to_string())))?;
                            let event = if kind == RestartKind::Answer {
                                "work.answer_recorded"
                            } else {
                                "work.retry_requested"
                            };
                            append_work_event(
                                ctx,
                                id,
                                event,
                                &json!({
                                    "attempt": attempt,
                                    "previous": old,
                                    "requestIdHash": key,
                                }),
                            )
                            .map_err(StoreWrap)?;
                            Ok(next)
                        })
                        .map_err(|error: StoreWrap| error.0)
                    };
                    commit().map_err(|error| AdmissionError(error.message))
                },
            )
            .map_err(|error| conflict(error.0))?;

            let mut launch_ctx = ctx.clone();
            launch_ctx.env.remove("PACER_WORK_GRANT");
            launch_ctx.env.remove("PACER_ROLE");
            if let Err(error) = runtime.spawn.launch(&launch_ctx, id, None) {
                let _ = append_work_event(
                    ctx,
                    id,
                    "work.launch_deferred",
                    &json!({"reason": error.message}),
                );
            }
            Ok(delegate::summarize(&updated))
        })
        .await
        .map_err(|error| conflict(format!("Restart is busy: {error}")))?
    }
    .await;
    delegate::finish_unlaunched_work(ctx, Some(lease.as_str()));
    result
}

fn record_replay(
    ctx: &Ctx,
    id: &str,
    key: &str,
    fingerprint: &str,
    attempt: i64,
) -> Result<(), CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    db.execute(
        "INSERT OR IGNORE INTO work_retry_requests(task_id,key,fingerprint,attempt) VALUES(?1,?2,?3,?4)",
        rusqlite::params![id, key, fingerprint, attempt],
    )
    .map_err(|e| internal(e.to_string()))?;
    Ok(())
}

fn read_summarized(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let task = store
        .read(id)
        .map_err(|e| internal(e.to_string()))?
        .ok_or_else(unknown_work)?;
    Ok(delegate::summarize(&task))
}

/// `dispatch.retry`: restart a settled managed item in the same lineage.
pub async fn retry_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    input: RestartInput,
) -> Result<Value, CoreError> {
    restart_work(ctx, runtime, id, RestartKind::Retry, input).await
}

/// `dispatch.answer`: record a question's answer and resume the same item.
pub async fn answer_work(
    ctx: &Ctx,
    runtime: &Runtime,
    id: &str,
    input: RestartInput,
) -> Result<Value, CoreError> {
    restart_work(ctx, runtime, id, RestartKind::Answer, input).await
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;