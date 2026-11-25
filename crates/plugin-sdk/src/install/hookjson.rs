//! Planner hook files: Claude-style matcher groups and flat Cursor entries.

use crate::install::{parse_jsonc, stringify};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HookFormat {
    Claude,
    Cursor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSpec {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedHook {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub hook: Value,
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn hooks_mut(doc: &mut Value, fmt: HookFormat) -> &mut Map<String, Value> {
    if !doc.is_object() {
        *doc = Value::Object(Map::new());
    }
    let map = match doc.as_object_mut() {
        Some(map) => map,
        None => unreachable!("document is an object"),
    };
    if fmt == HookFormat::Cursor && !map.contains_key("version") {
        map.insert("version".into(), Value::from(1));
    }
    if !map.contains_key("hooks") {
        map.insert("hooks".into(), Value::Object(Map::new()));
    }
    if !map.get("hooks").is_some_and(Value::is_object) {
        map.insert("hooks".into(), Value::Object(Map::new()));
    }
    match map.get_mut("hooks").and_then(Value::as_object_mut) {
        Some(hooks) => hooks,
        None => unreachable!("hooks is an object"),
    }
}

fn entries_mut<'a>(doc: &'a mut Value, fmt: HookFormat, event: &str) -> &'a mut Vec<Value> {
    let hooks = hooks_mut(doc, fmt);
    if !hooks.get(event).is_some_and(Value::is_array) {
        hooks.insert(event.to_string(), Value::Array(Vec::new()));
    }
    match hooks.get_mut(event).and_then(Value::as_array_mut) {
        Some(entries) => entries,
        None => unreachable!("hook entries is an array"),
    }
}

fn hook_command(value: &Value) -> Option<&str> {
    value.get("command").and_then(Value::as_str)
}

pub fn add_hooks(doc: &Value, fmt: HookFormat, specs: &[HookSpec]) -> Value {
    let mut result = doc.clone();
    let _ = hooks_mut(&mut result, fmt);
    for spec in specs {
        let entries = entries_mut(&mut result, fmt, &spec.event);
        let exists = match fmt {
            HookFormat::Cursor => entries
                .iter()
                .any(|h| hook_command(h) == Some(&spec.command)),
            HookFormat::Claude => entries.iter().any(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|hooks| {
                        hooks.iter().any(|h| hook_command(h) == Some(&spec.command))
                    })
            }),
        };
        if exists {
            continue;
        }
        let mut hook = Map::new();
        hook.insert("command".into(), Value::String(spec.command.clone()));
        if let Some(timeout) = spec.timeout {
            hook.insert("timeout".into(), Value::from(timeout));
        }
        if fmt == HookFormat::Cursor {
            entries.push(Value::Object(hook));
        } else {
            hook.insert("type".into(), Value::from("command"));
            if let Some(note) = &spec.status_message {
                hook.insert("statusMessage".into(), Value::String(note.clone()));
            }
            let mut group = Map::new();
            if let Some(matcher) = &spec.matcher {
                group.insert("matcher".into(), Value::String(matcher.clone()));
            }
            group.insert("hooks".into(), Value::Array(vec![Value::Object(hook)]));
            entries.push(Value::Object(group));
        }
    }
    result
}

pub fn remove_hooks<F>(doc: &Value, fmt: HookFormat, match_command: F) -> (Value, Vec<RemovedHook>)
where
    F: Fn(&str) -> bool,
{
    let mut result = doc.clone();
    let mut removed = Vec::new();
    let events: Vec<String> = object(&result)
        .and_then(|m| m.get("hooks"))
        .and_then(object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for event in events {
        let before = removed.len();
        let mut kept = Vec::new();
        let entries = result
            .as_object_mut()
            .and_then(|m| m.get_mut("hooks"))
            .and_then(Value::as_object_mut)
            .and_then(|m| m.get_mut(&event))
            .and_then(Value::as_array_mut);
        let Some(entries) = entries else { continue };
        let original = std::mem::take(entries);
        for mut entry in original {
            if fmt == HookFormat::Cursor {
                if hook_command(&entry).is_some_and(&match_command) {
                    removed.push(RemovedHook {
                        event: event.clone(),
                        matcher: None,
                        hook: entry,
                    });
                } else {
                    kept.push(entry);
                }
                continue;
            }
            let Some(hooks) = entry.get("hooks").and_then(Value::as_array) else {
                kept.push(entry);
                continue;
            };
            if hooks.is_empty() {
                kept.push(entry);
                continue;
            }
            let matcher = entry
                .get("matcher")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut surviving = Vec::new();
            for hook in hooks {
                if hook_command(hook).is_some_and(&match_command) {
                    removed.push(RemovedHook {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        hook: hook.clone(),
                    });
                } else {
                    surviving.push(hook.clone());
                }
            }
            if !surviving.is_empty() {
                if let Some(map) = entry.as_object_mut() {
                    map.insert("hooks".into(), Value::Array(surviving));
                }
                kept.push(entry);
            }
        }
        let hooks = result
            .as_object_mut()
            .and_then(|m| m.get_mut("hooks"))
            .and_then(Value::as_object_mut);
        if let Some(hooks) = hooks {
            if removed.len() > before && kept.is_empty() {
                hooks.shift_remove(&event);
            } else {
                hooks.insert(event, Value::Array(kept));
            }
        }
    }
    (result, removed)
}

pub fn restore_hooks(doc: &Value, fmt: HookFormat, removed: &[RemovedHook]) -> Value {
    let mut result = doc.clone();
    let _ = hooks_mut(&mut result, fmt);
    for item in removed {
        let entries = entries_mut(&mut result, fmt, &item.event);
        let hook = item.hook.clone();
        if fmt == HookFormat::Cursor {
            entries.push(hook);
        } else {
            let mut group = Map::new();
            if let Some(matcher) = &item.matcher {
                group.insert("matcher".into(), Value::String(matcher.clone()));
            }
            group.insert("hooks".into(), Value::Array(vec![hook]));
            entries.push(Value::Object(group));
        }
    }
    result
}

const PACER_SUFFIXES: &[&str] = &[
    "guard --planner ",
    "status --hook ",
    "session-start --planner ",
    "msg hook session --planner ",
    "msg hook stop --planner ",
    "msg hook prompt --planner ",
];

/// Recognize only pacer-installed hooks for the given planner.
pub fn is_pacer_hook(command: &str, planner: &str) -> bool {
    if !(command.contains("pacer") || command.contains("cli.ts") || command.contains("cli.js")) {
        return false;
    }
    for suffix in PACER_SUFFIXES {
        let needle = format!("{suffix}{planner}");
        if let Some(start) = command.strip_suffix(&needle)
            && start.chars().last().is_some_and(char::is_whitespace)
        {
            return true;
        }
    }
    false
}

pub fn upsert_hooks(doc: &Value, fmt: HookFormat, specs: &[HookSpec], planner: &str) -> Value {
    let mut result = doc.clone();
    let _ = hooks_mut(&mut result, fmt);
    for spec in specs {
        let candidates: Vec<Value> = {
            let entries = object(&result)
                .and_then(|m| m.get("hooks"))
                .and_then(object)
                .and_then(|m| m.get(&spec.event))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            match fmt {
                HookFormat::Cursor => entries,
                HookFormat::Claude => entries
                    .into_iter()
                    .filter(|group| {
                        group.get("matcher").and_then(Value::as_str) == spec.matcher.as_deref()
                    })
                    .filter_map(|group| group.get("hooks").and_then(Value::as_array).cloned())
                    .flatten()
                    .collect(),
            }
        };
        let existing: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(_, h)| hook_command(h).is_some_and(|c| is_pacer_hook(c, planner)))
            .map(|(i, _)| i)
            .collect();
        if existing.is_empty() {
            let added = add_hooks(&Value::Object(Map::new()), fmt, std::slice::from_ref(spec));
            let new = added
                .get("hooks")
                .and_then(object)
                .and_then(|m| m.get(&spec.event))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let entries = entries_mut(&mut result, fmt, &spec.event);
            entries.extend(new);
            continue;
        }
        for index in existing {
            let entries = entries_mut(&mut result, fmt, &spec.event);
            let mut groups: Vec<&mut Value> = match fmt {
                HookFormat::Cursor => entries.iter_mut().collect(),
                HookFormat::Claude => entries
                    .iter_mut()
                    .filter(|group| {
                        group.get("matcher").and_then(Value::as_str) == spec.matcher.as_deref()
                    })
                    .filter_map(|group| group.get_mut("hooks").and_then(Value::as_array_mut))
                    .flat_map(|hooks| hooks.iter_mut())
                    .collect(),
            };
            if let Some(hook) = groups.get_mut(index).and_then(|h| h.as_object_mut()) {
                hook.insert("command".into(), Value::String(spec.command.clone()));
                match spec.timeout {
                    Some(timeout) => {
                        hook.insert("timeout".into(), Value::from(timeout));
                    }
                    None => {
                        hook.remove("timeout");
                    }
                }
                match &spec.status_message {
                    Some(note) => {
                        hook.insert("statusMessage".into(), Value::String(note.clone()));
                    }
                    None => {
                        hook.remove("statusMessage");
                    }
                }
            }
        }
    }
    result
}

pub fn edit_hooks_file(
    old: Option<&str>,
    fmt: HookFormat,
    specs: &[HookSpec],
    planner: &str,
) -> Result<String, String> {
    let doc = match old {
        Some(text) if !text.trim().is_empty() => parse_jsonc(text).map_err(|e| e.0)?,
        _ => Value::Object(Map::new()),
    };
    let next = upsert_hooks(&doc, fmt, specs, planner);
    if old.is_some() && serde_json::to_string(&doc).ok() == serde_json::to_string(&next).ok() {
        return Ok(old.unwrap_or_default().to_string());
    }
    Ok(format!("{}\n", stringify(&next)))
}
