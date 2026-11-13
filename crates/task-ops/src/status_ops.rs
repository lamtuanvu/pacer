//! P5c/P5d status ops that compose from usage-broker injections. Project policy reads
//! `project-strategies.json` and the repository registry; the classifier (`goal`), remote
//! eligibility (any runner on a host, until #889) and inputs only TypeScript reads stay
//! forwarded.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_config_ops::strategy_load::native_load;
use pacer_engine::{balance::balance_by_load, usage_broker};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock},
};
use pacer_lifecycle::{AdmissionError, project_selection, read_project_strategies};
use pacer_read_model::retry;
use pacer_store::{TaskFilter, TaskStore};
use serde_json::{Map, Value, json};
use std::path::Path;

const TASK_KINDS: &[&str] = &[
    "boilerplate",
    "tests",
    "docs",
    "rename",
    "migration",
    "feature",
    "debug",
    "refactor",
    "performance",
    "unfamiliar-code",
    "research",
];

const SLOT_STATES: &[&str] = &["running", "needs_input"];
const POLICY_FILE: &str = "project-strategies.json";

pub fn needs_usage_broker(op: &str) -> bool {
    matches!(
        op,
        "limits.check"
            | "routing.status"
            | "routing.route"
            | "task.retry_options"
            | "strategy.preview"
            | "runner.list"
            | "mode.hold"
    )
}

/// TypeScript's remote eligibility (`remoteExclusion`) applies to runners on a host.
fn has_host_runner(strategy: &Value) -> bool {
    strategy["runners"]
        .as_object()
        .is_some_and(|runners| runners.values().any(|r| r["host"].is_string()))
}

/// A `project-strategies.json` only TypeScript reads: present, but not a regular file Rust
/// reads and validates, or beside a repository registry only TypeScript reads. A strategy
/// Bun may read differently from Rust also keeps the policy in TypeScript.
fn policy_needs_core(ctx: &Ctx) -> bool {
    let home = &ctx.pacer_home;
    match std::fs::metadata(home.join(POLICY_FILE)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Ok(meta) if meta.is_file() => {
            read_project_strategies(home).is_err()
                || pacer_repos::registry_needs_core(home, false)
                || !matches!(native_load(home), Some(Ok(_)))
        }
        _ => true,
    }
}

/// Live agent sessions hold slots in `slotUse(…, ctx)`, and only Core probes their runs:
/// any session record that has not ended keeps the least-loaded order in TypeScript.
fn agent_sessions_may_hold_slots(ctx: &Ctx) -> bool {
    if !ctx.pacer_home.join("state/tasks.db").exists() {
        return false;
    }
    let Ok(mut store) = TaskStore::open(&ctx.pacer_home) else {
        return true;
    };
    let Ok(db) = store.connection() else {
        return true;
    };
    let count = |sql: &str| db.query_row(sql, [], |row| row.get::<_, i64>(0));
    match count("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agent_sessions'") {
        Ok(0) => false,
        Ok(_) => count(
            "SELECT count(*) FROM agent_sessions WHERE json_extract(record, '$.state') IS NOT 'ended'",
        )
        .map_or(true, |open| open > 0),
        Err(_) => true,
    }
}

/// `task.retry_options` forwards for an unloadable strategy, any runner on a host (remote
/// eligibility) and a project policy only TypeScript reads.
pub fn task_retry_options_stays_forwarded(ctx: &Ctx) -> bool {
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return true;
    };
    has_host_runner(&strategy) || policy_needs_core(ctx)
}

/// `routing.route` forwards for a `goal` (the classifier), any runner on a host (remote
/// eligibility), a relative `repo` that names no registered repository (Core's working
/// directory), a policy or registry only TypeScript reads, and a least-loaded balance that
/// live agent sessions may affect or that runs on a strategy Bun may read differently.
pub fn routing_route_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    let text = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    if text("goal").is_some() {
        return true;
    }
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return false;
    };
    if has_host_runner(&strategy) {
        return true;
    }
    let home = &ctx.pacer_home;
    if let Some(repo) = text("repo") {
        let absolute = Path::new(repo).is_absolute();
        if policy_needs_core(ctx)
            || pacer_repos::registry_needs_core(home, absolute)
            || !matches!(native_load(home), Some(Ok(_)))
            || !absolute
                && !pacer_repos::list_repos_read_only(home)
                    .iter()
                    .any(|known| known.key == repo)
        {
            return true;
        }
    }
    strategy["pacing"]["balance"] == "least-loaded"
        && (agent_sessions_may_hold_slots(ctx) || !matches!(native_load(home), Some(Ok(_))))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

fn broker_unavailable(message: &str) -> OpFuture<'_> {
    Box::pin(async move { Err(CoreError::new(Code::Unavailable, message)) })
}

pub fn limits_check_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("limits.check requires the usage broker bridge")
}

pub fn routing_status_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("routing.status requires the usage broker bridge")
}

pub fn routing_route_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("routing.route requires the usage broker bridge")
}

pub async fn limits_check(ctx: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    Ok(usage_broker::limits_check(ctx, &strategy, &parts))
}

pub async fn routing_status(ctx: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    Ok(usage_broker::routing_status(ctx, &strategy, &parts))
}

/// `{kind: z.enum(KINDS).optional(), goal, repo: z.string().min(1).optional()}`: unknown keys
/// are stripped, and every issue is reported in schema order.
fn parse_route_params(params: &Value) -> Result<(Value, Option<String>), CoreError> {
    let empty = Map::new();
    let map = match params {
        Value::Null => &empty,
        other => object(other)?,
    };
    let mut issues = Vec::new();
    let kind = match map.get("kind") {
        None => Value::Null,
        Some(Value::String(kind)) if TASK_KINDS.contains(&kind.as_str()) => json!(kind),
        Some(_) => {
            let kinds: Vec<_> = TASK_KINDS.iter().map(|k| format!("\"{k}\"")).collect();
            issues.push(format!(
                "kind: Invalid option: expected one of {}",
                kinds.join("|")
            ));
            Value::Null
        }
    };
    let mut text = |key: &str| match map.get(key) {
        None => None,
        Some(Value::String(value)) if value.is_empty() => {
            issues.push(format!(
                "{key}: Too small: expected string to have >=1 characters"
            ));
            None
        }
        Some(Value::String(value)) => Some(value.clone()),
        Some(other) => {
            issues.push(format!(
                "{key}: Invalid input: expected string, received {}",
                type_name(other)
            ));
            None
        }
    };
    text("goal");
    let repo = text("repo");
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok((kind, repo))
}

fn policy_error(AdmissionError(message): AdmissionError) -> CoreError {
    let hint = if message.starts_with("Cannot read") {
        "Check project-strategies.json permissions before delegating."
    } else {
        "Repair project-strategies.json before delegating; no global fallback was used."
    };
    invalid(message).hint(hint)
}

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// A project naming its executors makes repository identity mandatory.
fn policy_is_strict(projects: &Value) -> bool {
    projects["projects"]
        .as_object()
        .is_some_and(|projects| projects.values().any(|p| !p["executors"].is_null()))
}

/// `requirePolicyIdentity`.
fn require_policy_identity(repo: &Value, projects: &Value) -> Result<(), CoreError> {
    if repo["identityUnverified"] == true && policy_is_strict(projects) {
        return Err(invalid("Cannot establish repository identity for project routing").hint(
            "Restore Git access and retry; project policy cannot safely fall back to global routing.",
        ));
    }
    Ok(())
}

/// `resolvePolicyRepoInput`: an absolute checkout registers under the `repos` lock (strictly
/// when the policy names executors); any other value names a registered repository.
fn policy_repo(ctx: &Ctx, value: &str, projects: &Value) -> Result<Value, CoreError> {
    if !Path::new(value).is_absolute() {
        return pacer_repos::list_repos(ctx, false)
            .map_err(internal)?
            .into_iter()
            .find(|known| known.key == value)
            .map(|known| known.to_json())
            .ok_or_else(|| invalid("repo must be an absolute path or a registered repo key"));
    }
    let strict = policy_is_strict(projects);
    let mut repo = with_lock(ctx, "repos", LockOptions::default(), || {
        pacer_repos::register_repo(ctx, value, strict)
    })
    .map_err(internal)??;
    repo["path"] = json!(pacer_repos::canonical(value).map_err(internal)?);
    require_policy_identity(&repo, projects)?;
    Ok(repo)
}

/// `routing.route` without a `goal`: project policy for `repo`, and `balanceByLoad` over the
/// slot-holding tasks when `pacing.balance` is least-loaded. Every refusal precedes the
/// status read, as in TypeScript.
pub async fn routing_route(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    let (kind, repo) = parse_route_params(&params)?;
    let strategy = match load_strategy(&ctx.pacer_home) {
        Ok(strategy) => strategy,
        Err(error) => {
            parts.await?;
            return Err(internal(error));
        }
    };
    let selection = match repo {
        None => None,
        Some(value) => {
            let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
            let repo = policy_repo(ctx, &value, &projects)?;
            let key = repo["key"].as_str().unwrap_or_default();
            project_selection(&strategy, key, &projects)
        }
    };
    let parts = parts.await?;
    let mut route = usage_broker::routing_route(&strategy, &parts, &kind, selection.as_ref());
    if strategy["pacing"]["balance"] == "least-loaded" {
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(internal)?;
        let filter = TaskFilter {
            states: Some(SLOT_STATES),
            ..TaskFilter::default()
        };
        let tasks = store.list(&filter).map_err(internal)?;
        let statuses: Map<String, Value> = parts["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p["id"].as_str()?.to_owned(), p.clone())))
            .collect();
        let ranked = route["ranked"].as_array().cloned().unwrap_or_default();
        route["ranked"] = json!(balance_by_load(
            &ranked,
            &strategy,
            &pacer_lifecycle::slot_use(&tasks),
            &Value::Object(statuses),
            |id| pacer_lifecycle::slot_limit(&strategy, id).executor,
        ));
    }
    Ok(route)
}

pub fn task_retry_options_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    broker_unavailable("task.retry_options requires the usage broker bridge")
}

fn parse_retry_id(params: &Value) -> Result<&str, CoreError> {
    let id = match params {
        Value::Null => None,
        Value::Object(map) => map.get("id"),
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let id = match id {
        None => {
            return Err(invalid(
                "id: Invalid input: expected string, received undefined",
            ));
        }
        Some(Value::String(id)) => id,
        Some(other) => {
            return Err(invalid(format!(
                "id: Invalid input: expected string, received {}",
                type_name(other)
            )));
        }
    };
    if id.is_empty() {
        return Err(invalid(
            "id: Too small: expected string to have >=1 characters",
        ));
    }
    if id.encode_utf16().count() > 128 {
        return Err(invalid(
            "id: Too big: expected string to have <=128 characters",
        ));
    }
    Ok(id)
}

fn read_model_error(error: pacer_read_model::Error) -> CoreError {
    match error {
        pacer_read_model::Error::Store(pacer_store::StoreError::UnknownTask(id)) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        other => CoreError::new(Code::Internal, other.to_string()),
    }
}

/// Broker readings are requested only after the task resolves, as TS reads
/// status only after `get`.
pub async fn task_retry_options(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    let id = parse_retry_id(&params)?;
    let mut store = pacer_store::TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let task = retry::retry_task(&mut store, id).map_err(read_model_error)?;
    let selection = retry_selection(ctx, &task)?;
    let parts = parts.await?;
    retry::retry_options(ctx, &mut store, &task, &parts, selection.as_ref())
        .map_err(read_model_error)
}

/// `optionsFor`'s project selection: the stored repository, else the registered checkout of
/// `brief.repo`, else its unverified identity, which a strict policy refuses.
fn retry_selection(ctx: &Ctx, task: &Value) -> Result<Option<Value>, CoreError> {
    let home = &ctx.pacer_home;
    let Ok(strategy) = load_strategy(home) else {
        return Ok(None);
    };
    let projects = read_project_strategies(home).map_err(policy_error)?;
    let brief_repo = task["brief"]["repo"].as_str().unwrap_or_default();
    let repo = match task.get("repo").filter(|repo| !repo.is_null()) {
        Some(repo) => repo.clone(),
        None => pacer_repos::registered_repo(home, brief_repo).unwrap_or_else(|| {
            let mut repo = pacer_repos::repo_for(home, brief_repo);
            repo["identityUnverified"] = json!(true);
            repo
        }),
    };
    require_policy_identity(&repo, &projects)?;
    let key = repo["key"].as_str().unwrap_or_default();
    Ok(project_selection(&strategy, key, &projects))
}

/// Native registry entries for status operations using injected broker data.
pub const fn ops() -> &'static [pacer_foundation::api::NativeOp] {
    use pacer_foundation::api::NativeOp;
    &[
        NativeOp {
            name: "limits.check",
            call: limits_check_stub,
        },
        NativeOp {
            name: "routing.status",
            call: routing_status_stub,
        },
        NativeOp {
            name: "routing.route",
            call: routing_route_stub,
        },
        NativeOp {
            name: "task.retry_options",
            call: task_retry_options_stub,
        },
    ]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_foundation::Ctx;
    use serde_json::json;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[tokio::test]
    async fn rejects_unknown_params() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        std::fs::write(
            pacer_home.join("strategy.yaml"),
            "planner: claude-code\nproviders:\n  claude-code: {}\n",
        )
        .unwrap();
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), 1.0);
        assert!(
            limits_check(&ctx, json!({"refresh": true}), json!({}))
                .await
                .is_err()
        );
        assert!(
            routing_status(&ctx, json!({"refresh": true}), json!({}))
                .await
                .is_err()
        );
        let parts = || -> OpFuture<'static> { Box::pin(async { Ok(json!({"providers": []})) }) };
        let error = routing_route(
            &ctx,
            json!({"kind": "nope", "goal": 1, "repo": ""}),
            parts(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.message,
            "kind: Invalid option: expected one of \"boilerplate\"|\"tests\"|\"docs\"|\"rename\"|\"migration\"|\"feature\"|\"debug\"|\"refactor\"|\"performance\"|\"unfamiliar-code\"|\"research\"; goal: Invalid input: expected string, received number; repo: Too small: expected string to have >=1 characters"
        );
        let route = routing_route(&ctx, json!({"extra": true}), parts())
            .await
            .unwrap();
        assert_eq!(route["kind"], Value::Null);
        assert_eq!(route["uncertain"], json!([]));
        let error = routing_route(&ctx, json!({"repo": "not/registered"}), parts())
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "repo must be an absolute path or a registered repo key"
        );
    }

    #[test]
    fn retry_id_errors_match_the_zod_schema() {
        let message = |params: Value| parse_retry_id(&params).unwrap_err().message;
        let undefined = "id: Invalid input: expected string, received undefined";
        assert_eq!(message(json!({})), undefined);
        assert_eq!(message(Value::Null), undefined);
        assert_eq!(
            message(json!({"id": 1})),
            "id: Invalid input: expected string, received number"
        );
        assert_eq!(
            message(json!([])),
            "params: Invalid input: expected object, received array"
        );
        assert_eq!(
            message(json!({"id": ""})),
            "id: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(json!({"id": "x".repeat(129)})),
            "id: Too big: expected string to have <=128 characters"
        );
        assert_eq!(
            parse_retry_id(&json!({"id": "t", "extra": 1})).unwrap(),
            "t"
        );
    }

    #[tokio::test]
    async fn retry_options_forward_for_policy_remote_or_unloadable_strategy() {
        let dir = tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        let ctx = Ctx::with(dir.path().into(), pacer_home.clone(), HashMap::new(), 1.0);
        assert!(task_retry_options_stays_forwarded(&ctx));
        let local = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n";
        std::fs::write(pacer_home.join("strategy.yaml"), local).unwrap();
        assert!(!task_retry_options_stays_forwarded(&ctx));
        let policy = pacer_home.join("project-strategies.json");
        std::fs::write(&policy, "{}").unwrap();
        assert!(task_retry_options_stays_forwarded(&ctx));
        std::fs::write(&policy, r#"{"version":1,"projects":{}}"#).unwrap();
        assert!(!task_retry_options_stays_forwarded(&ctx));
        std::fs::remove_file(&policy).unwrap();
        std::fs::create_dir(&policy).unwrap();
        assert!(task_retry_options_stays_forwarded(&ctx));
        std::fs::remove_dir(&policy).unwrap();
        let accounts = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\nrunners:\n  claude-code: {}\n";
        std::fs::write(pacer_home.join("strategy.yaml"), accounts).unwrap();
        assert!(!task_retry_options_stays_forwarded(&ctx));
        let remote = format!("{accounts}  codex@devbox: {{}}\n");
        std::fs::write(pacer_home.join("strategy.yaml"), remote).unwrap();
        assert!(load_strategy(&pacer_home).is_ok());
        assert!(task_retry_options_stays_forwarded(&ctx));
        let missing = task_retry_options(&ctx, json!({"id": "t-20990101-000000-abcd"}), {
            Box::pin(async { Ok(json!({})) })
        })
        .await
        .unwrap_err();
        assert_eq!(missing.code, Code::UnknownTask);
        assert_eq!(missing.message, "unknown task t-20990101-000000-abcd");
    }

    fn route_ctx(strategy: &str) -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        std::fs::write(pacer_home.join("strategy.yaml"), strategy).unwrap();
        let ctx = Ctx::with(dir.path().into(), pacer_home, HashMap::new(), 1.0);
        (dir, ctx)
    }

    const LOCAL: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";

    #[test]
    fn routing_route_forwards_goals_relative_repos_and_host_runners() {
        let (_dir, ctx) = route_ctx(LOCAL);
        assert!(routing_route_stays_forwarded(
            &ctx,
            &json!({"goal": "add tests"})
        ));
        assert!(routing_route_stays_forwarded(
            &ctx,
            &json!({"repo": "not/registered"})
        ));
        assert!(!routing_route_stays_forwarded(
            &ctx,
            &json!({"repo": "/tmp/x"})
        ));
        assert!(!routing_route_stays_forwarded(
            &ctx,
            &json!({"goal": "", "repo": ""})
        ));
        assert!(!routing_route_stays_forwarded(
            &ctx,
            &json!({"kind": "tests"})
        ));
        let policy = ctx.pacer_home.join("project-strategies.json");
        std::fs::write(&policy, "not json").unwrap();
        assert!(routing_route_stays_forwarded(
            &ctx,
            &json!({"repo": "/tmp/x"})
        ));
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        std::fs::remove_file(&policy).unwrap();
        let hosts = "hosts:\n  devbox: {ssh: devbox, repos: {}}\n";
        std::fs::write(
            ctx.pacer_home.join("strategy.yaml"),
            format!("{LOCAL}{hosts}"),
        )
        .unwrap();
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        let remote = format!("{LOCAL}  codex@devbox: {{}}\n{hosts}");
        std::fs::write(ctx.pacer_home.join("strategy.yaml"), remote).unwrap();
        assert!(load_strategy(&ctx.pacer_home).is_ok());
        assert!(routing_route_stays_forwarded(&ctx, &json!({})));
    }

    #[test]
    fn least_loaded_routes_forward_only_while_agent_sessions_are_open() {
        let (_dir, ctx) = route_ctx(&format!("{LOCAL}pacing:\n  balance: least-loaded\n"));
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        let db = store.connection().unwrap();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
        )
        .unwrap();
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        db.execute_batch(r#"INSERT INTO agent_sessions VALUES ('a', '{"state":"ended"}')"#)
            .unwrap();
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        db.execute_batch(r#"INSERT INTO agent_sessions VALUES ('b', '{"state":"running"}')"#)
            .unwrap();
        assert!(routing_route_stays_forwarded(&ctx, &json!({})));
    }
}
