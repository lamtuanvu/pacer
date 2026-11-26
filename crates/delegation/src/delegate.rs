//! Native `task.delegate`: admission, commit and launch.
//!
//! Port of `delegate` (`src/core/tasks.ts`), `prepareDelegate`, `commitDelegate`,
//! `validateInput`, `userStartedWork`, `strictCandidateSkip` (`src/tasks/api.ts`) and
//! `prepareCreationAdmission` (`src/tasks/creation-admission.ts`). The prepared receipt
//! comes from `pacer_lifecycle::prepare_delegate_admission`; plugin policy, runner spawn
//! and supervision reach this module only through [`Runtime`].
#![allow(clippy::result_large_err)]

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    lock::{LockOptions, with_lock_async},
};
use pacer_lifecycle::{
    AdmissionError, AdmissionState, DelegateAdmissionSnapshot, ExecutorResolution,
    PolicyAmendment, ValidationContext, map_policy_amendment, prepare_delegate_admission,
    read_project_strategies, resolve_runner, validate_input,
};

use pacer_repos::registered_repo;
use pacer_store::TaskStore;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::runtime::Runtime;

#[cfg(test)]
mod tests;

/// Public `delegateSchema` fields, decoded from the operation's params. Unknown
/// caller fields are discarded by the brief parser, as they are by Zod's object.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DelegateInput {
    pub goal: String,
    pub repo: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "request_id")]
    pub request_id: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub acceptance: Option<String>,
    #[serde(default)]
    pub constraints: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default, rename = "acceptance_timeout_min")]
    pub acceptance_timeout_min: Option<u32>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub executor: Option<String>,
    #[serde(default, rename = "worktree")]
    pub worktree: Option<String>,
    #[serde(default, rename = "timeout_min")]
    pub timeout_min: Option<f64>,
    #[serde(default)]
    pub grant: Option<bool>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn conflict(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Conflict, message)
}

fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn admission(error: AdmissionError) -> CoreError {
    let text = error.0;
    if text.contains("Admission context changed")
        || text.contains("Repository changed")
        || text.contains("already consumed")
    {
        conflict(text)
    } else {
        invalid(text)
    }
}

/// Runs `policy.before` for every enabled policy plugin, outside every task lock.
/// Delegation amendments stay host-owned: a policy may refine kind and placement
/// (`new` only) but never choose the executor. In closed mode a veto or a failing
/// plugin denies the delegation; in open mode failures are ignored.
async fn evaluate_delegate_policy(
    runtime: &Runtime,
    ctx: &Ctx,
    strategy: &Value,
    brief: &Value,
    input: &Value,
    providers: &[String],
) -> Result<Value, CoreError> {
    let closed = strategy
        .pointer("/plugins/policy/mode")
        .and_then(Value::as_str)
        == Some("closed");
    let mut current = input.clone();
    for id in providers {
        let envelope = json!({
            "decision": "delegate",
            "input": {
                "goal": brief.get("goal").cloned().unwrap_or(Value::Null),
                "repo": brief.pointer("/repo").cloned().unwrap_or(Value::Null),
                "kind": current.get("kind").cloned().filter(|value| !value.is_null()),
                "requestedExecutor": current.get("executor").cloned().filter(|value| !value.is_null()),
                "placement": current.get("worktree").cloned().unwrap_or_else(|| json!("auto")),
            },
        });
        let verdict = match runtime
            .plugins
            .call(ctx, id, "policy.before", envelope, Duration::from_secs(3))
            .await
        {
            Ok(verdict) => verdict,
            Err(error) => {
                if closed {
                    return Err(CoreError::new(Code::NotAllowed, error.message)
                        .hint(format!("plugin {id}")));
                }
                continue;
            }
        };
        match verdict.get("verdict").and_then(Value::as_str) {
            Some("veto") => {
                let reason = verdict
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Policy vetoed decision");
                return Err(CoreError::new(Code::NotAllowed, reason).hint(format!("plugin {id}")));
            }
            Some("amend") => {
                let Some(amendment) = verdict.get("amend") else {
                    continue;
                };
                let parsed = PolicyAmendment::from_value(amendment);
                if let Some(kind) = &parsed.kind {
                    current["kind"] = kind.clone();
                    if let Some(dispatch) = current.get_mut("dispatch").and_then(Value::as_object_mut) {
                        if kind.is_null() {
                            dispatch.remove("kind");
                        } else {
                            dispatch.insert("kind".into(), kind.clone());
                        }
                    }
                }
                if let Some(placement) = &parsed.placement {
                    if placement != "new" {
                        return Err(invalid("Placement amendments may only move to an isolated worktree"));
                    }
                    current["worktree"] = placement.clone();
                }
                if let Some(executor) = &parsed.requested_executor
                    && executor != &current.get("executor").cloned().unwrap_or(Value::Null)
                {
                    return Err(invalid("Executor amendments are refused: the host chooses the executor"));
                }
            }
            _ => {}
        }
    }
    Ok(current)
}

/// `strictCandidateSkip` (`src/tasks/api.ts`): detail of the first strict miss.
pub fn strict_candidate_skip(strategy: &Value, input: &Value) -> Option<Value> {
    let ids: Vec<String> = match input.get("executor").and_then(Value::as_str) {
        Some(id) => vec![id.to_owned()],
        None => strategy
            .get("runners")
            .or_else(|| strategy.get("providers"))
            .and_then(Value::as_object)
            .map(|runners| runners.keys().cloned().collect())
            .unwrap_or_default(),
    };
    let order = ["unverified", "interactive", "unsupported", "unavailable"];
    let mut misses: Vec<(usize, String)> = Vec::new();
    for id in ids {
        let runner = resolve_runner(strategy, &id);
        let ready = runner
            .as_ref()
            .and_then(|r| r.get("enabled"))
            .is_none_or(|enabled| enabled != false);
        if ready {
            return None;
        }
        let code = runner
            .as_ref()
            .and_then(|r| r.get("unavailableReason"))
            .and_then(Value::as_str)
            .unwrap_or("unavailable");
        let rank = order.iter().position(|item| *item == code).unwrap_or(3);
        misses.push((rank, format!("{id}: not available")));
    }
    misses.sort_by_key(|(rank, _)| *rank);
    let detail = if misses.is_empty() {
        "No executor is available".to_owned()
    } else {
        misses
            .into_iter()
            .map(|(_, detail)| detail)
            .collect::<Vec<_>>()
            .join("; ")
    };
    Some(json!({"reason": "unavailable", "detail": detail}))
}

/// `userStartedWork` (`src/tasks/api.ts`): a human root may coordinate children.
pub fn user_started_work(strategy: &Value, input: &Value, origin: Option<&str>) -> bool {
    if input.get("workParent").is_some()
        || input.get("dispatch").is_some()
        || origin != Some("human")
    {
        return false;
    }
    let grants = strategy.pointer("/messaging/grants");
    if grants.is_none() {
        return false;
    }
    input.get("grant").is_none_or(|value| value != false)
}

/// `summarizeTask` (`src/tasks/api.ts`) for the stored record.
pub(crate) fn summarize(task: &Value) -> Value {
    let goal = task
        .pointer("/brief/goal")
        .and_then(Value::as_str)
        .unwrap_or("");
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let first = goal.split(['.', '\n']).next().unwrap_or(goal).trim();
            let mut clipped: String = first.chars().take(57).collect();
            if first.chars().count() > 57 {
                clipped.push('…');
            }
            clipped
        });
    let attempts = task
        .get("attempts")
        .and_then(Value::as_array)
        .map(|attempts| {
            attempts
                .iter()
                .map(|attempt| {
                    json!({
                        "executor": attempt.get("executor").cloned().unwrap_or(Value::Null),
                        "model": attempt.get("model").cloned().unwrap_or(Value::Null),
                        "account": attempt.pointer("/usageAtStart/account").cloned().unwrap_or(Value::Null),
                        "exit_code": attempt.get("exitCode").cloned().unwrap_or(Value::Null),
                        "limit_hit": attempt.get("limitHit").cloned().unwrap_or(Value::Null),
                        "timed_out": attempt.get("timedOut").cloned().unwrap_or(Value::Null),
                        "log": attempt.get("log").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut out = Map::new();
    if let Some(source) = task.get("difficultySource") {
        out.insert("difficulty".into(), task.get("difficulty").cloned().unwrap_or(Value::Null));
        out.insert("difficultySource".into(), source.clone());
        if let Some(model) = task.get("model") {
            out.insert("model".into(), model.clone());
        }
    }
    if task.get("archived") == Some(&json!(true)) {
        out.insert("archived".into(), json!(true));
        out.insert("archive_path".into(), task.get("archivePath").cloned().unwrap_or(Value::Null));
    }
    out.insert("task_id".into(), task.get("id").cloned().unwrap_or(Value::Null));
    out.insert("title".into(), Value::String(title));
    out.insert("goal".into(), Value::String(goal.chars().take(200).collect()));
    let state = match task.get("state").and_then(Value::as_str) {
        Some("running") if task.pointer("/question/answer").is_none() && task.get("question").is_some() => "needs_input",
        Some(state) => state,
        None => "queued",
    };
    out.insert("state".into(), Value::String(state.into()));
    for (target, source) in [
        ("kind", "kind"),
        ("requested_executor", "requestedExecutor"),
        ("executor_fallback", "executorFallback"),
        ("placement", "placement"),
        ("queue", "queue"),
        ("stop_pending", "stopPending"),
        ("attempts", "attempts"),
        ("current_attempt", "pendingAttempt"),
        ("question", "question"),
        ("reviewRequest", "reviewRequest"),
        ("result", "result"),
        ("review", "review"),
        ("resolved", "resolved"),
    ] {
        if target == "attempts" {
            out.insert("attempts".into(), Value::Array(attempts.clone()));
            continue;
        }
        if let Some(value) = task.get(source) {
            out.insert(target.into(), value.clone());
        } else if matches!(target, "kind" | "requested_executor" | "placement" | "queue" | "result" | "review" | "resolved") {
            out.insert(target.into(), Value::Null);
        }
    }
    Value::Object(out)
}

/// `canonicalAsync` (`src/core/repos.ts`): realpath when the path exists, otherwise
/// canonicalize the longest existing ancestor and re-append the missing components.
fn canonical_path(path: &str) -> String {
    let original = Path::new(path);
    if let Ok(real) = std::fs::canonicalize(original) {
        return real.to_string_lossy().into_owned();
    }
    let mut cursor = original;
    let mut missing = Vec::new();
    while !cursor.exists() {
        if let Some(name) = cursor.file_name() {
            missing.push(name.to_os_string());
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }
    let mut resolved = std::fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    resolved.to_string_lossy().into_owned()
}

/// `summarizeTask` plus the difficulty warning the public op adds (`src/api/ops.ts:501`).
fn with_warnings(mut reply: Value) -> Value {
    if reply
        .get("difficultySource")
        .and_then(Value::as_str)
        == Some("unspecified")
    {
        reply["warnings"] = json!([{
            "code": "difficulty_missing",
            "field": "difficulty",
            "values": ["simple", "standard", "complex"],
        }]);
    }
    reply
}

/// A UUID-shaped, process-local lease id. It is never returned to callers.
fn lease_id(ctx: &Ctx) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:08x}-{:08x}-{:08x}", ctx.now.to_bits() as u32, std::process::id(), nanos as u32)
}

/// Persist a pending launch lease before any side effect. Mirrors `beginWorkSync`.
pub(crate) fn begin_work(ctx: &Ctx, id: &str, label: &str) -> Result<String, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
    let db = store.connection().map_err(|e| internal(e.to_string()))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL);
         INSERT OR IGNORE INTO admission (id, state) VALUES (1, '{\"schema\":1,\"reservation\":null,\"leases\":[]}');",
    )
    .map_err(|e| internal(e.to_string()))?;
    let text: String = db
        .query_row("SELECT state FROM admission WHERE id = 1", [], |row| row.get(0))
        .map_err(|e| internal(e.to_string()))?;
    let mut state: Value = serde_json::from_str(&text).map_err(|e| internal(e.to_string()))?;
    let leases = state
        .as_object_mut()
        .and_then(|map| map.get_mut("leases"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| conflict("Desktop admission evidence is unavailable"))?;
    let lease = lease_id(ctx);
    leases.push(json!({
        "id": lease,
        "blocker": {"kind": "launch", "id": id, "label": label},
        "state": "pending",
    }));
    db.execute(
        "UPDATE admission SET state = ? WHERE id = 1",
        [serde_json::to_string(&state).map_err(|e| internal(e.to_string()))?],
    )
    .map_err(|e| internal(e.to_string()))?;
    Ok(lease)
}

/// Release an unused preallocation. Mirrors `finishUnlaunchedWorkSync`.
pub(crate) fn finish_unlaunched_work(ctx: &Ctx, lease: Option<&str>) {
    let Some(lease) = lease else {
        return;
    };
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return;
    };
    let Ok(db) = store.connection() else {
        return;
    };
    let Ok(text) = db.query_row("SELECT state FROM admission WHERE id = 1", [], |row| row.get::<_, String>(0)) else {
        return;
    };
    let Ok(mut state) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if let Some(leases) = state
        .as_object_mut()
        .and_then(|map| map.get_mut("leases"))
        .and_then(Value::as_array_mut)
    {
        leases.retain(|item| item.get("id").and_then(Value::as_str) != Some(lease));
        if let Ok(serialized) = serde_json::to_string(&state) {
            let _ = db.execute("UPDATE admission SET state = ? WHERE id = 1", [serialized]);
        }
    }
}

fn snapshot(
    ctx: &Ctx,
    strategy: &Value,
    input: &Value,
) -> Result<DelegateAdmissionSnapshot, AdmissionError> {
    let projects = read_project_strategies(&ctx.pacer_home)?;
    let repo = input
        .pointer("/brief/repo")
        .and_then(Value::as_str)
        .map(|path| registered_repo(&ctx.pacer_home, path).unwrap_or_else(|| json!({"path": path})))
        .unwrap_or(Value::Null);
    let registration = registered_repo(&ctx.pacer_home, input.pointer("/brief/repo").and_then(Value::as_str).unwrap_or(""));
    let parent = input
        .get("workParent")
        .and_then(Value::as_str)
        .and_then(|id| {
            TaskStore::open(&ctx.pacer_home)
                .ok()
                .and_then(|mut store| store.read(id).ok().flatten())
        });
    Ok(DelegateAdmissionSnapshot {
        strategy: strategy.clone(),
        projects,
        repo,
        exclusions: json!({}),
        registered: registration,
        parent,
        work: None,
        root: None,
        active: None,
        candidates: None,
        context: None,
    })
}

fn utc_stamp(now: f64) -> String {
    let secs = now as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Build a new task id in TypeScript's `t-YYYYMMDD-HHMMSS-XXXX` form.
fn new_task_id(ctx: &Ctx, attempt: u32) -> String {
    format!("t-{}-{:04x}", utc_stamp(ctx.now), attempt)
}

/// Native `task.delegate`. Returns `summarizeTask` of the created (or deduped) task.
pub async fn delegate(
    ctx: &Ctx,
    runtime: &Runtime,
    params: &Value,
    origin: Option<&str>,
) -> Result<Value, CoreError> {
    // Zod's op schema runs before the handler, then the handler resolves the repository
    // and checks its directory before any strategy or admission work.
    let requested_repo = params.get("repo").and_then(Value::as_str).unwrap_or_default();
    let parsed =
        pacer_lifecycle::parse_delegate_brief(params, requested_repo).map_err(|e| invalid(e.0))?;
    // A retry carries the stored brief verbatim (including accumulated qa/feedback).
    // `retryTask` supplies it through `brief`; an ordinary delegate has none and uses
    // the brief assembled from the public fields by `parse_delegate_brief`.
    let mut brief = params
        .get("brief")
        .cloned()
        .or_else(|| parsed.get("brief").cloned())
        .unwrap_or(Value::Null);
    let repo_path = if Path::new(requested_repo).is_absolute() {
        requested_repo.to_owned()
    } else {
        pacer_repos::list_repos_read_only(&ctx.pacer_home)
            .into_iter()
            .find(|repo| repo.key == requested_repo)
            .map(|repo| repo.path)
            .ok_or_else(|| invalid("repo must be an absolute path or a registered repo key"))?
    };
    let repo_path = canonical_path(&repo_path);
    match std::fs::metadata(&repo_path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(invalid(format!("repo is not a directory: {repo_path}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(invalid(format!("repo does not exist: {repo_path}")));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            return Err(invalid(format!("repo does not exist: {repo_path}")));
        }
        Err(_) => return Err(invalid(format!("repo folder is not responding: {repo_path}"))),
    }
    brief["repo"] = Value::String(repo_path.clone());
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;

    let mut input = parsed
        .get("input")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    input["brief"] = brief.clone();
    input["repoValidated"] = json!(true);
    if let Some(origin) = origin {
        input["origin"] = Value::String(origin.into());
    }

    let provider_ids: Vec<String> = strategy
        .get("providers")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default();
    let provider_names: Vec<&str> = provider_ids.iter().map(String::as_str).collect();
    let executor_name = input.get("executor").and_then(Value::as_str).unwrap_or_default();
    let planner_name = strategy
        .pointer("/planner/agent")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resolution = if executor_name.is_empty() {
        ExecutorResolution::Unknown
    } else if executor_name == planner_name {
        ExecutorResolution::Planner
    } else {
        ExecutorResolution::Other
    };
    let context = ValidationContext {
        configured_providers: &provider_names,
        executor: resolution,
    };
    let problems = validate_input(&input, true, &context);
    if !problems.is_empty() {
        return Err(invalid(problems.join("; ")));
    }

    if let Some(rid) = input.get("requestId").and_then(Value::as_str) {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(|e| internal(e.to_string()))?;
        let prior = store
            .list_active_and_recent(ctx.now - 600.0)
            .map_err(|e| internal(e.to_string()))?;
        if let Some(existing) = prior.into_iter().find(|task| {
            task.get("requestId").and_then(Value::as_str) == Some(rid)
                && (ctx.now - task.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0))
                    .is_finite()
                && ctx.now - task.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0) >= 0.0
                && ctx.now - task.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0) <= 600.0
        }) {
            if existing.get("brief") != Some(&brief) {
                return Err(conflict("request_id was already used for a different brief"));
            }
            return Ok(with_warnings(summarize(&existing)));
        }
    }

    let lease = Some(begin_work(ctx, "delegate", "Delegating task")?);

    let result = async {
        // Plugin policy finishes before any task or session lock is taken.
        let providers = runtime.plugins.providers(ctx, "policy.before");
        let authorized = evaluate_delegate_policy(
            runtime,
            ctx,
            &strategy,
            &brief,
            &input,
            &providers,
        )
        .await?;

        let mut prepared = prepare_delegate_admission(
            &authorized,
            "",
            &[],
            None,
            || snapshot(ctx, &strategy, &authorized),
            |candidate| {
                let amendment = pacer_lifecycle::PolicyAmendment::from_value(candidate);
                Ok(map_policy_amendment(&authorized, &amendment))
            },
        )
        .map_err(admission)?;

        let snapshot_ctx = || snapshot(ctx, &strategy, &authorized).map(|value| value.admission_value());
        let validate_ctx = |candidate: &Value| -> Result<(), AdmissionError> {
            snapshot(ctx, &strategy, candidate)?.validate_input(candidate)
        };

        let session_lock = LockOptions {
            stale: Duration::from_secs(600),
            ..LockOptions::default()
        };
        let created = with_lock_async(ctx, "session-create", session_lock, || async {
            prepared.consume_checked(
                snapshot_ctx,
                validate_ctx,
                |effective, revalidate| {
                    revalidate()?;
                    create_and_launch(ctx, runtime, effective, origin)
                },
            )
        })
        .await
        .map_err(|error| conflict(format!("Workspace admission is busy: {error}")))?
        .map_err(admission)?;

        Ok(with_warnings(summarize(&created.task)))
    }
    .await;

    finish_unlaunched_work(ctx, lease.as_deref());
    result
}

struct Created {
    task: Value,
}

fn create_and_launch(
    ctx: &Ctx,
    runtime: &Runtime,
    input: &Value,
    origin: Option<&str>,
) -> Result<Created, AdmissionError> {
    let brief = input.get("brief").cloned().unwrap_or(Value::Null);
    let now = ctx.now;
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let goal = brief.pointer("/goal").and_then(Value::as_str).unwrap_or("");
            goal.split(['.', '\n']).next().unwrap_or(goal).trim().to_owned()
        });
    let mut state = AdmissionState::open(&ctx.pacer_home)?;
    let id = (0..65)
        .map(|attempt| new_task_id(ctx, attempt))
        .find(|id| state.read(id).map(|task| task.is_none()).unwrap_or(false))
        .ok_or_else(|| AdmissionError("could not allocate a unique task id".into()))?;

    let user_work = user_started_work(&state_strategy(ctx)?, input, origin);
    let managed_skip = if user_work {
        strict_candidate_skip(&state_strategy(ctx)?, input)
    } else {
        None
    };
    let work_options = if input.get("workParent").is_some() || input.get("dispatch").is_some() {
        Some(input.get("dispatch").cloned().unwrap_or_else(|| json!({})))
    } else if managed_skip.is_none() && user_work {
        Some(json!({"allowDelegation": true, "delegationEnforcement": "strict"}))
    } else {
        None
    };
    let timeout_min = input
        .get("timeoutMin")
        .and_then(Value::as_f64)
        .unwrap_or(30.0);
    let mut task = json!({
        "rev": 1,
        "id": id,
        "createdAt": now,
        "title": title,
        "brief": brief,
        "kind": input.get("kind").cloned().unwrap_or(Value::Null),
        "requestedExecutor": input.get("executor").cloned().unwrap_or(Value::Null),
        "timeoutS": (timeout_min * 60.0).round() as i64,
        "state": "queued",
        "attempts": [],
        "difficulty": input.get("difficulty").cloned().unwrap_or_else(|| json!("standard")),
        "difficultySource": input.get("difficultySource").cloned().unwrap_or_else(|| json!("unspecified")),
        "source": input.get("source").cloned().unwrap_or_else(|| json!("planner")),
        "placement": json!({"requested": input.get("worktree").cloned().unwrap_or_else(|| json!("auto"))}),
    });
    if let Some(model) = input.get("model") {
        task["model"] = model.clone();
    }
    if let Some(rid) = input.get("requestId") {
        task["requestId"] = rid.clone();
    }
    if let Some(origin) = origin {
        task["origin"] = Value::String(origin.into());
    }
    if let Some(messaging) = input.get("messaging") {
        task["messaging"] = messaging.clone();
    }
    if let Some(skip) = managed_skip {
        task["managedSkip"] = skip;
    }
    if let Some(parent) = input.get("workParent").and_then(Value::as_str) {
        task["workParent"] = Value::String(parent.into());
    }
    if input.get("interactive") == Some(&json!(true)) {
        task["interactionMode"] = json!("conversation");
        task["conversation"] = json!({"activity": "starting"});
        task["interactive"] = json!(true);
    }
    if input.get("interactive") == Some(&json!(false)) {
        task["interactive"] = json!(false);
    }
    if let Some(group) = input.get("group") {
        task["group"] = group.clone();
    }

    state.create(
        &task,
        work_options.as_ref(),
        input.get("workParent").and_then(Value::as_str),
        now,
    )?;
    state
        .tasks
        .update_current(&id, now, |stored| {
            let Some(fields) = stored.as_object_mut() else {
                return Ok(());
            };
            for (key, value) in task.as_object().map(Map::clone).unwrap_or_default() {
                if !fields.contains_key(&key) {
                    fields.insert(key, value);
                }
            }
            Ok(())
        })
        .map_err(|e| AdmissionError(e.to_string()))?;

    // A launch refusal is an error, not a silently queued task. `toCoreError`
    // classifies a thrown runner error as `invalid_input`, as TypeScript does.
    runtime
        .spawn
        .launch(ctx, &id, None)
        .map_err(|error| AdmissionError(error.message))?;
    let stored = state
        .read(&id)?
        .ok_or_else(|| AdmissionError("task vanished after creation".into()))?;
    Ok(Created { task: stored })
}

fn state_strategy(ctx: &Ctx) -> Result<Value, AdmissionError> {
    load_strategy(&ctx.pacer_home).map_err(|e| AdmissionError(e.to_string()))
}


