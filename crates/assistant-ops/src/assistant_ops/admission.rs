//! Native admission for `assistant.status` and `assistant.candidates` (spec §5).
//!
//! Rust composes the reply; only two facts still live in the TypeScript process:
//! the plugin registry snapshot (S2's private `snapshot` kind) and the read-only
//! usage parts behind `/_internal/status-broker-parts`. [`AssistantHost`] is the
//! door-shaped seam for both; the server implements it over HTTP and stdio, and
//! unit tests implement it with fixed entries and parts.

use super::*;
use crate::assistant_ops::selftest_read;
use pacer_engine::usage_broker::routing_status;
use pacer_plugin_ops::extension::{EntriesFuture, find_all};

/// What `admit` needs from the door: the plugin snapshot and the cached usage status parts.
pub trait AssistantHost: Send {
    fn plugins<'a>(&'a mut self, ctx: &'a Ctx) -> EntriesFuture<'a>;
    /// `/_internal/status-broker-parts` with `{"cacheOnly": true}`: read-only parts,
    /// no usage source is read.
    fn cached_status_parts(&mut self) -> OpFuture<'_>;
}

/// `Admission` (`src/assistant/service.ts:166`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admission {
    pub ok: bool,
    pub reason: Option<String>,
    pub hint: Option<String>,
}

impl Admission {
    fn no(reason: impl Into<String>, hint: Option<&str>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
            hint: hint.map(str::to_owned),
        }
    }
}

/// Agent display names from `src/view-model/agents.ts`, kept in step with the status line's
/// copy below `crates/cli/src/status_line/agents.rs` (layer 8 cannot import layer 10).
fn agent_name(agent: &str) -> &str {
    let key = match agent {
        "claude" => "claude-code",
        "antigravity" => "agy",
        other => other,
    };
    match key {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "agy" => "Antigravity",
        "byteplus" => "BytePlus",
        "local" => "Local model",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        _ => agent,
    }
}

/// `backendOf` (`service.ts:117`): an unlabelled assistant contribution serves pacer.
fn backend_of(contribution: &Value) -> &str {
    if contribution["backend"] == "executor" {
        "executor"
    } else {
        "pacer"
    }
}

fn has_reply_provider(entries: &[pacer_plugin_ops::public::Entry], backend: &str) -> bool {
    !find_all(entries, "assistant", |c| {
        c["reply"] == true && backend_of(c) == backend
    })
    .is_empty()
}

fn stored_settings(ctx: &Ctx) -> Result<Settings, CoreError> {
    with_db_core(ctx, |db| Ok(settings(db)))?
}

/// `readBlocked`, filtered to live entries (`src/executors/blocked.ts:5`).
fn read_blocked(ctx: &Ctx) -> Map<String, Value> {
    let text = std::fs::read_to_string(ctx.pacer_home.join("blocked.json")).unwrap_or_default();
    let mut values: Map<String, Value> = serde_json::from_str(&text).unwrap_or_default();
    values.retain(|_, m| {
        m["reason"].is_string()
            && (m.get("until") == Some(&Value::Null)
                || m["until"].as_f64().is_some_and(|until| until > ctx.now))
    });
    values
}

/// `executorAccountHidden` (`service.ts:559`): disabled or blocked runners stay off the picker.
fn executor_account_hidden(strategy: &Value, account: &str, blocked: &Map<String, Value>) -> bool {
    if blocked.contains_key(account) {
        return true;
    }
    strategy["runners"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, r)| r["account"] == account)
        .any(|(id, r)| {
            r["enabled"] == false || blocked.contains_key(id) || blocked.contains_key(r["name"].as_str().unwrap_or(""))
        })
}

fn midnight(ctx: &Ctx) -> Option<f64> {
    local_midnight(ctx.now, local_zone(ctx)?)
}

fn turns_today(ctx: &Ctx) -> Result<f64, CoreError> {
    with_db_core(ctx, |db| {
        assistant::usage_since(db, midnight(ctx).ok_or_else(|| unavailable("assistant time zone is unavailable"))?)
            .map(|today| today[0].as_f64().unwrap_or(0.0))
            .map_err(store_error)
    })
}

/// `selfTestStatus` (`selftest.ts:77`). The richer check also supplies candidates' `liveTools`.
pub fn self_test_status(ctx: &Ctx, account: &str, adapter: &str) -> (bool, Option<String>) {
    let check = selftest_read::check(ctx, account, adapter);
    (check.ok, check.reason)
}

/// `admit` (`service.ts:169-198`), in the same branch order as TypeScript.
pub async fn admit(ctx: &Ctx, host: &mut dyn AssistantHost) -> Result<Admission, CoreError> {
    let entries = host.plugins(ctx).await?;
    admit_with(ctx, host, &entries).await
}

async fn admit_with(
    ctx: &Ctx,
    host: &mut dyn AssistantHost,
    entries: &[pacer_plugin_ops::public::Entry],
) -> Result<Admission, CoreError> {
    let settings = stored_settings(ctx)?;
    let Some(account) = settings.account.as_deref().filter(|a| !a.is_empty()) else {
        return Ok(Admission::no(NOT_SET_UP.0, Some(NOT_SET_UP.1)));
    };
    let executor = settings.backend == "executor";
    // Each backend needs a plugin that answers whole turns with `assistant.reply`.
    if executor && !has_reply_provider(entries, "executor") {
        return Ok(Admission::no(
            "No plugin answers the assistant's executor backend.",
            Some("Choose pacer's agent in Settings › Assistant."),
        ));
    }
    let strategy = strategy(ctx)
        .ok_or_else(|| unavailable("the strategy requires the TypeScript loader"))?;
    if !endpoint_ok(ctx, &strategy, account, settings.runner.as_deref(), executor) {
        return Ok(Admission::no(
            "The account chosen for the assistant is no longer available.",
            Some("Choose another account in Settings › Assistant."),
        ));
    }
    if !executor && !has_reply_provider(entries, "pacer") {
        return Ok(Admission::no(
            NATIVE_UNAVAILABLE,
            Some("Update or repair pacer to install its assistant binary."),
        ));
    }
    if executor {
        // The native plugin owner's bridge cannot carry the ask-mode config binding yet.
        if env(ctx, "PACER_HOST_SOCKET").is_some() {
            return Ok(Admission::no(
                "The executor backend is not available with the native plugin host yet.",
                Some("Choose pacer's agent in Settings › Assistant."),
            ));
        }
        let adapter = ask_adapter(ctx, &strategy["accounts"][account]).unwrap_or("opencode");
        let check = selftest_read::check(ctx, account, adapter);
        if !check.ok {
            return Ok(Admission::no(
                check.reason.unwrap_or_default(),
                Some("Run the ask-mode check in Settings › Assistant."),
            ));
        }
    }
    if turns_today(ctx)? >= settings.limit("turnsPerDay") as f64 {
        return Ok(Admission::no(
            format!(
                "The assistant reached its limit of {} turns today.",
                settings.limit("turnsPerDay")
            ),
            Some("The limit resets at midnight, or raise it in Settings."),
        ));
    }
    let parts = host.cached_status_parts().await?;
    let status = routing_status(ctx, &strategy, &parts);
    let row = status["accounts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["name"] == account));
    let reserve = strategy["dispatch"]["reservePct"].as_f64().unwrap_or(0.0);
    if let Some(row) = row {
        let used = row["usedPct"].as_f64();
        let exhausted = row["verdict"] == "EXHAUSTED";
        let reserved = used.is_some_and(|used| reserve > 0.0 && 100.0 - used <= reserve);
        if exhausted || reserved {
            let reason = if exhausted {
                format!("{account} has no capacity left.")
            } else {
                format!("{account} is within its {reserve}% reserve.")
            };
            return Ok(Admission::no(
                reason,
                Some("The assistant stays on the account you chose. It never moves to another one."),
            ));
        }
    }
    if strategy["planner"]["account"] == account {
        if let Some(mode) = status["mode"].as_str() {
            if matches!(mode, "strict" | "emergency") {
                let name = agent_name(strategy["planner"]["agent"].as_str().unwrap_or(""));
                let label = if mode == "strict" { "Strict" } else { "Emergency" };
                return Ok(Admission::no(
                    format!("{name} is in {label} mode. The assistant is paused to save the planner's budget."),
                    None,
                ));
            }
        }
    }
    Ok(Admission {
        ok: true,
        reason: None,
        hint: None,
    })
}

/// Candidate rows from the same plugin snapshot, including the executor rows B4-2 adds.
/// Order is `Object.entries(strategy.accounts)` (pacer rows first, then executor rows).
pub(super) fn candidate_rows(
    ctx: &Ctx,
    strategy: &Value,
    entries: &[pacer_plugin_ops::public::Entry],
) -> Vec<Value> {
    let pacer_live = has_reply_provider(entries, "pacer");
    let executor_live = has_reply_provider(entries, "executor");
    let blocked = read_blocked(ctx);
    let accounts = strategy["accounts"].as_object().cloned().unwrap_or_default();
    let runners = strategy["runners"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let planners_account = strategy["planner"]["account"].as_str();
    let rows_of = |name: &str, account: &Value| -> (Vec<Value>, Vec<Value>) {
        let models: Vec<Value> = account["connection"]["models"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|m| {
                let name = if m["name"].is_null() {
                    m["id"].clone()
                } else {
                    m["name"].clone()
                };
                json!({"id":m["id"],"name":name})
            })
            .collect();
        let models = if models.is_empty() && account["model"].is_string() {
            vec![json!({"id":account["model"],"name":account["model"]})]
        } else {
            models
        };
        let runners: Vec<Value> = runners
            .values()
            .filter(|r| r["account"] == name)
            .map(|r| json!({"id":r["id"],"model":r["model"]}))
            .collect();
        (models, runners)
    };
    let mut pacer = Vec::new();
    let mut executor = Vec::new();
    for (name, account) in &accounts {
        let (models, runners) = rows_of(name, account);
        let is_planner = planners_account == Some(name.as_str());
        if account["kind"] == "endpoint" && account.get("connection").is_some_and(truth) {
            // `pacerRows` object-literal key order (`service.ts:624-632`).
            let mut row = Map::new();
            row.insert("account".into(), json!(name));
            row.insert("backend".into(), json!("pacer"));
            row.insert("available".into(), json!(pacer_live));
            row.insert("liveTools".into(), json!(pacer_live));
            if !pacer_live {
                row.insert("reason".into(), json!(NATIVE_UNAVAILABLE));
            }
            row.insert("models".into(), json!(models));
            row.insert("runners".into(), json!(runners));
            row.insert("isPlanner".into(), json!(is_planner));
            pacer.push(Value::Object(row));
        }
        if !executor_live || executor_account_hidden(strategy, name, &blocked) {
            continue;
        }
        let (cli, config_problem) = match account["kind"].as_str().unwrap_or("") {
            "claude" if ask_config_dir(ctx, account, "claude").is_none() => {
                ("claude-code", Some(format!("{name} has no Claude config directory.")))
            }
            "codex" if ask_config_dir(ctx, account, "codex").is_none() => {
                ("codex", Some(format!("{name} has no Codex home.")))
            }
            _ => (ask_adapter(ctx, account).unwrap_or("opencode"), None),
        };
        let check = selftest_read::check(ctx, name, cli);
        let reason = config_problem.or_else(|| (!check.ok).then(|| check.reason.unwrap_or_default()));
        // The executor row is `{...row, cli, available, liveTools, ...reason}` (`service.ts:580-596`).
        let mut row = Map::new();
        row.insert("account".into(), json!(name));
        row.insert("backend".into(), json!("executor"));
        row.insert("models".into(), json!(models));
        row.insert("runners".into(), json!(runners));
        row.insert("isPlanner".into(), json!(is_planner));
        row.insert("cli".into(), json!(cli));
        row.insert("available".into(), json!(check.ok && reason.is_none()));
        row.insert("liveTools".into(), json!(check.ok && reason.is_none() && check.live_tools));
        if let Some(reason) = reason {
            row.insert("reason".into(), json!(reason));
        }
        executor.push(Value::Object(row));
    }
    pacer.extend(executor);
    pacer
}

/// Reply shape of `assistant.candidates` (`service.ts:572`).
pub fn assistant_candidates_with<'a>(
    ctx: &'a Ctx,
    params: Value,
    host: &'a mut dyn AssistantHost,
) -> OpFuture<'a> {
    Box::pin(async move {
        refuse(ctx)?;
        parse("assistant.candidates", params)?;
        let strategy = strategy(ctx)
            .ok_or_else(|| unavailable("the strategy requires the TypeScript loader"))?;
        let entries = host.plugins(ctx).await?;
        Ok(json!({"accounts":candidate_rows(ctx, &strategy, &entries),"reads":READS}))
    })
}

/// `assistantStatus` (`service.ts:200-229`) over native admission.
pub fn assistant_status_with<'a>(
    ctx: &'a Ctx,
    params: Value,
    host: &'a mut dyn AssistantHost,
) -> OpFuture<'a> {
    Box::pin(async move {
        refuse(ctx)?;
        parse("assistant.status", params)?;
        let settings = stored_settings(ctx)?;
        let configured = settings.account.as_deref().is_some_and(|a| !a.is_empty());
        let entries = host.plugins(ctx).await?;
        // TypeScript catches admission failures and reports them as the reason, without a hint.
        let admission = if configured {
            match admit_with(ctx, host, &entries).await {
                Ok(admission) => admission,
                Err(error) => Admission {
                    ok: false,
                    reason: Some(error.message),
                    hint: None,
                },
            }
        } else {
            Admission::no(NOT_SET_UP.0, Some(NOT_SET_UP.1))
        };
        let mut live_tools = false;
        let mut cli: Option<String> = None;
        if configured {
            let strategy = strategy(ctx);
            if let Some(strategy) = &strategy {
                if let Some(chosen) = candidate_rows(ctx, strategy, &entries)
                    .into_iter()
                    .find(|row| {
                        row["account"] == settings.account.as_deref().unwrap_or("")
                            && row["backend"] == settings.backend
                    })
                {
                    live_tools = chosen["liveTools"].as_bool().unwrap_or(false);
                    cli = chosen["cli"].as_str().map(str::to_owned);
                }
            }
            if cli.is_none() && settings.backend == "executor" {
                if let Some(strategy) = strategy {
                    if let Some(account) = settings.account.as_deref() {
                        cli = ask_adapter(ctx, &strategy["accounts"][account]).map(str::to_owned);
                    }
                }
            }
        }
        let today = with_db_core(ctx, |db| {
            assistant::usage_since(db, midnight(ctx).unwrap_or(0.0)).map_err(store_error)
        })?;
        let mut out = Map::new();
        out.insert("available".into(), json!(configured && admission.ok));
        out.insert("configured".into(), json!(configured));
        put(&mut out, "account", settings.account.as_ref().map(|a| json!(a)).as_ref());
        put(&mut out, "runner", settings.runner.as_ref().map(|r| json!(r)).as_ref());
        out.insert("liveTools".into(), json!(live_tools));
        if let Some(cli) = cli {
            out.insert("cli".into(), json!(cli));
        }
        if !admission.ok {
            out.insert("reason".into(), json!(admission.reason.unwrap_or_default()));
            if let Some(hint) = admission.hint {
                out.insert("hint".into(), json!(hint));
            }
        }
        out.insert("limits".into(), settings.limits_json());
        out.insert("retention".into(), settings.retention_json());
        out.insert("rev".into(), json!(settings.rev));
        out.insert("today".into(), json!({"turns":today[0],"input":today[1],"output":today[2]}));
        Ok(Value::Object(out))
    })
}

/// Registry fallback for callers that bypass both doors: no plugin snapshot and no usage
/// channel, so the reply is the same refusal TypeScript gives without a reply plugin.
struct OfflineHost;

impl AssistantHost for OfflineHost {
    fn plugins<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        Box::pin(async { Err(unavailable("assistant status requires the front door's Core bridge")) })
    }
}

pub fn assistant_status(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut host = OfflineHost;
        assistant_status_with(ctx, params, &mut host).await
    })
}

pub fn assistant_candidates(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut host = OfflineHost;
        assistant_candidates_with(ctx, params, &mut host).await
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const CLI_AGENTS: &str = include_str!("../../../cli/src/status_line/agents.rs");

    #[test]
    fn agent_names_match_the_status_line_copy() {
        for (id, name) in [
            ("claude-code", "Claude Code"),
            ("codex", "Codex"),
            ("cursor", "Cursor"),
            ("agy", "Antigravity"),
            ("byteplus", "BytePlus"),
            ("local", "Local model"),
            ("opencode", "OpenCode"),
            ("gemini", "Gemini"),
        ] {
            assert_eq!(agent_name(id), name);
            assert!(
                CLI_AGENTS.contains(&format!("Some(\"{id}\") => (\"{name}\"," )),
                "status line no longer names {id} as {name}"
            );
        }
        assert_eq!(agent_name("claude"), "Claude Code");
        assert_eq!(agent_name("antigravity"), "Antigravity");
    }
}
