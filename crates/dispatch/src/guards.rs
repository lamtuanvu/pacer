//! Native port of the sealed dispatch parts only TypeScript used to compute
//! (`src/api/dispatch-parts-bridge.ts`, `src/executors/availability.ts` and
//! `src/dispatch/enforcement.ts`). Each function returns exactly the JSON
//! `dispatchPartsFor` returned for that kind, so the callers in
//! `pacer-dispatch-ops` can own the whole reply without a Core bridge.
#![allow(clippy::result_large_err)]
use pacer_config::{
    strategy::load_strategy,
    strategy_write::{DraftPreview, preview_draft},
};
use pacer_engine::exhausted::read_marks;
use pacer_foundation::{Ctx, api::{Code, CoreError}};
use pacer_js_json::stringify as js_stringify;
use pacer_repos::repo_for;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{readonly::ReadOnlyStore, version_cache::VersionCache};

#[cfg(test)]
#[path = "guards/tests.rs"]
mod tests;

type Object = Map<String, Value>;

fn internal(message: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, message.to_string())
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message.into())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

const STRICT_INTERACTIVE_REASON: &str =
    "Native subagent control is certified only for headless launches; remove the runner's session: interactive or set it to headless";

/// `digest(strictClaudeLaunch.toString())` from `src/dispatch/enforcement.ts`.
/// Q1 (planned) replaces this with a versioned constant; until it lands this is
/// the digest of the compiled TypeScript function source at this revision.
const STRICT_LAUNCH_DIGEST: &str =
    "cc453a0f27e08d11b155b66a0178add7233db0491140c8cdf0fc1e258068c386";

/// `digest` in `src/dispatch/enforcement.ts`: SHA-256 of `JSON.stringify(value)`.
fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(js_stringify(value).as_bytes()))
}

/// `pkg.version`, read from the same package.json the TypeScript core imports.
fn package_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        serde_json::from_str::<Value>(include_str!("../../../package.json"))
            .ok()
            .and_then(|value| value["version"].as_str().map(str::to_owned))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
    })
}

// ---------------------------------------------------------------------------
// dispatch.parts request routing
// ---------------------------------------------------------------------------

/// The JSON `dispatchPartsFor` returns for one sealed request. `runners` are
/// validated by the op crate before the bridge; this checks them again because
/// the result is assembled here.
pub async fn dispatch_parts(
    ctx: &Ctx,
    params: &Value,
    cache: &VersionCache,
) -> Result<Value, CoreError> {
    let kind = text(params, "kind").ok_or_else(|| invalid("params: invalid kind"))?;
    let runners: Vec<String> = params["runners"]
        .as_array()
        .ok_or_else(|| invalid("params: invalid runners"))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let strategy = match params.get("draft") {
        Some(draft) => match preview_draft(&ctx.pacer_home, draft) {
            DraftPreview::Valid { strategy, .. } => strategy,
            DraftPreview::Invalid { problems, .. } => {
                return Err(invalid("Invalid strategy draft").hint(problems.join("; ")))
            }
            DraftPreview::Unreadable => return Err(invalid("Invalid strategy draft")),
        },
        None => load_strategy(&ctx.pacer_home).map_err(internal)?,
    };
    match kind {
        "dispatch.executor-guards" => Ok(executor_guards(ctx, &strategy, &runners)),
        "dispatch.enforcement-exclusions" => {
            let repo = text(params, "repo").unwrap_or_default();
            let cached = params["cached"] == true;
            Ok(enforcement_exclusions(ctx, &strategy, &runners, repo, cached, cache).await)
        }
        "dispatch.enforcement-diagnostics" => {
            let repo = text(params, "repo").unwrap_or_default();
            Ok(enforcement_diagnostics(ctx, &strategy, repo, cache).await)
        }
        other => Err(invalid(format!("params: unknown kind {other}"))),
    }
}

// ---------------------------------------------------------------------------
// dispatch.executor-guards
// ---------------------------------------------------------------------------

/// `{guards: [{runner, reason}], admissionHooks}` for `executorExclusion` and
/// `classifierConfig(...).configured` (`dispatch-parts-bridge.ts:51-55`).
pub fn executor_guards(ctx: &Ctx, strategy: &Value, runners: &[String]) -> Value {
    json!({
        "guards": runners.iter().map(|runner| json!({
            "runner": runner,
            "reason": executor_exclusion(ctx, strategy, runner),
        })).collect::<Vec<_>>(),
        "admissionHooks": classifier_configured(strategy),
    })
}

/// `executorExclusion` (`src/executors/availability.ts:83-85`).
fn executor_exclusion(ctx: &Ctx, strategy: &Value, runner_id: &str) -> Option<String> {
    executor_guard(ctx, strategy, runner_id).map(|guard| guard.0)
}

/// The guard reason and its optional `until` (`ExecutorGuard`). Only the reason
/// crosses the parts bridge; `until` is kept here for the eligibility path.
fn executor_guard(ctx: &Ctx, strategy: &Value, id: &str) -> Option<(String, Option<f64>)> {
    let runner = resolve_runner(strategy, id);
    let parsed = parse_runner_id(id);
    let account_name = runner
        .and_then(|r| text(r, "account"))
        .or_else(|| parsed.as_ref().and_then(|p| p.account.as_deref()))
        .or_else(|| parsed.as_ref().map(|p| p.agent.as_str()));
    let matches = |key: &str| {
        key == id
            || account_name == Some(key)
            || runner.is_some_and(|r| {
                resolve_runner(strategy, key).and_then(|other| text(other, "id"))
                    == text(r, "id")
            })
    };
    let blocked = read_json_obj(&ctx.pacer_home.join("blocked.json"))
        .into_iter()
        .find(|(key, _)| matches(key));
    if let Some((_, block)) = blocked {
        if block.get("reason").is_some_and(Value::is_string) {
            let until = block.get("until").and_then(Value::as_f64).filter(|t| *t > ctx.now);
            return Some(("Blocked by you".into(), until));
        }
    }
    let mut limits = Vec::new();
    for (key, until) in read_marks(ctx) {
        if !matches(&key) || !until.as_f64().is_some_and(|u| u > ctx.now) {
            continue;
        }
        if let Some(observation) = limit_observation(ctx, &key, until.as_f64().unwrap_or(0.0)) {
            limits.push(observation);
        }
    }
    let account = runner
        .and_then(|r| text(r, "account"))
        .and_then(|name| strategy["accounts"].get(name));
    if runner.is_none() || account.is_none() {
        let manual = limits.iter().find(|limit| limit["manual"] == true);
        return manual.map(|limit| {
            ("exhausted".into(), limit["until"].as_f64().filter(|t| *t > ctx.now))
        });
    }
    let runner = runner?;
    let account = account?;
    let scope = account_evidence_scope(account, &strategy["hosts"]);
    let snapshot = read_evidence(ctx, &scope);
    let budget_policy = js_stringify(&json!([
        account.get("weeklyUsd").cloned().unwrap_or(Value::Null),
        account.get("weeklyTokens").cloned().unwrap_or(Value::Null),
    ]));
    let mut incoming = empty_evidence();
    for limit in limits {
        let limit_scope = limit.get("scope").filter(|s| s.is_object()).cloned().unwrap_or_else(|| {
            json!({"account": scope["account"], "identity": scope["identity"]})
        });
        let observed = limit.get("observedAt").cloned().unwrap_or(Value::Null);
        let until = limit.get("until").cloned().unwrap_or(Value::Null);
        let fact = json!({
            "id": digest(&json!({
                "scope": limit_scope, "source": if limit["manual"] == true {"configuration"} else {"execution"},
                "observedAt": observed, "validUntil": until, "reason": "quota_failure",
                "value": {"name": "limit", "usedPct": 100, "resetsAt": until, "lengthS": 86_400, "paced": false},
            }))[..24],
            "scope": limit_scope,
            "source": if limit["manual"] == true {"configuration"} else {"execution"},
            "observedAt": observed,
            "validUntil": until,
            "reason": "quota_failure",
            "value": {"name": "limit", "usedPct": 100, "resetsAt": until, "lengthS": 86_400, "paced": false},
        });
        incoming["facts"]["budget"].as_array_mut()?.push(fact);
    }
    let evidence = reconcile_evidence(&snapshot["evidence"], &incoming, ctx.now, Some(&budget_policy));
    let decision = pacer_engine::evaluate_eligibility(&json!({
        "now": ctx.now,
        "scope": json!({
            "account": scope["account"], "identity": scope["identity"],
            "runner": text(runner, "id").unwrap_or(id),
            "model": text(runner, "model").unwrap_or("default"),
            "host": text(runner, "host").unwrap_or("local"),
        }),
        "usage": account.get("usage").cloned().unwrap_or(Value::Null),
        "allowPaid": account.get("allowPaid").cloned().unwrap_or(Value::Null),
        "evidence": evidence,
        "restrictions": [],
    }));
    let exhausted = decision["reasons"].as_array().is_some_and(|reasons| {
        reasons.iter().any(|reason| reason["code"] == "budget_exhausted")
    });
    if !exhausted {
        return None;
    }
    let cap = ctx.now + 7.0 * 24.0 * 3600.0;
    let mut latest: Option<f64> = None;
    for fact in evidence["facts"]["budget"].as_array().into_iter().flatten() {
        let used = fact["value"]["usedPct"].as_f64();
        let resets = fact["value"]["resetsAt"].as_f64();
        if used.is_none_or(|p| p < 100.0) || resets.is_none_or(|t| t <= ctx.now) {
            continue;
        }
        let capped = resets?.min(cap);
        latest = Some(latest.map_or(capped, |value| value.max(capped)));
    }
    let until = latest.or_else(|| decision["validUntil"].as_f64());
    Some(("exhausted".into(), until))
}

/// `parseRunnerId` from `src/config/runner-id.ts`.
#[derive(Debug)]
struct RunnerId {
    agent: String,
    account: Option<String>,
    host: Option<String>,
}

fn parse_runner_id(id: &str) -> Option<RunnerId> {
    let mut parts = id.split('#');
    let agent = parts.next()?;
    if !is_runner_word(agent) || !is_agent(agent) {
        return None;
    }
    let rest = parts.next();
    let (account, host) = match rest {
        Some(value) => {
            let mut split = value.split('@');
            let account = Some(split.next()?.to_owned());
            let host = split.next().map(str::to_owned);
            if account.as_deref().is_some_and(|a| !is_runner_word(a))
                || host.as_deref().is_some_and(|h| !is_runner_word(h))
                || split.next().is_some()
            {
                return None;
            }
            (account, host.filter(|h| h != "local"))
        }
        None => {
            let mut split = agent.split('@');
            let agent = split.next()?;
            if !is_agent(agent) {
                return None;
            }
            let host = split.next().map(str::to_owned);
            if host.as_deref().is_some_and(|h| !is_runner_word(h)) || split.next().is_some() {
                return None;
            }
            return Some(RunnerId {
                agent: agent.to_owned(),
                account: None,
                host: host.filter(|h| h != "local"),
            });
        }
    };
    Some(RunnerId { agent: agent.to_owned(), account, host })
}

fn is_runner_word(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && value.as_bytes()[0].is_ascii_lowercase() || value.as_bytes()[0].is_ascii_digit()
}

fn is_agent(value: &str) -> bool {
    matches!(value, "claude-code" | "codex" | "cursor" | "opencode" | "agy" | "gemini")
}

/// `resolveRunner` from `src/config/runner-id.ts`, restricted to configured ids
/// and exact canonical aliases; strategy files already spell runners out.
fn resolve_runner<'a>(strategy: &'a Value, id: &str) -> Option<&'a Value> {
    if let Some(runner) = strategy["runners"].get(id) {
        return Some(runner);
    }
    if let Some(alias) = text(&strategy["runnerAliases"], id) {
        if let Some(runner) = strategy["runners"].get(alias) {
            return Some(runner);
        }
    }
    let parsed = parse_runner_id(id).or_else(|| {
        (strategy["accounts"].get(id).and_then(|a| text(a, "kind")) == Some("endpoint"))
            .then(|| RunnerId { agent: "opencode".into(), account: Some(id.into()), host: None })
    })?;
    let defaults = runner_defaults(strategy);
    let formatted = format!(
        "{}{}{}",
        parsed.agent,
        parsed
            .account
            .filter(|account| defaults.get(&parsed.agent).map(String::as_str) != Some(account.as_str()))
            .map(|account| format!("#{account}"))
            .unwrap_or_default(),
        parsed.host.filter(|host| host != "local").map(|host| format!("@{host}")).unwrap_or_default()
    );
    strategy["runners"].get(formatted)
}

fn runner_defaults(strategy: &Value) -> HashMap<String, String> {
    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    if let Some(accounts) = strategy["accounts"].as_object() {
        for account in accounts.values() {
            let (Some(name), Some(kind)) = (text(account, "name"), text(account, "kind")) else {
                continue;
            };
            if account.get("home").is_some_and(|v| !v.is_null())
                || account.get("orcaAccount").is_some_and(|v| !v.is_null())
            {
                continue;
            }
            if allowed_pair(kind, name) {
                *counts.entry((kind.to_owned(), name.to_owned())).or_default() += 1;
            }
        }
    }
    let mut out = HashMap::new();
    for ((kind, name), count) in counts {
        if count == 1 && kind != "opencode" {
            out.insert(kind, name);
        }
    }
    out
}

fn allowed_pair(agent: &str, kind: &str) -> bool {
    matches!((agent, kind), ("claude-code", "claude") | ("codex", "codex") | ("cursor", "cursor") | ("opencode", "opencode"))
}

/// `classifierConfig(strategy).configured` with the TS validation's throw
/// turned into `false` (the bridge's `try/catch`).
fn classifier_configured(strategy: &Value) -> bool {
    let raw = match strategy.get("classifier") {
        Some(Value::Object(map)) => map.clone(),
        _ => return false,
    };
    let allowed_keys = ["default", "decisions", "shadow", "shadow_external", "timeout_ms",
        "log_state", "tiers", "adapters", "bench"];
    if raw.keys().any(|key| !allowed_keys.contains(&key.as_str())) {
        return false;
    }
    let adapter = |value: Option<&Value>| -> bool {
        value.is_none() || value.and_then(Value::as_str).is_some_and(|v| matches!(v, "rules" | "ollama" | "jev" | "shadow"))
    };
    if !adapter(raw.get("default")) {
        return false;
    }
    if let Some(decisions) = raw.get("decisions") {
        let Value::Object(decisions) = decisions else { return false; };
        for (name, decision) in decisions {
            if !matches!(name.as_str(), "task_kind" | "difficulty" | "guard" | "result_check") {
                return false;
            }
            let Value::Object(decision) = decision else { return false; };
            if decision.keys().any(|key| !["use", "min_confidence", "verify_kind", "max_for_cheap"].contains(&key.as_str())) {
                return false;
            }
            if !adapter(decision.get("use")) || !unit(decision.get("min_confidence"))
                || !unit(decision.get("max_for_cheap"))
                || decision.get("verify_kind").is_some_and(|v| !v.is_boolean())
            {
                return false;
            }
        }
    }
    if let Some(shadow) = raw.get("shadow") {
        let Value::Array(values) = shadow else { return false; };
        if !values.iter().all(|value| value.as_str().is_some_and(|v| matches!(v, "rules" | "ollama" | "jev"))) {
            return false;
        }
    }
    if raw.get("shadow_external").is_some_and(|v| !v.is_boolean())
        || !positive(raw.get("timeout_ms"))
        || raw.get("log_state").is_some_and(|v| {
            !matches!(v.as_str(), Some("full" | "trimmed" | "none"))
        })
    {
        return false;
    }
    if let Some(tiers) = raw.get("tiers") {
        let Value::Object(tiers) = tiers else { return false; };
        for (id, tier) in tiers {
            if strategy["providers"].get(id).is_none() || !matches!(tier.as_str(), Some("cheap" | "capable")) {
                return false;
            }
        }
    }
    if let Some(adapters) = raw.get("adapters") {
        let Value::Object(adapters) = adapters else { return false; };
        if adapters.keys().any(|key| key != "ollama" && key != "jev") {
            return false;
        }
    }
    if let Some(bench) = raw.get("bench") {
        let Value::Object(bench) = bench else { return false; };
        if bench.keys().any(|key| key != "redact" && key != "timeout_ms")
            || bench.get("redact").is_some_and(|v| !v.is_boolean())
            || !positive(bench.get("timeout_ms"))
        {
            return false;
        }
    }
    !raw.is_empty()
}

fn unit(value: Option<&Value>) -> bool {
    value.is_none() || value.and_then(Value::as_f64).is_some_and(|n| (0.0..=1.0).contains(&n))
}

fn positive(value: Option<&Value>) -> bool {
    value.is_none() || value.and_then(Value::as_f64).is_some_and(|n| n > 0.0)
}

// ---------------------------------------------------------------------------
// local evidence helpers for `executorGuard`
// ---------------------------------------------------------------------------

fn read_json_obj(path: &Path) -> Object {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => Object::new(),
    }
}

/// `limitObservation` from `src/usage/reactive.ts`.
fn limit_observation(ctx: &Ctx, key: &str, until: f64) -> Option<Value> {
    let evidence = read_json_obj(&ctx.pacer_home.join("state/exhausted-evidence.json"));
    let stored = evidence.get(key)?;
    if stored["until"].as_f64() != Some(until) {
        return Some(json!({"observedAt": null, "until": until, "manual": false}));
    }
    Some(stored.clone())
}

/// `accountEvidenceScope` from `src/evidence/scope.ts`.
fn account_evidence_scope(account: &Value, hosts: &Value) -> Value {
    let mut identity = vec![
        account.get("name").cloned().unwrap_or(Value::Null),
        account.get("kind").cloned().unwrap_or(Value::Null),
        account.get("source").cloned().unwrap_or(Value::Null),
        account.get("home").cloned().unwrap_or(Value::Null),
        account.get("orcaAccount").cloned().unwrap_or(Value::Null),
        account.get("usageSource").cloned().unwrap_or(Value::Null),
        account.get("quotaSource").cloned().unwrap_or(Value::Null),
        account["connection"].get("base_url").cloned().unwrap_or(Value::Null),
        account["connection"].get("key").cloned().unwrap_or(Value::Null),
    ];
    let mut rows: Vec<(String, &Value)> = hosts.as_object().into_iter().flatten()
        .map(|(alias, host)| (alias.clone(), host))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    identity.push(json!(rows.iter().map(|(alias, host)| json!([
        alias, host.get("ssh").cloned().unwrap_or(Value::Null),
        host["accounts"].get(account["name"].as_str().unwrap_or_default())
            .and_then(|a| a.get("home")).cloned().unwrap_or(Value::Null),
    ])).collect::<Vec<_>>()));
    if let Some(provider) = account.get("provider") {
        identity.push(provider.clone());
    }
    json!({"account": account.get("name").cloned().unwrap_or(Value::Null), "identity": digest(&Value::Array(identity))})
}

fn empty_evidence() -> Value {
    json!({"facts": {"availability": [], "budget": [], "spending": []}, "conflicts": []})
}

/// `readEvidence` from `src/core/evidence.ts` with the same validity checks.
fn read_evidence(ctx: &Ctx, scope: &Value) -> Value {
    let empty = json!({
        "version": 1, "revision": 0, "identity": scope["identity"], "evidence": empty_evidence()
    });
    let identity = scope["identity"].as_str().unwrap_or_default();
    if !identity.bytes().all(|b| b.is_ascii_hexdigit() && (b.is_ascii_digit() || b < b'g')) || identity.len() != 64 {
        return empty;
    }
    let Ok(bytes) = std::fs::read(ctx.pacer_home.join("state/evidence").join(format!("{identity}.json"))) else {
        return empty;
    };
    let Ok(saved) = serde_json::from_slice::<Value>(&bytes) else { return empty; };
    if saved["version"] != 1 || saved["identity"] != scope["identity"]
        || !saved["revision"].as_u64().is_some_and(|n| n <= i64::MAX as u64)
        || !saved["evidence"].is_object() || !saved["evidence"]["conflicts"].is_array()
    {
        return empty;
    }
    let facts = &saved["evidence"]["facts"];
    for kind in ["availability", "budget", "spending"] {
        let Some(rows) = facts[kind].as_array() else { return empty; };
        for fact in rows {
            if !fact["id"].is_string() || fact["scope"]["identity"] != scope["identity"]
                || fact["scope"]["account"] != scope["account"] || !fact["source"].is_string()
                || !fact["reason"].is_string()
                || fact["observedAt"].is_null() && !fact["observedAt"].is_number()
                || !fact["validUntil"].is_null() && !fact["validUntil"].is_number()
            {
                return empty;
            }
        }
    }
    saved["evidence"].clone()
}

/// `reconcileEvidence` from `src/engine/evidence.ts`: group by scope/kind,
/// keep only current observations at the newest timestamp, prefer the highest
/// source precedence and drop expired cooldown marks.
fn reconcile_evidence(
    previous: &Value,
    incoming: &Value,
    now: f64,
    budget_policy: Option<&str>,
) -> Value {
    let mut facts = empty_evidence();
    let mut conflicts = Vec::new();
    let precedence = |source: &str| if source == "configuration" { 3 } else if source == "provider-cli" { 2 } else { 1 };
    for kind in ["availability", "budget", "spending"] {
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        for fact in previous["facts"][kind].as_array().into_iter().flatten()
            .chain(incoming["facts"][kind].as_array().into_iter().flatten())
        {
            let key = js_stringify(&json!([
                fact["scope"]["account"], fact["scope"]["identity"], fact["scope"]["runner"],
                fact["scope"]["model"], fact["scope"]["host"],
                if kind == "budget" { json!([fact["value"]["name"], fact.get("budgetPolicy").cloned()]) }
                else { json!(kind) },
            ]));
            if let Some((_, values)) = groups.iter_mut().find(|(k, _)| *k == key) {
                values.push(fact.clone());
            } else {
                groups.push((key, vec![fact.clone()]));
            }
        }
        for (_, values) in groups {
            let observed = |fact: &Value| -> f64 {
                if is_current(fact, now, None) { fact["observedAt"].as_f64().unwrap_or(f64::NEG_INFINITY) }
                else { f64::NEG_INFINITY }
            };
            let newest = values.iter().map(observed).fold(f64::NEG_INFINITY, f64::max);
            let contemporary: Vec<&Value> = values.iter().filter(|fact| observed(fact) == newest).collect();
            let top = contemporary.iter().map(|fact| precedence(text(fact, "source").unwrap_or(""))).max().unwrap_or(0);
            let mut unique: Vec<Value> = Vec::new();
            for fact in contemporary {
                if precedence(text(fact, "source").unwrap_or("")) != top {
                    continue;
                }
                let value = js_stringify(&json!([fact["value"], fact["validUntil"]]));
                if unique.iter().any(|seen| js_stringify(&json!([seen["value"], seen["validUntil"]])) == value) {
                    conflicts.push(fact["id"].clone());
                } else {
                    unique.push(fact.clone());
                }
            }
            facts["facts"][kind].as_array_mut().map(|rows| rows.extend(unique));
        }
    }
    let measured: Vec<Value> = facts["facts"]["budget"].as_array().into_iter().flatten()
        .filter(|fact| {
            let source = text(fact, "source").unwrap_or("");
            source != "execution" && source != "configuration" && fact["value"]["name"] != "limit"
                && (source != "metered" || budget_policy.is_none()
                    || fact["budgetPolicy"].as_str() == budget_policy)
        })
        .cloned()
        .collect();
    if !measured.is_empty()
        && measured.iter().all(|fact| {
            is_current(fact, now, deadline(fact))
                && fact["value"]["usedPct"].as_f64().is_some_and(|p| p < 100.0)
        })
    {
        if let Some(rows) = facts["facts"]["budget"].as_array_mut() {
            rows.retain(|fact| {
                let source = text(fact, "source").unwrap_or("");
                if source != "execution" && source != "configuration" || fact["value"]["name"] != "limit" {
                    return true;
                }
                !measured.iter().all(|sample| {
                    sample["observedAt"].as_f64().is_some_and(|at| at > fact["observedAt"].as_f64().unwrap_or(f64::INFINITY))
                        && sample["scope"]["account"] == fact["scope"]["account"]
                        && sample["scope"]["identity"] == fact["scope"]["identity"]
                })
            });
        }
    }
    if let Some(rows) = facts["facts"]["budget"].as_array_mut() {
        rows.retain(|fact| {
            let source = text(fact, "source").unwrap_or("");
            if (source != "execution" && source != "configuration") || fact["value"]["name"] != "limit" {
                return true;
            }
            let until = fact["validUntil"].as_f64().or_else(|| fact["value"]["resetsAt"].as_f64());
            is_current(fact, now, None) && until.is_some_and(|t| t > now)
        });
    }
    facts["conflicts"] = json!(conflicts);
    facts
}

fn is_current(fact: &Value, now: f64, deadline: Option<f64>) -> bool {
    let Some(observed) = fact["observedAt"].as_f64() else { return false; };
    if !observed.is_finite() || observed < 0.0 || observed > now {
        return false;
    }
    match deadline.or_else(|| fact["validUntil"].as_f64()) {
        None => true,
        Some(valid) => valid > now,
    }
}

fn deadline(fact: &Value) -> Option<f64> {
    let source = text(fact, "source").unwrap_or("");
    if source == "configuration" || (source == "execution" && fact["value"]["name"] == "limit") {
        return fact["validUntil"].as_f64().or_else(|| fact["value"]["resetsAt"].as_f64());
    }
    let observed = fact["observedAt"].as_f64()?;
    let length = fact["value"]["lengthS"].as_f64().unwrap_or(0.0);
    let age = if length <= 3600.0 { 900.0 } else { 21_600.0 };
    Some([Some(observed + age), fact["validUntil"].as_f64(), fact["value"]["resetsAt"].as_f64()]
        .into_iter().flatten().fold(f64::INFINITY, f64::min))
}

// ---------------------------------------------------------------------------
// dispatch.enforcement-exclusions
// ---------------------------------------------------------------------------

/// `enforcementExclusion` / `enforcementExclusionCached` for each runner.
pub async fn enforcement_exclusions(
    ctx: &Ctx,
    strategy: &Value,
    runners: &[String],
    repo: &str,
    cached: bool,
    cache: &VersionCache,
) -> Value {
    let mut rows = Vec::new();
    for runner in runners {
        if cached {
            let (reason, unverified) = enforcement_exclusion_cached(ctx, strategy, runner, repo, cache).await;
            rows.push(json!({"runner": runner, "reason": reason, "unverified": unverified}));
        } else {
            let reason = enforcement_exclusion(ctx, strategy, runner, repo, cache).await;
            rows.push(json!({"runner": runner, "reason": reason, "unverified": null}));
        }
    }
    Value::Array(rows)
}

async fn enforcement_exclusion(
    ctx: &Ctx,
    strategy: &Value,
    runner: &str,
    repo: &str,
    cache: &VersionCache,
) -> Option<String> {
    match resolve_enforcement_target(ctx, strategy, runner, repo, cache, false).await {
        Err(error) => Some(error),
        Ok(target) => {
            if let Some(reason) = probe_support_reason(&target, repo) {
                return Some(reason);
            }
            let cert = certificate_status(ctx, &target);
            if cert["state"] == "certified" { None } else { text(&cert, "reason").map(str::to_owned) }
        }
    }
}

async fn enforcement_exclusion_cached(
    ctx: &Ctx,
    strategy: &Value,
    runner: &str,
    repo: &str,
    cache: &VersionCache,
) -> (Option<String>, Option<String>) {
    match resolve_enforcement_target(ctx, strategy, runner, repo, cache, true).await {
        Err(error) => {
            if let Some(agent) = error.strip_suffix(" version has not been checked in this process") {
                (None, Some(agent.to_owned()))
            } else {
                (Some(error), None)
            }
        }
        Ok(target) => {
            if let Some(reason) = probe_support_reason(&target, repo) {
                return (Some(reason), None);
            }
            let cert = certificate_status(ctx, &target);
            if cert["state"] == "certified" { (None, None) }
            else { (text(&cert, "reason").map(str::to_owned), None) }
        }
    }
}

// ---------------------------------------------------------------------------
// dispatch.enforcement-diagnostics
// ---------------------------------------------------------------------------

/// `enforcementDiagnosticsParts` (`src/dispatch/enforcement.ts:300-321`).
pub async fn enforcement_diagnostics(
    ctx: &Ctx,
    strategy: &Value,
    repo: &str,
    cache: &VersionCache,
) -> Value {
    let scheduled = scheduled_repo(ctx);
    let mut rows = Vec::new();
    for (id, _) in strategy["runners"].as_object().into_iter().flatten() {
        let target = match resolve_enforcement_target(ctx, strategy, id, repo, cache, false).await {
            Ok(target) => target,
            Err(error) => {
                rows.push(json!({"runner": id, "error": error}));
                continue;
            }
        };
        let unsupported = probe_support_reason(&target, repo);
        let cert = certificate_status(ctx, &target);
        let mut scheduled_cert = Value::Null;
        let mut scheduled_unsupported = Value::Null;
        if let Some((path, _)) = &scheduled {
            if path != repo {
                let there = EnforcementTarget {
                    control_files: control_files_for(ctx, strategy, id, path),
                    ..target.clone()
                };
                scheduled_unsupported = probe_support_reason(&there, path)
                    .map(Value::from).unwrap_or(Value::Null);
                scheduled_cert = certificate_status(ctx, &there);
            }
        }
        rows.push(json!({
            "runner": id,
            "version": target.version,
            "unsupportedReason": unsupported,
            "cert": cert,
            "scheduledCert": scheduled_cert,
            "scheduledUnsupported": scheduled_unsupported,
            "key": target_key(&target),
        }));
    }
    json!({
        "scheduled": scheduled.map(|(path, label)| json!({"path": path, "label": label})).unwrap_or(Value::Null),
        "runners": rows,
    })
}

/// `scheduledRepo` in `src/dispatch/certification-schedule.ts:317-329`.
fn scheduled_repo(ctx: &Ctx) -> Option<(String, String)> {
    let registry = read_json_obj(&ctx.pacer_home.join("state/repos.json"));
    if registry.is_empty() {
        return None;
    }
    let updated_at = |task: &Value| -> f64 {
        let attempts = task["attempts"].as_array().into_iter().flatten();
        let last = attempts.last();
        [
            task["createdAt"].as_f64().unwrap_or(0.0),
            last.and_then(|a| a["startedAt"].as_f64()).unwrap_or(0.0),
            last.and_then(|a| a["endedAt"].as_f64()).unwrap_or(0.0),
            task["attemptStartedAt"].as_f64().unwrap_or(0.0),
        ].into_iter().fold(0.0, f64::max)
    };
    // Read-only: a parts call must never checkpoint or grow the task database.
    let store = ReadOnlyStore::open(&ctx.pacer_home, false).ok();
    let mut tasks: Vec<Value> = store
        .as_ref()
        .and_then(|store| {
            store.query(
                "SELECT record FROM tasks WHERE archived=0 AND (updated_at>=? OR state IN ('queued','running') OR (state='needs_input' AND json_type(record, '$.question.answer') IS NULL AND json_extract(record, '$.retriedBy') IS NULL AND NOT COALESCE(json_extract(record, '$.dismissed'),0))) ORDER BY id DESC",
                [ctx.now - 86_400.0],
                |row| row.get::<_, String>(0),
            ).ok()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|record| serde_json::from_str::<Value>(&record).ok())
        .filter(|task| {
            matches!(task["state"].as_str(), Some("queued" | "running"))
                || task["dismissed"] != true && updated_at(task) >= ctx.now - 86_400.0
        })
        .collect();
    tasks.sort_by(|a, b| updated_at(b).partial_cmp(&updated_at(a)).unwrap_or(std::cmp::Ordering::Equal));
    if let Some(first) = tasks.first() {
        let path = first["repo"].get("path").and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                repo_for(&ctx.pacer_home, text(&first["brief"], "repo").unwrap_or_default())["path"]
                    .as_str().unwrap_or_default().to_owned()
            });
        let label = registry.values().find(|entry| entry["path"].as_str() == Some(path.as_str()))
            .and_then(|entry| text(entry, "key"))
            .unwrap_or("");
        return Some((path, label.to_owned()));
    }
    let first = registry.values().next()?;
    Some((text(first, "path")?.to_owned(), text(first, "key").unwrap_or_default().to_owned()))
}

// ---------------------------------------------------------------------------
// enforcement target, version probe and certificates
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct EnforcementTarget {
    runner: String,
    account: String,
    agent: String,
    version: String,
    binary: String,
    control_files: Vec<String>,
    launch_mode: String,
    launch_args: Vec<String>,
    guard_argv: Vec<String>,
}

/// `localTarget` in `src/dispatch/enforcement.ts:61-75`.
fn local_target(ctx: &Ctx, strategy: &Value, runner_id: &str, repo: &str) -> Result<EnforcementTarget, String> {
    let runner = strategy["runners"].get(runner_id);
    let cfg = strategy["providers"].get(runner_id);
    let (Some(runner), Some(cfg)) = (runner, cfg) else {
        return Err("Strict native control requires a local executor".into());
    };
    if !cfg.get("host").is_none_or(Value::is_null) || runner.get("host").is_some_and(|h| !h.is_null()) {
        return Err("Strict native control requires a local executor".into());
    }
    let agent = text(runner, "agent").unwrap_or_default();
    let command = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor-agent",
        "opencode" => "opencode",
        _ => return Err(format!("No native control adapter for {agent}")),
    };
    let Some(binary) = which(ctx, command) else {
        return Err(format!("Executor {agent} is not installed"));
    };
    let account = text(runner, "account").unwrap_or_default();
    if strategy["accounts"].get(account).is_none() {
        return Err("Executor account is unavailable".into());
    }
    let launch_mode = cfg.get("session").and_then(Value::as_str)
        .or_else(|| strategy["execution"].get("launch_mode").and_then(Value::as_str))
        .unwrap_or("interactive")
        .to_owned();
    let parsed_agent = parse_runner_id(runner_id).map(|id| id.agent).unwrap_or_else(|| runner_id.to_owned());
    let launch_cfg = json!({"id": runner_id, "agent": parsed_agent,
        "via": cfg.get("via").cloned().unwrap_or(Value::Null),
        "session": launch_mode, "model": cfg.get("model").cloned().unwrap_or(Value::Null)});
    let launch_args = launch_argv(ctx, &launch_cfg, &launch_mode, "__prompt__", "__repo__", "__run__", "__task__")?;
    Ok(EnforcementTarget {
        runner: runner_id.to_owned(),
        account: account.to_owned(),
        agent: agent.to_owned(),
        version: String::new(),
        binary,
        control_files: control_files_for(ctx, strategy, runner_id, repo),
        launch_mode,
        launch_args,
        guard_argv: pacer_argv(ctx),
    })
}

/// `resolveEnforcementTarget` (`src/dispatch/enforcement.ts:76-89`).
async fn resolve_enforcement_target(
    ctx: &Ctx,
    strategy: &Value,
    runner: &str,
    repo: &str,
    cache: &VersionCache,
    cached_version_only: bool,
) -> Result<EnforcementTarget, String> {
    let mut target = local_target(ctx, strategy, runner, repo)?;
    if cached_version_only {
        match cache.get(&version_key(&target.binary)) {
            Some(version) => target.version = version,
            None => return Err(format!("{} version has not been checked in this process", target.agent)),
        }
        return Ok(target);
    }
    let output = run_version(&target.binary).await;
    let version = regex_version(&output.0);
    if output.1 != 0 || version.is_none() {
        return Err(format!("Could not verify {} version", target.agent));
    }
    target.version = version.ok_or_else(|| format!("Could not verify {} version", target.agent))?;
    cache.insert(version_key(&target.binary), target.version.clone());
    Ok(target)
}

/// `[binary, "--version"]` with the TypeScript 5 s deadline, argv only (SEC-5/RUST-3).
async fn run_version(binary: &str) -> (String, i32) {
    let run = async {
        tokio::process::Command::new(binary)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output()
            .await
    };
    match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(output)) => (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            output.status.code().unwrap_or(1),
        ),
        _ => (String::new(), 1),
    }
}

/// `\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9]+)?` on the first matching line.
fn regex_version(stdout: &str) -> Option<String> {
    let bytes = stdout.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() || start > 0 && bytes[start - 1].is_ascii_digit() {
            continue;
        }
        let mut end = start;
        let mut groups = 0;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        while end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() && groups < 3 {
            groups += 1;
            end += 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
        if groups == 0 {
            continue;
        }
        if end < bytes.len() && bytes[end] == b'-' {
            let suffix = end + 1;
            let mut tail = suffix;
            while tail < bytes.len() && bytes[tail].is_ascii_alphanumeric() {
                tail += 1;
            }
            if tail > suffix {
                end = tail;
            }
        }
        return Some(stdout[start..end].to_owned());
    }
    None
}

/// `versionKey` in `src/dispatch/enforcement.ts:58`.
fn version_key(binary: &str) -> String {
    match std::fs::metadata(binary).and_then(|m| m.modified()) {
        Ok(modified) => format!("{}:{}", binary, modified.duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0)),
        Err(_) => binary.to_owned(),
    }
}

/// `Bun.which`: the first executable file on `PATH`.
fn which(ctx: &Ctx, name: &str) -> Option<String> {
    let path = ctx.env.get("PATH")?;
    for dir in path.split(':') {
        let candidate = if dir.is_empty() { PathBuf::from(name) } else { Path::new(dir).join(name) };
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
                #[cfg(not(unix))]
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// `pacerArgv` in `src/install/self.ts`: the stable binary when the service set
/// `PACER_BIN`, otherwise this process's own executable.
fn pacer_argv(ctx: &Ctx) -> Vec<String> {
    match ctx.env.get("PACER_BIN").filter(|v| !v.is_empty()) {
        Some(bin) => vec![bin.clone()],
        None => vec![std::env::current_exe()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()],
    }
}

/// `controlFilesFor` (`src/dispatch/enforcement.ts:91-98`).
fn control_files_for(ctx: &Ctx, strategy: &Value, runner_id: &str, repo: &str) -> Vec<String> {
    let runner = &strategy["runners"][runner_id];
    let agent = text(runner, "agent").unwrap_or_default();
    let account = strategy["accounts"].get(text(runner, "account").unwrap_or_default());
    let folder = account
        .and_then(|a| text(a, "home"))
        .map(|home| expand_home(ctx, home))
        .unwrap_or_else(|| {
            let folder = if agent == "claude-code" { ".claude".to_owned() } else { format!(".{agent}") };
            ctx.home.join(folder).to_string_lossy().into_owned()
        });
    match agent {
        "claude-code" => [folder + "/settings.json", format!("{repo}/.claude/settings.json"),
            format!("{repo}/.claude/settings.local.json")].to_vec(),
        "codex" => [folder + "/hooks.json", format!("{repo}/.codex/hooks.json")].to_vec(),
        "cursor" => [folder + "/hooks.json", format!("{repo}/.cursor/hooks.json")].to_vec(),
        _ => {
            let config = ctx.env.get("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| ctx.home.join(".config"))
                .join("opencode");
            let path = if config.join("opencode.jsonc").exists() { config.join("opencode.jsonc") }
                else { config.join("opencode.json") };
            [path.to_string_lossy().into_owned(), format!("{repo}/opencode.json"),
                format!("{repo}/opencode.jsonc")].to_vec()
        }
    }
}

fn expand_home(ctx: &Ctx, path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        ctx.home.join(rest).to_string_lossy().into_owned()
    } else {
        path.to_owned()
    }
}

/// `launchFor` in `src/exec/launch.ts`, with the fixed placeholder arguments
/// `resolveEnforcementTarget` passes. Headless is the strict-control path.
fn launch_argv(
    _ctx: &Ctx,
    cfg: &Value,
    mode: &str,
    prompt: &str,
    repo: &str,
    task_dir: &str,
    task_id: &str,
) -> Result<Vec<String>, String> {
    let agent = text(cfg, "agent").unwrap_or_default();
    let model = text(cfg, "model").unwrap_or_default();
    if mode == "interactive" {
        let models = if model.is_empty() { Vec::new() }
            else if matches!(agent, "codex" | "opencode") { vec!["-m".into(), model.into()] }
            else { vec!["--model".into(), model.into()] };
        if cfg["via"].as_str() == Some("opencode") {
            return Ok(json!(["opencode", "--standalone", "--auto", "--prompt", prompt])
                .as_array().unwrap().iter().map(|v| v.as_str().unwrap_or_default().to_owned()).collect());
        }
        return match agent {
            "codex" => {
                let trust = format!("projects={{{}={{trust_level=\"trusted\"}}}}", js_stringify(&json!(repo)));
                Ok(["codex", "--no-daemon", "-c", &trust, "-C", repo,
                    "--dangerously-bypass-approvals-and-sandbox", "--add-dir", task_dir]
                    .into_iter().map(str::to_owned).chain(models).chain(["--".into(), prompt.into()]).collect())
            }
            "claude-code" => Ok(["claude", "--dangerously-skip-permissions".into()]
                .into_iter().map(str::to_owned).chain(models).chain(["--".into(), prompt.into()]).collect()),
            "cursor" => Ok(["cursor-agent", "--force", "--trust", "--sandbox", "disabled", "--workspace", repo]
                .into_iter().map(str::to_owned).chain(models).chain(["--".into(), prompt.into()]).collect()),
            _ => Err(format!("no interactive launcher for provider \"{}\"", text(cfg, "id").unwrap_or_default())),
        };
    }
    if cfg["via"].as_str() == Some("opencode") {
        return Ok(["opencode", "run", "--standalone", "--agent", "build", "-m", model, "--auto",
            "--title", &format!("pacer {task_id}"), prompt].into_iter().map(str::to_owned).collect());
    }
    match agent {
        "codex" => {
            let last = format!("{task_dir}/{task_id}.codex-last.md");
            let mut argv: Vec<String> = ["codex", "exec", "-C", repo, "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check", "-o", &last].into_iter().map(str::to_owned).collect();
            if !model.is_empty() {
                argv.extend(["-m".into(), model.into()]);
            }
            argv.push("-".into());
            Ok(argv)
        }
        "cursor" => {
            let mut argv: Vec<String> = ["cursor-agent", "-p", "--output-format", "text", "--force", "--trust",
                "--sandbox", "disabled", "--workspace", repo].into_iter().map(str::to_owned).collect();
            if !model.is_empty() {
                argv.extend(["--model".into(), model.into()]);
            }
            argv.push(prompt.into());
            Ok(argv)
        }
        "claude-code" => {
            let mut argv: Vec<String> = ["claude", "-p", "--dangerously-skip-permissions",
                "--output-format", "stream-json", "--verbose"].into_iter().map(str::to_owned).collect();
            if !model.is_empty() {
                argv.extend(["--model".into(), model.into()]);
            }
            argv.push(prompt.into());
            Ok(argv)
        }
        _ => Err(format!("no launcher for provider \"{}\"", text(cfg, "id").unwrap_or_default())),
    }
}

/// `probeSupportReason` (`src/dispatch/enforcement.ts:154-161`).
fn probe_support_reason(target: &EnforcementTarget, repo: &str) -> Option<String> {
    if target.launch_mode == "interactive" {
        return Some(STRICT_INTERACTIVE_REASON.into());
    }
    match target.agent.as_str() {
        "codex" => return Some("Native subagent control: Codex tool-result observation is not implemented for this CLI version".into()),
        "cursor" => return Some("Cursor has not proven that subagentStart denial prevents child startup".into()),
        "opencode" => return Some("OpenCode permission denial needs a host-observed native canary".into()),
        _ => {}
    }
    if target.control_files.iter().any(|file| file.starts_with(&format!("{repo}/")) && Path::new(file).exists()) {
        return Some("Project-level native control overrides need an exact-environment canary".into());
    }
    None
}

/// `enforcementFingerprint` (`src/dispatch/enforcement.ts:105-109`).
fn enforcement_fingerprint(target: &EnforcementTarget) -> String {
    let guard_files: Vec<Value> = target.guard_argv.iter()
        .filter(|path| Path::new(path).exists())
        .map(|path| file_identity(path))
        .collect();
    let value = json!([
        package_version(),
        "native-control-v3",
        target.agent,
        target.version,
        target.launch_args,
        target.guard_argv,
        guard_files,
        STRICT_LAUNCH_DIGEST,
        file_identity(&target.binary),
        target.control_files.iter().map(|path| file_identity(path)).collect::<Vec<_>>(),
    ]);
    digest(&value)
}

/// `key` in `src/dispatch/enforcement.ts:100`.
fn target_key(target: &EnforcementTarget) -> String {
    js_stringify(&json!([target.runner, target.account, target.launch_mode]))
}

/// `fileIdentity` in `src/dispatch/enforcement.ts:101-104`.
fn file_identity(path: &str) -> Value {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let modified = meta.modified().ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0.0, |d| d.as_secs_f64() * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0);
                json!([real.to_string_lossy(), meta.dev(), meta.ino(), meta.len(), modified])
            }
            #[cfg(not(unix))]
            {
                let modified = meta.modified().ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                json!([real.to_string_lossy(), 0, 0, meta.len(), modified])
            }
        }
        Err(_) => json!([path, "missing"]),
    }
}

/// `certificateStatus` (`src/dispatch/enforcement.ts:135-143`) as a JSON object
/// with the same keys. A missing row is `uncertified`, matching TypeScript.
fn certificate_status(ctx: &Ctx, target: &EnforcementTarget) -> Value {
    let uncertified = || json!({"state": "uncertified", "reason": "Native subagent control has not been verified"});
    // The read-only view cannot checkpoint the WAL (explain writes nothing).
    let rows = ReadOnlyStore::open(&ctx.pacer_home, false)
        .ok()
        .and_then(|store| {
            store.query(
                "SELECT fingerprint,probed_at,expires FROM enforcement_certificates WHERE target=?",
                [target_key(target)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
            ).ok()
        })
        .unwrap_or_default();
    let Some((fingerprint, probed_at, expires)) = rows.into_iter().next() else { return uncertified(); };
    if expires <= ctx.now {
        return json!({"state": "stale", "reason": "Native subagent control verification expired",
            "probedAt": probed_at, "expiresAt": expires});
    }
    if fingerprint != enforcement_fingerprint(target) {
        return json!({"state": "stale", "reason": "Executor or native control configuration changed",
            "probedAt": probed_at, "expiresAt": expires});
    }
    json!({"state": "certified", "probedAt": probed_at, "expiresAt": expires})
}
