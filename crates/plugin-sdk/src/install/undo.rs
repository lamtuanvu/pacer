//! Ownership records and their undo operations. The host commits files; this
//! module only plans how to put them back.

use crate::install::{
    BlockStyle, HookFormat, RemovedHook, get_member, has_block, is_empty_object, parse_jsonc,
    remove_block, remove_hooks, remove_member, restore_hooks, stringify,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoOp {
    #[serde(rename = "block")]
    Block {
        style: BlockStyle,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        restore: Option<Vec<RestoreBlock>>,
    },
    #[serde(rename = "toml-table")]
    TomlTable { table: String },
    #[serde(rename = "json-member")]
    JsonMember {
        path: Vec<String>,
        #[serde(rename = "dropEmpty")]
        #[serde(skip_serializing_if = "Option::is_none", default)]
        drop_empty: Option<Vec<String>>,
    },
    Hooks {
        format: HookFormat,
        commands: Vec<String>,
        restore: Vec<RemovedHook>,
    },
    #[serde(rename = "json-key")]
    JsonKey { key: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBlock {
    pub text: String,
    /// `null` inserts at the running position instead of looking for an anchor line.
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub spacing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub at_marker: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub managed: Option<ManagedHash>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub backup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub after_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exact: Option<bool>,
    pub undo: Vec<UndoOp>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ManagedHash {
    pub schema: u8,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSnapshotFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub before_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size: Option<u64>,
    pub after_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub copy: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSnapshot {
    pub at: i64,
    pub revision: String,
    pub size: u64,
    pub files: Vec<UndoSnapshotFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerRecord {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mcp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub integration: Option<Integration>,
    pub planner: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub config_env: Option<std::collections::BTreeMap<String, String>>,
    pub installed_at: i64,
    pub pacer_argv: Vec<String>,
    pub files: Vec<FileChange>,
    pub commands: Vec<CommandUndo>,
    pub notes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub undo_connect: Option<UndoSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub undone_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Integration {
    pub schema: u8,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CommandUndo {
    pub undo: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Manifest {
    pub version: u8,
    pub planners: std::collections::BTreeMap<String, PlannerRecord>,
}

pub type InstallManifest = Manifest;

fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, _) in text.match_indices('\n') {
        out.push(&text[start..=i]);
        start = i + 1;
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn table_headers(table: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for segment in table.split('.') {
        names = if names.is_empty() {
            vec![segment.to_string(), format!("\"{segment}\"")]
        } else {
            names
                .iter()
                .flat_map(|prefix| {
                    vec![
                        format!("{prefix}.{segment}"),
                        format!("{prefix}.\"{segment}\""),
                    ]
                })
                .collect()
        };
    }
    names.into_iter().map(|name| format!("[{name}]")).collect()
}

fn header_line_rest_ok(rest: &str) -> bool {
    let rest = rest.strip_suffix('\n').unwrap_or(rest);
    let rest = rest.strip_suffix('\r').unwrap_or(rest);
    let body = rest.trim_start_matches([' ', '\t']);
    body.is_empty() || body.starts_with('#')
}

pub fn remove_toml_table(text: &str, table: &str) -> String {
    let lines = split_lines(text);
    let headers = table_headers(table);
    let mut start: Option<usize> = None;
    for header in headers {
        if let Some(found) = lines.iter().position(|line| {
            line.starts_with(&header) && header_line_rest_ok(&line[header.len()..])
        }) && start.is_none_or(|s| found < s)
        {
            start = Some(found);
        }
    }
    let Some(start) = start else {
        return text.to_string();
    };
    let mut end = start + 1;
    while end < lines.len() && !lines[end].starts_with('[') {
        end += 1;
    }
    lines[..start].concat() + &lines[end..].concat()
}

pub fn apply_undo(text: &str, ops: &[UndoOp], notes: &mut Vec<String>) -> Result<String, String> {
    let mut text = text.to_string();
    for op in ops {
        match op {
            UndoOp::Block { style, restore } => {
                let mut marker = if *style == BlockStyle::Hash && has_block(&text, *style)? {
                    text.find("# >>> pacer >>>").map(|m| m as i64)
                } else {
                    None
                };
                let prefix = marker
                    .map(|m| text[..m as usize].to_string())
                    .unwrap_or_default();
                text = remove_block(&text, *style)?;
                if marker.is_some_and(|m| (text.len() as i64) < m)
                    && restore
                        .as_ref()
                        .is_some_and(|items| items.iter().any(|i| i.at_marker == Some(true)))
                {
                    text = prefix;
                }
                let mut position = 0usize;
                for removed in restore.as_deref().unwrap_or(&[]) {
                    if text.contains(&removed.text) {
                        continue;
                    }
                    let mut at: Option<usize> = None;
                    if removed.at_marker == Some(true) && marker.is_some() {
                        at = marker.map(|m| m as usize);
                    } else if removed.anchor.is_none() {
                        at = Some(position);
                    } else {
                        let anchor = removed.anchor.as_deref().unwrap_or_default();
                        let mut offset = 0usize;
                        for line in split_lines(&text) {
                            if offset >= position && line == anchor {
                                let mut point = offset + line.len();
                                if let Some(spacing) = &removed.spacing
                                    && text[point..].starts_with(spacing)
                                {
                                    point += spacing.len();
                                }
                                at = Some(point);
                                break;
                            }
                            offset += line.len();
                        }
                    }
                    let point = match at {
                        Some(p) => p,
                        None => {
                            if !text.is_empty() && !text.ends_with('\n') {
                                text.push('\n');
                            }
                            let p = text.len();
                            notes.push(
                                "Legacy statusline block anchor missing; appended restored block."
                                    .into(),
                            );
                            p
                        }
                    };
                    text.insert_str(point, &removed.text);
                    if marker.is_some_and(|m| m >= point as i64) {
                        marker = marker.map(|m| m + removed.text.len() as i64);
                    }
                    position = point;
                }
            }
            UndoOp::TomlTable { table } => text = remove_toml_table(&text, table),
            UndoOp::JsonMember { path, drop_empty } => {
                text = remove_member(&text, path)?;
                if let Some(drop) = drop_empty
                    && is_empty_object(&text, drop)?
                {
                    text = remove_member(&text, drop)?;
                }
            }
            UndoOp::Hooks {
                format,
                commands,
                restore,
            } => {
                let doc = parse_jsonc(&text).map_err(|e| e.0)?;
                let (kept, _) = remove_hooks(&doc, *format, |command| {
                    commands.iter().any(|c| c == command)
                });
                let next = restore_hooks(&kept, *format, restore);
                text = format!("{}\n", stringify(&next));
            }
            UndoOp::JsonKey { key } => {
                let mut doc = parse_jsonc(&text).map_err(|e| e.0)?;
                if let Some(map) = doc.as_object_mut() {
                    // JS `delete` preserves the order of the remaining keys.
                    map.shift_remove(key);
                }
                text = format!("{}\n", stringify(&doc));
            }
        }
    }
    Ok(text)
}

fn op_key(op: &UndoOp) -> String {
    let value = match op {
        UndoOp::Block { style, .. } => serde_json::json!(["block", style]),
        UndoOp::TomlTable { table } => serde_json::json!(["toml-table", table]),
        UndoOp::JsonMember { path, .. } => serde_json::json!(["json-member", path]),
        UndoOp::JsonKey { key } => serde_json::json!(["json-key", key]),
        UndoOp::Hooks { format, .. } => serde_json::json!(["hooks", format]),
    };
    value.to_string()
}

pub fn merge_undo(old: &[UndoOp], added: &[UndoOp]) -> Vec<UndoOp> {
    let mut result: Vec<UndoOp> = old.to_vec();
    for op in added {
        let key = op_key(op);
        if let Some(index) = result.iter().position(|item| op_key(item) == key) {
            match (&mut result[index], op) {
                (
                    UndoOp::Block { restore: prior, .. },
                    UndoOp::Block {
                        restore: Some(added),
                        ..
                    },
                ) => {
                    let prior = prior.get_or_insert_with(Vec::new);
                    for item in added {
                        if !prior.iter().any(|p| p.text == item.text) {
                            prior.push(item.clone());
                        }
                    }
                }
                (
                    UndoOp::Hooks {
                        commands, restore, ..
                    },
                    UndoOp::Hooks {
                        commands: added,
                        restore: extra,
                        ..
                    },
                ) => {
                    for command in added {
                        if !commands.contains(command) {
                            commands.push(command.clone());
                        }
                    }
                    restore.extend(extra.iter().cloned());
                }
                _ => {}
            }
        } else {
            result.push(op.clone());
        }
    }
    result
}

fn present(text: &str, ops: &[UndoOp]) -> Result<bool, String> {
    for op in ops {
        let ok = match op {
            UndoOp::Block { style, .. } => has_block(text, *style)?,
            UndoOp::TomlTable { table } => remove_toml_table(text, table) != text,
            UndoOp::JsonMember { path, .. } => get_member(text, path)?.is_some(),
            UndoOp::JsonKey { key } => parse_jsonc(text)
                .map_err(|e| e.0)?
                .as_object()
                .is_some_and(|m| m.contains_key(key)),
            UndoOp::Hooks {
                format, commands, ..
            } => {
                let doc = parse_jsonc(text).map_err(|e| e.0)?;
                let (_, removed) = remove_hooks(&doc, *format, |command| {
                    commands.iter().any(|c| c == command)
                });
                commands.iter().all(|command| {
                    removed.iter().any(|item| {
                        item.hook.get("command").and_then(Value::as_str) == Some(command)
                    })
                })
            }
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn pieces_present(text: &str, ops: &[UndoOp]) -> bool {
    present(text, ops).unwrap_or(false)
}
