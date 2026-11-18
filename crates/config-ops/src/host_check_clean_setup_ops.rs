//! Native `host.check`, `host.clean` and `host.repo.setup` over Core's whole-operation host
//! effects bridge (`/_internal/host-effects`, `_internal.host.effects`).
//!
//! Rust answers what needs no Core effect: the enforcement-identity refusal, the published
//! params schemas (setup's `consent` must be literal `true`), the unknown-host refusal before
//! any SSH (`configured` in `src/remote/hosts.ts`), setup's canonical-key and repo-not-mapped
//! refusal (`setupJob`), and `host.clean` dry runs, which read the task store, run the local
//! transfer gate and `pacer-lifecycle::hosts::clean`, and write nothing. Every other request is
//! the reference operation's job (`checkJob`, `cleanJob`, `setupJob`): the bridge carries
//! `{"kind": <op>, "params": <the original params>}`, Core runs that operation, and its result
//! or error is the reply unchanged. Jobs, the local checkout search, SSH probes, clones,
//! identity writes and clean mutations through the bundled plugins, one-use grants,
//! `state/host-checks.json` and the remote usage cache stay in Core. Over stdio those requests
//! are forwarded instead, so the core child keeps answering pipelined requests while a job runs.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::hosts;
use pacer_store::{TaskFilter, TaskStore};
use serde_json::{Map, Value, json};
use std::time::Duration;

use crate::runner_ops::{authorize, invalid, params_object, type_name};

/// `TERMINAL_STATES` in `src/tasks/types.ts`.
const TERMINAL: [&str; 6] = [
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];
/// `localRepo` and `transferred` bound each git read to ten seconds.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a front door does with an admitted request.
#[derive(Debug, PartialEq)]
pub enum Admission {
    /// The reply, computed without Core.
    Native(Value),
    /// The reference operation must run in Core.
    Core,
}

/// Ops a front door answers through [`admit`] and, for admitted requests, Core.
pub fn needs_host_effects(op: &str) -> bool {
    matches!(op, "host.check" | "host.clean" | "host.repo.setup")
}

/// Registry entry for ops that run only through [`call`].
pub fn host_effects_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "host effects bridge unavailable",
        ))
    })
}

/// Work-grant callers, whose scope Core checks.
pub fn host_stays_forwarded(ctx: &Ctx, op: &str, _params: &Value) -> bool {
    needs_host_effects(op)
        && ctx
            .env
            .get("PACER_WORK_GRANT")
            .is_some_and(|grant| !grant.is_empty())
}

/// `parseOpParams` and the reference operation up to its first Core effect. A strategy or
/// task store Rust cannot read leaves the request to Core, which reports its own error.
pub fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<Admission, CoreError> {
    use Field::{Bool, Id, NonEmpty, True};
    authorize(ctx)?;
    let schema: &[(&str, Field)] = match op {
        "host.check" => &[("alias", Id), ("repo", NonEmpty)],
        "host.clean" => &[("alias", Id), ("dry_run", Bool)],
        "host.repo.setup" => &[
            ("alias", Id),
            ("key", Id),
            ("clone", Bool),
            ("identity", Bool),
            ("consent", True),
        ],
        _ => return Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    };
    let params = parse(params, schema)?;
    let text = |name: &str| params.get(name).and_then(Value::as_str).unwrap_or_default();
    let alias = text("alias");
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return Ok(Admission::Core);
    };
    let Some(host) = strategy["hosts"].get(alias) else {
        return Err(invalid(format!("unknown host {alias}")));
    };
    match op {
        "host.repo.setup" => {
            let key = text("key").to_lowercase();
            if !hosts::canonical(&key) || host["repos"].get(&key).is_none() {
                return Err(invalid(format!("repo not mapped on {alias}"))
                    .hint("Use a mapped canonical host/owner/repo key."));
            }
            Ok(Admission::Core)
        }
        "host.clean" if params.get("dry_run") == Some(&Value::Bool(true)) => {
            Ok(clean_preview(ctx, alias, host).map_or(Admission::Core, Admission::Native))
        }
        _ => Ok(Admission::Core),
    }
}

/// Dispatch an admitted request; `core` runs the reference operation through the bridge.
pub async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    core: Option<OpFuture<'_>>,
) -> Result<Value, CoreError> {
    match admit(ctx, op, &params)? {
        Admission::Native(reply) => Ok(reply),
        Admission::Core => match core {
            Some(bridge) => bridge.await,
            None => Err(CoreError::new(
                Code::Unavailable,
                "host effects bridge unavailable",
            )),
        },
    }
}

enum Field {
    /// `id`: `z.string().min(1).max(128)`.
    Id,
    /// `z.string().min(1).optional()`.
    NonEmpty,
    /// `z.boolean().optional()`.
    Bool,
    /// `z.literal(true)`.
    True,
}

/// `def.params.safeParse(params ?? {})` with Zod's issue texts in schema order.
fn parse(params: &Value, schema: &[(&str, Field)]) -> Result<Map<String, Value>, CoreError> {
    let map = params_object(params)?;
    let issues: Vec<String> = schema
        .iter()
        .filter_map(|(name, field)| issue(name, field, map.get(*name)))
        .collect();
    if issues.is_empty() {
        Ok(map)
    } else {
        Err(invalid(issues.join("; ")))
    }
}

fn issue(name: &str, field: &Field, value: Option<&Value>) -> Option<String> {
    match (field, value) {
        (Field::True, Some(Value::Bool(true)))
        | (Field::NonEmpty | Field::Bool, None)
        | (Field::Bool, Some(Value::Bool(_))) => None,
        (Field::True, _) => Some(format!("{name}: Invalid input: expected true")),
        (Field::Id | Field::NonEmpty, Some(Value::String(text))) => {
            match text.encode_utf16().count() {
                0 => Some(too_small(name)),
                n if n > 128 && matches!(field, Field::Id) => Some(format!(
                    "{name}: Too big: expected string to have <=128 characters"
                )),
                _ => None,
            }
        }
        (Field::Id | Field::NonEmpty, other) => Some(expected(name, "string", other)),
        (Field::Bool, other) => Some(expected(name, "boolean", other)),
    }
}

fn too_small(name: &str) -> String {
    format!("{name}: Too small: expected string to have >=1 characters")
}

fn expected(name: &str, kind: &str, value: Option<&Value>) -> String {
    let received = value.map_or("undefined", type_name);
    format!("{name}: Invalid input: expected {kind}, received {received}")
}

/// `clean(ctx, alias, {dryRun: true})`: one fate per task this host ran in a new worktree,
/// newest task first. `None` when the task store cannot be read.
fn clean_preview(ctx: &Ctx, alias: &str, host: &Value) -> Option<Value> {
    let tasks = TaskStore::open(&ctx.pacer_home)
        .ok()?
        .list(&TaskFilter::default())
        .ok()?;
    let mut worktrees = Vec::new();
    for task in tasks {
        let run = &task["run"];
        if run["host"] != alias || run["mode"] != "new" {
            continue;
        }
        let eligible = TERMINAL.contains(&task["state"].as_str().unwrap_or(""))
            && ["review", "dismissed", "resolved"]
                .iter()
                .any(|key| truthy(&task[*key]));
        let received = eligible && transferred(&task);
        // A removable preview also needs the task's local checkout mapped on the host.
        let origin = if received && truthy(&run["remoteWorktree"]) && truthy(&run["remoteDir"]) {
            git(&task, &["remote", "get-url", "origin"])
                .map(|stdout| js_trim(&stdout).to_owned())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let mut transfers = Map::new();
        transfers.insert(
            task["id"].as_str().unwrap_or("").into(),
            Value::Bool(received),
        );
        let preview = hosts::clean(&json!({
            "alias": alias, "host": host, "dryRun": true, "tasks": [task],
            "transferred": transfers, "local": {"origin": origin},
        }));
        worktrees.extend(
            preview["worktrees"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned(),
        );
    }
    Some(json!({ "worktrees": worktrees }))
}

/// `transferred` in `src/remote/transfer.ts`: the task's received head is still the local
/// result branch.
fn transferred(task: &Value) -> bool {
    let run = &task["run"];
    if !truthy(&run["transferredHead"]) {
        return false;
    }
    let id = task["id"].as_str().unwrap_or("");
    let branch = if task["executorProvider"] == "pacer-exec-direct" {
        let intent = &task["remoteTransferIntent"];
        let same = |key: &str, actual: Option<&Value>| strict_equal(intent.get(key), actual);
        let retry = js_string(run.get("attempt")).map(|attempt| format!("pacer/{id}-r{attempt}"));
        match intent.get("branch").and_then(Value::as_str) {
            Some(branch)
                if truthy(intent)
                    && same("attempt", run.get("attempt"))
                    && same("providerId", task.get("executorProvider"))
                    && same("dir", run.get("dir"))
                    && same("startedAt", run.get("startedAt"))
                    && (branch == format!("pacer/{id}") || Some(branch) == retry.as_deref()) =>
            {
                branch.to_owned()
            }
            _ => return false,
        }
    } else {
        format!("pacer/{id}")
    };
    let reference = format!("refs/heads/{branch}");
    git(task, &["rev-parse", "--verify", &reference])
        .is_some_and(|stdout| run["transferredHead"].as_str() == Some(js_trim(&stdout)))
}

/// Stdout of `ctx.run(["git", "-C", task.brief.repo, ...args], 10000)` when it exits 0.
fn git(task: &Value, args: &[&str]) -> Option<String> {
    let repo = task["brief"]["repo"].as_str()?;
    match pacer_repos::git_read_unmarked(repo, args, GIT_TIMEOUT)? {
        (0, stdout) => Some(stdout),
        _ => None,
    }
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a === b` for JSON values, where a missing field is `undefined` and objects are never
/// identical.
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a @ (Value::Null | Value::Bool(_) | Value::String(_))), Some(b)) => a == b,
        _ => false,
    }
}

/// A template literal's text for a scalar JSON value.
fn js_string(value: Option<&Value>) -> Option<String> {
    Some(match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => ryu_js::Buffer::new()
            .format(n.as_f64().unwrap_or(f64::NAN))
            .to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(_) | Value::Object(_)) => return None,
    })
}

#[cfg(test)]
mod tests;
