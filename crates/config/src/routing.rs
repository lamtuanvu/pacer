//! Conservative read-only strategy model for the first native routing operation.

use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
};
use serde_json::{Value, json};
use serde_yaml::{Mapping, Value as Yaml};
use std::{collections::HashMap, fs, path::PathBuf};

const KINDS: &[&str] = &[
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
];
const MAX_STRATEGY_BYTES: u64 = 256 * 1024;

fn mapping(value: &Yaml) -> Option<&Mapping> {
    value.as_mapping()
}
fn get<'a>(map: &'a Mapping, name: &str) -> Option<&'a Yaml> {
    map.get(Yaml::String(name.to_owned()))
}
fn only(map: &Mapping, names: &[&str]) -> bool {
    map.keys()
        .all(|key| key.as_str().is_some_and(|key| names.contains(&key)))
}
fn strings(value: &Yaml) -> Option<Vec<String>> {
    value
        .as_sequence()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}
fn runner_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(i, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (i > 0 && byte == b'-')
        })
}

fn strategy_path(ctx: &Ctx) -> Option<PathBuf> {
    let active = ctx.pacer_home.join("active");
    let name = match fs::read_to_string(&active) {
        Ok(name) => name.trim().to_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return None,
    };
    if name.is_empty() {
        return Some(ctx.pacer_home.join("strategy.yaml"));
    }
    if name.len() > 40
        || name == "default"
        || !name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'-'))
    {
        return None;
    }
    Some(
        ctx.pacer_home
            .join("strategies")
            .join(format!("{name}.yaml")),
    )
}

fn read_strategy(ctx: &Ctx) -> Option<Yaml> {
    let path = strategy_path(ctx)?;
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_STRATEGY_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_STRATEGY_BYTES {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    // Anchors, merge keys and tags have parser-specific behavior. Until the
    // strategy port covers them, keep those documents with the TypeScript core.
    if text.contains('&') || text.contains('*') || text.contains('!') || text.contains("<<") {
        return None;
    }
    serde_yaml::from_str(text).ok()
}

fn canonical_runner(
    reference: &str,
    defaults: &HashMap<String, String>,
    kinds: &HashMap<String, String>,
) -> Option<String> {
    if reference.contains('@') {
        return None;
    }
    let (agent, account) = reference
        .split_once('#')
        .map_or((reference, None), |(a, b)| (a, Some(b)));
    let expected = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor",
        "agy" => "agy",
        _ => return None,
    };
    let account = account.or_else(|| defaults.get(agent).map(String::as_str))?;
    if kinds.get(account).map(String::as_str) != Some(expected) {
        return None;
    }
    if defaults.get(agent).is_some_and(|name| name == account) {
        Some(agent.to_owned())
    } else {
        Some(format!("{agent}#{account}"))
    }
}

fn model(value: &Yaml) -> Option<Value> {
    let root = mapping(value)?;
    if !only(root, &["accounts", "planner", "routing", "pacing"]) {
        return None;
    }
    let accounts = mapping(get(root, "accounts")?)?;
    if accounts.is_empty() {
        return None;
    }
    let mut kinds = HashMap::new();
    let mut counts = HashMap::<&str, usize>::new();
    for (name, config) in accounts {
        let name = name.as_str()?;
        if !runner_name(name) {
            return None;
        }
        let config = mapping(config)?;
        if !only(config, &["kind"]) {
            return None;
        }
        let kind = get(config, "kind")?.as_str()?;
        if !["claude", "codex", "cursor", "agy"].contains(&kind) {
            return None;
        }
        *counts.entry(kind).or_default() += 1;
        kinds.insert(name.to_owned(), kind.to_owned());
    }
    // Multiple default accounts of the same kind are invalid in the reference.
    if counts.values().any(|count| *count > 1) {
        return None;
    }
    let mut defaults = HashMap::new();
    for (name, kind) in &kinds {
        let agent = if kind == "claude" {
            "claude-code"
        } else {
            kind.as_str()
        };
        defaults.insert(agent.to_owned(), name.clone());
    }
    let planner = get(root, "planner")?.as_str()?;
    if !["claude-code", "codex", "cursor"]
        .iter()
        .any(|agent| planner.starts_with(agent))
    {
        return None;
    }
    let planner = canonical_runner(planner, &defaults, &kinds)?;
    let mut available = vec![planner.clone()];
    let mut rules = Vec::new();
    if let Some(raw) = get(root, "routing") {
        for rule in raw.as_sequence()? {
            let rule = mapping(rule)?;
            if !only(rule, &["default", "executors", "kinds"]) {
                return None;
            }
            let is_default = get(rule, "default").is_some();
            if is_default && (get(rule, "executors").is_some() || get(rule, "kinds").is_some()) {
                return None;
            }
            let refs = strings(get(rule, if is_default { "default" } else { "executors" })?)?;
            if refs.is_empty() {
                return None;
            }
            let mut executors = Vec::new();
            for reference in refs {
                let id = canonical_runner(&reference, &defaults, &kinds)?;
                if !available.contains(&id) {
                    available.push(id.clone());
                }
                executors.push(id);
            }
            if is_default {
                rules.push(json!({"executors":executors}));
            } else {
                let kinds = strings(get(rule, "kinds")?)?;
                if kinds.is_empty() || kinds.iter().any(|kind| !KINDS.contains(&kind.as_str())) {
                    return None;
                }
                rules.push(json!({"kinds":kinds,"executors":executors}));
            }
        }
    } else {
        rules.push(json!({"executors":available.clone()}));
    }
    if let Some(pacing) = get(root, "pacing") {
        let pacing = mapping(pacing)?;
        if !only(pacing, &["order", "policy"]) {
            return None;
        }
        if let Some(policy) = get(pacing, "policy")
            && !["priority", "even", "burn-before-reset", "cheapest-first"]
                .contains(&policy.as_str()?)
        {
            return None;
        }
        if let Some(order) = get(pacing, "order") {
            for reference in strings(order)? {
                let id = canonical_runner(&reference, &defaults, &kinds)?;
                if !available.contains(&id) {
                    return None;
                }
            }
        }
    }
    Some(json!({"rules":rules,"available":available}))
}

fn load(ctx: &Ctx) -> Option<Value> {
    model(&read_strategy(ctx)?)
}

/// True when this strategy needs Bun's broader YAML and validation semantics.
pub fn requires_core_routing_parser(ctx: &Ctx) -> bool {
    load(ctx).is_none()
}

/// Read-only native `routing.get` for the validated strategy subset.
pub fn routing_get(ctx: &Ctx) -> Result<Value, CoreError> {
    load(ctx).ok_or_else(|| CoreError::new(Code::Conflict, "strategy changed during routing read"))
}

fn get_op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move {
        if !params.is_object() && !params.is_null() {
            let received = match params {
                Value::Array(_) => "array",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => "unknown",
            };
            return Err(CoreError::new(
                Code::InvalidInput,
                format!("params: Invalid input: expected object, received {received}"),
            ));
        }
        routing_get(ctx)
    })
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "routing.get",
        call: get_op,
    }]
}
