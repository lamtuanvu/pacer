//! `effectivePolicy` and `checkSend` from `src/messaging/policy.ts`, as `msg.policy` reports them.
use pacer_config::{project_messaging, strategy};
use pacer_store::{
    StoreError, TaskStore,
    messages::{count_sent_since, parent_of, root_of, task_of},
};
use serde_json::{Map, Value, json};
use std::path::Path;

type Result<T> = std::result::Result<T, StoreError>;

const MAX_DEPTH: usize = 64;

fn default_rules() -> Value {
    json!([
        {"effect":"allow","from_kind":"human"},
        {"effect":"allow","to_kind":"human"},
        {"effect":"allow","from_position":"top","relation":["child","top_peer"]},
        {"effect":"allow","from_position":"child","relation":["parent"]},
        {"effect":"allow","from_position":"child","relation":["sibling","child"],"grant":"required"},
        {"effect":"allow","from_kind":"external","relation":["child"]},
    ])
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Array.prototype.includes`, or `String.prototype.includes` for a string.
fn includes(list: &Value, item: &str) -> bool {
    match list {
        Value::Array(items) => items.iter().any(|v| v == item),
        Value::String(s) => s.contains(item),
        _ => false,
    }
}

/// `JSON.parse` numbers: imported task records keep integral values as floats (`4.0`).
fn js_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15) {
                *value = json!(f as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(js_numbers),
        Value::Object(map) => map.values_mut().for_each(js_numbers),
        _ => {}
    }
}

/// `readTask` for a `task:` participant.
fn read_task(store: &mut TaskStore, p: &str) -> Result<Option<Value>> {
    let Some(id) = task_of(p) else {
        return Ok(None);
    };
    let mut task = store.read(id)?;
    if let Some(task) = task.as_mut() {
        js_numbers(task);
    }
    Ok(task)
}

fn participant_kind(p: &str) -> &'static str {
    match p {
        "human" => "human",
        "broker" => "broker",
        _ if p.starts_with("external:") => "external",
        _ => "launched",
    }
}

/// The strategy messaging section, or the defaults when the strategy is missing or invalid.
/// Rules are normalized to the Zod schema key order, as `parseMessagingConfig` returns them.
fn strategy_config(home: &Path) -> Value {
    let mut config = strategy::load_strategy(home)
        .ok()
        .and_then(|s| s.get("messaging").cloned())
        .unwrap_or_else(strategy::default_messaging_config);
    if let Some(rules) = config.get_mut("rules").and_then(Value::as_array_mut) {
        for rule in rules {
            if let Some(normal) = project_messaging::rule(rule) {
                *rule = normal;
            }
        }
    }
    config
}

fn layered(rules: Option<&Value>, layer: &str, out: &mut Vec<Value>) {
    for rule in rules.and_then(Value::as_array).into_iter().flatten() {
        let mut map = rule.as_object().cloned().unwrap_or_default();
        map.insert("layer".into(), json!(layer));
        out.push(Value::Object(map));
    }
}

/// `effectivePolicy(ctx, { root })`: `{config, rules}`. An unusable project file stays forwarded.
pub fn effective(home: &Path, store: &mut TaskStore, root: Option<&str>) -> Result<Value> {
    let mut config = strategy_config(home);
    let root_task = match root {
        Some(root) => read_task(store, root)?,
        None => None,
    };
    let tree = root_task.as_ref().and_then(|t| t.get("messaging"));
    let projects = project_messaging::read_projects(home).unwrap_or_default();
    let project = root_task
        .as_ref()
        .and_then(|t| t.get("repo")?.get("key")?.as_str())
        .and_then(|repo| projects.get(repo));
    if let Some(turns) = project
        .and_then(|p| p.get("max_turns"))
        .filter(|v| truthy(Some(v)))
    {
        config["tree"]["max_turns"] = turns.clone();
    }
    if let Some(live) = project.and_then(|p| p.get("liveness")?.as_object()) {
        for (key, value) in live {
            config["liveness"][key] = value.clone();
        }
    }
    if let Some(turns) = tree
        .and_then(|t| t.get("max_turns"))
        .filter(|v| truthy(Some(v)))
    {
        config["tree"]["max_turns"] = turns.clone();
    }
    let mut rules = Vec::new();
    layered(tree.and_then(|t| t.get("rules")), "tree", &mut rules);
    layered(project.and_then(|p| p.get("rules")), "project", &mut rules);
    layered(config.get("rules"), "global", &mut rules);
    if truthy(config.get("defaults")) {
        layered(Some(&default_rules()), "default", &mut rules);
    }
    Ok(json!({"config": config, "rules": rules}))
}

fn ancestors(store: &mut TaskStore, p: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut current = parent_of(store, p)?;
    while let Some(node) = current
        .take()
        .filter(|n| !n.is_empty() && out.len() < MAX_DEPTH)
    {
        current = parent_of(store, &node)?;
        out.push(node);
    }
    Ok(out)
}

/// `isTop`: an identified external agent, or a task whose parent is the human.
fn is_top(store: &mut TaskStore, p: &str) -> Result<bool> {
    Ok(match participant_kind(p) {
        "external" => p != "external:local",
        "human" => false,
        _ => parent_of(store, p)?.as_deref() == Some("human"),
    })
}

/// `relation(ctx, from, to)`.
fn relation(store: &mut TaskStore, from: &str, to: &str) -> Result<&'static str> {
    if from == to {
        return Ok("self");
    }
    let from_parent = parent_of(store, from)?;
    let to_parent = parent_of(store, to)?;
    if from_parent.as_deref() == Some(to) {
        return Ok("parent");
    }
    if to_parent.as_deref() == Some(from) {
        return Ok("child");
    }
    if is_top(store, from)? && is_top(store, to)? {
        return Ok("top_peer");
    }
    if from_parent
        .as_deref()
        .is_some_and(|p| !p.is_empty() && p != "human" && Some(p) == to_parent.as_deref())
    {
        return Ok("sibling");
    }
    if ancestors(store, to)?.iter().any(|a| a == from) {
        return Ok("descendant");
    }
    if ancestors(store, from)?.iter().any(|a| a == to) {
        return Ok("ancestor");
    }
    if task_of(from).is_some()
        && task_of(to).is_some()
        && root_of(store, from)? == root_of(store, to)?
    {
        return Ok("same_tree");
    }
    Ok("none")
}

/// A hypothetical send in `msg.policy`: zero bytes, so the size cap never applies.
pub struct Send<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub kind: &'a str,
    pub grant: bool,
}

fn deny(code: &str, message: String, data: Option<Value>) -> Value {
    let mut error = json!({"code": code, "message": message});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"decision": "deny", "error": error})
}

/// `checkSend`, with its `CoreError` reported as `{decision: "deny", error}`.
pub fn check(home: &Path, store: &mut TaskStore, now: f64, s: &Send<'_>) -> Result<Value> {
    let anchor = if task_of(s.to).is_some() {
        s.to
    } else {
        s.from
    };
    let root = root_of(store, anchor)?;
    let policy = effective(home, store, Some(&root))?;
    let rules = policy["rules"].as_array().cloned().unwrap_or_default();
    let rel = relation(store, s.from, s.to)?;
    let position = if is_top(store, s.from)? {
        "top"
    } else {
        "child"
    };
    let (from_task, to_task) = (read_task(store, s.from)?, read_task(store, s.to)?);
    if task_of(s.to).is_some() && to_task.is_none() {
        return Ok(deny(
            "not_found",
            format!("Unknown participant {}", s.to),
            None,
        ));
    }
    let pick = |path: [&str; 2]| -> [Option<&Value>; 2] {
        [&from_task, &to_task].map(|t| t.as_ref()?.get(path[0])?.get(path[1]))
    };
    let (repos, executors) = (pick(["brief", "repo"]), pick(["run", "executor"]));
    let human = participant_kind(s.from) == "human";
    let kind_ok = |want: Option<&Value>, p: &str| {
        !truthy(want) || want.is_some_and(|w| w == "any" || w == participant_kind(p))
    };
    let matches = |r: &Value, grant: bool| {
        let field = |k: &str| r.get(k);
        let any_of = |k: &str, values: &[Option<&Value>; 2]| {
            !truthy(field(k)) || values.iter().any(|v| *v == field(k))
        };
        kind_ok(field("from_kind"), s.from)
            && kind_ok(field("to_kind"), s.to)
            && (!truthy(field("from_position"))
                || field("from_position").is_some_and(|p| p == "any" || (!human && p == position)))
            && (!truthy(field("relation"))
                || field("relation").is_some_and(|v| v == "any" || includes(v, rel)))
            && (!truthy(field("kinds")) || field("kinds").is_some_and(|v| includes(v, s.kind)))
            && any_of("repo", &repos)
            && any_of("executor", &executors)
            && (!grant
                || !truthy(field("grant"))
                || (field("grant").is_some_and(|g| g == "required")) == s.grant)
    };
    let index = rules.iter().position(|r| matches(r, true));
    let layer_of = |r: &Value| r["layer"].clone();
    let rule = match index.map(|i| (i, &rules[i])) {
        Some((i, rule)) if rule["effect"] != "deny" => (i, rule),
        found => {
            let base = format!(
                "Messaging from {} to {} ({rel}) is not allowed",
                s.from, s.to
            );
            if let Some((i, rule)) = found {
                let message = format!(
                    "{base}: rule {i} ({}) denies it",
                    rule["layer"].as_str().unwrap_or_default()
                );
                let data = json!({"reason": "msg_forbidden", "layer": layer_of(rule), "rule": i, "relation": rel});
                return Ok(deny("not_allowed", message, Some(data)));
            }
            let near = rules.iter().position(|r| {
                r["effect"] == "allow"
                    && r.get("grant").is_some_and(|g| g == "required")
                    && !s.grant
                    && matches(r, false)
            });
            let mut data = Map::new();
            data.insert("reason".into(), json!("msg_forbidden"));
            data.insert("layer".into(), json!("none"));
            data.insert("relation".into(), json!(rel));
            let mut message = format!("{base}: no rule matched");
            if let Some(near) = near {
                let layer = layer_of(&rules[near]);
                message += &format!(
                    "; rule {near} ({}) allows it with a work grant",
                    layer.as_str().unwrap_or_default()
                );
                data.insert(
                    "closest".into(),
                    json!({"rule": near, "layer": layer, "grant": "required"}),
                );
            }
            return Ok(deny("not_allowed", message, Some(Value::Object(data))));
        }
    };
    let (index, rule) = rule;
    let limits = rule.get("limits");
    if let Some(cap) = limits
        .and_then(|l| l.get("per_minute"))
        .filter(|v| truthy(Some(v)))
        && (count_sent_since(store, s.from, now - 60.0)? as f64) >= cap.as_f64().unwrap_or(f64::NAN)
    {
        let data = json!({"reason": "msg_cap_reached", "limit": "per_minute"});
        return Ok(deny(
            "conflict",
            "Message rate limit reached".into(),
            Some(data),
        ));
    }
    let hold = truthy(limits.and_then(|l| l.get("confirm"))) && !human;
    Ok(json!({"decision": "allow", "hold": hold, "rule": index, "layer": rule["layer"]}))
}

#[cfg(test)]
mod tests;
