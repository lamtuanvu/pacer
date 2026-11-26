//! P5c/P5d status ops that compose from usage-broker injections. Project policy reads
//! `project-strategies.json` and the repository registry; the classifier (`goal`), remote
//! eligibility (any runner on a host, until #889) and inputs only TypeScript reads stay
//! forwarded.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_config_ops::strategy_load::native_load;
use pacer_dispatch_ops::policy::{
    agent_sessions_may_hold_slots, policy_error, policy_repo, repo_needs_core,
    require_policy_identity,
};
use pacer_engine::{balance::balance_by_load, usage_broker};
use pacer_delegation::{Runtime, runtime::PluginCalls};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{project_selection, read_project_strategies};
use pacer_read_model::retry;
use pacer_store::{TaskFilter, TaskStore};
use serde_json::{Map, Value, json};
use sha2::Digest;

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

/// The active strategy when Rust and Bun load the same file alike. Rust resolves an absolute
/// or dotted active name to another file than Node's `path.join`, so `load_strategy` alone
/// may read a strategy without TypeScript's host runners.
fn native_strategy(ctx: &Ctx) -> Option<Value> {
    native_load(&ctx.pacer_home).and_then(Result::ok)
}

/// `routing.route` forwards for a `goal` (the classifier), a `difficulty` (planner tier fallback), a strategy Rust does not load as Bun
/// does, any runner on a host (remote eligibility), a relative `repo` that names no registered
/// repository (Core's working directory), a policy or registry only TypeScript reads, and a
/// least-loaded balance that live agent sessions may affect.
pub fn routing_route_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    let text = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    // The classifier and the planner tier fallback (`difficulty`) run in TypeScript.
    if text("goal").is_some() || params.get("difficulty").is_some() {
        return true;
    }
    let Some(strategy) = native_strategy(ctx) else {
        return true;
    };
    if has_host_runner(&strategy) {
        return true;
    }
    if text("repo").is_some_and(|repo| repo_needs_core(ctx, repo, true)) {
        return true;
    }
    strategy["pacing"]["balance"] == "least-loaded" && agent_sessions_may_hold_slots(ctx)
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
    let strategy = parts_strategy(ctx, &parts)?;
    Ok(usage_broker::limits_check(ctx, &strategy, &parts))
}

pub async fn routing_status(ctx: &Ctx, params: Value, parts: Value) -> Result<Value, CoreError> {
    let map = object(&params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    let strategy = parts_strategy(ctx, &parts)?;
    Ok(usage_broker::routing_status(ctx, &strategy, &parts))
}

/// The strategy the TypeScript parts were computed against: the bridge carries
/// the snapshot `{path, name, text}` (as the account-list bridge does), and
/// parsing that text keeps rows and runners in one strategy even if the file
/// changes between the TS read and this op. A core without the snapshot field
/// keeps the host's own read.
fn parts_strategy(ctx: &Ctx, parts: &Value) -> Result<Value, CoreError> {
    let snapshot = &parts["strategy"];
    match (
        snapshot["path"].as_str(),
        snapshot["name"].as_str(),
        snapshot["text"].as_str(),
    ) {
        (Some(path), Some(name), Some(text)) => {
            pacer_config::strategy::parse_strategy(text, std::path::Path::new(path), name)
                .map_err(|error| invalid(error.to_string()))
        }
        _ => load_strategy(&ctx.pacer_home).map_err(|error| invalid(error.to_string())),
    }
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

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// `routing.route` without a `goal`: project policy for `repo`, and `balanceByLoad` over the
/// slot-holding tasks when `pacing.balance` is least-loaded. Policy refusals precede the
/// status read, as in TypeScript, and rows and runners stay in one strategy: the snapshot
/// the parts were computed against wins over a reload (see `parts_strategy`).
pub async fn routing_route(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    let (kind, repo) = parse_route_params(&params)?;
    // Policy refusals still precede the status read, as in TypeScript.
    let policy = match &repo {
        None => None,
        Some(value) => {
            let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
            let repo = policy_repo(ctx, value, &projects)?;
            Some((
                repo["key"].as_str().unwrap_or_default().to_owned(),
                projects,
            ))
        }
    };
    let parts = parts.await?;
    // Rows and runners stay in one strategy: the snapshot the parts were
    // computed against wins over a reload (see `parts_strategy`).
    let strategy = parts_strategy(ctx, &parts)?;
    let selection = policy
        .as_ref()
        .and_then(|(key, projects)| project_selection(&strategy, key, projects));
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

/// `targetKey` in `src/remote/eligibility.ts:19`: the SHA-256 of the JSON array
/// `[alias, ssh]`, so a changed target invalidates a cached reachability reading.
fn target_key(host: &Value) -> String {
    let alias = host["alias"].as_str().unwrap_or_default();
    let ssh = host["ssh"].as_str().unwrap_or_default();
    let input = serde_json::to_string(&json!([alias, ssh])).unwrap_or_default();
    format!("{:x}", sha2::Sha256::digest(input.as_bytes()))
}

/// `reachable` in `src/remote/eligibility.ts:62`. A fresh cache reading answers
/// without a probe; otherwise the SSH caller plugin answers through `PluginCalls`.
async fn reachable(
    ctx: &Ctx,
    plugins: &dyn PluginCalls,
    host: &Value,
    alias: &str,
) -> bool {
    let target = target_key(host);
    let file = ctx.pacer_home.join("cache").join("hosts.json");
    if let Ok(bytes) = std::fs::read(&file)
        && let Ok(Value::Object(readings)) = serde_json::from_slice::<Value>(&bytes)
        && let Some(reading) = readings.get(alias)
        && reading["target"].as_str() == Some(target.as_str())
        && reading["reachable"].is_boolean()
        && reading["at"].as_f64().is_some_and(|at| {
            at.is_finite() && ctx.now >= at && ctx.now - at < 60.0
        })
    {
        return reading["reachable"].as_bool().unwrap_or(false);
    }
    if !plugins
        .providers(ctx, "remoteCaller.reachability")
        .iter()
        .any(|id| id == "pacer-remote-caller")
    {
        return false;
    }
    let call = plugins.call(
        ctx,
        "pacer-remote-caller",
        "remoteCaller.reachability",
        json!({"alias": alias}),
        std::time::Duration::from_secs(30),
    );
    call.await
        .ok()
        .and_then(|reply| reply["reachable"].as_bool())
        .unwrap_or(false)
}

/// `slotBlock` for a remote runner (`src/engine/slots.ts:49`). Remote eligibility
/// asks about a *new* worktree, so the machine guard (which gates fresh local
/// starts) does not apply.
fn slot_block(strategy: &Value, runner_id: &str, use_: &Value) -> Option<String> {
    let runner = pacer_lifecycle::resolve_runner(strategy, runner_id);
    let id = runner
        .and_then(|r| r["id"].as_str())
        .unwrap_or(runner_id);
    let limit = pacer_lifecycle::slot_limit(strategy, id);
    let used = use_["byExecutor"][id].as_u64().unwrap_or(0) as usize;
    if used >= limit.executor {
        return Some(format!(
            "{} busy ({used}/{})",
            pacer_config::strategy::display_name(id),
            limit.executor
        ));
    }
    let alias = runner.and_then(|r| r["host"].as_str()).unwrap_or_default();
    if let Some(max) = limit.host {
        let used = use_["byHost"][alias].as_u64().unwrap_or(0) as usize;
        if used >= max {
            return Some(format!("{alias} busy ({used}/{max})"));
        }
    }
    None
}

/// Port of `remoteExclusion` (`src/remote/eligibility.ts:86`) for an executor in a
/// broker reading. Only runners with a host are checked; the reachability probe
/// goes through `PluginCalls`, and the project registry is the native B8 one.
pub async fn remote_exclusion(
    ctx: &Ctx,
    plugins: &dyn PluginCalls,
    strategy: &Value,
    runner_id: &str,
    task: Option<&Value>,
    use_: &Value,
) -> Option<String> {
    let alias = pacer_lifecycle::resolve_runner(strategy, runner_id)
        .and_then(|r| r["host"].as_str())
        .unwrap_or_default();
    if alias.is_empty() {
        return None;
    }
    let host = &strategy["hosts"][alias];
    if host["paused"] == true {
        return Some(format!("{alias} paused"));
    }
    if !reachable(ctx, plugins, host, alias).await {
        return Some(format!("host {alias} unreachable"));
    }
    let task = task?;
    let repo = task["brief"]["repo"].as_str().unwrap_or_default();
    let origin = std::process::Command::new("git")
        .args(["-C", repo, "remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout);
            pacer_config::host::repo_key(text.trim())
        });
    let known = origin.as_deref().is_some_and(|key| {
        host["repos"]
            .as_object()
            .is_some_and(|repos| repos.contains_key(key))
    });
    if !known {
        return Some(format!(
            "repo not set up on {alias} (add hosts.{alias}.repos.{})",
            origin.as_deref().unwrap_or("<key>")
        ));
    }
    slot_block(strategy, runner_id, use_)
}

/// Set `unavailableReason` on the broker providers exactly where TypeScript's
/// `optionsFor` would (`src/core/task-detail.ts:67-70`).
async fn apply_remote_exclusions(
    ctx: &Ctx,
    plugins: &dyn PluginCalls,
    parts: &mut Value,
    task: &Value,
    tasks: &[Value],
) {
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return;
    };
    let use_ = pacer_lifecycle::slot_use(tasks);
    let mut providers = parts["providers"].as_array().cloned().unwrap_or_default();
    for provider in &mut providers {
        let Some(id) = provider["id"].as_str().map(str::to_owned) else {
            continue;
        };
        if let Some(reason) =
            remote_exclusion(ctx, plugins, &strategy, &id, Some(task), &use_).await
        {
            provider["unavailableReason"] = json!(reason);
        }
    }
    parts["providers"] = json!(providers);
}

/// Broker readings are requested only after the task resolves, as TS reads
/// status only after `get`. Remote eligibility is applied here, over the front
/// door's plugin calls, before the read model ranks the executors.
pub async fn task_retry_options(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
    runtime: Option<&Runtime>,
) -> Result<Value, CoreError> {
    let id = parse_retry_id(&params)?;
    let mut store = pacer_store::TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let task = retry::retry_task(&mut store, id).map_err(read_model_error)?;
    // `optionsFor` catches an unloadable strategy before asking the broker; do
    // not await parts whose TypeScript bridge would throw on that same file.
    if load_strategy(&ctx.pacer_home).is_err() {
        return Ok(json!([]));
    }
    let selection = retry_selection(ctx, &task)?;
    let mut parts = parts.await?;
    if let Some(runtime) = runtime {
        let tasks = store
            .list(&TaskFilter::default())
            .unwrap_or_default()
            .iter()
            .map(|row| {
                let mut slot = row.clone();
                slot["host"] = row["run"]["host"].clone();
                slot
            })
            .collect::<Vec<_>>();
        apply_remote_exclusions(ctx, runtime.plugins.as_ref(), &mut parts, &task, &tasks).await;
    }
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
    async fn retry_options_answer_unknown_and_unloadable_inputs_natively() {
        let dir = tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        let ctx = Ctx::with(dir.path().into(), pacer_home.clone(), HashMap::new(), 1.0);
        let missing = task_retry_options(
            &ctx,
            json!({"id": "t-20990101-000000-abcd"}),
            Box::pin(async { Ok(json!({"providers": []})) }),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(missing.code, Code::UnknownTask);
        assert_eq!(missing.message, "unknown task t-20990101-000000-abcd");
        std::fs::write(pacer_home.join("strategy.yaml"), "planner: [\n").unwrap();
        let mut store = pacer_store::TaskStore::open(&pacer_home).unwrap();
        let task = json!({"id":"t-1","state":"failed","brief":{"repo":"/tmp/x"},"attempts":[]});
        assert_eq!(
            retry::retry_options(&ctx, &mut store, &task, &json!({"providers":[]}), None).unwrap(),
            json!([])
        );
    }

    #[tokio::test]
    async fn remote_exclusion_checks_host_pause_and_reachability() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(pacer_home.join("cache")).unwrap();
        let ctx = Ctx::with(home.into(), pacer_home.clone(), HashMap::new(), 1_700_000_000.0);
        struct NoPlugins;
        impl PluginCalls for NoPlugins {
            fn providers(&self, _: &Ctx, _: &str) -> Vec<String> {
                Vec::new()
            }
            fn call<'a>(
                &'a self,
                _: &'a Ctx,
                _: &'a str,
                _: &'a str,
                _: Value,
                _: std::time::Duration,
            ) -> OpFuture<'a> {
                Box::pin(async { Err(CoreError::new(Code::Unavailable, "no plugins")) })
            }
        }
        let strategy = json!({
            "planner": "claude-code",
            "hosts": {"devbox": {"ssh": "devbox", "paused": true, "repos": {}}},
            "runners": {"codex@devbox": {"host": "devbox"}},
        });
        let use_ = json!({"byExecutor": {}, "byHost": {}, "local": 0});
        assert_eq!(
            remote_exclusion(&ctx, &NoPlugins, &strategy, "codex@devbox", None, &use_).await,
            Some("devbox paused".into())
        );
        let strategy = json!({
            "planner": "claude-code",
            "hosts": {"devbox": {"ssh": "devbox", "repos": {}}},
            "runners": {"codex@devbox": {"host": "devbox"}},
        });
        assert_eq!(
            remote_exclusion(&ctx, &NoPlugins, &strategy, "codex@devbox", None, &use_).await,
            Some("host devbox unreachable".into())
        );
        assert_eq!(
            remote_exclusion(&ctx, &NoPlugins, &strategy, "codex", None, &use_).await,
            None
        );
    }

    fn route_ctx(strategy: &str) -> (tempfile::TempDir, Ctx) {
        let dir = tempdir().unwrap();
        let pacer_home = dir.path().join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        std::fs::write(pacer_home.join("strategy.yaml"), strategy).unwrap();
        let ctx = Ctx::with(dir.path().into(), pacer_home, HashMap::new(), 1.0);
        (dir, ctx)
    }

    /// The parts' strategy snapshot wins over a reload: the passed text decides
    /// even when the file on disk changed after the TypeScript read, and a core
    /// without the snapshot field falls back to the host's own read.
    #[test]
    fn parts_strategy_uses_the_snapshot_text_and_falls_back_to_disk() {
        let (_dir, ctx) = route_ctx("planner: claude-code\nproviders:\n  claude-code: {}\n");
        let snapshot = json!({
            "strategy": {
                "path": "/pacer/strategy.yaml",
                "name": "default",
                "text": "planner: codex\nproviders:\n  codex: {}\n",
            }
        });
        assert_eq!(
            parts_strategy(&ctx, &snapshot).unwrap()["runners"]["codex"]["agent"],
            "codex"
        );
        // Missing snapshot: the host's own read.
        assert_eq!(
            parts_strategy(&ctx, &json!({})).unwrap()["runners"]["claude-code"]["agent"],
            "claude-code"
        );
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
    fn routes_forward_unless_rust_loads_the_strategy_bun_loads() {
        let (dir, ctx) = route_ctx(LOCAL);
        let home = &ctx.pacer_home;
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("local.yaml"), LOCAL).unwrap();
        std::fs::create_dir_all(home.join("strategies")).unwrap();
        std::fs::write(home.join("strategies/local.yaml"), LOCAL).unwrap();
        let absolute = elsewhere.join("local").to_str().unwrap().to_owned();
        // B3-1 (missing at this stack base) changes how an absolute or dotted
        // active name resolves; while it is absent the native loader reads a
        // different file than Bun for both, so routing still forwards.
        for (name, forward) in [(absolute.as_str(), true), ("none/../local", false)] {
            std::fs::write(home.join("active"), format!("{name}\n")).unwrap();
            assert_eq!(
                routing_route_stays_forwarded(&ctx, &json!({})),
                forward,
                "{name}"
            );
        }
        std::fs::write(home.join("active"), "local\n").unwrap();
        assert!(!routing_route_stays_forwarded(&ctx, &json!({})));
        std::fs::remove_file(home.join("strategies/local.yaml")).unwrap();
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
