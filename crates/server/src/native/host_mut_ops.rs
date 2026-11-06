//! Native host YAML mutations (`pacer-config::host`); endpoint sync and publication
//! stay on the shared P2-C bridge. `host.set` composes its summary via the host-read bridge.
#![allow(clippy::result_large_err)]
use pacer_config::{
    host::{HostEdit, save_host},
    strategy::{load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::hosts;
use pacer_store::append_activity;
use serde_json::{Map, Value, json};

use super::config_params;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message.into())
}

fn host_error(op: &str, message: &str) -> CoreError {
    let code = if op == "host.add" && message.starts_with("host ") && message.ends_with(" already exists")
    {
        Code::Conflict
    } else if op == "host.remove" && message.contains(" is used by ") {
        Code::Conflict
    } else if message == "Your settings changed while they were being updated. Try again."
        || message == "strategy changed during edit; retry"
    {
        Code::Conflict
    } else {
        Code::InvalidInput
    };
    let mut error = CoreError::new(code, message);
    if op == "host.add" && code == Code::Conflict {
        error = error.hint("Choose a different alias or remove the existing host.");
    } else if op == "host.remove" && message == "local is reserved" {
        error = error.hint("Only configured SSH hosts can be removed.");
    } else if op == "host.repo.map" && message == "invalid repo key" {
        error = error.hint("Use the canonical host/owner/repo form, e.g. github.com/acme/api.");
    } else if message == "strategy changed during edit; retry" {
        error = error.hint("Check the strategy values and retry.");
    }
    error
}

fn host_cfg<'a>(strategy: &'a Value, alias: &str) -> Result<&'a Map<String, Value>, CoreError> {
    strategy["hosts"]
        .get(alias)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("unknown host {alias}")))
}

fn summary_row(parts: &Value, alias: &str) -> Result<Value, CoreError> {
    let host = parts["hosts"]
        .get(alias)
        .ok_or_else(|| invalid(format!("unknown host {alias}")))?;
    let reachability = parts["reachabilityByAlias"]
        .get(alias)
        .cloned()
        .unwrap_or_else(|| json!({}));
    let stored = parts["storedByAlias"]
        .get(alias)
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(hosts::summary(&json!({
        "alias": alias,
        "host": host,
        "reachability": reachability,
        "stored": stored,
        "jobs": parts["jobs"],
        "runners": parts["runners"],
        "repos": parts["repos"],
        "tasks": parts["tasks"],
    })))
}

pub(super) fn host_add(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = config_params::parse("host.add", params)?;
        let alias = p["alias"].as_str().unwrap_or("");
        let ssh = p["ssh"].as_str().unwrap_or("");
        let (path, name) = strategy_path(&ctx.pacer_home).map_err(|e| host_error("host.add", &e.to_string()))?;
        save_host(
            &path,
            &name,
            HostEdit::Add { alias, ssh },
        )
        .map_err(|e| host_error("host.add", &e.to_string()))?;
        Ok(json!({"alias": alias}))
    })
}

pub(super) fn host_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = config_params::parse("host.remove", params)?;
        let alias = p["alias"].as_str().unwrap_or("");
        let (path, name) =
            strategy_path(&ctx.pacer_home).map_err(|e| host_error("host.remove", &e.to_string()))?;
        save_host(
            &path,
            &name,
            HostEdit::Remove { alias },
        )
        .map_err(|e| host_error("host.remove", &e.to_string()))?;
        Ok(json!({"removed": true}))
    })
}

pub(super) fn host_repo_map(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = config_params::parse("host.repo.map", params)?;
        let alias = p["alias"].as_str().unwrap_or("");
        let key = p["key"].as_str().unwrap_or("").to_ascii_lowercase();
        let repo_path = p["path"].as_str().unwrap_or("");
        let strategy = load_strategy(&ctx.pacer_home).map_err(|e| host_error("host.repo.map", &e.to_string()))?;
        host_cfg(&strategy, alias)?;
        let (strategy_path, name) =
            strategy_path(&ctx.pacer_home).map_err(|e| host_error("host.repo.map", &e.to_string()))?;
        save_host(
            &strategy_path,
            &name,
            HostEdit::MapRepo {
                alias,
                key: &key,
                path: repo_path,
            },
        )
        .map_err(|e| host_error("host.repo.map", &e.to_string()))?;
        Ok(json!({"alias": alias, "key": key, "path": repo_path}))
    })
}

pub(super) fn host_set_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "host.set requires the host read bridge",
        ))
    })
}

pub(crate) async fn host_set_write(ctx: &Ctx, params: Value) -> Result<String, CoreError> {
    let p = config_params::parse("host.set", params)?;
    let alias = p["alias"].as_str().unwrap_or("").to_owned();
    let strategy = load_strategy(&ctx.pacer_home).map_err(|e| host_error("host.set", &e.to_string()))?;
    let before = host_cfg(&strategy, &alias)?;
    let paused_before = before.get("paused").and_then(Value::as_bool).unwrap_or(false);
    let (path, name) = strategy_path(&ctx.pacer_home).map_err(|e| host_error("host.set", &e.to_string()))?;
    save_host(
        &path,
        &name,
        HostEdit::Set {
            alias: &alias,
            max_tasks: p.get("max_tasks").and_then(Value::as_f64),
            paused: p.get("paused").and_then(Value::as_bool),
            session: p.get("session").and_then(Value::as_str),
        },
    )
    .map_err(|e| host_error("host.set", &e.to_string()))?;
    if p.get("paused") == Some(&Value::Bool(true)) && !paused_before {
        append_activity(
            ctx,
            json!({
                "kind": "host_state",
                "level": "info",
                "host": alias,
                "text": format!("{alias} paused · new work goes elsewhere"),
            }),
        )
        .map_err(|e| invalid(e.to_string()))?;
    }
    Ok(alias)
}

pub(crate) fn host_set_summary(parts: Value, alias: &str) -> Result<Value, CoreError> {
    if parts.get("alias").and_then(Value::as_str) != Some(alias) {
        return Err(invalid(format!("unknown host {alias}")));
    }
    summary_row(&parts, alias)
}
