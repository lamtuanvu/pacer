//! P2-C/P2-E operation effects. The transport retains the TS endpoint-plugin bridge;
//! final publication is performed only after that bridge has settled.
use pacer_config::{
    config_writes, executor_settings, notifications,
    settings::{self, SettingsError},
    strategy::{StrategyError, list_strategy_reads, load_strategy, show_strategy, strategy_path},
    strategy_write,
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    lock::{LockOptions, with_lock},
};
use serde_json::{Value, json};

/// Planner install and backend readiness stay on the TypeScript `config.set` path.
pub(crate) fn config_set_stays_forwarded(params: &Value) -> bool {
    matches!(
        params.get("key").and_then(Value::as_str),
        Some("planner" | "execution.backend")
    )
}

const STRATEGY_HINT: &str =
    "Use strategy.list to choose a strategy and strategy.preview to validate a draft.";
#[allow(clippy::result_large_err)]
fn error(op: &str, error: StrategyError) -> CoreError {
    let message = error.to_string();
    let settings_conflict = op.starts_with("runner.settings.")
        && (message == "Executor settings changed elsewhere."
            || message == "Executor settings changed. Reload saved settings."
            || message.contains("changed during edit"));
    let code = if message == "Your settings changed while they were being updated. Try again."
        || settings_conflict
    {
        Code::Conflict
    } else if op == "runner.set" && message == "cannot edit the planner runner" {
        Code::NotAllowed
    } else {
        Code::InvalidInput
    };
    let mut error = CoreError::new(code, &message);
    // strategy.list maps through toCoreError without the strategyAction hint.
    if op.starts_with("strategy.") && op != "strategy.list" {
        error = error.hint(STRATEGY_HINT);
    } else if op == "runner.remove" {
        error = error.hint("Check the runner id, account and host configuration.");
    } else if message == "Executor settings changed elsewhere." {
        error = error.hint("Reload saved settings, then reapply your changes.");
    } else if matches!(op, "runner.set" | "runner.reorder" | "routing.set")
        && (message.starts_with("invalid strategy ")
            || message.starts_with("bad YAML:")
            || message.contains(" at line ")
            || message.starts_with("while parsing "))
    {
        error = error.hint("Check the strategy values and retry.");
    }
    error
}

fn settings_error(error: SettingsError) -> CoreError {
    let code = match error.code {
        "conflict" => Code::Conflict,
        "unavailable" => Code::Unavailable,
        _ => Code::InvalidInput,
    };
    let mut out = CoreError::new(code, error.message);
    if let Some(hint) = error.hint {
        out = out.hint(hint);
    }
    out
}

pub(super) fn area(op: &str) -> Option<&'static str> {
    match op {
        "strategy.use" | "strategy.save" | "strategy.remove" => Some("strategy"),
        "runner.set" | "runner.reorder" | "runner.remove" | "runner.settings.save" => {
            Some("runners")
        }
        "host.add" | "host.set" | "host.remove" | "host.repo.map" | "host.account.add" => {
            Some("hosts")
        }
        "routing.set" => Some("routing"),
        "notifications.set" | "config.set" => Some("config"),
        "delegation.pause" | "delegation.resume" => Some("delegation"),
        "mode.hold" | "mode.release" => Some("mode"),
        "machine.set" | "machine.rotate" => Some("machine"),
        "project.messaging.set" | "project.messaging.remove" => Some("project-messaging"),
        _ => None,
    }
}
pub(super) fn syncs_endpoints(op: &str) -> bool {
    matches!(
        op,
        "host.add"
            | "host.set"
            | "host.remove"
            | "host.repo.map"
            | "host.account.add"
            | "runner.set"
            | "runner.reorder"
            | "runner.remove"
            | "routing.set"
    )
}

#[allow(clippy::result_large_err)]
pub(crate) fn finish(ctx: &Ctx, op: &str, result: &Value) -> Result<(), CoreError> {
    if op == "strategy.use" {
        let name = result["name"].as_str().unwrap_or("");
        report(pacer_store::publish(
            ctx,
            &[
                json!({"type":"alert","data":{"key":"strategy-switch","level":"info","title":format!("Switched to strategy {name}"),"body":"Nothing to do.","notification":{"kind":"strategy","strategy":name},"at":ctx.now}}),
            ],
        ));
    }
    if let Some(area) = area(op) {
        match pacer_store::publish_config_change(ctx, area) {
            Ok(result) => report(result),
            Err(error) => return Err(CoreError::new(Code::InvalidInput, error.to_string())),
        }
    }
    Ok(())
}
fn report(report: pacer_store::PublishReport) {
    for error in report.errors {
        eprintln!("pacer: config publication failed: {error}");
    }
}

fn legacy_dir(ctx: &Ctx) -> std::path::PathBuf {
    legacy_dir_for_platform(ctx, cfg!(target_os = "macos"))
}

fn legacy_dir_for_platform(ctx: &Ctx, macos: bool) -> std::path::PathBuf {
    let base = ctx
        .env
        .get("PACER_ORCA_USER_DATA")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            if macos {
                ctx.home.join("Library/Application Support/orca")
            } else {
                ctx.env
                    .get("XDG_CONFIG_HOME")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| ctx.home.join(".config"))
                    .join("orca")
            }
        });
    base.join("plugins-data/lamtuanvu.pacer")
}

fn run<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        let p = super::config_params::parse(op, params)?;
        let name = p["name"].as_str().unwrap_or("");
        let id = p["id"].as_str().unwrap_or("");
        let home = &ctx.pacer_home;
        if matches!(op, "runner.set" | "runner.reorder" | "routing.set") {
            load_strategy(home).map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
        }
        let result = match op {
            "strategy.list" => list_strategy_reads(home),
            "strategy.show" => show_strategy(home, name),
            "strategy.use" => strategy_write::use_strategy(home, name),
            "strategy.save" => {
                let millis = (ctx.now * 1000.0).trunc() as i64;
                let date = chrono::DateTime::from_timestamp_millis(millis).ok_or_else(|| {
                    CoreError::new(Code::InvalidInput, "Invalid time value").hint(STRATEGY_HINT)
                })?;
                strategy_write::save_strategy(
                    home,
                    name,
                    &p["draft"],
                    p["reason"].as_str().unwrap_or(""),
                    strategy_write::SaveOptions {
                        who: ctx
                            .env
                            .get("PACER_AGENT")
                            .or_else(|| ctx.env.get("ORCA_AGENT"))
                            .map(String::as_str)
                            .unwrap_or("agent"),
                        now_iso: &date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        overwrite: p["overwrite"] == true,
                        active_ok: false,
                    },
                )
                .map(|value| json!({"name":value["name"],"path":value["path"]}))
            }
            "strategy.remove" => {
                if name == "default"
                    || load_strategy(home).map_err(|e| error(op, e))?["name"] == name
                {
                    return Err(CoreError::new(
                        Code::NotAllowed,
                        format!(
                            "cannot delete the {} strategy",
                            if name == "default" {
                                "default"
                            } else {
                                "active"
                            }
                        ),
                    )
                    .hint("Switch to another strategy first; default cannot be removed."));
                }
                strategy_write::remove_strategy(home, name).map(|_| json!({"removed":true}))
            }
            "routing.get" => config_writes::get_routing(home),
            "routing.set" => {
                let rules = p["rules"].as_array().cloned().unwrap_or_default();
                // Keep the TS operation's actionable hints at the API boundary.
                let strategy = load_strategy(home)
                    .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
                if rules.is_empty()
                    || rules.last().is_some_and(|r| r.get("kinds").is_some())
                    || rules
                        .iter()
                        .take(rules.len().saturating_sub(1))
                        .any(|r| r.get("kinds").is_none())
                {
                    return Err(CoreError::new(
                        Code::InvalidInput,
                        "the default routing rule must be last",
                    )
                    .hint("End the rules with one rule without kinds."));
                }
                match config_writes::set_routing(home, &rules) {
                    Err(e) if e.to_string().starts_with("unknown executor ") => {
                        return Err(CoreError::new(Code::InvalidInput, e.to_string()).hint(
                            format!(
                                "available: {}",
                                strategy["runners"]
                                    .as_object()
                                    .map(|r| r.keys().cloned().collect::<Vec<_>>().join(", "))
                                    .unwrap_or_default()
                            ),
                        ));
                    }
                    result => result,
                }
            }
            "runner.set" => config_writes::set_runner(home, id, &p),
            "runner.reorder" => config_writes::reorder_runners(
                home,
                &p["ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            ),
            "runner.remove" => config_writes::remove_runner(home, id).map(|value| {
                let mut result = json!({"removed":true});
                if let Some(migrated) = value.get("migrated") {
                    result["migrated"] = migrated.clone();
                }
                result
            }),
            "runner.settings.get" => {
                return executor_settings::read_executor_settings(home).map_err(|e| error(op, e));
            }
            "runner.settings.save" => {
                // Matches TS withLock('executor-settings') + mutation(..., "runners", ...).
                // No endpoint-plugin sync: finishNativeConfigEdit does not cover this op.
                return with_lock(ctx, "executor-settings", LockOptions::default(), || {
                    executor_settings::save_executor_settings(home, &p)
                })
                .map_err(|e| CoreError::new(Code::Unavailable, e.to_string()))?
                .map_err(|e| error(op, e));
            }
            "notifications.get" => {
                return notifications::get_level(home, &legacy_dir(ctx))
                    .map_err(|e| CoreError::new(Code::Internal, e.to_string()));
            }
            "notifications.set" => {
                return notifications::set_level(home, p["level"].as_str().unwrap_or(""))
                    .map_err(|e| CoreError::new(Code::InvalidInput, e.to_string()));
            }
            "config.set" => {
                let key = p["key"].as_str().unwrap_or("");
                if config_set_stays_forwarded(&p) {
                    return Err(CoreError::new(
                        Code::Unavailable,
                        format!("{key} requires the forwarded config.set operation"),
                    ));
                }
                let (path, name) = strategy_path(home).map_err(|e| error(op, e))?;
                let presets_only = ctx
                    .env
                    .get("PACER_TERMINAL_PRESETS_ONLY")
                    .is_some_and(|v| v == "1");
                let mut result =
                    settings::set_setting(&path, &name, key, &p["value"], presets_only)
                        .map_err(settings_error)?;
                // Match the TypeScript op handler: notes stay internal.
                if let Some(obj) = result.as_object_mut() {
                    obj.remove("notes");
                }
                return Ok(result);
            }
            _ => return Err(CoreError::new(Code::UnknownOp, op)),
        };
        result.map_err(|e| error(op, e))
    })
}
macro_rules! handler {
    ($($name:ident => $op:literal),* $(,)?) => {$(pub(super) fn $name(ctx: &Ctx, params: Value) -> OpFuture<'_> { run(ctx,$op,params) })*};
}
handler! { strategy_list => "strategy.list", strategy_show => "strategy.show", strategy_use => "strategy.use", strategy_save => "strategy.save", strategy_remove => "strategy.remove", routing_get => "routing.get", routing_set => "routing.set", runner_set => "runner.set", runner_reorder => "runner.reorder", runner_remove => "runner.remove", runner_settings_get => "runner.settings.get", runner_settings_save => "runner.settings.save", notifications_get => "notifications.get", notifications_set => "notifications.set", config_set => "config.set" }

#[cfg(test)]
mod tests;
