//! Conservative read-only strategy catalog for the native public API.

use crate::strategy_load::normalize_basic;
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
};
use rustix::{
    fs::{CWD, Dir, FileType, Mode, OFlags, openat},
    io::Errno,
};
use serde_json::{Value, json};
use std::{fs::File, io::Read, os::fd::AsFd};

const MAX_STRATEGY_BYTES: u64 = 256 * 1024;
const MAX_ACTIVE_BYTES: u64 = 4096;
const MAX_STRATEGIES: usize = 128;

fn read_regular(dir: impl AsFd, name: &str, max: u64) -> Option<String> {
    let fd = openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let mut file = File::from(fd);
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let mut bytes = Vec::new();
    file.by_ref().take(max + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > max {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn active_name(pacer: &impl AsFd) -> Option<String> {
    let fd = match openat(
        pacer,
        "active",
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Some("default".to_owned()),
        Err(_) => return None,
    };
    let mut file = File::from(fd);
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_ACTIVE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_ACTIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_ACTIVE_BYTES || !bytes.is_ascii() {
        return None;
    }
    let name = std::str::from_utf8(&bytes).ok()?.trim();
    if name.is_empty() {
        Some("default".to_owned())
    } else if valid_name(name) && name != "default" {
        Some(name.to_owned())
    } else {
        None
    }
}

fn valid_name(name: &str) -> bool {
    name.len() <= 40
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn names(dir: &impl AsFd) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut stream = Dir::read_from(dir).ok()?;
    while let Some(entry) = stream.read() {
        let entry = entry.ok()?;
        let name = entry.file_name().to_str().ok()?;
        let Some(stem) = name.strip_suffix(".yaml") else {
            continue;
        };
        if entry.file_type() == FileType::Unknown {
            return None;
        }
        if entry.file_type().is_file() {
            if !valid_name(stem) || stem == "default" || names.len() >= MAX_STRATEGIES {
                return None;
            }
            names.push(stem.to_owned());
        }
    }
    names.sort();
    Some(names)
}

fn display_name(id: &str) -> Option<&'static str> {
    match id {
        "claude-code" => Some("Claude"),
        "codex" => Some("Codex"),
        "cursor" => Some("Cursor"),
        "opencode" => Some("OpenCode"),
        "opencode#local" => Some("Local"),
        _ => None,
    }
}

fn summary(strategy: &Value) -> Option<String> {
    let planner = strategy.pointer("/planner/agent")?.as_str()?;
    let order = strategy.pointer("/pacing/order")?.as_array()?;
    let first = order
        .iter()
        .filter_map(Value::as_str)
        .find(|id| *id != planner);
    let first = if let Some(first) = first {
        format!("{} first", display_name(first)?)
    } else {
        "Configured executors".to_owned()
    };
    let reserve = strategy.pointer("/pacing/plannerReserve")?.as_i64()?;
    let policy = strategy.pointer("/pacing/policy")?.as_str()?;
    let suffix = if policy == "priority" {
        String::new()
    } else {
        format!("; {policy} policy")
    };
    Some(format!(
        "{first}, {} keeps {reserve}%{suffix}",
        display_name(planner)?
    ))
}

fn description(yaml: &str) -> Option<&str> {
    let first = yaml
        .lines()
        .next()
        .unwrap_or_default()
        .trim_end_matches('\r');
    if !first.starts_with('#') {
        return Some("");
    }
    if !first
        .chars()
        .all(|ch| ch.is_ascii_graphic() || matches!(ch, ' ' | '\t'))
    {
        return None;
    }
    let rest = first.strip_prefix('#')?;
    let text = rest
        .strip_prefix(' ')
        .or_else(|| rest.strip_prefix('\t'))
        .unwrap_or(rest);
    if text
        .to_ascii_lowercase()
        .starts_with("pacer starter strategy")
    {
        Some("")
    } else {
        Some(text)
    }
}

fn model(ctx: &Ctx) -> Option<Value> {
    let pacer = openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let active = active_name(&pacer)?;
    let strategies = match openat(
        &pacer,
        "strategies",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(dir) => Some(dir),
        Err(Errno::NOENT) => None,
        Err(_) => return None,
    };
    let named = if let Some(dir) = &strategies {
        names(dir)?
    } else {
        Vec::new()
    };
    if active != "default" && !named.contains(&active) {
        return None;
    }
    let default_yaml = read_regular(&pacer, "strategy.yaml", MAX_STRATEGY_BYTES)?;
    let mut files = vec![("default".to_owned(), default_yaml)];
    if let Some(dir) = &strategies {
        for name in named {
            let yaml = read_regular(dir, &format!("{name}.yaml"), MAX_STRATEGY_BYTES)?;
            files.push((name, yaml));
        }
    }
    let mut rows = Vec::with_capacity(files.len());
    for (name, yaml) in files {
        let parsed = normalize_basic(&yaml, &name)?;
        rows.push(json!({
            "name":name,
            "active":name == active,
            "summary":summary(&parsed)?,
            "description":description(&yaml)?,
        }));
    }
    Some(Value::Array(rows))
}

/// Preselect only requested names in a catalog whose complete YAML set and
/// current active file are representable by the native loader.
pub(crate) fn use_selection(ctx: &Ctx, params: &Value) -> Option<(String, String)> {
    let name = params.get("name")?.as_str()?;
    if !valid_name(name) {
        return None;
    }
    let rows = model(ctx)?;
    let rows = rows.as_array()?;
    if !rows.iter().any(|row| row["name"] == name) {
        return None;
    }
    let observed = rows.iter().find(|row| row["active"] == true)?["name"]
        .as_str()?
        .to_owned();
    Some((name.to_owned(), observed))
}

/// Keep the full call with TypeScript when any file needs broader validation.
pub fn requires_core_strategy_list_parser(ctx: &Ctx) -> bool {
    model(ctx).is_none()
}

/// Read the subset whose every strategy file has proven TypeScript parity.
pub fn strategy_list(ctx: &Ctx) -> Result<Value, CoreError> {
    model(ctx).ok_or_else(|| CoreError::new(Code::Conflict, "strategy changed during list read"))
}

fn show_model_with(ctx: &Ctx, params: &Value, before_active: impl FnOnce()) -> Option<Value> {
    let name = params.get("name")?.as_str()?;
    if !valid_name(name) {
        return None;
    }
    let pacer = openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let yaml = if name == "default" {
        read_regular(&pacer, "strategy.yaml", MAX_STRATEGY_BYTES)?
    } else {
        let dir = openat(
            &pacer,
            "strategies",
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .ok()?;
        read_regular(&dir, &format!("{name}.yaml"), MAX_STRATEGY_BYTES)?
    };
    let parsed = normalize_basic(&yaml, name)?;
    // TypeScript reads the requested YAML before loading the active strategy.
    // Validate the catalog and active target after this read so a concurrent
    // switch cannot pair fresh YAML with a stale active flag.
    before_active();
    let rows = model(ctx)?;
    let row = rows
        .as_array()?
        .iter()
        .find(|row| row.get("name").and_then(Value::as_str) == Some(name))?;
    Some(json!({
        "yaml":yaml,
        "summary":summary(&parsed)?,
        "active":row.get("active")?.as_bool()?,
    }))
}

fn show_model(ctx: &Ctx, params: &Value) -> Option<Value> {
    show_model_with(ctx, params, || {})
}

/// Forward invalid and broader strategy shapes before native dispatch.
pub fn requires_core_strategy_show_parser(ctx: &Ctx, params: &Value) -> bool {
    show_model(ctx, params).is_none()
}

/// Return the named strategy's exact YAML bytes and TypeScript-compatible summary.
pub fn strategy_show(ctx: &Ctx, params: &Value) -> Result<Value, CoreError> {
    if params.get("name").and_then(Value::as_str).is_none() {
        return Err(CoreError::new(Code::InvalidInput, "name is required"));
    }
    show_model(ctx, params)
        .ok_or_else(|| CoreError::new(Code::Conflict, "strategy changed during show read"))
}

fn list_op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
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
        strategy_list(ctx)
    })
}

fn show_op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move { strategy_show(ctx, &params) })
}

pub fn ops() -> &'static [NativeOp] {
    &[
        NativeOp {
            name: "strategy.list",
            call: list_op,
        },
        NativeOp {
            name: "strategy.show",
            call: show_op,
        },
    ]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::{collections::HashMap, fs};

    #[test]
    fn show_uses_active_state_after_requested_yaml_read() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().join("home"),
            dir.path().join("pacer"),
            HashMap::new(),
            0.0,
        );
        fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        let yaml =
            "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
        fs::write(ctx.pacer_home.join("strategy.yaml"), yaml).unwrap();
        fs::write(ctx.pacer_home.join("strategies/research.yaml"), yaml).unwrap();
        let result = show_model_with(&ctx, &json!({"name":"default"}), || {
            fs::write(ctx.pacer_home.join("active"), "research\n").unwrap();
        })
        .unwrap();
        assert_eq!(result["yaml"], yaml);
        assert_eq!(result["active"], false);
    }
}
