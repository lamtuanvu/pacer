//! Managed endpoint `account.add`, `account.edit` and `account.adopt` from
//! `src/core/endpoints.ts` when no key is written and no test task runs.
use crate::{
    SETTINGS_CONFLICT,
    js::{array_index, prototype_key, redact},
    model::{endpoint_row, endpoint_states_native, ts_account, ts_runner, write_endpoint_state},
    params::{self, Endpoint},
    strategy_loads,
};
use pacer_config::{
    config_writes::{edit, ensure_migrated},
    doc::StrategyDoc,
    strategy::{StrategyError, load_strategy},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Map, Value, json};

const ENDPOINT_REQUIRED: &str = "a configured endpoint account is required";

/// `endpointAction`: the redacted message, its code and no hint.
fn fail(code: Code, message: &str) -> CoreError {
    CoreError::new(code, redact(&redact(message)))
}

fn invalid(message: impl AsRef<str>) -> CoreError {
    fail(Code::InvalidInput, message.as_ref())
}

fn strategy_error(error: StrategyError) -> CoreError {
    let message = error.to_string();
    if message == SETTINGS_CONFLICT || message.contains("changed during edit") {
        return fail(Code::Conflict, SETTINGS_CONFLICT);
    }
    invalid(message)
}

fn parse(op: &str, params: &Value) -> Option<Endpoint> {
    match op {
        "account.add" => params::add(params).filter(|p| p.test == Some(false)),
        "account.edit" => params::edit(params).filter(|p| p.test != Some(true)),
        "account.adopt" => params::adopt(params),
        _ => None,
    }
    .filter(|p| !p.key)
}

/// Adds with a test task or a key, edits that test or write a key, and inputs
/// whose files only TypeScript reads the same way stay forwarded.
pub(crate) fn stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    let Some(p) = parse(op, params) else {
        return true;
    };
    prototype_key(&p.name)
        || !strategy_loads(ctx)
        || !endpoint_states_native(ctx)
        || (op == "account.adopt" && external(ctx, &p.name).is_none())
}

/// `account(ctx, name)`: a configured endpoint account.
fn endpoint_account(s: &Value, name: &str) -> Result<Value, CoreError> {
    s["accounts"]
        .get(name)
        .filter(|a| a["kind"] == "endpoint")
        .cloned()
        .ok_or_else(|| invalid(ENDPOINT_REQUIRED))
}

/// `externalEndpoint`'s inputs, read only when the result is the same as
/// TypeScript's; `Some(Err)` is a TypeScript refusal.
fn external(ctx: &Ctx, name: &str) -> Option<Result<(String, Vec<Value>), String>> {
    let s = load_strategy(&ctx.pacer_home).ok()?;
    let Some(account) = s["accounts"].get(name).filter(|a| a["kind"] == "endpoint") else {
        return Some(Err(ENDPOINT_REQUIRED.into()));
    };
    if account.get("connection").is_some_and(Value::is_object) {
        return Some(Err("endpoint is already managed".into()));
    }
    let runner_model = s["runners"].as_object().and_then(|runners| {
        runners
            .values()
            .find(|r| r["account"] == name && r["agent"] == "opencode")
            .map(|r| r["model"].clone())
    });
    let model = match runner_model {
        Some(m) if !m.is_null() => m,
        Some(_) | None => account["model"].clone(),
    };
    let provider = model.as_str().map(|m| m.split('/').next().unwrap_or(""));
    let Some(provider) = provider.filter(|p| !p.is_empty()) else {
        return Some(Err("external OpenCode provider not found".into()));
    };
    if prototype_key(provider) {
        return None;
    }
    let path = ctx.home.join(".config/opencode/opencode.json");
    let config = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(config) = config else {
        return Some(Err(
            "could not read external OpenCode provider metadata".into()
        ));
    };
    let entry = config
        .get("provider")
        .filter(|p| p.is_object())
        .and_then(|p| p.get(provider));
    let Some(base_url) = entry.and_then(|e| e["options"]["baseURL"].as_str()) else {
        return Some(Err("external provider baseURL not found".into()));
    };
    let models = match entry.and_then(|e| e.get("models")) {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) if !m.keys().any(|k| array_index(k)) => m.clone(),
        Some(_) => return None,
    };
    let models = models
        .keys()
        .map(|id| json!({"id": id, "context": 128000, "output": 16000, "tools": true}))
        .collect();
    Some(Ok((base_url.to_owned(), models)))
}

/// The `save` input after the edit and adopt defaults are applied.
struct Input {
    name: String,
    base_url: String,
    key_source: String,
    env_var: Option<String>,
    models: Vec<Value>,
    usage: String,
    weekly_tokens: Option<Value>,
    quota_source: Option<Value>,
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn input(ctx: &Ctx, op: &str, p: Endpoint) -> Result<Input, CoreError> {
    if op == "account.add" {
        return Ok(Input {
            name: p.name,
            base_url: p.base_url.unwrap_or_default(),
            key_source: p.key_source.unwrap_or_default(),
            env_var: p.env_var,
            models: p.models.unwrap_or_default(),
            usage: p.usage.unwrap_or_default(),
            weekly_tokens: p.weekly_tokens.map(Value::from),
            quota_source: p.quota_source.map(Value::from),
        });
    }
    let s = load_strategy(&ctx.pacer_home).map_err(|e| invalid(e.to_string()))?;
    let account = endpoint_account(&s, &p.name)?;
    let known = |v: &Value| (!v.is_null()).then(|| v.clone());
    let weekly = p
        .weekly_tokens
        .map(Value::from)
        .or(known(&account["weeklyTokens"]));
    let quota = p
        .quota_source
        .map(Value::from)
        .or(known(&account["quotaSource"]));
    let usage = p.usage.or(text(&account["usage"])).unwrap_or_default();
    if op == "account.adopt" {
        let (base_url, models) = match external(ctx, &p.name) {
            Some(Ok(found)) => found,
            Some(Err(message)) => return Err(invalid(message)),
            None => return Err(crate::forwarded()),
        };
        return Ok(Input {
            name: p.name,
            base_url,
            key_source: p.key_source.unwrap_or_default(),
            env_var: p.env_var,
            models,
            usage,
            weekly_tokens: weekly,
            quota_source: quota,
        });
    }
    let c = &account["connection"];
    if !c.is_object() {
        return Err(invalid(format!(
            "External OpenCode provider; adopt with pacer account edit {}",
            p.name
        )));
    }
    let models = p.models.unwrap_or_else(|| {
        c["models"]
            .as_array()
            .into_iter()
            .flatten()
            .map(crate::model::ts_model)
            .collect()
    });
    Ok(Input {
        base_url: p.base_url.or(text(&c["base_url"])).unwrap_or_default(),
        key_source: p.key_source.or(text(&c["key"])).unwrap_or_default(),
        env_var: p.env_var,
        models,
        usage,
        weekly_tokens: weekly,
        quota_source: quota,
        name: p.name,
    })
}

/// `source(input)`.
fn key_source(input: &Input) -> Option<String> {
    let value = if input.key_source == "env" {
        format!("env:{}", input.env_var.as_deref().unwrap_or(""))
    } else {
        input.key_source.clone()
    };
    let env = value.strip_prefix("env:").is_some_and(|var| {
        let b = var.as_bytes();
        !b.is_empty()
            && (b[0].is_ascii_alphabetic() || b[0] == b'_')
            && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
    });
    (env || ["keychain", "file", "none"].contains(&value.as_str())).then_some(value)
}

fn at(parts: &[&str]) -> Vec<Value> {
    parts.iter().map(|p| json!(p)).collect()
}

/// `addRunnerAndRoute`: the runner and the default routing rule, in the same edit.
fn add_runner_and_route(
    doc: &mut StrategyDoc,
    s: &Value,
    id: &str,
    model: &str,
) -> Result<(), pacer_config::doc::EditError> {
    if s["runners"].get(id).is_some() {
        return Ok(());
    }
    doc.add_mapping_entry("runners", id, &json!({"model": model}))?;
    let rules = match doc.get_in(&at(&["routing"]))? {
        Some(Value::Array(rules)) => rules,
        _ => {
            let rules: Vec<Value> = s["routing"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| match r.get("kinds").filter(|k| !k.is_null()) {
                    Some(kinds) => json!({"kinds": kinds, "executors": r["executors"]}),
                    None => json!({"default": r["executors"]}),
                })
                .collect();
            doc.set_in(&at(&["routing"]), &Value::Array(rules.clone()))?;
            rules
        }
    };
    match rules.iter().position(|r| r["default"].is_array()) {
        None => {
            let mut rules = rules;
            rules.push(json!({"default": [id]}));
            doc.set_in(&at(&["routing"]), &Value::Array(rules))
        }
        Some(index) => {
            let mut list = rules[index]["default"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            list.push(json!(id));
            doc.set_list(&[json!("routing"), json!(index), json!("default")], &list)
        }
    }
}

/// The `save` change: account, budget, quota source, OpenCode runner models and route.
fn change(
    doc: &mut StrategyDoc,
    s: &Value,
    input: &Input,
    connection: &Value,
    editing: bool,
) -> Result<(), pacer_config::doc::EditError> {
    let name = input.name.as_str();
    let account = |key: &str| at(&["accounts", name, key]);
    if !editing {
        doc.add_mapping_entry(
            "accounts",
            name,
            &json!({"kind": "endpoint", "usage": input.usage, "connection": connection}),
        )?;
    } else {
        doc.set_in(&account("connection"), connection)?;
        doc.set_in(&account("usage"), &json!(input.usage))?;
        let prior = &s["accounts"][name];
        let keep = prior["connection"].is_object()
            && input.models.iter().any(|m| {
                let id = m["id"].as_str().unwrap_or("");
                prior["model"] == id || prior["model"] == format!("pacer-{name}/{id}").as_str()
            });
        if !keep {
            doc.delete_in(&account("model"))?;
        }
    }
    if input.usage == "metered"
        && let Some(n) = &input.weekly_tokens
    {
        doc.set_in(&at(&["accounts", name, "budget", "weekly_tokens"]), n)?;
    }
    if let Some(q) = &input.quota_source {
        doc.set_in(&account("quota_source"), q)?;
    }
    if input.usage != "quota" {
        doc.delete_in(&account("quota_source"))?;
    }
    if input.usage != "metered" {
        doc.delete_in(&account("budget"))?;
    }
    let first = input
        .models
        .first()
        .and_then(|m| m["id"].as_str())
        .unwrap_or("");
    let prefix = format!("pacer-{name}/");
    let runners = s["runners"].as_object().into_iter().flatten();
    for runner in runners
        .map(|(_, r)| r)
        .filter(|r| r["account"] == name && r["agent"] == "opencode")
    {
        let declarations = doc
            .get_in(&at(&["runners"]))?
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let current = runner["model"].as_str().unwrap_or("");
        let selected = if current.starts_with(&prefix)
            && input
                .models
                .iter()
                .any(|m| format!("{prefix}{}", m["id"].as_str().unwrap_or("")) == current)
        {
            current.to_owned()
        } else {
            format!("{prefix}{first}")
        };
        for reference in declarations.keys() {
            if s["runnerAliases"][reference] == runner["id"] || runner["id"] == reference.as_str() {
                doc.set_in(&at(&["runners", reference, "model"]), &json!(selected))?;
            }
        }
    }
    add_runner_and_route(
        doc,
        s,
        &format!("opencode#{name}"),
        &format!("{prefix}{first}"),
    )
}

pub(crate) async fn save(ctx: &Ctx, op: &str, params: &Value) -> Result<Value, CoreError> {
    let p = parse(op, params).ok_or_else(crate::forwarded)?;
    let editing = op != "account.add";
    let input = input(ctx, op, p)?;
    let home = &ctx.pacer_home;
    let name = input.name.clone();
    let migrated = ensure_migrated(home).map_err(strategy_error)?;
    let s = load_strategy(home).map_err(strategy_error)?;
    if !crate::js::account_name(&name) {
        return Err(invalid("invalid endpoint name"));
    }
    if !editing && s["accounts"].get(&name).is_some() {
        return Err(invalid(format!(
            "account {name} already exists; use pacer account edit {name}"
        )));
    }
    if editing {
        endpoint_account(&s, &name)?;
    }
    if !["quota", "metered", "unmetered"].contains(&input.usage.as_str()) {
        return Err(invalid("usage must be quota, metered or unmetered"));
    }
    let source = key_source(&input).ok_or_else(|| invalid("invalid endpoint key source"))?;
    if matches!(source.as_str(), "file" | "keychain")
        && (!editing || s["accounts"][&name]["connection"]["key"] != source.as_str())
    {
        return Err(invalid("endpoint key must not be empty"));
    }
    let connection = json!({
        "api": "openai-compatible",
        "base_url": input.base_url,
        "key": source,
        "models": input.models,
    });
    edit(home, |doc, current| {
        change(doc, current, &input, &connection, editing)
            .map_err(|e| StrategyError::Other(e.to_string()))
    })
    .map_err(strategy_error)?;
    write_endpoint_state(ctx, &name, json!({"state": "not_tested"})).map_err(invalid)?;
    let updated = load_strategy(home).map_err(strategy_error)?;
    let loaded = &updated["accounts"][&name];
    let row = endpoint_row(ctx, &name, &loaded["connection"])
        .await
        .map_err(invalid)?;
    let missing = row["state"] == "key_missing";
    let mut account = ts_account(loaded);
    account.extend(row);
    let mut result = Map::new();
    if let Some(migrated) = migrated {
        result.insert("migrated".into(), migrated);
    }
    result.insert("account".into(), Value::Object(account));
    if let Some(runner) = updated["runners"].get(format!("opencode#{name}")) {
        result.insert("runner".into(), ts_runner(runner));
    }
    result.insert(
        "state".into(),
        json!(if missing { "key_missing" } else { "not_tested" }),
    );
    Ok(Value::Object(result))
}
