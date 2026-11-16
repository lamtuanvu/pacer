//! Native `runner.list`, `runner.block`, `runner.unblock` and `runner.add`
//! (`src/core/runners.ts`, `src/executors/blocked.ts`, `src/exec/broken.ts`,
//! `src/core/runners-config.ts`).
//!
//! `runner.list` composes rows from `blocked.json`, `broken.json` and the live
//! provider eligibility the usage-broker bridge supplies. `runner.add` is
//! native when it starts no scratch check job (`test: false`); the check job
//! (`runner.check`, and `runner.add` without `test: false`) runs in the
//! TypeScript job registry, so those inputs stay forwarded.
#![allow(clippy::result_large_err)]
use pacer_config::{
    config_writes::{default_account, edit, ensure_migrated, move_rank, parse_runner_ref},
    doc::parse_value,
    strategy::{StrategyError, load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
};
use pacer_models::{Validation, model_check_needs_core, validate_runner_model};
use serde_json::{Map, Value, json};

#[cfg(test)]
mod tests;

const AGENTS: [&str; 5] = ["claude-code", "codex", "cursor", "agy", "opencode"];
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const RUNNER_HINT: &str = "Check the runner id, account and host configuration.";

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub(crate) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

/// `def.params.safeParse(params ?? {})` for a non-strict object schema.
pub(crate) fn params_object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(other)
        ))),
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `z.string().min(1).max(128)`, required.
fn runner_id(p: &Map<String, Value>, issues: &mut Vec<String>) -> String {
    match p.get("id") {
        Some(Value::String(id)) => {
            if id.is_empty() {
                issues.push("id: Too small: expected string to have >=1 characters".into());
            } else if units(id) > 128 {
                issues.push("id: Too big: expected string to have <=128 characters".into());
            }
            id.clone()
        }
        other => {
            issues.push(format!(
                "id: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
            String::new()
        }
    }
}

fn optional_string(p: &Map<String, Value>, key: &str, issues: &mut Vec<String>) -> Option<String> {
    match p.get(key) {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            issues.push(format!(
                "{key}: Invalid input: expected string, received {}",
                type_name(other)
            ));
            None
        }
    }
}

fn done(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

fn strategy(ctx: &Ctx) -> Result<Value, CoreError> {
    load_strategy(&ctx.pacer_home).map_err(|e| CoreError::new(Code::Internal, e.to_string()))
}

/// `Object.keys(s.providers)` without the planner agent.
fn executor_ids(strategy: &Value) -> Vec<String> {
    let planner = strategy["planner"]["agent"].as_str().unwrap_or("");
    strategy["providers"]
        .as_object()
        .map(|providers| {
            providers
                .keys()
                .filter(|id| id.as_str() != planner)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn must_executor(strategy: &Value, id: &str) -> Result<(), CoreError> {
    let ids = executor_ids(strategy);
    if ids.iter().any(|known| known == id) {
        return Ok(());
    }
    Err(
        CoreError::new(Code::UnknownExecutor, format!("unknown executor {id}"))
            .hint(format!("configured: {}", ids.join(", "))),
    )
}

/// An array index key, which JavaScript objects order first.
fn index_key(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `JSON.stringify`: binary64 numbers and array-index keys first.
fn stringify(value: &Value, out: &mut String) {
    match value {
        Value::Number(n) => {
            let n = n.as_f64().unwrap_or(f64::NAN);
            if n.is_finite() {
                out.push_str(ryu_js::Buffer::new().format(n));
            } else {
                out.push_str("null");
            }
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify(item, out);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_by_key(|k| index_key(k).map_or((1, 0), |n| (0, n)));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                stringify(&fields[key], out);
            }
            out.push('}');
        }
        _ => out.push_str(&value.to_string()),
    }
}

/// `Object.entries(readJson(path) ?? {})`.
fn entries(ctx: &Ctx, name: &str) -> Vec<(String, Value)> {
    let Ok(bytes) = std::fs::read(ctx.pacer_home.join(name)) else {
        return Vec::new();
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => map.into_iter().collect(),
        Ok(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// `readBlocked`: entries with a string reason and a null or future `until`.
fn read_blocked(ctx: &Ctx) -> Map<String, Value> {
    entries(ctx, "blocked.json")
        .into_iter()
        .filter(|(_, m)| {
            m["reason"].is_string()
                && (m.get("until") == Some(&Value::Null)
                    || number(&m["until"]).is_some_and(|until| until > ctx.now))
        })
        .collect()
}

/// `readBroken`: entries with a string reason and a future numeric `until`.
fn read_broken(ctx: &Ctx) -> Map<String, Value> {
    entries(ctx, "broken.json")
        .into_iter()
        .filter(|(_, m)| {
            m["reason"].is_string() && number(&m["until"]).is_some_and(|until| until > ctx.now)
        })
        .collect()
}

fn write_blocked(ctx: &Ctx, blocks: &Map<String, Value>) -> Result<(), CoreError> {
    let mut text = String::new();
    stringify(&Value::Object(blocks.clone()), &mut text);
    write_private(&ctx.pacer_home.join("blocked.json"), text.as_bytes())
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))
}

/// A whole number as an integer, as `JSON.stringify` spells it.
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `blockExecutor`'s duration: a positive count of s, m, h or d.
fn block_until(now: f64, duration: Option<&str>) -> Result<Value, CoreError> {
    let Some(duration) = duration.filter(|d| !d.is_empty()) else {
        return Ok(Value::Null);
    };
    let refuse = || invalid("duration must be a positive number followed by s, m, h or d");
    let (digits, unit) = duration.split_at(duration.len().saturating_sub(1));
    let scale = match unit {
        "s" => 1.0,
        "m" => 60.0,
        "h" => 3600.0,
        "d" => 86400.0,
        _ => return Err(refuse()),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refuse());
    }
    let count: f64 = digits.parse().map_err(|_| refuse())?;
    if count <= 0.0 {
        return Err(refuse());
    }
    let until = now + count * scale;
    if !until.is_finite() {
        return Err(invalid("invalid duration"));
    }
    Ok(js_number(until))
}

pub fn runner_block(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        let id = runner_id(&p, &mut issues);
        let duration = optional_string(&p, "for", &mut issues);
        let reason = optional_string(&p, "reason", &mut issues);
        done(issues)?;
        must_executor(&strategy(ctx)?, &id)?;
        let until = block_until(ctx.now, duration.as_deref())?;
        let reason = reason.unwrap_or_else(|| "Paused by user".into());
        let reason = pacer_foundation::js_semantics::js_trim(&reason);
        let mut blocks = read_blocked(ctx);
        blocks.insert(
            id,
            json!({"until": until, "reason": if reason.is_empty() { "Paused by user" } else { reason }}),
        );
        write_blocked(ctx, &blocks)?;
        Ok(json!({"ok": true}))
    })
}

pub fn runner_unblock(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        let id = runner_id(&p, &mut issues);
        done(issues)?;
        must_executor(&strategy(ctx)?, &id)?;
        let mut blocks = read_blocked(ctx);
        blocks.shift_remove(&id);
        write_blocked(ctx, &blocks)?;
        Ok(json!({"ok": true}))
    })
}

/// `eligibilityPresentation(decision, now).detail`.
fn eligibility_detail(decision: &Value) -> String {
    decision["reasons"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|reason| match reason["code"].as_str().unwrap_or("") {
            "budget_exhausted" => "Budget exhausted; paid execution is not allowed",
            "budget_missing" => "No budget observation is available",
            "budget_expired_or_unknown" => "Budget evidence has expired or is incomplete",
            "evidence_conflicting" => "Current observations disagree",
            "evidence_missing" => "Execution evidence is missing",
            "availability_unknown" => "Executor availability is not confirmed",
            "subscription_missing" => "No active subscription",
            "subscription_failed" => "Subscription is unavailable",
            "subscription_response_invalid" => "Subscription status could not be read",
            "authentication_failed" | "signed_out" => "Sign-in is required",
            "refresh_failed" => "Could not refresh execution evidence",
            "disabled" => "Disabled",
            "not_installed" => "Not installed",
            "blocked" => "Blocked by you",
            "broken" => "Executor is not working",
            "unavailable" => "Executor is unavailable",
            "planner" => "Reserved for planning",
            "not_configured" => "Not configured",
            "quota_failure" => "The executor reported a quota limit",
            _ => "Execution evidence needs attention",
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn row(
    id: &str,
    eligibility: Option<&Value>,
    state: &str,
    until: Option<&Value>,
    reason: Value,
) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    if let Some(eligibility) = eligibility {
        row.insert("eligibility".into(), eligibility.clone());
    }
    row.insert("state".into(), json!(state));
    if let Some(until) = until {
        row.insert("until".into(), until.clone());
    }
    row.insert("reason".into(), reason);
    Value::Object(row)
}

pub fn runner_list_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "runner.list requires the usage broker bridge",
        ))
    })
}

/// `runners.list` over the usage-broker `providers` (`computeStatus`).
pub async fn runner_list(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    params_object(&params)?;
    let strategy = strategy(ctx)?;
    let blocked = read_blocked(ctx);
    let broken = read_broken(ctx);
    let parts = parts.await?;
    let providers = parts["providers"].as_array().cloned().unwrap_or_default();
    let rows = executor_ids(&strategy)
        .into_iter()
        .map(|id| {
            let eligibility = providers
                .iter()
                .find(|p| p["id"] == id.as_str())
                .and_then(|p| p.get("eligibility"));
            if let Some(block) = blocked.get(&id) {
                return row(
                    &id,
                    eligibility,
                    "blocked",
                    block.get("until"),
                    block["reason"].clone(),
                );
            }
            if let Some(bad) = broken.get(&id) {
                return row(
                    &id,
                    eligibility,
                    "broken",
                    bad.get("until"),
                    bad["reason"].clone(),
                );
            }
            match eligibility {
                Some(e) if e["state"] == "ineligible" => {
                    let state = if e["budget"] == "exhausted" {
                        "exhausted"
                    } else {
                        "broken"
                    };
                    row(
                        &id,
                        Some(e),
                        state,
                        e.get("validUntil"),
                        json!(eligibility_detail(e)),
                    )
                }
                _ => row(
                    &id,
                    eligibility.filter(|e| truthy(e)),
                    "ok",
                    Some(&Value::Null),
                    Value::Null,
                ),
            }
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(rows))
}

/// The non-interactive `runner.add` params, when they parse with `test: false`.
fn add_params(params: &Value) -> Option<&Map<String, Value>> {
    let p = params.as_object()?;
    let id = |v: &Value| v.as_str().is_some_and(|s| !s.is_empty() && units(s) <= 128);
    let count = |v: &Value, min: f64| {
        v.as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE && n >= min)
    };
    let kinds = |v: &Value| {
        v.as_array().is_some_and(|kinds| {
            !kinds.is_empty()
                && kinds.iter().all(|k| {
                    k.as_str()
                        .is_some_and(|k| pacer_lifecycle::TASK_KINDS.contains(&k))
                })
        })
    };
    let fine = !p.contains_key("interactive")
        && p.get("test") == Some(&Value::Bool(false))
        && p["agent"].as_str().is_some_and(|a| AGENTS.contains(&a))
        && ["account", "host"]
            .iter()
            .all(|key| p.get(*key).is_none_or(id))
        && p.get("model")
            .is_none_or(|m| m.as_str().is_some_and(|m| !m.is_empty()))
        && p.get("rank").is_none_or(|r| count(r, 0.0))
        && p.get("max_tasks").is_none_or(|n| count(n, 1.0))
        && p.get("kinds").is_none_or(kinds);
    fine.then_some(p)
}

/// The `runner.set` model check, which may run OpenCode discovery. A legacy
/// strategy is migrated by TypeScript before the check, so its runners are
/// listed there.
pub(crate) async fn model_check(ctx: &Ctx, strategy: &Value, id: &str, model: &str) -> Validation {
    if strategy["legacy"] == true {
        return Validation::NeedsCore;
    }
    validate_runner_model(&ctx.pacer_home, ctx.now, strategy, id, model).await
}

/// `runner.set` with a string `model` in otherwise valid params forwards only
/// where TypeScript alone lists the runner's models: discovery the front door
/// cannot run as Core does, a cache or catalog shape only TypeScript
/// reproduces, a legacy strategy, or a strategy that does not load.
pub fn runner_set_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    if !params["model"].is_string() {
        return false;
    }
    let Ok(p) = crate::config_params::parse("runner.set", params.clone()) else {
        return false;
    };
    if !p["model"].is_string() {
        return false;
    }
    load_strategy(&ctx.pacer_home).map_or(true, |strategy| {
        let id = p["id"].as_str().unwrap_or("");
        strategy["legacy"] == true
            || model_check_needs_core(&ctx.pacer_home, ctx.now, &strategy, id)
    })
}

/// `runner.add` with an interactive terminal, a check job or params outside
/// the non-interactive schema stays with TypeScript, as does an unreadable or
/// syntactically invalid strategy file: TypeScript reports it in its own
/// parser's words. `runner.set` stays with TypeScript when only TypeScript
/// can list the runner's models to check a string `model`.
pub fn runner_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    (op == "runner.add" && (add_params(params).is_none() || !strategy_parses(ctx)))
        || (op == "runner.set" && runner_set_stays_forwarded(ctx, params))
}

fn strategy_parses(ctx: &Ctx) -> bool {
    strategy_path(&ctx.pacer_home)
        .ok()
        .and_then(|(path, _)| std::fs::read_to_string(path).ok())
        .is_some_and(|text| parse_value(&text).is_ok())
}

fn add_error(error: StrategyError) -> CoreError {
    let message = error.to_string();
    if message == "Your settings changed while they were being updated. Try again." {
        return CoreError::new(Code::Conflict, message).hint(RUNNER_HINT);
    }
    let strategy = message.starts_with("invalid strategy ")
        || message.starts_with("bad YAML:")
        || message.contains(" at line ")
        || message.starts_with("while parsing ");
    invalid(&message).hint(if strategy {
        "Check the strategy values and retry."
    } else {
        RUNNER_HINT
    })
}

fn refuse(message: impl Into<String>) -> StrategyError {
    StrategyError::Other(message.into())
}

fn path(parts: &[Value]) -> Vec<Value> {
    parts.to_vec()
}

/// `runnersConfig.add` without the check job: the runner declaration, its
/// routing rule and its pacing rank, in one validated strategy edit.
fn add_runner(ctx: &Ctx, p: &Map<String, Value>) -> Result<Value, StrategyError> {
    let home = &ctx.pacer_home;
    let migrated = ensure_migrated(home)?;
    let strategy = load_strategy(home)?;
    let agent = p["agent"].as_str().unwrap_or("");
    let text = |key: &str| p.get(key).and_then(Value::as_str);
    let reference = format!(
        "{agent}{}{}",
        text("account").map_or(String::new(), |a| format!("#{a}")),
        text("host").map_or(String::new(), |h| format!("@{h}"))
    );
    let (agent, named, host) =
        parse_runner_ref(&reference).ok_or_else(|| refuse("invalid runner id"))?;
    if let Some(host) = host
        && strategy["hosts"].get(host).is_none()
    {
        let names = strategy["hosts"]
            .as_object()
            .map(|hosts| hosts.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        return Err(refuse(format!(
            "unknown host {host} (hosts: {})",
            if names.is_empty() { "none" } else { &names }
        )));
    }
    let default = default_account(&strategy, agent);
    let kind = match agent {
        "claude-code" => "claude",
        "opencode" => "endpoint",
        other => other,
    };
    let account = named
        .or(default)
        .filter(|name| strategy["accounts"][*name]["kind"] == kind)
        .ok_or_else(|| refuse("agent/account pairing not allowed or account not found"))?;
    let id = format!(
        "{agent}{}{}",
        if default == Some(account) {
            String::new()
        } else {
            format!("#{account}")
        },
        host.map_or(String::new(), |h| format!("@{h}"))
    );
    if strategy["runners"].get(&id).is_some() {
        return Err(refuse(format!("runner {id} already exists")));
    }
    let mut settings = Map::new();
    for key in ["model", "max_tasks", "test"] {
        if let Some(value) = p.get(key) {
            settings.insert(key.into(), value.clone());
        }
    }
    let kinds = p.get("kinds").and_then(Value::as_array);
    let rank = p.get("rank").and_then(Value::as_f64).map(|r| r as usize);
    edit(home, |doc, current| {
        let e = |error: pacer_config::doc::EditError| refuse(error.to_string());
        doc.add_mapping_entry("runners", &id, &Value::Object(settings))
            .map_err(e)?;
        let raw = doc.get_in(&path(&[json!("routing")])).map_err(e)?;
        if !raw.as_ref().is_some_and(Value::is_array) {
            let rules: Vec<Value> = current["routing"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|rule| match rule.get("kinds") {
                    Some(kinds) if !kinds.is_null() => {
                        json!({"kinds": kinds, "executors": rule["executors"]})
                    }
                    _ => json!({"default": rule["executors"]}),
                })
                .collect();
            doc.set_in(&path(&[json!("routing")]), &json!(rules))
                .map_err(e)?;
        }
        let rules = doc
            .get_in(&path(&[json!("routing")]))
            .map_err(e)?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let same = |rule: &Value| match kinds {
            Some(kinds) => rule["kinds"].as_array().is_some_and(|have| {
                have.len() == kinds.len() && kinds.iter().all(|k| have.contains(k))
            }),
            None => rule["default"].is_array(),
        };
        if let Some(index) = rules.iter().position(same) {
            let key = if kinds.is_some() {
                "executors"
            } else {
                "default"
            };
            let mut list = rules[index][key].as_array().cloned().unwrap_or_default();
            list.push(json!(id));
            doc.set_list(&path(&[json!("routing"), json!(index), json!(key)]), &list)
                .map_err(e)?;
        } else if let Some(kinds) = kinds {
            let at = rules
                .iter()
                .position(|rule| rule["default"].is_array())
                .unwrap_or(rules.len());
            let rule = json!({"kinds": kinds, "executors": [id]});
            let insert = json!({"kind": "insertAt", "index": at, "value": rule});
            if doc
                .replace_node(&path(&[json!("routing")]), &insert)
                .is_err()
            {
                // Flow sequences are re-rendered whole, as the TS YAML writer does.
                let mut rules = rules;
                rules.insert(at, rule);
                doc.set_in(&path(&[json!("routing")]), &json!(rules))
                    .map_err(e)?;
            }
        } else {
            let mut rules = rules;
            rules.push(json!({"default": [id]}));
            doc.set_in(&path(&[json!("routing")]), &json!(rules))
                .map_err(e)?;
        }
        if let Some(rank) = rank {
            move_rank(doc, &strategy, &id, rank)?;
        }
        Ok(())
    })?;
    let mut result = json!({"id": id});
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}

/// The caller performs the endpoint synchronization and the `runners`
/// publication, as for `runner.set`.
pub fn runner_add(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = add_params(&params).ok_or_else(|| {
            CoreError::new(
                Code::Unavailable,
                "runner.add with a check job requires the forwarded operation",
            )
        })?;
        if let Some(kinds) = p.get("kinds").and_then(Value::as_array) {
            let mut seen = std::collections::HashSet::new();
            if !kinds.iter().all(|k| seen.insert(k.as_str())) {
                return Err(invalid("kinds must be a nonempty set"));
            }
        }
        add_runner(ctx, p).map_err(add_error)
    })
}
