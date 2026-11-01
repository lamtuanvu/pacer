//! Strategy reads and legacy migration. This module does not register API ops.

use crate::{
    doc::{StrategyDoc, parse_value},
    write::atomic_strategy_write,
};
use serde_json::{Map, Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum StrategyError {
    #[error("no strategy found at {0}")]
    Missing(PathBuf),
    #[error("invalid strategy {path}:\n{message}")]
    Invalid {
        path: PathBuf,
        problems: Vec<String>,
        message: String,
    },
    #[error("{0}")]
    Other(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn invalid(path: &Path, problems: Vec<String>) -> StrategyError {
    let message = problems
        .iter()
        .map(|p| format!("  - {p}"))
        .collect::<Vec<_>>()
        .join("\n");
    StrategyError::Invalid {
        path: path.to_path_buf(),
        problems,
        message,
    }
}
fn obj(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}
fn string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        _ => value.to_string(),
    }
}
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}
fn optional_string(value: &Value) -> Value {
    if value.is_null() {
        Value::Null
    } else {
        Value::String(string(value))
    }
}
fn number(value: &Value, default: f64, key: &str, problems: &mut Vec<String>) -> Value {
    if value.is_null() {
        return numeric(default);
    }
    if value.is_number() {
        value.clone()
    } else {
        problems.push(format!("pacing.{key} must be a number"));
        numeric(default)
    }
}
fn numeric(value: f64) -> Value {
    if value.fract() == 0. && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}
fn decimal(text: &str) -> Option<f64> {
    let (whole, fraction) = text
        .split_once('.')
        .map_or((text, None), |(a, b)| (a, Some(b)));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    text.parse().ok()
}
fn size(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    let text = value.as_str()?.trim();
    let cut = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let n = decimal(&text[..cut])?;
    let mult = match text[cut..].trim().to_ascii_lowercase().as_str() {
        "" => 1.,
        "k" => 1e3,
        "m" => 1e6,
        "g" => 1e9,
        _ => return None,
    };
    Some(n * mult)
}
fn duration(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    let text = value.as_str()?.trim();
    let unit = text.chars().last()?;
    let n = decimal(text[..text.len() - 1].trim())?;
    Some(
        n * match unit {
            's' => 1.,
            'm' => 60.,
            'h' => 3600.,
            'd' => 86400.,
            _ => return None,
        },
    )
}
fn agent_kind(agent: &str) -> Option<&'static str> {
    match agent {
        "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "agy" => Some("agy"),
        "opencode" => Some("endpoint"),
        _ => None,
    }
}
fn default_usage(kind: &str) -> &'static str {
    match kind {
        "claude" | "codex" => "quota",
        "endpoint" => "metered",
        _ => "reactive",
    }
}
fn account(name: &str, c: &Value, kind: &str) -> Value {
    let source = if field(c, "orca_account").as_str().is_some() {
        "orca"
    } else if field(c, "home").as_str().is_some() {
        "pacer"
    } else if kind == "endpoint" && field(c, "source") == "opencode" {
        "opencode"
    } else if kind == "endpoint" {
        "endpoint"
    } else {
        "default"
    };
    let usage = c
        .get("usage")
        .map(string)
        .unwrap_or_else(|| default_usage(kind).into());
    let quota = c.get("quota_source").and_then(Value::as_str).or_else(|| {
        if source == "opencode"
            && usage == "quota"
            && c.get("usage_source").is_none()
            && matches!(
                c.get("provider").and_then(Value::as_str),
                Some("coding-plan" | "byteplus-coding-plan" | "volcengine-coding-plan")
            )
        {
            Some("arkcli")
        } else {
            None
        }
    });
    let usage_source = c.get("usage_source").map(string).unwrap_or_else(|| {
        if quota == Some("arkcli") {
            "arkcli".into()
        } else if usage == "quota" {
            "native".into()
        } else {
            usage.clone()
        }
    });
    json!({"name":name,"model":optional_string(field(c,"model")),"kind":kind,"source":source,
        "home":field(c,"home").as_str(),"orcaAccount":field(c,"orca_account").as_str(),"usage":usage,
        "usageSource":usage_source,"quotaSource":quota,"provider":field(c,"provider").as_str(),
        "weeklyUsd":field(field(c,"budget"),"weekly_usd").as_f64().map(numeric),"weeklyTokens":size(field(field(c,"budget"),"weekly_tokens")).map(numeric),
        "cooldownS":numeric(c.get("cooldown").and_then(duration).unwrap_or(21600.)),"allowPaid":field(c,"allow_paid") == true})
}
fn validate_account(name: &str, value: &Value, cfg: &mut Value, problems: &mut Vec<String>) {
    let at = format!("accounts.{name}");
    let kind = cfg["kind"].as_str().unwrap_or("");
    if !["claude", "codex", "cursor", "agy", "endpoint"].contains(&kind) {
        problems.push(format!("{at}: unknown account kind"));
    }
    for key in ["home", "orca_account"] {
        if let Some(v) = value.get(key)
            && (v.as_str().is_none_or(|s| s.trim().is_empty())
                || !["claude", "codex"].contains(&kind))
        {
            problems.push(format!(
                "{at}: {key} requires a non-empty {} on a claude or codex account",
                if key == "home" { "folder" } else { "id" }
            ));
        }
    }
    if value.get("home").is_some() && value.get("orca_account").is_some() {
        problems.push(format!(
            "{at}: home and orca_account are mutually exclusive"
        ));
    }
    let usage = cfg["usage"].as_str().unwrap_or("");
    let source = cfg["usageSource"].as_str().unwrap_or("");
    if !["quota", "metered", "reactive", "unmetered"].contains(&usage) {
        problems.push(format!("{at}: unknown usage kind"));
    }
    if ![
        "native",
        "orca",
        "arkcli",
        "metered",
        "reactive",
        "unmetered",
    ]
    .contains(&source)
    {
        problems.push(format!("{at}: unknown usage_source"));
    }
    if ["cursor", "agy"].contains(&kind) && usage == "quota" && source != "orca" {
        problems.push(format!(
            "{at}: quota usage is not available for {kind}; use reactive"
        ));
    }
    if value.get("source") == Some(&json!("opencode")) {
        if kind != "endpoint" {
            problems.push(format!(
                "{at}: source: opencode requires an endpoint account"
            ));
        } else {
            if cfg["provider"].as_str().is_none_or(|s| {
                s.is_empty()
                    || !s.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c)
                    })
            }) {
                problems.push(format!(
                    "{at}: source: opencode needs provider (an OpenCode provider id)"
                ));
            }
            if value.get("connection").is_some() {
                problems.push(format!("{at}: source: opencode cannot have a connection"));
            }
        }
    }
    if let Some(budget) = value.get("budget").and_then(Value::as_object) {
        if budget.contains_key("weekly_usd") && budget.contains_key("weekly_tokens") {
            problems.push(format!(
                "{at}: budget cannot combine weekly_usd and weekly_tokens"
            ));
        }
        if budget
            .get("weekly_usd")
            .is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite() || n <= 0.))
        {
            problems.push(format!("{at}: budget.weekly_usd must be a positive number"));
        }
    }
    if kind == "endpoint"
        && usage == "quota"
        && cfg["quotaSource"] != "arkcli"
        && source != "orca"
        && cfg["source"] != "opencode"
    {
        problems.push(format!("{at}: quota usage needs quota_source: arkcli"));
    }
    if kind != "endpoint"
        && usage == "metered"
        && cfg["weeklyTokens"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n <= 0.)
    {
        problems.push(format!("{at}: metered usage needs budget.weekly_tokens"));
    }
    if kind == "endpoint"
        && usage == "metered"
        && value
            .get("budget")
            .and_then(|b| b.get("weekly_tokens"))
            .is_some()
        && cfg["weeklyTokens"].as_f64().is_none_or(|n| n <= 0.)
    {
        problems.push(format!(
            "{at}: budget.weekly_tokens must be a positive size such as 20M"
        ));
    }
    if value.get("cooldown").is_some()
        && (value.get("cooldown").and_then(duration).is_none()
            || cfg["cooldownS"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n < 0.))
    {
        problems.push(format!("{at}: cooldown must look like 30m, 6h or 2d"));
    }
    if let Some(connection) = value.get("connection") {
        let before = problems.len();
        if kind != "endpoint" {
            problems.push(format!("{at}: connection requires an endpoint account"));
        }
        if !valid_plugin_id(name) {
            problems.push(format!(
                "{at}: connection account name must contain lowercase letters, digits and hyphens"
            ));
        }
        if let Some(conn) = connection.as_object() {
            if conn.get("api") != Some(&json!("openai-compatible")) {
                problems.push(format!("{at}.connection.api must be openai-compatible"));
            }
            let url = conn.get("base_url").and_then(Value::as_str).unwrap_or("");
            let authority = url
                .split_once("://")
                .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""))
                .unwrap_or("");
            if !(url.starts_with("http://") || url.starts_with("https://"))
                || authority.is_empty()
                || authority.contains('@')
                || authority.chars().any(char::is_whitespace)
            {
                problems.push(format!(
                    "{at}.connection.base_url must be an http(s) URL without credentials"
                ));
            }
            let key = conn.get("key").and_then(Value::as_str).unwrap_or("");
            if !["keychain", "file", "none"].contains(&key)
                && !key.strip_prefix("env:").is_some_and(|s| {
                    !s.is_empty()
                        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                        && !s.as_bytes()[0].is_ascii_digit()
                })
            {
                problems.push(format!(
                    "{at}.connection.key must be keychain, file, env:VAR or none"
                ));
            }
            let models = conn.get("models").and_then(Value::as_array);
            if models.is_none_or(Vec::is_empty) {
                problems.push(format!("{at}.connection.models must be a non-empty list"));
            }
            let mut normalized_models = Vec::new();
            let mut ids = std::collections::HashSet::new();
            if let Some(models) = models {
                for (i, m) in models.iter().enumerate() {
                    let loc = format!("{at}.connection.models.{i}");
                    if m.as_object().is_none() {
                        problems.push(format!("{loc} must be a mapping"));
                        continue;
                    }
                    if m["id"].as_str().is_none_or(|s| s.trim().is_empty()) {
                        problems.push(format!("{loc}.id must be non-empty"));
                    } else if !ids.insert(m["id"].as_str().unwrap_or("")) {
                        problems.push(format!("{loc}.id must be unique"));
                    }
                    if m.get("name")
                        .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
                    {
                        problems.push(format!("{loc}.name must be non-empty"));
                    }
                    for key in ["context", "output"] {
                        if !m[key].as_u64().is_some_and(|n| n > 0) {
                            problems.push(format!("{loc}.{key} must be a positive integer"));
                        }
                    }
                    if !m["tools"].is_boolean() {
                        problems.push(format!("{loc}.tools must be a boolean"));
                    }
                    let mut model = json!({"id":m["id"],"context":m["context"],"output":m["output"],"tools":m["tools"]});
                    if let Some(v) = m.get("name") {
                        model["name"] = v.clone();
                    }
                    normalized_models.push(model);
                }
            }
            if problems.len() == before {
                cfg["connection"] = json!({"api":"openai-compatible","base_url":url,"key":key,"models":normalized_models});
            }
        } else {
            problems.push(format!("{at}.connection must be a mapping"));
        }
    }
}
fn runner(id: &str, agent: &str, account: &str, model: &Value) -> Value {
    json!({"id":id,"name":id,"host":null,"agent":agent,"account":account,"model":model})
}
fn add_runner(
    reference: &str,
    declaration: &Value,
    accounts: &Map<String, Value>,
    hosts: &Value,
    runners: &mut Map<String, Value>,
    aliases: &mut Map<String, Value>,
    problems: &mut Vec<String>,
) {
    if !declaration.is_object() {
        problems.push(format!("runner {reference}: must be a mapping"));
    }
    if declaration
        .get("session")
        .is_some_and(|v| !matches!(v.as_str(), Some("headless" | "interactive")))
    {
        problems.push(format!(
            "runner {reference}: session must be headless or interactive"
        ));
    }
    if declaration.get("enabled").is_some_and(|v| !v.is_boolean()) {
        problems.push(format!("runner {reference}: enabled must be a boolean"));
    }
    if declaration.get("test").is_some_and(|v| !v.is_boolean()) {
        problems.push(format!("runner {reference}: test must be a boolean"));
    }
    if declaration
        .get("max_tasks")
        .is_some_and(|v| v.as_u64().is_none_or(|n| !(1..=16).contains(&n)))
    {
        problems.push(format!("runners.{reference}.max_tasks must be 1..16"));
    }
    let explicit_agent = declaration.get("agent").and_then(Value::as_str);
    let explicit_account = declaration.get("account").and_then(Value::as_str);
    let (local_ref, raw_host) = reference
        .split_once('@')
        .map_or((reference, None), |(a, b)| (a, Some(b)));
    let host = raw_host.filter(|h| *h != "local");
    let (parsed_agent, parsed_account) = local_ref
        .split_once('#')
        .map_or((local_ref, None), |(a, b)| (a, Some(b)));
    let agent = explicit_agent.unwrap_or_else(|| {
        if accounts
            .get(reference)
            .is_some_and(|a| a["kind"] == "endpoint")
        {
            "opencode"
        } else {
            parsed_agent
        }
    });
    if agent_kind(agent).is_none() {
        problems.push(format!(
            "runner {reference}: invalid runner id or unknown agent"
        ));
        return;
    }
    if let Some(host) = host {
        if hosts.get(host).is_none() {
            let names = hosts
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            problems.push(format!(
                "runner {reference}: unknown host {host} (hosts: {})",
                if names.is_empty() { "none" } else { &names }
            ));
        }
        if !["codex", "claude-code"].contains(&agent) {
            problems.push(format!(
                "runner {reference}: remote runners support codex and claude-code"
            ));
        }
    }
    if agent == "opencode" && reference == "opencode" && !accounts.contains_key("opencode") {
        return;
    }
    let default = accounts
        .iter()
        .filter(|(_, a)| {
            a["kind"] == agent_kind(agent).unwrap_or("")
                && a["home"].is_null()
                && a["orcaAccount"].is_null()
        })
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>();
    if (explicit_agent.is_some() || explicit_account.is_some())
        && agent_kind(parsed_agent).is_some()
        && (explicit_agent != Some(parsed_agent)
            || explicit_account
                != parsed_account.or_else(|| {
                    if default.len() == 1 {
                        Some(default[0])
                    } else {
                        None
                    }
                }))
    {
        problems.push(format!(
            "runner {reference}: declaration conflicts with runner id identity"
        ));
    }
    let account = explicit_account.or(parsed_account).or_else(|| {
        if accounts
            .get(reference)
            .is_some_and(|a| a["kind"] == "endpoint")
        {
            Some(reference)
        } else if default.len() == 1 {
            Some(default[0])
        } else {
            None
        }
    });
    let Some(account) = account else {
        problems.push(format!(
            "runner {reference}: no default account for {agent}"
        ));
        return;
    };
    let Some(cfg) = accounts.get(account) else {
        problems.push(format!(
            "runner {reference}: no default account for {agent}"
        ));
        return;
    };
    if cfg["kind"] != agent_kind(agent).unwrap_or("") {
        problems.push(format!(
            "runner {reference}: {agent} cannot use {} account \"{account}\"",
            cfg["kind"].as_str().unwrap_or("")
        ));
    }
    let id = if agent == "opencode" || default.first().copied() != Some(account) {
        format!("{agent}#{account}")
    } else {
        agent.into()
    };
    let id = if let Some(host) = host {
        format!("{id}@{host}")
    } else {
        id
    };
    if let Some(host) = host
        && default.first().copied() != Some(account)
        && hosts.get(host).is_some()
        && hosts[host]["accounts"].get(account).is_none()
    {
        problems.push(format!("runner {reference}: account {account} on {host} needs hosts.{host}.accounts.{account}.home"));
    }
    if runners.contains_key(&id) && declaration.as_object().is_some_and(Map::is_empty) {
        aliases.insert(reference.into(), json!(id));
        return;
    }
    let mut model = declaration
        .get("model")
        .cloned()
        .unwrap_or_else(|| cfg["model"].clone());
    if let Some(models) = cfg
        .get("connection")
        .and_then(|c| c.get("models"))
        .and_then(Value::as_array)
    {
        let prefix = format!("pacer-{account}/");
        let selected = model
            .as_str()
            .map(|m| m.strip_prefix(&prefix).unwrap_or(m))
            .or_else(|| models.first().and_then(|m| m["id"].as_str()))
            .unwrap_or("");
        if !models.iter().any(|m| m["id"] == selected) {
            problems.push(format!(
                "runner {reference}: model must be selected from connection.models"
            ));
        }
        model = json!(format!("{prefix}{selected}"));
    }
    if cfg["source"] == "opencode"
        && cfg["provider"].as_str().is_some_and(|provider| {
            !model
                .as_str()
                .unwrap_or("")
                .starts_with(&format!("{provider}/"))
        })
    {
        problems.push(format!(
            "runner {reference}: model must start with \"{}/\"",
            cfg["provider"].as_str().unwrap_or("")
        ));
    }
    if agent == "opencode" && model.as_str().is_none_or(|m| !m.contains('/')) {
        problems.push(format!(
            "runner {id}: model must look like \"<provider>/<model>\""
        ));
    }
    let mut value = runner(&id, agent, account, &model);
    if let Some(host) = host {
        value["host"] = json!(host);
    }
    for (source, target) in [
        ("session", "session"),
        ("enabled", "enabled"),
        ("max_tasks", "maxTasks"),
        ("test", "test"),
    ] {
        if let Some(v) = declaration.get(source) {
            value[target] = v.clone();
        }
    }
    if let Some(models) = declaration.get("models") {
        let mut seen = std::collections::HashSet::new();
        let mut normalized = Vec::new();
        let mut valid = true;
        if let Some(list) = models
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 256)
        {
            for m in list {
                let Some(map) = m.as_object() else {
                    valid = false;
                    break;
                };
                if map
                    .keys()
                    .any(|k| !["id", "tier", "strengths", "tools", "context"].contains(&k.as_str()))
                {
                    valid = false;
                    break;
                }
                let Some(mid) = m["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 256) else {
                    valid = false;
                    break;
                };
                if !seen.insert(mid) {
                    problems.push(format!("runner {reference}: duplicate models"));
                    valid = false;
                    break;
                }
                let tier = m.get("tier").and_then(Value::as_str).unwrap_or("unknown");
                if !["small", "medium", "frontier", "unknown"].contains(&tier) {
                    valid = false;
                    break;
                }
                let strengths = m.get("strengths").cloned().unwrap_or(json!([]));
                if strengths.as_array().is_none_or(|a| {
                    a.len() > 64
                        || a.iter()
                            .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 256))
                }) {
                    valid = false;
                    break;
                }
                if m.get("tools").is_some_and(|v| !v.is_boolean())
                    || m.get("context")
                        .is_some_and(|v| v.as_u64().is_none_or(|n| n < 1))
                {
                    valid = false;
                    break;
                }
                let mut out = json!({"id":mid,"tier":tier,"strengths":strengths});
                for key in ["tools", "context"] {
                    if let Some(v) = m.get(key) {
                        out[key] = v.clone();
                    }
                }
                normalized.push(out);
            }
        } else {
            valid = false;
        }
        if !valid {
            problems.push(format!("runner {reference}: invalid models declaration"));
        } else {
            value["models"] = json!(normalized);
        }
    }
    runners.insert(id.clone(), value);
    aliases.insert(reference.into(), json!(id));
}
fn plugins(raw: Option<&Value>, problems: &mut Vec<String>) -> Value {
    let empty = json!({});
    let raw = raw.unwrap_or(&empty);
    let mut mode = "open";
    let mut disabled = Vec::new();
    let mut installed = Map::new();
    let mut config = Map::new();
    if obj(raw).is_none() {
        problems.push("plugins must be a mapping".into());
    }
    if let Some(policy) = raw.get("policy") {
        if obj(policy).is_none() {
            problems.push("plugins.policy must be a mapping".into());
        } else if let Some(v) = policy.get("mode") {
            if v == "open" || v == "closed" {
                mode = v.as_str().unwrap_or("open");
            } else {
                problems.push("plugins.policy.mode must be open or closed".into());
            }
        }
    }
    if let Some(value) = raw.get("disabled") {
        if let Some(ids) = value.as_array() {
            for id in ids {
                let s = string(id);
                if !valid_plugin_id(&s) || !id.is_string() {
                    problems.push(format!("plugins.disabled: invalid plugin id \"{s}\""));
                } else {
                    disabled.push(id.clone());
                }
            }
        } else {
            problems.push("plugins.disabled must be a list of plugin ids".into());
        }
    }
    if let Some(value) = raw.get("installed") {
        if let Some(grants) = obj(value) {
            for (id, g) in grants {
                if !valid_plugin_id(id) {
                    problems.push(format!("plugins.installed: invalid plugin id \"{id}\""));
                    continue;
                }
                let Some(g) = obj(g) else {
                    problems.push(format!("plugins.installed.{id} must be a mapping"));
                    continue;
                };
                let version = g.get("version").and_then(Value::as_str).unwrap_or("");
                if !semver(version) {
                    problems.push(format!("plugins.installed.{id}.version must be semver"));
                }
                let capabilities = g.get("capabilities").and_then(Value::as_array);
                if capabilities.is_none_or(|v| v.iter().any(|x| !x.is_string())) {
                    problems.push(format!(
                        "plugins.installed.{id}.capabilities must be a list of names"
                    ));
                    continue;
                }
                if let Some(surfaces) = g.get("surfaces")
                    && surfaces
                        .as_array()
                        .is_none_or(|v| v.iter().any(|x| !x.is_string()))
                {
                    problems.push(format!(
                        "plugins.installed.{id}.surfaces must be a list of names"
                    ));
                    continue;
                }
                let mut out = json!({"version":version,"capabilities":capabilities});
                if let Some(v) = g.get("surfaces") {
                    out["surfaces"] = v.clone();
                }
                if let Some(v) = g.get("policy").filter(|v| v.is_boolean()) {
                    out["policy"] = v.clone();
                }
                installed.insert(id.clone(), out);
            }
        } else {
            problems.push("plugins.installed must be a mapping of plugin id to grant".into());
        }
    }
    if let Some(value) = raw.get("config") {
        if let Some(settings) = obj(value) {
            for (id, c) in settings {
                if obj(c).is_none() {
                    problems.push(format!("plugins.config.{id} must be a mapping"));
                } else {
                    config.insert(id.clone(), c.clone());
                }
            }
        } else {
            problems.push("plugins.config must be a mapping of plugin id to settings".into());
        }
    }
    json!({"policy":{"mode":mode},"disabled":disabled,"installed":installed,"config":config})
}
fn valid_plugin_id(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 64
        && !s.starts_with('-')
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn semver(s: &str) -> bool {
    let (without_build, build) = s.split_once('+').map_or((s, None), |(a, b)| (a, Some(b)));
    if build.is_some_and(|part| {
        part.is_empty()
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
    }) {
        return false;
    }
    let (head, pre) = without_build
        .split_once('-')
        .map_or((without_build, None), |(a, b)| (a, Some(b)));
    if pre.is_some_and(|part| {
        part.is_empty()
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
    }) {
        return false;
    }
    head.split('.').count() == 3
        && head
            .split('.')
            .all(|x| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit()))
}

/// Validate and normalize a strategy without changing its source document.
pub fn validate_strategy(raw: &Value, path: &Path, name: &str) -> Result<Value, StrategyError> {
    let Some(root) = obj(raw) else {
        return Err(invalid(path, vec!["top level must be a mapping".into()]));
    };
    let mut p = Vec::new();
    let hosts = crate::sections::hosts(raw.get("hosts"), &mut p);
    let legacy = root.contains_key("providers");
    if legacy && (root.contains_key("accounts") || root.contains_key("runners")) {
        p.push("providers cannot be combined with accounts or runners".into());
    }
    let planner_ref = field(raw, "planner");
    let planner_agent = if legacy {
        planner_ref.as_str().unwrap_or("")
    } else {
        planner_ref
            .as_str()
            .or_else(|| planner_ref.get("agent").and_then(Value::as_str))
            .unwrap_or("")
    }
    .split(['#', '@'])
    .next()
    .unwrap_or("");
    if !["claude-code", "codex", "cursor", "opencode"].contains(&planner_agent) {
        p.push(if legacy {format!("planner must be one of claude-code, codex, cursor, opencode (got \"{planner_agent}\")")} else {"planner must be one of claude-code, codex, cursor, opencode".into()});
    }
    let mut accounts = Map::new();
    let mut runners = Map::new();
    let mut aliases = Map::new();
    let mut providers = Map::new();
    if legacy {
        let entries = root.get("providers").and_then(obj);
        if entries.is_none_or(|m| m.is_empty() && planner_agent != "opencode") {
            p.push("providers must be a non-empty mapping".into());
        }
        for (id, value) in entries.into_iter().flat_map(|m| m.iter()) {
            let c = if value.is_object() {
                value.clone()
            } else {
                json!({})
            };
            let native = ["claude-code", "codex", "cursor", "agy"].contains(&id.as_str());
            let via = c.get("via").and_then(Value::as_str);
            if native && via.is_some() {
                p.push(format!(
                    "providers.{id}: native providers cannot set \"via\""
                ));
            }
            if !native && via != Some("opencode") {
                p.push(format!(
                    "providers.{id}: non-native providers need via: opencode"
                ));
            }
            let model = c.get("model").map(string);
            if via == Some("opencode") && model.as_ref().is_none_or(|m| !m.contains('/')) {
                p.push(format!(
                    "providers.{id}: model must look like \"<provider>/<model>\""
                ));
            }
            let agent = if via == Some("opencode") {
                "opencode"
            } else {
                id.as_str()
            };
            let kind = agent_kind(agent).unwrap_or("endpoint");
            let cfg = account(id, &c, kind);
            let usage = cfg["usage"].as_str().unwrap_or("");
            if !["quota", "metered", "reactive", "unmetered"].contains(&usage) {
                p.push(format!(
                    "providers.{id}: usage must be one of quota, metered, reactive, unmetered"
                ));
            }
            if ["cursor", "agy"].contains(&id.as_str()) && usage == "quota" {
                p.push(format!(
                    "providers.{id}: quota usage is not available for {id}; use reactive"
                ));
            }
            if !native && usage == "quota" && cfg["quotaSource"] != "arkcli" {
                p.push(format!(
                    "providers.{id}: quota usage via opencode needs quota_source: arkcli"
                ));
            }
            if usage == "metered" && cfg["weeklyTokens"].is_null() {
                p.push(format!(
                    "providers.{id}: metered usage needs budget.weekly_tokens (e.g. 20M)"
                ));
            }
            if c.get("cooldown").is_some() && duration(field(&c, "cooldown")).is_none() {
                p.push(format!(
                    "providers.{id}: cooldown must look like 30m, 6h or 2d"
                ));
            }
            accounts.insert(id.clone(), cfg.clone());
            let rid = if agent == "opencode" {
                format!("opencode#{id}")
            } else {
                agent.into()
            };
            aliases.insert(id.clone(), json!(rid));
            runners.insert(rid.clone(), runner(&rid, agent, id, &cfg["model"]));
        }
        if planner_agent != "opencode" && !accounts.contains_key(planner_agent) {
            let kind = agent_kind(planner_agent).unwrap_or("endpoint");
            let cfg = account(planner_agent, &json!({}), kind);
            accounts.insert(planner_agent.into(), cfg.clone());
            runners.insert(
                planner_agent.into(),
                runner(planner_agent, planner_agent, planner_agent, &cfg["model"]),
            );
        }
    } else {
        let entries = root.get("accounts").and_then(obj);
        if entries.is_none_or(|m| m.is_empty() && planner_agent != "opencode") {
            p.push("accounts must be a non-empty mapping".into());
        }
        for (id, value) in entries.into_iter().flat_map(|m| m.iter()) {
            let Some(c) = obj(value) else {
                p.push(format!("accounts.{id} must be a mapping"));
                continue;
            };
            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
            let mut cfg = account(id, value, kind);
            validate_account(id, value, &mut cfg, &mut p);
            accounts.insert(id.clone(), cfg);
        }
        for kind in ["claude", "codex", "cursor", "agy"] {
            if accounts
                .values()
                .filter(|a| a["kind"] == kind && a["home"].is_null() && a["orcaAccount"].is_null())
                .count()
                > 1
            {
                p.push(format!("accounts: more than one default {kind} account"));
            }
        }
        if root.get("runners").is_some_and(|v| obj(v).is_none()) {
            p.push("runners must be a mapping".into());
        }
        let planner_default = accounts
            .iter()
            .filter(|(_, a)| {
                a["kind"] == agent_kind(planner_agent).unwrap_or("")
                    && a["home"].is_null()
                    && a["orcaAccount"].is_null()
            })
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>();
        let planner_account = planner_ref
            .get("account")
            .and_then(Value::as_str)
            .or_else(|| {
                if planner_default.len() == 1 {
                    Some(planner_default[0])
                } else {
                    None
                }
            })
            .unwrap_or(planner_agent);
        let planner_id = if planner_ref.is_string() {
            planner_ref.as_str().unwrap_or("").to_owned()
        } else if planner_default.as_slice() == [planner_account] {
            planner_agent.to_owned()
        } else {
            format!("{planner_agent}#{planner_account}")
        };
        let planner_declaration = if planner_ref.is_string() {
            json!({})
        } else {
            planner_ref.clone()
        };
        add_runner(
            &planner_id,
            &planner_declaration,
            &accounts,
            &hosts,
            &mut runners,
            &mut aliases,
            &mut p,
        );
        if planner_id
            .split_once('@')
            .is_some_and(|(_, host)| host != "local")
        {
            p.push("the planner can't run on a host".into());
        }
        if let Some(entries) = root.get("runners").and_then(obj) {
            for (id, c) in entries {
                add_runner(id, c, &accounts, &hosts, &mut runners, &mut aliases, &mut p);
            }
        }
        if let Some(rules) = root.get("routing").and_then(Value::as_array) {
            for rule in rules {
                let refs = rule
                    .get("default")
                    .or_else(|| rule.get("executors"))
                    .and_then(Value::as_array);
                for id in refs.into_iter().flatten() {
                    let reference = string(id);
                    let canonical = aliases
                        .get(&reference)
                        .and_then(Value::as_str)
                        .unwrap_or(&reference)
                        .to_owned();
                    add_runner(
                        &canonical,
                        &json!({}),
                        &accounts,
                        &hosts,
                        &mut runners,
                        &mut aliases,
                        &mut p,
                    );
                }
            }
        }
    }
    let planner_account = if legacy {
        planner_agent
    } else {
        planner_ref
            .get("account")
            .and_then(Value::as_str)
            .or_else(|| {
                accounts
                    .iter()
                    .find(|(_, a)| {
                        a["kind"] == agent_kind(planner_agent).unwrap_or("")
                            && a["home"].is_null()
                            && a["orcaAccount"].is_null()
                    })
                    .map(|(id, _)| id.as_str())
            })
            .unwrap_or(planner_agent)
    };
    for (id, r) in &runners {
        if let Some(a) = accounts.get(r["account"].as_str().unwrap_or("")) {
            let usage = &a["usage"];
            let via = if r["agent"] == "opencode" {
                json!("opencode")
            } else {
                Value::Null
            };
            providers.insert(id.clone(),json!({"id":id,"via":via,"model":r["model"],"usage":usage,"allowPaid":a["allowPaid"],"cooldownS":a["cooldownS"],"quotaSource":if a["quotaSource"] == "arkcli" {json!("arkcli")} else {Value::Null},"weeklyTokens":a["weeklyTokens"],"weeklyUsd":a["weeklyUsd"]}));
        }
    }
    let pc = field(raw, "pacing");
    let policy = pc
        .get("policy")
        .map(string)
        .unwrap_or_else(|| "priority".into());
    if !["priority", "even", "burn-before-reset", "cheapest-first"].contains(&policy.as_str()) {
        p.push(format!("pacing.policy must be one of priority, even, burn-before-reset, cheapest-first (got \"{policy}\")"));
    }
    let resolve = |v: &Value| {
        let id = string(v);
        aliases
            .get(&id)
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned()
    };
    let order: Vec<String> = match pc.get("order") {
        None => {
            if legacy {
                ["codex", "cursor", "agy", "opencode"]
                    .into_iter()
                    .filter(|id| {
                        runners.contains_key(*id)
                            || (*id == "opencode"
                                && providers.values().any(|p| p["via"] == "opencode"))
                    })
                    .map(str::to_owned)
                    .collect()
            } else {
                runners.keys().cloned().collect()
            }
        }
        Some(Value::Array(values)) => values.iter().map(&resolve).collect(),
        _ => {
            p.push("pacing.order must be a list".into());
            vec![]
        }
    };
    if pc.get("order").is_some() {
        for id in &order {
            if id != "opencode" && !providers.contains_key(id) {
                p.push(format!("pacing.order: unknown provider \"{id}\""));
            }
        }
    }
    let reserve = number(field(pc, "planner_reserve"), 15., "planner_reserve", &mut p);
    let headroom = number(
        field(pc, "planner_reserve_headroom"),
        25.,
        "planner_reserve_headroom",
        &mut p,
    );
    let fill = number(field(pc, "fill_threshold"), 90., "fill_threshold", &mut p);
    let probe = pc
        .get("planner_probe")
        .map(string)
        .unwrap_or_else(|| "ask".into());
    let accounts_mode = pc
        .get("accounts")
        .map(string)
        .unwrap_or_else(|| "spread".into());
    if !["spread", "fill"].contains(&accounts_mode.as_str()) {
        p.push("pacing.accounts must be spread or fill".into());
    }
    if fill.as_f64().is_some_and(|n| !(50. ..=100.).contains(&n)) {
        p.push("pacing.fill_threshold must be between 50 and 100".into());
    }
    if reserve.as_f64().is_some_and(|n| !(0. ..100.).contains(&n)) {
        p.push("pacing.planner_reserve must be between 0 and 99".into());
    }
    if headroom.as_f64().is_some_and(|n| !(0. ..100.).contains(&n)) {
        p.push("pacing.planner_reserve_headroom must be between 0 and 99".into());
    }
    if !["ask", "auto", "off"].contains(&probe.as_str()) {
        p.push("pacing.planner_probe must be ask, auto or off".into());
    }
    let pacing = json!({"policy":policy,"order":order,"plannerReserve":reserve,"plannerReserveHeadroom":headroom,"plannerProbe":probe,
        "aheadThreshold":number(field(pc,"ahead_threshold"),10.,"ahead_threshold",&mut p),
        "behindThreshold":number(field(pc,"behind_threshold"),-10.,"behind_threshold",&mut p),"accounts":accounts_mode,"fillThreshold":fill});
    let mut routing = Vec::new();
    let default_routing = json!([{"default":providers.keys().collect::<Vec<_>>()}]);
    let raw_routing = root.get("routing").unwrap_or(&default_routing);
    if let Some(rules) = raw_routing.as_array() {
        for (i, r) in rules.iter().enumerate() {
            let Some(r) = obj(r) else {
                p.push(format!("routing[{i}] must be a mapping"));
                continue;
            };
            let default = r.get("default").is_some_and(Value::is_array);
            let executors = r
                .get(if default { "default" } else { "executors" })
                .and_then(Value::as_array);
            if executors.is_none_or(Vec::is_empty) {
                p.push(format!(
                    "routing[{i}] needs a non-empty executors (or default) list"
                ));
                continue;
            }
            let ids = executors
                .into_iter()
                .flatten()
                .map(&resolve)
                .collect::<Vec<_>>();
            for e in executors.into_iter().flatten() {
                if !providers.contains_key(&resolve(e)) {
                    p.push(format!("routing[{i}]: unknown provider \"{}\"", string(e)));
                }
            }
            let kinds = if default {
                Value::Null
            } else if let Some(kinds) = r
                .get("kinds")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
            {
                let kinds = kinds.iter().map(string).collect::<Vec<_>>();
                for k in &kinds {
                    if ![
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
                    ]
                    .contains(&k.as_str())
                    {
                        p.push(format!("routing[{i}]: unknown kind \"{k}\" (allowed: boilerplate, tests, docs, rename, migration, feature, debug, refactor, performance, unfamiliar-code, research)"));
                    }
                }
                json!(kinds)
            } else {
                p.push(format!("routing[{i}] needs kinds (or use default:)"));
                continue;
            };
            routing.push(json!({"kinds":kinds,"executors":ids}));
        }
    } else {
        p.push("routing must be a list".into());
    }
    let execution = field(raw, "execution");
    if let Some(v) = execution.get("auto_clean")
        && !v.is_boolean()
    {
        p.push("execution.auto_clean must be a boolean".into());
    }
    if let Some(v) = execution.get("local_max_tasks")
        && !v.is_null()
        && v != "unlimited"
        && v.as_u64().is_none_or(|n| n < 1)
    {
        p.push(
            "execution.local_max_tasks must be a whole number of at least 1, or \"unlimited\""
                .into(),
        );
    }
    if let Some(v) = execution.get("local_memory_pressure_limit")
        && !v.is_null()
        && !matches!(v.as_str(), Some("critical" | "warning" | "off"))
    {
        p.push("execution.local_memory_pressure_limit must be critical, warning or off".into());
    }
    if let Some(v) = execution.get("local_load_limit")
        && !v.is_null()
        && v != "off"
        && v.as_f64().is_none_or(|n| !n.is_finite() || n <= 0.)
    {
        p.push(
            "execution.local_load_limit must be a positive number (load per CPU core) or \"off\""
                .into(),
        );
    }
    if let Some(v) = execution.get("launch_mode")
        && v != "interactive"
        && v != "headless"
    {
        p.push("execution.launch_mode must be interactive or headless".into());
    }
    let retention = raw.get("task_retention_days").cloned().unwrap_or(json!(14));
    if retention.as_i64().is_none_or(|n| n < 0) {
        p.push("task_retention_days must be a non-negative integer".into());
    }
    let plug = plugins(raw.get("plugins"), &mut p);
    let dispatch = root.get("dispatch").and_then(crate::sections::dispatch);
    if root.contains_key("dispatch") && dispatch.is_none() {
        p.push("Invalid dispatch configuration".into());
    }
    let messaging = root.get("messaging").and_then(crate::sections::messaging);
    if root.contains_key("messaging") && messaging.is_none() {
        p.push("messaging: Invalid messaging configuration".into());
    }
    if !p.is_empty() {
        return Err(invalid(path, p));
    }
    let mut result = json!({"name":name,"planner":{"agent":planner_agent,"account":planner_account},"accounts":accounts,"hosts":hosts,"runners":runners,"legacy":legacy,"runnerAliases":aliases,"providers":providers,"pacing":pacing,"routing":routing,
        "execution":if execution.is_object(){execution.clone()}else{json!({})},"classifier":if field(raw,"classifier").is_object(){field(raw,"classifier").clone()}else{json!({})},"taskRetentionDays":retention,"plugins":plug});
    if let Some(v) = dispatch {
        result["dispatch"] = v;
    }
    if let Some(v) = messaging {
        result["messaging"] = v;
    }
    if let Some(open) = raw.get("terminal").and_then(|t| t.get("open")) {
        let value = string(open);
        if value.len() > 2000 || value.bytes().any(|b| b < 32 || b == 127) {
            return Err(StrategyError::Other("invalid terminal.open".into()));
        }
        if !value.is_empty()
            && ![
                "ghostty",
                "iterm",
                "terminal-app",
                "wezterm",
                "kitty",
                "alacritty",
                "gnome-terminal",
                "x-terminal-emulator",
                "auto",
            ]
            .contains(&value.as_str())
            && !value.contains("{cmd}")
        {
            return Err(StrategyError::Other(
                "terminal.open requires a preset or a template with {cmd}".into(),
            ));
        }
        result["terminal"] = json!({"open":value});
    }
    Ok(result)
}

pub fn strategy_path(home: &Path) -> Result<(PathBuf, String), StrategyError> {
    let active = home.join("active");
    let name = if active.exists() {
        fs::read_to_string(active)?.trim().to_owned()
    } else {
        String::new()
    };
    if name.is_empty() {
        Ok((home.join("strategy.yaml"), "default".into()))
    } else {
        Ok((home.join("strategies").join(format!("{name}.yaml")), name))
    }
}
pub fn load_strategy(home: &Path) -> Result<Value, StrategyError> {
    let (path, name) = strategy_path(home)?;
    let text = fs::read_to_string(&path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            StrategyError::Missing(path.clone())
        } else {
            e.into()
        }
    })?;
    let raw =
        parse_value(&text).map_err(|e| invalid(&path, vec![format!("YAML syntax error: {e}")]))?;
    validate_strategy(&raw, &path, &name)
}
pub fn list_strategies(home: &Path) -> Result<Vec<String>, StrategyError> {
    let mut names = vec!["default".to_owned()];
    match fs::read_dir(home.join("strategies")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && let Some(name) = entry
                        .file_name()
                        .to_str()
                        .and_then(|n| n.strip_suffix(".yaml"))
                    && name != "default"
                {
                    names.push(name.into());
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    names[1..].sort();
    Ok(names)
}
fn provider_name(id: &str) -> String {
    match id {
        "claude-code" => "Claude".into(),
        "codex" => "Codex".into(),
        "cursor" => "Cursor".into(),
        "agy" => "Antigravity".into(),
        "byteplus" => "BytePlus".into(),
        "local" => "Local".into(),
        "opencode" => "OpenCode".into(),
        _ => {
            let mut c = id.chars();
            c.next().map_or_else(String::new, |x| {
                x.to_uppercase().collect::<String>() + c.as_str()
            })
        }
    }
}
fn display_name(id: &str) -> String {
    let (agent, account) = id.split_once('#').map_or((id, None), |(a, b)| (a, Some(b)));
    if agent == "opencode" {
        return account.map_or_else(|| provider_name(agent), provider_name);
    }
    if let Some(account) = account {
        return format!(
            "{} ({account})",
            if agent == "claude-code" {
                "Claude Code".into()
            } else {
                provider_name(agent)
            }
        );
    }
    provider_name(agent)
}
fn summary(strategy: &Value) -> String {
    let planner = strategy["planner"]["agent"].as_str().unwrap_or("");
    let first = strategy["pacing"]["order"]
        .as_array()
        .and_then(|a| a.iter().filter_map(Value::as_str).find(|id| *id != planner));
    let prefix = first.map_or_else(
        || "Configured executors".into(),
        |id| format!("{} first", display_name(id)),
    );
    let mut out = format!(
        "{prefix}, {} keeps {}%",
        display_name(planner),
        strategy["pacing"]["plannerReserve"]
    );
    if strategy["pacing"]["policy"] != "priority" {
        out.push_str(&format!(
            "; {} policy",
            strategy["pacing"]["policy"].as_str().unwrap_or("")
        ));
    }
    out
}
pub fn show_strategy(home: &Path, name: &str) -> Result<Value, StrategyError> {
    if !list_strategies(home)?.iter().any(|n| n == name) {
        return Err(StrategyError::Other(format!("unknown strategy \"{name}\"")));
    }
    let path = if name == "default" {
        home.join("strategy.yaml")
    } else {
        home.join("strategies").join(format!("{name}.yaml"))
    };
    let yaml = fs::read_to_string(&path)?;
    let raw =
        parse_value(&yaml).map_err(|e| invalid(&path, vec![format!("YAML syntax error: {e}")]))?;
    let strategy = validate_strategy(&raw, &path, name)?;
    Ok(
        json!({"yaml":yaml,"summary":summary(&strategy),"active":load_strategy(home)?["name"] == name}),
    )
}
pub fn list_strategy_reads(home: &Path) -> Result<Value, StrategyError> {
    let mut out = Vec::new();
    for name in list_strategies(home)? {
        match show_strategy(home,&name) {
        Ok(show) => { let yaml = show["yaml"].as_str().unwrap_or(""); let first = yaml.strip_prefix('#').and_then(|s| s.lines().next()).map(str::trim).unwrap_or("");
            let description = if first.to_ascii_lowercase().starts_with("pacer starter strategy") {""} else {first};
            out.push(json!({"name":name,"active":show["active"],"summary":show["summary"],"description":description})); },
        Err(_) => out.push(json!({"name":name,"active":false,"summary":"Invalid or missing strategy","description":""})),
    }
    }
    Ok(json!(out))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationResult {
    pub changed: bool,
    pub backup: Option<PathBuf>,
    pub summary: Vec<String>,
}

pub fn migration_lines(path: &Path, result: &MigrationResult) -> Vec<String> {
    if !result.changed {
        return Vec::new();
    }
    let quote = |value: &Path| format!("'{}'", value.to_string_lossy().replace('\'', "'\"'\"'"));
    let Some(backup) = result.backup.as_deref() else {
        return result.summary.clone();
    };
    let mut lines = result.summary.clone();
    lines.push(format!("Backup: {}", backup.display()));
    lines.push(format!("Restore: cp {} {}", quote(backup), quote(path)));
    lines
}

pub fn migrate_strategy(
    path: &Path,
    expected: Option<&str>,
) -> Result<MigrationResult, StrategyError> {
    let before = fs::read_to_string(path)?;
    if expected.is_some_and(|e| e != before) {
        return Err(StrategyError::Other(
            "strategy changed during migration; retry".into(),
        ));
    }
    let raw =
        parse_value(&before).map_err(|e| invalid(path, vec![format!("YAML syntax error: {e}")]))?;
    let strategy = validate_strategy(&raw, path, "default")?;
    if strategy["legacy"] == false {
        return Ok(MigrationResult {
            changed: false,
            backup: None,
            summary: vec![],
        });
    }
    let mut doc = StrategyDoc::new(&before);
    let kinds = strategy["accounts"]
        .as_object()
        .map(|all| {
            all.iter()
                .map(|(id, c)| (id.clone(), c["kind"].clone()))
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    doc.migrate_provider_kinds(&Value::Object(kinds))
        .map_err(|e| StrategyError::Other(e.to_string()))?;
    doc.rename_key(&[json!("providers")], "accounts")
        .map_err(|e| StrategyError::Other(e.to_string()))?;
    if let Some(all) = strategy["accounts"].as_object() {
        for (id, c) in all {
            if raw["providers"].get(id).is_none() {
                doc.set_in(
                    &[json!("accounts"), json!(id)],
                    &json!({"kind":c["kind"],"usage":c["usage"]}),
                )
                .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
        }
    }
    let planner = strategy["planner"]["agent"].as_str().unwrap_or("");
    doc.set_in(&[json!("planner")], &json!(planner))
        .map_err(|e| StrategyError::Other(e.to_string()))?;
    if raw.get("pacing").and_then(|p| p.get("order")).is_none() {
        doc.set_in(
            &[json!("pacing"), json!("order")],
            &strategy["pacing"]["order"],
        )
        .map_err(|e| StrategyError::Other(e.to_string()))?;
    }
    if raw.get("routing").is_none() {
        let route = strategy["routing"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|r| {
                if r["kinds"].is_null() {
                    json!({"default":r["executors"]})
                } else {
                    json!({"kinds":r["kinds"],"executors":r["executors"]})
                }
            })
            .collect::<Vec<_>>();
        doc.set_in(&[json!("routing")], &json!(route))
            .map_err(|e| StrategyError::Other(e.to_string()))?;
    }
    let canonical = |value: &Value| {
        let id = string(value);
        strategy["runnerAliases"]
            .get(&id)
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned()
    };
    if let Some(order) = raw
        .get("pacing")
        .and_then(|v| v.get("order"))
        .and_then(Value::as_array)
    {
        for (i, id) in order.iter().enumerate() {
            let resolved = canonical(id);
            if id != "opencode" && resolved != string(id) {
                doc.set_in(
                    &[json!("pacing"), json!("order"), json!(i)],
                    &json!(resolved),
                )
                .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
        }
    }
    if let Some(rules) = raw.get("routing").and_then(Value::as_array) {
        for (i, rule) in rules.iter().enumerate() {
            let key = if rule.get("default").is_some_and(Value::is_array) {
                "default"
            } else {
                "executors"
            };
            if let Some(ids) = rule.get(key).and_then(Value::as_array) {
                for (j, id) in ids.iter().enumerate() {
                    let resolved = canonical(id);
                    if resolved != string(id) {
                        doc.set_in(
                            &[json!("routing"), json!(i), json!(key), json!(j)],
                            &json!(resolved),
                        )
                        .map_err(|e| StrategyError::Other(e.to_string()))?;
                    }
                }
            }
        }
    }
    let mut referenced = std::collections::HashSet::new();
    for route in strategy["routing"].as_array().into_iter().flatten() {
        for id in route["executors"].as_array().into_iter().flatten() {
            if let Some(id) = id.as_str() {
                referenced.insert(id.to_owned());
            }
        }
    }
    referenced.insert(planner.to_owned());
    let mut unreferenced = Map::new();
    if let Some(all) = strategy["runners"].as_object() {
        for id in all.keys() {
            if !referenced.contains(id) {
                unreferenced.insert(id.clone(), json!({}));
            }
        }
    }
    if !unreferenced.is_empty() {
        doc.set_in(&[json!("runners")], &Value::Object(unreferenced))
            .map_err(|e| StrategyError::Other(e.to_string()))?;
    }
    let after = doc.as_str().to_owned();
    let parsed = parse_value(&after).map_err(|e| StrategyError::Other(e.to_string()))?;
    validate_strategy(&parsed, path, "default")?;
    let backup = PathBuf::from(format!("{}.pre-accounts.bak", path.display()));
    if backup.exists() {
        if fs::read_to_string(&backup)? != before {
            return Err(StrategyError::Other(format!(
                "migration backup already exists: {}; preserve or move it before retrying",
                backup.display()
            )));
        }
    } else {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options.open(&backup)?.write_all(before.as_bytes())?;
    }
    if fs::read_to_string(path)? != before {
        return Err(StrategyError::Other(
            "strategy changed during migration; retry".into(),
        ));
    }
    atomic_strategy_write(path, &after)?;
    Ok(MigrationResult {
        changed: true,
        backup: Some(backup),
        summary: vec![
            format!(
                "Migrated providers to {} accounts and {} runners.",
                strategy["accounts"].as_object().map_or(0, Map::len),
                strategy["runners"].as_object().map_or(0, Map::len)
            ),
            format!(
                "Planner: {planner} on {}; pacing order and routing preserved.",
                strategy["planner"]["account"].as_str().unwrap_or("")
            ),
        ],
    })
}
