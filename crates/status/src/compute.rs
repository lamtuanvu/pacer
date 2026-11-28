//! Native `computeStatus` (`src/engine/status.ts:163-385`), ported one-to-one
//! to Rust. `compute_status` fetches the registry entries once, evaluates one
//! budget per account (in account order, in `join_all`), composes the provider
//! rows from the runner configuration, merges evidence (per-account, honoring
//! `read_only`), and hands the composed parts to `pacer_engine::status::compose_status`
//! for ranking, tier fallback and the final Status key order.
//!
//! All inputs and outputs are `serde_json::Value` in the TypeScript JSON shapes,
//! and every field is inserted in the TS spread order so the parity driver can
//! compare `JSON.stringify` byte-for-byte.

use crate::{
    endpoint::endpoint_cell,
    evidence::{
        account_scope, applies_to, current_evidence, evidence_deadline, evidence_fact,
        merge_evidence, reading_evidence,
    },
    freshness::{AUTH_LIFETIME_S, LIMIT_WINDOW_LENGTH_S, mark_freshness},
    marks::{active_limit_observations, auth_observation, read_blocked, read_broken},
    signin::account_sign_in,
    trace::StatusTimer,
    usage::{NativeUsage, PluginDoor, ReadMode, UsageReads},
};
use futures::future::join_all;
use pacer_foundation::{Ctx, api::CoreError};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Readings keyed both by account name and by the model-inventory key
/// (`status.ts:179,186-187`), reused between the parity driver and the
/// computation.
pub type Readings = Mutex<HashMap<String, Value>>;

/// Endpoint rows the computation probed, reused by `account.list`.
pub type Endpoints = Mutex<HashMap<String, Value>>;

/// The process's login-PATH cache: `cachedLoginPath` (status.ts:263). Empty
/// (`None`) means no login PATH has been read, so `installed` uses the
/// service `PATH` (`status.ts:264`).
#[derive(Default)]
pub struct LoginPaths {
    cached: Option<PathBuf>,
}

impl LoginPaths {
    /// `cachedLoginPath` (install/login.ts): the shell profile's PATH once read
    /// during install, or `None` when it was never recorded (the service PATH).
    pub fn cached(&self, _env: &HashMap<String, String>, _home: &Path) -> Option<PathBuf> {
        self.cached.clone()
    }
}

/// Activity rebuild trigger; the native first cut only records that a rebuild
/// happened (the activity profile is loaded by `compute_status` itself).
pub struct ActivityRebuilds;

impl Default for ActivityRebuilds {
    fn default() -> Self {
        ActivityRebuilds
    }
}

/// One per door process: what `computeStatus` needs from its process.
pub struct StatusRuntime {
    pub usage: Arc<NativeUsage>,
    pub door: Arc<dyn PluginDoor>,
    pub login: Arc<LoginPaths>,
    pub activity: Arc<ActivityRebuilds>,
}

#[derive(Default)]
pub struct StatusOptions<'a> {
    pub read_only: bool,
    pub include_planner_sign_in: bool,
    pub cache_only: bool,
    pub service_path: bool,
    /// None = load the activity profile; Some(None) = TS `profile: null`; Some(Some(p)) = given.
    pub profile: Option<Option<Value>>,
    pub readings: Option<&'a Readings>,
    pub endpoints: Option<&'a Endpoints>,
    pub refresh_accounts: &'a [String],
}

/// The binary name for an agent id (`status.ts:74`).
fn binary_for(agent: &str) -> &str {
    match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor-agent",
        "agy" => "agy",
        _ => agent,
    }
}

/// `Number.isFinite` over a JSON number (`figureOf`, status.ts:97).
fn finite(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

/// `pickLimit` (status.ts:86-92): the covering mark/fact with the latest end.
fn pick_limit(facts: &[Value]) -> Option<Value> {
    let with_end: Vec<&Value> = facts
        .iter()
        .filter(|f| {
            f.get("validUntil")
                .unwrap_or(&Value::Null)
                .as_f64()
                .is_some()
                || f.get("value")
                    .and_then(|v| v.get("resetsAt"))
                    .and_then(Value::as_f64)
                    .is_some()
        })
        .collect();
    if with_end.is_empty() {
        return None;
    }
    let end = |f: &Value| {
        f.get("validUntil")
            .and_then(Value::as_f64)
            .or_else(|| {
                f.get("value")
                    .and_then(|v| v.get("resetsAt"))
                    .and_then(Value::as_f64)
            })
            .unwrap_or(f64::MIN)
    };
    let best = with_end
        .iter()
        .copied()
        .max_by(|a, b| end(a).total_cmp(&end(b)))?
        .clone();
    Some(json!({
        "until": end(&best),
        "observedAt": best.get("observedAt").cloned().unwrap_or(Value::Null),
        "manual": best.get("source") == Some(&json!("configuration")),
    }))
}

/// `figureOf` (status.ts:95-99): the record's quoted figure.
fn figure_of(limit: Option<&Value>, binding: &Value) -> Value {
    if let Some(limit) = limit {
        return json!({
            "usedPct": 100, "window": "limit", "lengthS": LIMIT_WINDOW_LENGTH_S,
            "resetsAt": limit.get("until").cloned().unwrap_or(Value::Null),
        });
    }
    if !binding.is_null()
        && !binding.get("usedPct").unwrap_or(&Value::Null).is_null()
        && finite(&binding["usedPct"])
    {
        return json!({
            "usedPct": binding.get("usedPct").cloned().unwrap_or(Value::Null),
            "window": binding.get("name").cloned().unwrap_or(Value::Null),
            "lengthS": binding.get("lengthS").cloned().unwrap_or(Value::Null),
            "resetsAt": binding.get("resetsAt").cloned().unwrap_or(Value::Null),
        });
    }
    Value::Null
}

/// `freshnessOf` (status.ts:104-107). An active limit is a current fact, so a
/// limited record is fresh even when the reading under it has aged.
fn freshness_of(
    reading: &Value,
    binding: &Value,
    windows: &[Value],
    limit: Option<&Value>,
) -> &'static str {
    if limit.is_some() {
        return "fresh";
    }
    let has_error = reading.get("error").is_some_and(|e| !e.is_null());
    let stale = reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let binding_stale = binding
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if has_error || stale || binding_stale {
        "historical"
    } else if !windows.is_empty() {
        "fresh"
    } else {
        "unknown"
    }
}

/// `observedAtOf` (status.ts:111-114).
fn observed_at_of(usage: &str, limit: Option<&Value>, eligibility: &Value, now: f64) -> Value {
    if usage == "reactive" || usage == "unmetered" {
        return limit
            .and_then(|l| l.get("observedAt").cloned())
            .unwrap_or(Value::Null);
    }
    match eligibility.get("evidenceAgeS").and_then(Value::as_f64) {
        Some(age) => json!(now - age),
        None => Value::Null,
    }
}

/// `selectableModels` (status.ts:117-119): the models a runner's tiers can select.
fn selectable_models(runner: &Value) -> HashSet<String> {
    let models = runner
        .get("models")
        .and_then(Value::as_array)
        .and_then(|m| (!m.is_empty()).then_some(m));
    if let Some(models) = models {
        models
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .collect()
    } else if let Some(model) = runner.get("model").and_then(Value::as_str) {
        if model.is_empty() {
            HashSet::new()
        } else {
            HashSet::from([model.to_string()])
        }
    } else {
        HashSet::new()
    }
}

/// A blocked runner row (`BlockedRunner`).
fn blocked_entry(runner: &str, model: &str, until: Value, reason: &str) -> Value {
    let mut out = json!({"runner": runner, "model": model});
    if !until.is_null() {
        out["until"] = until;
    }
    out["reason"] = json!(reason);
    out
}

/// `blockedRunnersOf` (status.ts:127-162): runners of the account that cannot
/// take work right now.
fn blocked_runners_of(
    account_scope: &Value,
    runners: &[Value],
    snapshot: &Value,
    now: f64,
) -> Value {
    let mut entries: Vec<Value> = Vec::new();
    let mut keys = Vec::<String>::new();
    let add = |entries: &mut Vec<Value>, keys: &mut Vec<String>, key: &str, entry: Value| {
        if let Some(prev) = keys.iter().position(|k| k == key) {
            let previous = &entries[prev];
            let previous_reason = previous.get("reason").and_then(Value::as_str).unwrap_or("");
            let entry_reason = entry.get("reason").and_then(Value::as_str).unwrap_or("");
            let prev_until = previous
                .get("until")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MIN);
            let entry_until = entry
                .get("until")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MIN);
            if entry_reason == "quota_failure"
                && (previous_reason != "quota_failure" || prev_until < entry_until)
            {
                entries[prev] = entry;
            }
        } else {
            keys.push(key.to_string());
            entries.push(entry);
        }
    };
    let base_scope = |r: &Value| {
        json!({
            "account": account_scope.get("account").cloned().unwrap_or(Value::Null),
            "identity": account_scope.get("identity").cloned().unwrap_or(Value::Null),
            "runner": r.get("name").cloned().unwrap_or(Value::Null),
            "host": host_of(r),
        })
    };
    for runner in runners {
        let model = runner
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string();
        let base = base_scope(runner);
        let selectable = selectable_models(runner);
        let mut model_scope = base.clone();
        model_scope["model"] = json!(model);
        for fact in snapshot["evidence"]["facts"]["budget"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if fact
                .get("value")
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                != Some("limit")
                || fact
                    .get("value")
                    .and_then(|v| v.get("resetsAt"))
                    .and_then(Value::as_f64)
                    .is_none()
            {
                continue;
            }
            let until = fact
                .get("validUntil")
                .and_then(Value::as_f64)
                .or_else(|| {
                    fact.get("value")
                        .and_then(|v| v.get("resetsAt"))
                        .and_then(Value::as_f64)
                })
                .unwrap_or(f64::MIN);
            let runner_name = runner.get("name").and_then(Value::as_str).unwrap_or("");
            if applies_to(fact, &model_scope) {
                add(
                    &mut entries,
                    &mut keys,
                    &format!("{runner_name}\u{0}{model}"),
                    blocked_entry(runner_name, &model, json!(until), "quota_failure"),
                );
            } else if fact
                .get("scope")
                .and_then(|s| s.get("runner"))
                .and_then(Value::as_str)
                == Some(runner_name)
                && let Some(fact_model) = fact
                    .get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                && fact_model != model
                && selectable.contains(&fact_model)
                && (fact
                    .get("scope")
                    .and_then(|s| s.get("host"))
                    .is_none_or(|h| h.is_null() || h == &base["host"]))
                && fact.get("scope").and_then(|s| s.get("account")) == account_scope.get("account")
                && fact.get("scope").and_then(|s| s.get("identity"))
                    == account_scope.get("identity")
            {
                add(
                    &mut entries,
                    &mut keys,
                    &format!("{runner_name}\u{0}{fact_model}"),
                    blocked_entry(runner_name, &fact_model, json!(until), "quota_failure"),
                );
            }
        }
        for fact in snapshot["evidence"]["facts"]["availability"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let value = fact.get("value").cloned().unwrap_or(Value::Null);
            let reason = fact.get("reason").and_then(Value::as_str).unwrap_or("");
            if value != json!("unavailable")
                || !(reason == "authentication_failed" || reason == "subscription_missing")
                || !current_evidence(fact, now, None)
            {
                continue;
            }
            let runner_name = runner.get("name").and_then(Value::as_str).unwrap_or("");
            if applies_to(fact, &model_scope) {
                add(
                    &mut entries,
                    &mut keys,
                    &format!("{runner_name}\u{0}{model}"),
                    blocked_entry(runner_name, &model, Value::Null, reason),
                );
            } else if fact
                .get("scope")
                .and_then(|s| s.get("runner"))
                .and_then(Value::as_str)
                == Some(runner_name)
                && let Some(fact_model) = fact
                    .get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                && fact_model != model
                && selectable.contains(&fact_model)
                && (fact
                    .get("scope")
                    .and_then(|s| s.get("host"))
                    .is_none_or(|h| h.is_null() || h == &base["host"]))
                && fact.get("scope").and_then(|s| s.get("account")) == account_scope.get("account")
                && fact.get("scope").and_then(|s| s.get("identity"))
                    == account_scope.get("identity")
            {
                add(
                    &mut entries,
                    &mut keys,
                    &format!("{runner_name}\u{0}{fact_model}"),
                    blocked_entry(runner_name, &fact_model, Value::Null, reason),
                );
            }
        }
    }
    Value::Array(entries)
}

/// The host part of a runner's scope (`locals`, status.ts:hostOf); a runner
/// with no `host` is local.
fn host_of(runner: &Value) -> Value {
    match runner.get("host").and_then(Value::as_str) {
        Some(host) if !host.is_empty() => json!(host),
        _ => json!("local"),
    }
}

/// `isCalendar` (src/pace/calendar.ts): a profile engages calendar pacing only
/// when it has 7+ days with at least one active hour.
fn is_calendar(profile: &Value) -> bool {
    if profile.is_null() {
        return true;
    }
    let days = profile.get("days").and_then(Value::as_f64).unwrap_or(0.0);
    if days < 7.0 {
        return true;
    }
    let active = profile.get("active").and_then(Value::as_array);
    if active.is_none_or(Vec::is_empty) {
        return true;
    }
    !active
        .map(|a| a.iter().any(|v| v.as_bool().unwrap_or(false)))
        .unwrap_or(false)
}

/// `onPath` (status.ts:264): whether `bin` resolves inside `path` (a PATH).
fn on_path(path: &str, bin: &str) -> bool {
    path.split(':')
        .map(PathBuf::from)
        .any(|dir| dir.join(bin).is_file())
}

/// `ctx.which(bin)` (`status.ts:264`): whether `bin` is on the service PATH.
fn which(env: &HashMap<String, String>, bin: &str) -> bool {
    match env.get("PATH") {
        Some(path) => on_path(path, bin),
        None => false,
    }
}

/// `resolveRunner(s, id)?.id ?? id` (status.ts:171-172): the canonical runner
/// id for a block/broken alias.
fn resolved_runner_id(strategy: &Value, id: &str) -> String {
    pacer_config::config_writes::resolve(strategy, id)
        .and_then(|r| r.get("id").and_then(Value::as_str))
        .unwrap_or(id)
        .to_string()
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// `runner.model ?? "default"` (`status.ts:213,267`): an explicit JSON null is
/// the same as an absent model, not a model literally named `null`.
fn model_of(runner: &Value) -> Value {
    match runner.get("model") {
        Some(value) if !value.is_null() => value.clone(),
        _ => json!("default"),
    }
}

/// `statusBrokerParts` (status.ts:69-72).
pub fn status_broker_parts(status: &Value) -> Value {
    let mut out = json!({});
    out["accounts"] = status.get("accounts").cloned().unwrap_or(json!([]));
    out["providers"] = status.get("providers").cloned().unwrap_or(json!([]));
    out["policy"] = status.get("policy").cloned().unwrap_or(Value::Null);
    out["calendarPace"] = status.get("calendarPace").cloned().unwrap_or(json!(true));
    if let Some(warnings) = status.get("warnings") {
        out["warnings"] = warnings.clone();
    }
    out
}

/// The timezone for `evaluateWindow` (`hourBin`): the process's `TZ`, else UTC
/// (the parity driver sets `TZ=UTC` on both sides).
fn zone_from_env(env: &HashMap<String, String>) -> chrono_tz::Tz {
    env.get("TZ")
        .and_then(|tz| tz.parse().ok())
        .unwrap_or(chrono_tz::UTC)
}

/// The activity profile: `loadActivity(ctx).catch(() => null)` (status.ts:176).
/// On any read or parse error the profile is `null` (i.e. calendar, like TS).
fn activity_profile(ctx: &Ctx) -> Value {
    let path = ctx.pacer_home.join("state").join("activity.json");
    pacer_foundation::fsutil::read_json::<Value>(&path).unwrap_or(Value::Null)
}

/// `computeStatus` (status.ts:163-385).
#[allow(clippy::too_many_lines)]
pub async fn compute_status(
    ctx: &Ctx,
    strategy: &Value,
    opts: &StatusOptions<'_>,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let zone = zone_from_env(&ctx.env);
    let mut trace = StatusTimer::new(ctx);
    let warnings: Vec<Value> = strategy["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|accounts| accounts.values())
        .filter(|a| a.get("usageSource").and_then(Value::as_str) == Some("orca"))
        .map(|a| {
            let kind = a.get("kind").and_then(Value::as_str).unwrap_or("");
            let repl = if kind == "claude" || kind == "codex" {
                "native"
            } else {
                "reactive"
            };
            json!(format!(
                "account {}: usage_source orca is no longer read; using {}",
                string(&a["name"]),
                repl
            ))
        })
        .collect();
    let blocked: Map<String, Value> = read_blocked(ctx)
        .into_iter()
        .map(|(id, mark)| (resolved_runner_id(strategy, &id), mark))
        .collect();
    let broken: Map<String, Value> = read_broken(ctx)
        .into_iter()
        .map(|(id, mark)| (resolved_runner_id(strategy, &id), mark))
        .collect();
    // Active limit marks, keyed by the exhausted.json key they were recorded under.
    let marks = Arc::new(active_limit_observations(ctx));
    let profile = match &opts.profile {
        None => activity_profile(ctx),
        Some(Some(p)) => p.clone(),
        Some(None) => Value::Null,
    };
    trace.phase("activity");

    let accounts: Vec<Value> = strategy["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.values().cloned())
        .collect();
    let hosts = &strategy["hosts"];
    let runners_all: Vec<Value> = strategy["runners"]
        .as_object()
        .into_iter()
        .flat_map(|rt| rt.values().cloned())
        .collect();

    let budgets = join_all(accounts.iter().map(|account| {
        let profile = profile.clone();
        let account = account.clone();
        let runners_all = runners_all.clone();
        let marks = marks.clone();
        let hosts = hosts.clone();
        async move {
            compute_budget(
                ctx,
                strategy,
                &account,
                &runners_all,
                &marks,
                &hosts,
                &profile,
                zone,
                opts,
                rt,
            )
            .await
        }
    }))
    .await;
    trace.phase("budgets");

    let by_account: HashMap<String, Value> = budgets
        .iter()
        .filter_map(|b| b.as_ref().ok().cloned())
        .map(|b| (string(&b["account"]["name"]).to_string(), b))
        .collect();
    let login_path = if opts.service_path {
        None
    } else {
        rt.login.cached(&ctx.env, &ctx.home)
    };
    let installed = |bin: &str| -> bool {
        match &login_path {
            Some(path) => {
                let path_os = path.to_string_lossy().to_string();
                on_path(&path_os, bin)
            }
            None => which(&ctx.env, bin),
        }
    };

    let providers: Vec<Value> = runners_all
        .iter()
        .map(|runner| {
            let account_name = string(&runner["account"]);
            let account = &by_account[account_name];
            provider_row(
                ctx,
                strategy,
                runner,
                account,
                &by_account,
                &blocked,
                &broken,
                &installed,
                &profile,
                zone,
                opts,
            )
        })
        .collect();
    let mode_hold = pacer_engine::mode_hold::read_hold(ctx).unwrap_or(Value::Null);
    let paused = pacer_engine::pause::read_pause(ctx).unwrap_or(Value::Null);

    let policy_value = crate::policy::policy_summary(ctx, &fetch_entries(ctx, rt).await?)?;

    let accounts = account_records(ctx, &budgets);
    let mut input = json!({
        "now": ctx.now,
        "strategy": strategy,
        "providers": providers,
        "accounts": accounts,
        "policy": policy_value,
        "paused": paused,
        "modeHold": mode_hold,
        "disabled": (ctx.env.get("PACER").cloned().unwrap_or_default()).to_lowercase() == "off",
        "calendarPace": is_calendar(&profile),
    });
    if !warnings.is_empty() {
        input["warnings"] = json!(warnings);
    }
    let status = pacer_engine::status::compose_status(&input);
    trace.phase("providers-and-ranking");
    Ok(status)
}

/// The `accounts` rows of the final Status document, mapped from each budget
/// (status.ts:337-380). `accountVerdict` is EXHAUSTED when the account itself
/// is limited or every runner is quota-blocked for its configured model.
fn account_records(ctx: &Ctx, budgets: &[Result<Value, CoreError>]) -> Vec<Value> {
    budgets
        .iter()
        .filter_map(|b| b.as_ref().ok())
        .map(|budget| {
            let account = &budget["account"];
            let runners: Vec<Value> = budget["runners"].as_array().cloned().unwrap_or_default();
            let binding = &budget["binding"];
            let verdict = string(&budget["verdict"]);
            let reading = &budget["reading"];
            let snapshot = &budget["snapshot"];
            let usage = string(&budget["usage"]);
            let scope = &budget["scope"];
            let account_eligibility = &budget["eligibility"];
            let windows: Vec<Value> = budget["windows"].as_array().cloned().unwrap_or_default();
            let account_limit = pick_limit(
                &snapshot["evidence"]["facts"]["budget"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|f| {
                        f.get("value")
                            .and_then(|v| v.get("name"))
                            .and_then(Value::as_str)
                            == Some("limit")
                            && f.get("value")
                                .and_then(|v| v.get("resetsAt"))
                                .and_then(Value::as_f64)
                                .is_some()
                            && applies_to(f, scope)
                    })
                    .cloned()
                    .collect::<Vec<Value>>(),
            );
            let blocked = blocked_runners_of(scope, &runners, snapshot, ctx.now);
            let every_runner_blocked = !runners.is_empty()
                && runners.iter().all(|r| {
                    let rname = string(&r["name"]);
                    let rmodel = r
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("default")
                        .to_string();
                    blocked.as_array().into_iter().flatten().any(|b| {
                        string(&b["runner"]) == rname
                            && string(&b["model"]) == rmodel
                            && string(&b["reason"]) == "quota_failure"
                    })
                });
            let account_verdict: String =
                if account_limit.is_some() || every_runner_blocked {
                    "EXHAUSTED".to_string()
                } else {
                    verdict.to_string()
                };
            let record = json!({
                "scope": {"account": string(&account["name"])},
                "source": reading.get("source").cloned().unwrap_or_else(|| json!("unknown")),
                "figure": figure_of(account_limit.as_ref(), binding),
                "windows": windows,
                "limit": account_limit,
                "blockedRunners": blocked,
                "observedAt": observed_at_of(usage, account_limit.as_ref(), account_eligibility, ctx.now),
                "freshness": freshness_of(reading, binding, &windows, account_limit.as_ref()),
                "verdict": account_verdict,
                "eligibility": account_eligibility,
                "spend": reading.get("spendUsd").and_then(Value::as_f64).map(|s| json!({
                    "usdWeek": s,
                    "capUsdWeek": account.get("weeklyUsd").cloned().unwrap_or(Value::Null),
                })).unwrap_or(Value::Null),
                "error": reading.get("error").and_then(|e| (!e.is_null()).then_some(json!({
                    "message": e, "at": ctx.now,
                }))).unwrap_or(Value::Null),
            });
            let figure = record.get("figure").cloned().unwrap_or(Value::Null);
            let figure_is_binding = !figure.is_null()
                && !binding.is_null()
                && figure.get("window") == binding.get("name")
                && figure.get("resetsAt") == binding.get("resetsAt");
            let mut out = json!({
                "name": string(&account["name"]),
                "kind": string(&account["kind"]),
                "verdict": account_verdict,
                "eligibility": account_eligibility,
                "evidence": snapshot["evidence"],
                "usedPct": figure.get("usedPct").cloned().unwrap_or(Value::Null),
                "pacePct": if figure_is_binding { binding.get("pace").cloned().unwrap_or(Value::Null) } else { Value::Null },
                "resetsAt": figure.get("resetsAt").cloned().unwrap_or(Value::Null),
                "window": figure.get("window").cloned().unwrap_or(Value::Null),
                "stale": record.get("freshness").and_then(Value::as_str) == Some("historical"),
                "runners": runners.iter().map(|r| r.get("name").cloned().unwrap_or(Value::Null)).collect::<Vec<Value>>(),
                "source": reading.get("source").cloned().unwrap_or(Value::Null),
                "capturedAt": reading.get("capturedAt").cloned().unwrap_or(Value::Null),
                "spendUsd": reading.get("spendUsd").cloned().unwrap_or(Value::Null),
                "usageState": record,
            });
            if let Some(remote_host) = reading.get("remoteHost").and_then(Value::as_str) {
                out["remoteHost"] = json!(remote_host);
            }
            out
        })
        .collect()
}

/// `rt.door.calls().entries(ctx)` once per call (Task 4).
async fn fetch_entries(
    ctx: &Ctx,
    rt: &StatusRuntime,
) -> Result<Vec<pacer_plugin_ops::public::Entry>, CoreError> {
    let mut calls = rt.door.calls();
    calls.entries(ctx).await
}

/// One account's budget progression (status.ts:179-257), in account order.
#[allow(clippy::too_many_arguments)]
async fn compute_budget(
    ctx: &Ctx,
    strategy: &Value,
    account: &Value,
    runners_all: &[Value],
    marks: &[crate::marks::LimitObservation],
    hosts: &Value,
    profile: &Value,
    zone: chrono_tz::Tz,
    opts: &StatusOptions<'_>,
    rt: &StatusRuntime,
) -> Result<Value, CoreError> {
    let account_name = string(&account["name"]);
    let runners: Vec<Value> = runners_all
        .iter()
        .filter(|r| r.get("account").and_then(Value::as_str) == Some(account_name))
        .cloned()
        .collect();
    let models: Vec<Value> = runners
        .iter()
        .filter_map(|r| r.get("model").cloned())
        .collect();
    let key = pacer_js_json::stringify(&json!({"account": account, "models": models}));
    let reading = if let Some(readings) = opts.readings {
        let locked = readings.lock().unwrap_or_else(|e| e.into_inner());
        locked
            .get(account_name)
            .cloned()
            .or_else(|| locked.get(&key).cloned())
    } else {
        None
    };
    let reading = match reading {
        Some(r) => r,
        None => {
            let read = rt
                .usage
                .read_account_usage(
                    ctx,
                    account,
                    &runners,
                    hosts,
                    ReadMode {
                        refresh: opts.refresh_accounts.contains(&account_name.to_string()),
                        cache_only: opts.cache_only,
                        read_only: opts.read_only,
                    },
                )
                .await;
            match read {
                Ok(r) => r,
                Err(e) => json!({
                    "windows": [], "capturedAt": Value::Null, "stale": false, "error": format!("{e}"),
                }),
            }
        }
    };
    if let Some(readings) = opts.readings {
        let mut locked = readings.lock().unwrap_or_else(|e| e.into_inner());
        locked.insert(account_name.to_string(), reading.clone());
        locked.insert(key, reading.clone());
    }
    let th = json!({
        "ahead": strategy["pacing"]["aheadThreshold"],
        "behind": strategy["pacing"]["behindThreshold"],
        "paceScale": if account_name == string(&strategy["planner"]["account"]) {
            1.0 - strategy["pacing"]["plannerReserve"].as_f64().unwrap_or(0.0) / 100.0
        } else {
            1.0
        },
    });
    // Account marks constrain all runners; runner marks and other-model facts
    // keep their actual scope (status.ts:196-201).
    let limits: Vec<Value> = marks
        .iter()
        .filter(|m| m.key == account_name)
        .map(|m| m.observation.clone())
        .chain(runners.iter().flat_map(|r| {
            let rname = string(&r["name"]);
            marks
                .iter()
                .filter(move |m| {
                    m.key != account_name
                        && (m.key == rname || resolved_runner_id(strategy, &m.key) == rname)
                })
                .map(|m| m.observation.clone())
        }))
        .collect();
    let usage = if reading.get("source").and_then(Value::as_str) == Some("reactive") {
        "reactive"
    } else {
        string(&account["usage"])
    };
    let fresh = mark_freshness(&reading, ctx.now);
    let scope = account_scope(account, hosts);
    let mut incoming = reading_evidence(&scope, &reading, usage);
    let budget_policy = pacer_js_json::stringify(&json!([
        account.get("weeklyUsd").cloned().unwrap_or(Value::Null),
        account.get("weeklyTokens").cloned().unwrap_or(Value::Null),
    ]));
    let budget_policy_str: Option<&str> = Some(&budget_policy);
    let metered: Vec<Value> = incoming["budget"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f.get("source") == Some(&json!("metered")))
        .map(|f| {
            evidence_fact(
                &f["scope"],
                string(&f["source"]),
                f.get("observedAt").and_then(Value::as_f64),
                f.get("validUntil").and_then(Value::as_f64),
                string(&f["reason"]),
                f.get("value").cloned().unwrap_or(Value::Null),
                budget_policy_str,
            )
        })
        .collect();
    incoming["budget"] = json!(
        incoming["budget"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f.get("source") != Some(&json!("metered")))
            .cloned()
            .chain(metered)
            .collect::<Vec<Value>>()
    );
    if let Some((at, obs_scope)) = auth_observation(ctx, &scope)
        && let Some(availability) = incoming["availability"].as_array_mut()
    {
        availability.push(evidence_fact(
            &obs_scope,
            "execution",
            Some(at),
            Some(at + AUTH_LIFETIME_S),
            "authentication_failed",
            json!("unavailable"),
            None,
        ));
    }
    let include_planner = opts.include_planner_sign_in;
    let planner_agent = string(&strategy["planner"]["agent"]);
    let planner_account = string(&strategy["planner"]["account"]);
    for runner in runners
        .iter()
        .filter(|r| r.get("host").is_none_or(|h| h.is_null()))
        .filter(|r| {
            include_planner
                || !(r.get("agent").and_then(Value::as_str) == Some(planner_agent)
                    && r.get("account").and_then(Value::as_str) == Some(planner_account))
        })
    {
        let runner_scope = json!({
            "account": scope.get("account").cloned().unwrap_or(Value::Null),
            "identity": scope.get("identity").cloned().unwrap_or(Value::Null),
            "runner": runner.get("name").cloned().unwrap_or(Value::Null),
            "model": model_of(runner),
            "host": json!("local"),
        });
        let sign_in = account_sign_in(ctx, account, &runner_scope);
        if let Some(recovered) = sign_in.get("recoveredScopes").and_then(Value::as_array) {
            let recovered_at = sign_in
                .get("recoveredAt")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if let Some(availability) = incoming["availability"].as_array_mut() {
                for recovered_scope in recovered {
                    availability.push(evidence_fact(
                        recovered_scope,
                        "session-log",
                        Some(recovered_at),
                        Some(recovered_at + AUTH_LIFETIME_S),
                        "signin_observed",
                        json!("ready"),
                        None,
                    ));
                }
            }
        }
    }
    for limit in limits.iter().filter(|v| {
        v.get("manual").and_then(Value::as_bool).unwrap_or(false)
            || v.get("scope")
                .and_then(|s| s.get("identity"))
                .map(|id| id == &scope["identity"])
                .unwrap_or(false)
    }) {
        let limit_scope = limit.get("scope").cloned().unwrap_or_else(|| scope.clone());
        let manual = limit
            .get("manual")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let observed = limit.get("observedAt").and_then(Value::as_f64);
        let until = limit.get("until").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(budget) = incoming["budget"].as_array_mut() {
            budget.push(evidence_fact(
                &limit_scope,
                if manual { "configuration" } else { "execution" },
                observed,
                Some(until),
                "quota_failure",
                json!({"name": "limit", "usedPct": 100, "resetsAt": until,
                       "lengthS": LIMIT_WINDOW_LENGTH_S, "paced": false}),
                None,
            ));
        }
    }
    let snapshot =
        merge_evidence(ctx, &scope, &incoming, budget_policy_str, opts.read_only).await?;
    let mut snapshot = snapshot;
    let applicable_ids: HashSet<String> = snapshot["evidence"]["facts"]
        .as_object()
        .into_iter()
        .flat_map(|facts| facts.values())
        .flat_map(|list| list.as_array().into_iter().flatten())
        .filter_map(|f| f.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    if let Some(facts) = snapshot["evidence"]["facts"].as_object_mut()
        && let Some(budget) = facts.get_mut("budget").and_then(Value::as_array_mut)
    {
        budget.retain(|f| {
            f.get("source").and_then(Value::as_str) != Some("metered")
                || f.get("budgetPolicy").and_then(Value::as_str) == Some(&budget_policy)
        });
    }
    if let Some(conflicts) = snapshot["evidence"]["conflicts"].as_array_mut() {
        conflicts.retain(|id| id.as_str().is_some_and(|id| applicable_ids.contains(id)));
    }
    let usage_windows: Vec<Value> = snapshot["evidence"]["facts"]["budget"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| applies_to(f, &scope))
        .map(|f| {
            let mut value = f.get("value").cloned().unwrap_or(Value::Null);
            if let Some(v) = value.as_object_mut() {
                v.insert(
                    "stale".to_string(),
                    json!(
                        v.get("stale").and_then(Value::as_bool).unwrap_or(false)
                            || !current_evidence(f, ctx.now, Some(evidence_deadline(f)))
                    ),
                );
            }
            value
        })
        .collect();
    let windows: Vec<Value> = usage_windows
        .iter()
        .map(|w| {
            pacer_engine::evaluate_window(
                &json!({"now": ctx.now, "usage": w, "profile": profile, "thresholds": th}),
                zone,
            )
        })
        .collect();
    let live: Vec<Value> = windows
        .iter()
        .filter(|w| !w.get("stale").and_then(Value::as_bool).unwrap_or(false))
        .cloned()
        .collect();
    let binding = pacer_engine::binding_window(&live);
    let binding = if binding.is_null() {
        pacer_engine::binding_window(&windows)
    } else {
        binding
    };
    let binding_fact = snapshot["evidence"]["facts"]["budget"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|f| f.get("value").and_then(|v| v.get("name")) == binding.get("name"));
    let mut reconciled_reading = fresh;
    let fresh_stale = reconciled_reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || usage_windows
            .iter()
            .any(|w| w.get("stale").and_then(Value::as_bool).unwrap_or(false));
    if let Some(facts_obj) = reconciled_reading.as_object_mut() {
        facts_obj.insert("windows".to_string(), json!(usage_windows));
        facts_obj.insert("stale".to_string(), json!(fresh_stale));
    }
    if let Some(binding_fact) = binding_fact
        && let Some(facts_obj) = reconciled_reading.as_object_mut()
    {
        facts_obj.insert(
            "capturedAt".to_string(),
            binding_fact
                .get("observedAt")
                .cloned()
                .unwrap_or(Value::Null),
        );
        let source = binding_fact
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !["execution", "configuration"].contains(&source) {
            facts_obj.insert("source".to_string(), json!(source));
        }
    }
    let unlimited = usage == "unmetered"
        || usage == "reactive"
        || (string(&account["usage"]) == "metered"
            && account.get("weeklyUsd").is_none_or(|v| v.is_null())
            && account.get("weeklyTokens").is_none_or(|v| v.is_null()));
    let verdict: String = if usage == "unmetered" && windows.is_empty() {
        "UNMETERED".to_string()
    } else if unlimited && windows.is_empty() {
        "OK".to_string()
    } else if !live.is_empty() {
        binding
            .get("verdict")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string()
    } else {
        "UNKNOWN".to_string()
    };
    let endpoint = endpoint_cell(ctx, account, opts.cache_only).await;
    if let Some(endpoints) = opts.endpoints {
        let mut locked = endpoints.lock().unwrap_or_else(|e| e.into_inner());
        locked.insert(account_name.to_string(), endpoint.clone());
    }
    let endpoint_reason = match endpoint.get("state").and_then(Value::as_str) {
        Some("key_missing") => Some("Key missing".to_string()),
        Some("not_working") => Some(format!(
            "Not working \u{00b7} {}",
            endpoint
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("test task failed")
        )),
        _ => None,
    };
    let endpoint_not_tested = endpoint.get("state").and_then(Value::as_str) == Some("not_tested");
    let eligibility = pacer_engine::evaluate_eligibility(&json!({
        "now": ctx.now, "scope": scope, "usage": usage,
        "budgetRequired": !unlimited, "allowPaid": account.get("allowPaid").cloned().unwrap_or(json!(false)),
        "evidence": snapshot["evidence"], "restrictions": [],
    }));
    let has_error = reading.get("error").is_some_and(|e| !e.is_null());
    let reading_stale = reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let account_eligibility = if (has_error || reading_stale)
        && eligibility.get("state").and_then(Value::as_str) == Some("eligible")
    {
        let mut e = eligibility;
        e["state"] = json!("uncertain");
        e["reasons"] = json!([{"code": "refresh_failed", "evidenceIds": []}]);
        e
    } else {
        eligibility
    };
    Ok(json!({
        "account": account, "runners": runners, "reading": reconciled_reading,
        "windows": windows, "binding": binding, "verdict": verdict,
        "endpointReason": endpoint_reason, "endpointNotTested": endpoint_not_tested,
        "scope": scope, "snapshot": snapshot, "eligibility": account_eligibility,
        "usage": usage, "unlimited": unlimited,
    }))
}

/// One runner's provider row (status.ts:263-323).
#[allow(clippy::too_many_arguments)]
fn provider_row(
    ctx: &Ctx,
    strategy: &Value,
    runner: &Value,
    account: &Value,
    by_account: &HashMap<String, Value>,
    _blocked: &Map<String, Value>,
    _broken: &Map<String, Value>,
    installed: &dyn Fn(&str) -> bool,
    profile: &Value,
    zone: chrono_tz::Tz,
    opts: &StatusOptions<'_>,
) -> Value {
    let usage = string(&account["usage"]);
    let reading = &account["reading"];
    let endpoint_reason = account
        .get("endpointReason")
        .cloned()
        .unwrap_or(Value::Null);
    let endpoint_not_tested = account
        .get("endpointNotTested")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scope = account.get("scope").cloned().unwrap_or(Value::Null);
    let snapshot = account.get("snapshot").cloned().unwrap_or(Value::Null);
    let unlimited = account
        .get("unlimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runner_scope = json!({
        "account": scope.get("account").cloned().unwrap_or(Value::Null),
        "identity": scope.get("identity").cloned().unwrap_or(Value::Null),
        "runner": runner.get("name").cloned().unwrap_or(Value::Null),
        "model": model_of(runner),
        "host": runner.get("host").cloned().unwrap_or_else(|| json!("local")),
    });
    let runner_name = string(&runner["name"]);
    let _ = by_account;
    let th = json!({
        "ahead": strategy["pacing"]["aheadThreshold"],
        "behind": strategy["pacing"]["behindThreshold"],
        "paceScale": if string(&account["account"]["name"]) == string(&strategy["planner"]["account"]) {
            1.0 - strategy["pacing"]["plannerReserve"].as_f64().unwrap_or(0.0) / 100.0
        } else {
            1.0
        },
    });
    let windows: Vec<Value> = snapshot["evidence"]["facts"]["budget"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| applies_to(f, &runner_scope))
        .map(|f| {
            let mut value = f.get("value").cloned().unwrap_or(Value::Null);
            if let Some(v) = value.as_object_mut() {
                v.insert(
                    "stale".to_string(),
                    json!(
                        v.get("stale").and_then(Value::as_bool).unwrap_or(false)
                            || !current_evidence(f, ctx.now, Some(evidence_deadline(f)))
                    ),
                );
            }
            value
        })
        .map(|w| {
            pacer_engine::evaluate_window(
                &json!({"now": ctx.now, "usage": w, "profile": profile, "thresholds": th}),
                zone,
            )
        })
        .collect();
    let live: Vec<Value> = windows
        .iter()
        .filter(|w| !w.get("stale").and_then(Value::as_bool).unwrap_or(false))
        .cloned()
        .collect();
    let binding = pacer_engine::binding_window(&live);
    let binding = if binding.is_null() {
        pacer_engine::binding_window(&windows)
    } else {
        binding
    };
    let verdict: String = if usage == "unmetered" && windows.is_empty() {
        "UNMETERED".to_string()
    } else if unlimited && windows.is_empty() {
        "OK".to_string()
    } else if !live.is_empty() {
        binding
            .get("verdict")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string()
    } else {
        "UNKNOWN".to_string()
    };
    let account_kind = string(&account["account"]["kind"]);
    let include_planner = opts.include_planner_sign_in;
    let planner_agent = string(&strategy["planner"]["agent"]);
    let planner_account = string(&strategy["planner"]["account"]);
    let runner_host = runner.get("host").and_then(Value::as_str);
    let sign_in = if (include_planner
        || !(runner.get("agent").and_then(Value::as_str) == Some(planner_agent)
            && runner.get("account").and_then(Value::as_str) == Some(planner_account)))
        && runner_host.is_none_or(|h| h.is_empty())
        && account_kind != "endpoint"
    {
        account_sign_in(ctx, &account["account"], &runner_scope)
    } else {
        json!({"signedIn": Value::Null})
    };
    let agent_field = runner.get("agent").cloned().unwrap_or(Value::Null);
    let legacy = strategy["legacy"].as_bool().unwrap_or(false);
    let account_source = string(&account["account"]["source"]);
    let account_kind2 = string(&account["account"]["kind"]);
    let orca_account = string(&account["account"]["orcaAccount"]);
    let mut provider = json!({
        "id": runner.get("name").cloned().unwrap_or(Value::Null),
        "account": string(&account["account"]["name"]),
        "usage": usage,
        "windows": windows,
        "binding": binding,
        "verdict": verdict,
    });
    if !legacy {
        provider["agent"] = agent_field;
    }
    if account_source == "orca"
        && (account_kind2 == "claude" || account_kind2 == "codex")
        && crate::folders::orca_account_home(ctx, account_kind2, orca_account).is_none()
    {
        provider["unavailableReason"] = json!("account folder not found");
    }
    let signed_in = sign_in.get("signedIn").and_then(Value::as_bool);
    if signed_in == Some(false) {
        provider["signedOutReason"] = sign_in.get("reason").cloned().unwrap_or(Value::Null);
    }
    if let Some(er) = endpoint_reason.as_str() {
        provider["unavailableReason"] = json!(er);
    }
    if endpoint_not_tested {
        provider["endpointNotTested"] = json!(true);
    }
    let installed_flag = runner_host.is_some() || installed(binary_for(string(&runner["agent"])));
    let reading_stale = reading
        .get("stale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let windows_stale = windows
        .iter()
        .any(|w| w.get("stale").and_then(Value::as_bool).unwrap_or(false));
    provider["installed"] = json!(installed_flag);
    provider["stale"] = json!(reading_stale || windows_stale);
    if let Some(blocked) = _blocked.get(runner_name) {
        provider["blockedReason"] = blocked.get("reason").cloned().unwrap_or(Value::Null);
        provider["blockedUntil"] = blocked.get("until").cloned().unwrap_or(Value::Null);
    }
    if let Some(broken) = _broken.get(runner_name) {
        provider["brokenReason"] = broken.get("reason").cloned().unwrap_or(Value::Null);
    }
    let reading_error = reading.get("error").cloned();
    let has_error = reading_error.as_ref().is_some_and(|e| !e.is_null());
    if let Some(e) = &reading_error
        && !e.is_null()
    {
        provider["error"] = e.clone();
    }
    if let Some(ec) = reading.get("errorCode").and_then(Value::as_str)
        && has_error
    {
        provider["errorCode"] = json!(ec);
    }
    provider["evidenceScope"] = scope;
    provider["evidenceRevision"] = snapshot.get("revision").cloned().unwrap_or(Value::Null);

    let mut restrictions: Vec<Value> = Vec::new();
    if runner.get("enabled") == Some(&json!(false)) {
        restrictions.push(json!({"code": "disabled", "evidenceIds": []}));
    }
    let installed_b = provider
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !installed_b {
        restrictions.push(json!({"code": "not_installed", "evidenceIds": []}));
    }
    for (field, code) in [
        ("unavailableReason", "unavailable"),
        ("signedOutReason", "signed_out"),
        ("blockedReason", "blocked"),
        ("brokenReason", "broken"),
    ] {
        if provider.get(field).is_some_and(|v| !v.is_null()) {
            restrictions.push(json!({"code": code, "evidenceIds": []}));
        }
    }
    let positional = json!({
        "restrictions": restrictions,
    });
    let mut provider_c = provider;
    let eligibility = pacer_engine::evaluate_eligibility(&json!({
        "now": ctx.now, "scope": runner_scope,
        "usage": usage, "budgetRequired": !unlimited,
        "allowPaid": account["account"].get("allowPaid").cloned().unwrap_or(json!(false)),
        "evidence": snapshot["evidence"], "restrictions": positional["restrictions"],
    }));
    let mut eligibility = eligibility;
    if (has_error || reading_stale)
        && eligibility.get("state").and_then(Value::as_str) == Some("eligible")
    {
        let mut e = eligibility.clone();
        e["state"] = json!("uncertain");
        e["reasons"] = json!([{"code": "refresh_failed", "evidenceIds": []}]);
        eligibility = e;
    }
    provider_c["eligibility"] = eligibility.clone();
    let runner_limit = pick_limit(
        &snapshot["evidence"]["facts"]["budget"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| {
                f.get("value")
                    .and_then(|v| v.get("name"))
                    .and_then(Value::as_str)
                    == Some("limit")
                    && f.get("value")
                        .and_then(|v| v.get("resetsAt"))
                        .and_then(Value::as_f64)
                        .is_some()
                    && applies_to(f, &runner_scope)
            })
            .cloned()
            .collect::<Vec<Value>>(),
    );
    let runner_scope_small = json!({
        "account": string(&account["account"]["name"]), "runner": runner_name,
    });
    let figure = figure_of(runner_limit.as_ref(), &provider_c["binding"]);
    let observed_at = observed_at_of(usage, runner_limit.as_ref(), &eligibility, ctx.now);
    let freshness = freshness_of(reading, &binding, &windows, runner_limit.as_ref());
    let read_spend = reading.get("spendUsd").and_then(Value::as_f64);
    let spend = if read_spend.is_some() {
        json!({"usdWeek": read_spend, "capUsdWeek": account["account"].get("weeklyUsd").cloned().unwrap_or(Value::Null)})
    } else {
        Value::Null
    };
    let read_err = reading.get("error").cloned();
    let error = if read_err.as_ref().is_some_and(|e| !e.is_null()) {
        json!({"message": read_err, "at": ctx.now})
    } else {
        Value::Null
    };
    let usage_state = json!({
        "scope": runner_scope_small,
        "source": reading.get("source").cloned().unwrap_or_else(|| json!("unknown")),
        "figure": figure,
        "windows": windows,
        "limit": runner_limit,
        "blockedRunners": [],
        "observedAt": observed_at,
        "freshness": freshness,
        "verdict": if runner_limit.is_some() { "EXHAUSTED".to_string() } else { verdict.clone() },
        "eligibility": eligibility,
        "spend": spend,
        "error": error,
    });
    provider_c["usageState"] = usage_state;
    let fresh_h = provider_c
        .get("usageState")
        .and_then(|u| u.get("freshness"))
        .and_then(Value::as_str)
        .unwrap_or("");
    provider_c["stale"] = json!(fresh_h == "historical");
    let _ = opts;
    provider_c
}

/// Re-exports for the integration test (`crates/status/tests/compute.rs`), matching
/// the brief's signatures: `pick_limit` returns the record or `null`, and
/// `freshness_of` takes an optional binding.
pub mod testing {
    use serde_json::Value;
    /// `pickLimit` (status.ts:86-92): the covering mark/fact with the latest end,
    /// or `null` when none covers.
    pub fn pick_limit(facts: &[Value]) -> Value {
        super::pick_limit(facts).unwrap_or(Value::Null)
    }
    /// `freshnessOf` (status.ts:104-107).
    pub fn freshness_of(
        reading: &Value,
        binding: Option<&Value>,
        windows: &[Value],
        limit: Option<&Value>,
    ) -> &'static str {
        super::freshness_of(reading, binding.unwrap_or(&Value::Null), windows, limit)
    }
}
