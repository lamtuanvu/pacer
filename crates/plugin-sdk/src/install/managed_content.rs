//! Project only installer-owned pieces as an ownership fingerprint.

use crate::install::{get_member, parse_jsonc, stringify_compact};
use icu_collator::CollatorBorrowed;
use serde_json::{Map, Value};

fn collator() -> CollatorBorrowed<'static> {
    CollatorBorrowed::new_root(Default::default())
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| collator().compare(a, b));
            let mut out = Map::new();
            for (key, item) in entries {
                out.insert(key.clone(), canonical(item));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn toml_value(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => Value::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(items) => Value::Array(items.iter().map(toml_value).collect()),
        toml::Value::Table(table) => {
            let mut map = Map::new();
            for (key, item) in table {
                map.insert(key.clone(), toml_value(item));
            }
            Value::Object(map)
        }
    }
}

fn block_marks(style: crate::install::BlockStyle) -> (&'static str, &'static str) {
    match style {
        crate::install::BlockStyle::Md => ("<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"),
        crate::install::BlockStyle::Hash => ("# >>> pacer >>>", "# <<< pacer <<<"),
    }
}

fn piece(text: &str, op: &crate::install::UndoOp) -> Result<Value, String> {
    use crate::install::UndoOp;
    Ok(match op {
        UndoOp::Block { style, .. } => {
            let (open, close) = block_marks(*style);
            let starts = text.matches(open).count();
            let ends = text.matches(close).count();
            if starts == 0 && ends == 0 {
                Value::Null
            } else {
                let open_at = text.find(open);
                let close_at = text.find(close);
                if starts != 1
                    || ends != 1
                    || open_at.is_none_or(|o| close_at.is_some_and(|c| c < o))
                {
                    return Err("ambiguous managed block".into());
                }
                match (open_at, close_at) {
                    (Some(o), Some(c)) => Value::String(text[o..c + close.len()].to_string()),
                    _ => return Err("ambiguous managed block".into()),
                }
            }
        }
        UndoOp::JsonKey { key } => parse_jsonc(text)
            .map_err(|e| e.0)?
            .get(key)
            .cloned()
            .unwrap_or(Value::Null),
        UndoOp::JsonMember { path, .. } => get_member(text, path)
            .map_err(|e| e.0)?
            .unwrap_or(Value::Null),
        UndoOp::TomlTable { table } => {
            let doc: toml::Value = toml::from_str(text).map_err(|e| e.to_string())?;
            let mut current = &doc;
            for segment in table.split('.') {
                current = match current.get(segment) {
                    Some(value) => value,
                    None => return Ok(Value::Null),
                };
            }
            toml_value(current)
        }
        UndoOp::Hooks {
            format, commands, ..
        } => {
            let doc = parse_jsonc(text).map_err(|e| e.0)?;
            let mut result = Vec::new();
            if let Some(hooks) = doc.get("hooks").and_then(Value::as_object) {
                for (event, entries) in hooks {
                    let entries = entries.as_array().ok_or("invalid hooks")?;
                    for entry in entries {
                        if *format == crate::install::HookFormat::Cursor {
                            let command = entry.get("command").and_then(Value::as_str);
                            if command.is_some_and(|c| commands.iter().any(|owned| owned == c)) {
                                let mut row = Map::new();
                                row.insert("event".into(), Value::String(event.clone()));
                                row.insert("hook".into(), entry.clone());
                                result.push(Value::Object(row));
                            }
                        } else {
                            let hooks = entry
                                .get("hooks")
                                .and_then(Value::as_array)
                                .ok_or("invalid hook group")?;
                            let matching: Vec<Value> = hooks
                                .iter()
                                .filter(|hook| {
                                    hook.get("command")
                                        .and_then(Value::as_str)
                                        .is_some_and(|c| commands.iter().any(|owned| owned == c))
                                })
                                .cloned()
                                .collect();
                            if !matching.is_empty() {
                                let mut group = entry.as_object().cloned().unwrap_or_default();
                                group.insert("hooks".into(), Value::Array(matching));
                                let mut row = Map::new();
                                row.insert("event".into(), Value::String(event.clone()));
                                row.insert("group".into(), Value::Object(group));
                                result.push(Value::Object(row));
                            }
                        }
                    }
                }
            }
            Value::Array(result)
        }
    })
}

pub fn managed_content(text: &str, ops: &[crate::install::UndoOp]) -> Result<String, String> {
    if ops.is_empty() {
        return Ok(text.to_string());
    }
    let mut pieces = Vec::new();
    for op in ops {
        pieces.push(piece(text, op)?);
    }
    Ok(stringify_compact(&canonical(&Value::Array(pieces))))
}
