//! Pure strategy document writes. The API caller owns endpoint sync and publication.

use crate::{
    doc::StrategyDoc,
    strategy::{StrategyError, load_strategy, migrate_strategy, strategy_path},
    write::atomic_strategy_write,
};
use serde_json::{Value, json};
use std::{collections::HashSet, fs, path::Path};

#[cfg(test)]
mod tests;

fn selected_settings_match(home: &Path, path: &Path, before: &str) -> bool {
    strategy_path(home).is_ok_and(|(selected, _)| selected == path)
        && fs::read_to_string(path).is_ok_and(|current| current == before)
}

pub fn ensure_migrated(home: &Path) -> Result<Option<Value>, StrategyError> {
    let (path, _) = strategy_path(home)?;
    let before = fs::read_to_string(&path)?;
    let strategy = load_strategy(home)?;
    if !selected_settings_match(home, &path, &before) {
        return Err(StrategyError::Other(
            "Your settings changed while they were being updated. Try again.".into(),
        ));
    }
    if strategy["legacy"] != true {
        return Ok(None);
    }
    let migration = migrate_strategy(&path, Some(&before))?;
    if !strategy_path(home).is_ok_and(|(selected, _)| selected == path) {
        return Err(StrategyError::Other(
            "Your settings changed while they were being updated. Try again.".into(),
        ));
    }
    if !migration.changed {
        return Ok(None);
    }
    Ok(Some(
        json!({"changed":true,"backup":migration.backup,"summary":migration.summary}),
    ))
}

pub fn edit(
    home: &Path,
    change: impl FnOnce(&mut StrategyDoc, &Value) -> Result<(), StrategyError>,
) -> Result<String, StrategyError> {
    let (path, name) = strategy_path(home)?;
    let before = fs::read_to_string(&path)?;
    let strategy = load_strategy(home)?;
    if !selected_settings_match(home, &path, &before) {
        return Err(StrategyError::Other(
            "Your settings changed while they were being updated. Try again.".into(),
        ));
    }
    let mut doc = StrategyDoc::new(&before);
    change(&mut doc, &strategy)?;
    let after = doc.as_str();
    let raw =
        crate::doc::parse_yaml_value(after).map_err(|e| StrategyError::Other(e.to_string()))?;
    crate::strategy::validate_yaml_strategy(&raw, &path, &name)?;
    if before == after {
        return Ok(String::new());
    }
    if !selected_settings_match(home, &path, &before) {
        return Err(StrategyError::Other(
            "Your settings changed while they were being updated. Try again.".into(),
        ));
    }
    atomic_strategy_write(&path, after)?;
    Ok(diff(&path.display().to_string(), &before, after))
}

fn diff(path: &str, before: &str, after: &str) -> String {
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let mut out = vec![
        format!("--- {path}"),
        format!("+++ {path}"),
        format!(
            "@@ -{},{} +{},{} @@",
            start + 1,
            end_a - start,
            start + 1,
            end_b - start
        ),
    ];
    out.extend(a[start..end_a].iter().map(|line| format!("-{line}")));
    out.extend(b[start..end_b].iter().map(|line| format!("+{line}")));
    out.join("\n")
}

/// Resolve a runner id or alias the same way TypeScript `resolveRunner` does.
pub fn resolve<'a>(strategy: &'a Value, id: &str) -> Option<&'a Value> {
    if let Some(runner) = strategy["runners"].get(id) {
        return Some(runner);
    }
    if let Some(alias) = strategy["runnerAliases"].get(id).and_then(Value::as_str)
        && let Some(runner) = strategy["runners"].get(alias)
    {
        return Some(runner);
    }
    let (agent, account, host) = parse_runner_ref(id).or_else(|| {
        (strategy["accounts"][id]["kind"] == "endpoint").then_some(("opencode", Some(id), None))
    })?;
    let account = account.or_else(|| default_account(strategy, agent));
    let account_part = if agent != "opencode" && account == default_account(strategy, agent) {
        String::new()
    } else {
        account.map_or(String::new(), |name| format!("#{name}"))
    };
    let canonical = format!(
        "{agent}{account_part}{}",
        host.map_or(String::new(), |name| format!("@{name}"))
    );
    strategy["runners"].get(&canonical)
}

fn runner_component(text: &str) -> bool {
    (text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        || text.as_bytes().first().is_some_and(u8::is_ascii_digit))
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub fn parse_runner_ref(reference: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    let (body, host) = match reference.split_once('@') {
        Some((body, host)) if runner_component(host) => (body, Some(host)),
        Some(_) => return None,
        None => (reference, None),
    };
    let (agent, account) = match body.split_once('#') {
        Some((agent, account)) if runner_component(account) => (agent, Some(account)),
        Some(_) => return None,
        None => (body, None),
    };
    if !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent)
        || !runner_component(agent)
    {
        return None;
    }
    Some((agent, account, host.filter(|name| *name != "local")))
}

pub fn default_account<'a>(strategy: &'a Value, agent: &str) -> Option<&'a str> {
    let kind = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor",
        "agy" => "agy",
        _ => return None,
    };
    let mut matches = strategy["accounts"]
        .as_object()?
        .values()
        .filter(|account| {
            account["kind"] == kind && account["home"].is_null() && account["orcaAccount"].is_null()
        });
    let one = matches.next()?["name"].as_str()?;
    matches.next().is_none().then_some(one)
}

pub(crate) fn planner(strategy: &Value, runner: &Value) -> bool {
    runner["host"].is_null()
        && runner["agent"] == strategy["planner"]["agent"]
        && runner["account"] == strategy["planner"]["account"]
}

pub(crate) fn executor_ids(strategy: &Value) -> Vec<String> {
    strategy["runners"]
        .as_object()
        .into_iter()
        .flat_map(|map| map.values())
        .filter(|runner| !planner(strategy, runner))
        .filter_map(|runner| runner["id"].as_str().map(str::to_owned))
        .collect()
}

/// Match `orderedExecutorIds`: pacing order first, then remaining non-planner runners.
pub(crate) fn ordered_executor_ids(strategy: &Value) -> Vec<String> {
    let ids = executor_ids(strategy);
    let mut order = Vec::new();
    for reference in strategy["pacing"]["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if reference == "opencode" {
            for candidate in &ids {
                if strategy["runners"][candidate]["agent"] == "opencode"
                    && !order.contains(candidate)
                {
                    order.push(candidate.clone());
                }
            }
        } else {
            let candidate = resolve(strategy, reference)
                .and_then(|runner| runner["id"].as_str())
                .unwrap_or(reference);
            if ids.iter().any(|known| known == candidate)
                && !order.iter().any(|known| known == candidate)
            {
                order.push(candidate.to_owned());
            }
        }
    }
    for candidate in &ids {
        if !order.contains(candidate) {
            order.push(candidate.clone());
        }
    }
    order
}

fn path(parts: &[Value]) -> &[Value] {
    parts
}

/// `routing.get` read model: routing rules plus available executor ids.
/// Matches `src/core/routing-config.ts` `get` (no usage broker).
pub fn get_routing(home: &Path) -> Result<Value, StrategyError> {
    let strategy = load_strategy(home)?;
    let rules: Vec<Value> = strategy["routing"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|rule| {
            let executors = rule.get("executors").cloned().unwrap_or_else(|| json!([]));
            match rule.get("kinds") {
                Some(kinds) if !kinds.is_null() => json!({"kinds": kinds, "executors": executors}),
                _ => json!({"executors": executors}),
            }
        })
        .collect();
    let available: Vec<Value> = strategy["runners"]
        .as_object()
        .map(|runners| runners.keys().map(|id| json!(id)).collect())
        .unwrap_or_default();
    Ok(json!({"rules": rules, "available": available}))
}

/// `routing.set` document effect. Endpoint synchronization and config event
/// publication are the caller's responsibility after this returns.
pub fn set_routing(home: &Path, rules: &[Value]) -> Result<Value, StrategyError> {
    let strategy = load_strategy(home)?;
    if rules.is_empty()
        || rules.last().is_some_and(|r| r.get("kinds").is_some())
        || rules[..rules.len() - 1]
            .iter()
            .any(|r| r.get("kinds").is_none())
    {
        return Err(StrategyError::Other(
            "the default routing rule must be last".into(),
        ));
    }
    for rule in rules {
        for id in rule["executors"].as_array().into_iter().flatten() {
            let id = id.as_str().unwrap_or("");
            if resolve(&strategy, id).is_none() {
                return Err(StrategyError::Other(format!("unknown executor {id}")));
            }
        }
    }
    let values: Vec<Value> = rules
        .iter()
        .map(|r| match r.get("kinds") {
            Some(kinds) => json!({"kinds":kinds,"executors":r["executors"]}),
            None => json!({"default":r["executors"]}),
        })
        .collect();
    let changed = edit(home, |doc, _| {
        let old = doc
            .get_in(path(&[json!("routing")]))
            .map_err(|e| StrategyError::Other(e.to_string()))?;
        if let Some(Value::Array(items)) = old {
            for (index, value) in values.iter().take(items.len()).enumerate() {
                if let Some(kinds) = value.get("kinds") {
                    if items[index].get("default").is_some() {
                        doc.rename_key(
                            path(&[json!("routing"), json!(index), json!("default")]),
                            "executors",
                        )
                        .map_err(|e| StrategyError::Other(e.to_string()))?;
                    }
                    doc.set_list(
                        path(&[json!("routing"), json!(index), json!("kinds")]),
                        kinds.as_array().unwrap_or(&Vec::new()),
                    )
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
                    doc.set_list(
                        path(&[json!("routing"), json!(index), json!("executors")]),
                        value["executors"].as_array().unwrap_or(&Vec::new()),
                    )
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
                } else {
                    doc.delete_in(path(&[json!("routing"), json!(index), json!("kinds")]))
                        .map_err(|e| StrategyError::Other(e.to_string()))?;
                    if items[index].get("executors").is_some() {
                        doc.rename_key(
                            path(&[json!("routing"), json!(index), json!("executors")]),
                            "default",
                        )
                        .map_err(|e| StrategyError::Other(e.to_string()))?;
                    }
                    doc.set_list(
                        path(&[json!("routing"), json!(index), json!("default")]),
                        value["default"].as_array().unwrap_or(&Vec::new()),
                    )
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
                }
            }
            if items.len() != values.len() {
                doc.set_sequence_preserving_prefix(path(&[json!("routing")]), &values)
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
        } else {
            doc.set_list(path(&[json!("routing")]), &values)
                .map_err(|e| StrategyError::Other(e.to_string()))?;
        }
        Ok(())
    })?;
    Ok(json!({"diff":changed}))
}

/// `runner.reorder` document effect.
pub fn reorder_runners(home: &Path, ids: &[String]) -> Result<Value, StrategyError> {
    let migrated = ensure_migrated(home)?;
    let strategy = load_strategy(home)?;
    let expected = executor_ids(&strategy);
    let distinct: HashSet<&String> = ids.iter().collect();
    if ids.len() != expected.len()
        || distinct.len() != ids.len()
        || ids.iter().any(|id| !expected.contains(id))
    {
        return Err(StrategyError::Other(
            "ids must be a permutation of the non-planner runners".into(),
        ));
    }
    edit(home, |doc, _| {
        doc.set_list(
            path(&[json!("pacing"), json!("order")]),
            &ids.iter().map(|id| json!(id)).collect::<Vec<_>>(),
        )
        .map_err(|e| StrategyError::Other(e.to_string()))
    })?;
    let mut result = json!({"order":ids});
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}

pub fn move_rank(
    doc: &mut StrategyDoc,
    strategy: &Value,
    id: &str,
    rank: usize,
) -> Result<(), StrategyError> {
    let mut order = ordered_executor_ids(strategy);
    order.retain(|candidate| candidate != id);
    order.insert(rank.min(order.len()), id.to_owned());
    doc.set_list(
        path(&[json!("pacing"), json!("order")]),
        &order.into_iter().map(Value::String).collect::<Vec<_>>(),
    )
    .map_err(|e| StrategyError::Other(e.to_string()))
}

/// `runner.set` document effect. The caller must perform the same endpoint
/// synchronization and config publication as the TypeScript API mutation.
pub fn set_runner(home: &Path, reference: &str, options: &Value) -> Result<Value, StrategyError> {
    let migrated = ensure_migrated(home)?;
    let strategy = load_strategy(home)?;
    let runner = resolve(&strategy, reference)
        .ok_or_else(|| StrategyError::Other("unknown runner".into()))?;
    if planner(&strategy, runner) {
        return Err(StrategyError::Other(
            "cannot edit the planner runner".into(),
        ));
    }
    let id = runner["id"].as_str().unwrap_or(reference).to_owned();
    let rank = options.get("rank").and_then(|value| {
        crate::js_semantics::integer(value)
            .filter(|number| *number >= 0.0)
            .map(|number| number as u64)
    });
    if options.get("rank").is_some() && rank.is_none() {
        return Err(StrategyError::Other(
            "rank must be a nonnegative integer".into(),
        ));
    }
    edit(home, |doc, current| {
        let key = doc
            .get_in(path(&[json!("runners")]))
            .map_err(|e| StrategyError::Other(e.to_string()))?
            .and_then(|value| value.as_object().cloned())
            .and_then(|declarations| {
                declarations
                    .keys()
                    .find(|key| {
                        resolve(current, key).is_some_and(|candidate| candidate["id"] == id)
                    })
                    .cloned()
            })
            .unwrap_or_else(|| id.clone());
        for name in ["enabled", "model", "max_tasks"] {
            if let Some(value) = options.get(name) {
                doc.set_in(path(&[json!("runners"), json!(key), json!(name)]), value)
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
        }
        if let Some(rank) = rank {
            move_rank(doc, current, &id, rank as usize)?;
        }
        Ok(())
    })?;
    let updated = load_strategy(home)?;
    let mut warnings = Vec::new();
    if options.get("enabled") == Some(&Value::Bool(false)) {
        for rule in updated["routing"].as_array().into_iter().flatten() {
            let executors = rule["executors"].as_array().cloned().unwrap_or_default();
            let contains = executors.iter().filter_map(Value::as_str).any(|reference| {
                resolve(&updated, reference).is_some_and(|candidate| candidate["id"] == id)
            });
            let available = executors.iter().filter_map(Value::as_str).any(|reference| {
                resolve(&updated, reference).is_some_and(|candidate| {
                    candidate["enabled"] != false && !planner(&strategy, candidate)
                })
            });
            if contains && !available {
                let label = rule["kinds"]
                    .as_array()
                    .map(|kinds| {
                        kinds
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "default".into());
                warnings.push(format!(
                    "routing rule '{label}' has no enabled executor left"
                ));
            }
        }
    }
    let mut result = json!({"id":id,"warnings":warnings});
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}

/// `runner.remove` document effect. This leaves any endpoint synchronization
/// and config event publication to the operation caller.
pub fn remove_runner(home: &Path, reference: &str) -> Result<Value, StrategyError> {
    let migrated = ensure_migrated(home)?;
    let strategy = load_strategy(home)?;
    let (agent, named_account, host) = parse_runner_ref(reference)
        .ok_or_else(|| StrategyError::Other("invalid runner id".into()))?;
    if let Some(host) = host
        && strategy["hosts"].get(host).is_none()
    {
        let names = strategy["hosts"]
            .as_object()
            .map(|hosts| hosts.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        return Err(StrategyError::Other(format!(
            "unknown host {host} (hosts: {})",
            if names.is_empty() { "none" } else { &names }
        )));
    }
    let account = named_account.or_else(|| default_account(&strategy, agent));
    let expected_kind = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor",
        "agy" => "agy",
        "opencode" => "endpoint",
        _ => "",
    };
    if account.is_none_or(|name| strategy["accounts"][name]["kind"] != expected_kind) {
        return Err(StrategyError::Other(
            "agent/account pairing not allowed or account not found".into(),
        ));
    }
    let runner = resolve(&strategy, reference)
        .ok_or_else(|| StrategyError::Other("unknown runner".into()))?;
    if planner(&strategy, runner) {
        return Err(StrategyError::Other("planner runner is in use".into()));
    }
    if strategy["runners"]
        .as_object()
        .is_none_or(|runners| runners.len() <= 1)
    {
        return Err(StrategyError::Other("cannot remove the last runner".into()));
    }
    let id = runner["id"].as_str().unwrap_or(reference).to_owned();
    let diff = edit(home, |doc, current| {
        if let Some(declarations) = doc
            .get_in(path(&[json!("runners")]))
            .map_err(|e| StrategyError::Other(e.to_string()))?
            .and_then(|value| value.as_object().cloned())
        {
            for key in declarations.keys() {
                if resolve(current, key).is_some_and(|candidate| candidate["id"] == id) {
                    doc.remove_mapping_entry("runners", key)
                        .map_err(|e| StrategyError::Other(e.to_string()))?;
                }
            }
        }
        let raw = doc
            .get_in(path(&[json!("routing")]))
            .map_err(|e| StrategyError::Other(e.to_string()))?;
        let source = raw
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                current["routing"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|rule| match rule.get("kinds") {
                        Some(kinds) if !kinds.is_null() => {
                            json!({"kinds":kinds,"executors":rule["executors"]})
                        }
                        _ => json!({"default":rule["executors"]}),
                    })
                    .collect()
            });
        let mut kept = Vec::new();
        let mut deleted = Vec::new();
        for (index, rule) in source.iter().enumerate() {
            let key = if rule.get("default").is_some_and(Value::is_array) {
                "default"
            } else {
                "executors"
            };
            let remaining = rule[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|reference| {
                    reference
                        .as_str()
                        .and_then(|reference| resolve(current, reference))
                        .is_none_or(|candidate| candidate["id"] != id)
                })
                .cloned()
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                deleted.push(index);
            } else {
                kept.push((index, key, remaining));
            }
        }
        if raw.as_ref().and_then(Value::as_array).is_none() {
            let values = kept
                .iter()
                .map(|(index, key, remaining)| {
                    let mut rule = source[*index].clone();
                    rule[*key] = Value::Array(remaining.clone());
                    rule
                })
                .collect::<Vec<_>>();
            doc.set_in(path(&[json!("routing")]), &json!(values))
                .map_err(|e| StrategyError::Other(e.to_string()))?;
        } else {
            for (index, key, remaining) in &kept {
                doc.set_list(
                    path(&[json!("routing"), json!(index), json!(key)]),
                    remaining,
                )
                .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
            for index in &deleted {
                let key = if source[*index].get("default").is_some_and(Value::is_array) {
                    "default"
                } else {
                    "executors"
                };
                doc.set_list(path(&[json!("routing"), json!(index), json!(key)]), &[])
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
            if !deleted.is_empty() {
                doc.remove_sequence_indices(path(&[json!("routing")]), &deleted)
                    .map_err(|e| StrategyError::Other(e.to_string()))?;
            }
        }
        if let Some(order) = doc
            .get_in(path(&[json!("pacing"), json!("order")]))
            .map_err(|e| StrategyError::Other(e.to_string()))?
            .and_then(|value| value.as_array().cloned())
        {
            let filtered = order
                .into_iter()
                .filter(|reference| {
                    reference
                        .as_str()
                        .and_then(|reference| resolve(current, reference))
                        .is_none_or(|candidate| candidate["id"] != id)
                })
                .collect::<Vec<_>>();
            doc.set_list(path(&[json!("pacing"), json!("order")]), &filtered)
                .map_err(|e| StrategyError::Other(e.to_string()))?;
        }
        Ok(())
    })?;
    let mut result = json!({"id":id,"removed":true,"diff":diff});
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}
