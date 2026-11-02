//! Strategy reads and legacy migration. This module does not register API ops.

use crate::{
    doc::{StrategyDoc, parse_value, parse_yaml_value},
    write::atomic_strategy_write,
};
use pacer_foundation::js_semantics::JsTrim;
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod trim_tests {
    use super::strategy_path;

    #[test]
    fn strategy_active_name_uses_javascript_trim_set() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("active"), "\u{FEFF}focus\u{2028}").unwrap();
        assert_eq!(strategy_path(home.path()).unwrap().1, "focus");
    }
}

pub(crate) fn invalid(path: &Path, problems: Vec<String>) -> StrategyError {
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
pub(crate) fn string(value: &Value) -> String {
    crate::yaml_value::Value::from(value).string()
}
pub fn validate_strategy(raw: &Value, path: &Path, name: &str) -> Result<Value, StrategyError> {
    validate_yaml_strategy(&crate::yaml_value::Value::from(raw), path, name)
}
pub(crate) fn validate_yaml_strategy(
    raw: &crate::yaml_value::Value,
    path: &Path,
    name: &str,
) -> Result<Value, StrategyError> {
    crate::strategy_validation::validate_strategy(raw, path, name).map(|v| v.to_json())
}

pub fn strategy_path(home: &Path) -> Result<(PathBuf, String), StrategyError> {
    let active = home.join("active");
    let name = if active.exists() {
        fs::read_to_string(active)?.js_trim().to_owned()
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
    let raw = parse_yaml_value(&text)
        .map_err(|e| invalid(&path, vec![format!("YAML syntax error: {e}")]))?;
    validate_yaml_strategy(&raw, &path, &name)
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
pub(crate) fn summary_yaml(strategy: &crate::yaml_value::Value) -> String {
    let planner = strategy["planner"]["agent"].as_str().unwrap_or("");
    let first = strategy["pacing"]["order"].as_array().and_then(|a| {
        a.iter()
            .filter_map(crate::yaml_value::Value::as_str)
            .find(|id| *id != planner)
    });
    let prefix = first.map_or_else(
        || "Configured executors".into(),
        |id| format!("{} first", display_name(id)),
    );
    let mut out = format!(
        "{prefix}, {} keeps {}%",
        display_name(planner),
        strategy["pacing"]["plannerReserve"].string()
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
    let raw = parse_yaml_value(&yaml)
        .map_err(|e| invalid(&path, vec![format!("YAML syntax error: {e}")]))?;
    let strategy = crate::strategy_validation::validate_strategy(&raw, &path, name)?;
    Ok(
        json!({"yaml":yaml,"summary":summary_yaml(&strategy),"active":load_strategy(home)?["name"] == name}),
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
    let strategy = validate_yaml_strategy(
        &parse_yaml_value(&before)
            .map_err(|e| invalid(path, vec![format!("YAML syntax error: {e}")]))?,
        path,
        "default",
    )?;
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
    let parsed = parse_yaml_value(&after).map_err(|e| StrategyError::Other(e.to_string()))?;
    validate_yaml_strategy(&parsed, path, "default")?;
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
