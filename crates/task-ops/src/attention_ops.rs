//! Native `attention.dismiss` and `attention.snooze` (`src/core/attention.ts`,
//! `src/attention/store.ts`): the raised items come from the read model over
//! the snapshot probe bridge, and the `state/attention.json` transaction is
//! Rust's.
//!
//! Stays forwarded: `discovery-network` items (raised from the radio's network
//! in TypeScript memory), dismissing a task item (it also dismisses the task),
//! an unloadable strategy (TypeScript raises from a reduced input), and a store
//! file or entry the TypeScript transaction would throw on.
#![allow(clippy::result_large_err)]
use crate::snapshot_get_ops::{local_zone, model, parse_snapshot_parts};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_read_model::{SnapshotInput, StatusInput, js};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

const TASK_KINDS: &[&str] = &[
    "question", "review", "failed", "limit", "stuck", "stalled", "message",
];

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("attention.json")
}

/// `readJson(path) ?? {}`; None for a value the TypeScript transaction cannot index.
fn read_store(ctx: &Ctx) -> Option<Map<String, Value>> {
    let Ok(bytes) = std::fs::read(path(ctx)) else {
        return Some(Map::new());
    };
    match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
        Err(_) | Ok(Value::Null) => Some(Map::new()),
        Ok(Value::Object(store)) => Some(store),
        Ok(_) => None,
    }
}

fn store_native(ctx: &Ctx, id: &str) -> bool {
    read_store(ctx).is_some_and(|store| store.get(id).is_none_or(Value::is_object))
}

pub fn attention_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !matches!(op, "attention.dismiss" | "attention.snooze") {
        return false;
    }
    let id = params.get("id").and_then(Value::as_str).unwrap_or("");
    let kind = id.split(':').next().unwrap_or("");
    kind == "discovery-network"
        || (op == "attention.dismiss" && TASK_KINDS.contains(&kind))
        || pacer_config::strategy::load_strategy(&ctx.pacer_home).is_err()
        || !store_native(ctx, id)
}

fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

/// `z.object({id: z.string().min(1).max(256), for?: z.enum(...)})`
fn parse(params: &Value, snooze: bool) -> Result<(String, &'static str), CoreError> {
    let empty = Map::new();
    let p = match params {
        Value::Null => &empty,
        Value::Object(map) => map,
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let mut issues = Vec::new();
    let id = match p.get("id") {
        Some(Value::String(id)) => {
            let units = id.encode_utf16().count();
            if units < 1 {
                issues.push("id: Too small: expected string to have >=1 characters".to_owned());
            } else if units > 256 {
                issues.push("id: Too big: expected string to have <=256 characters".to_owned());
            }
            id.clone()
        }
        other => {
            issues.push(format!(
                "id: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
            String::new()
        }
    };
    let duration = if snooze {
        match p.get("for").and_then(Value::as_str) {
            Some("1h") => "1h",
            Some("4h") => "4h",
            Some("1d") => "1d",
            _ => {
                issues.push(r#"for: Invalid option: expected one of "1h"|"4h"|"1d""#.to_owned());
                ""
            }
        }
    } else {
        ""
    };
    if issues.is_empty() {
        Ok((id, duration))
    } else {
        Err(invalid(issues.join("; ")))
    }
}

/// `raisedItems`: the attention items before the store hides dismissed and snoozed ones.
async fn raised(ctx: &Ctx, parts: OpFuture<'_>) -> Result<Vec<Value>, CoreError> {
    let bridge = parse_snapshot_parts(parts.await?)?;
    if let StatusInput::Failure(message) = &bridge.status {
        return Err(CoreError::new(Code::Internal, message.clone()));
    }
    let alive_pids = bridge.alive_pids;
    let alive = move |pid: i64| alive_pids.contains(&pid);
    let input = SnapshotInput::new(&bridge.probes, bridge.status);
    let result = model()
        .lock()
        .map_err(|_| CoreError::new(Code::Internal, "read model lock poisoned"))?
        .snapshot(ctx, input, local_zone(ctx), &alive)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    Ok(result.raised)
}

/// JavaScript `===` between two possibly absent JSON values.
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// The locked read-modify-write of `state/attention.json`; writes only a changed store.
fn transaction(
    ctx: &Ctx,
    id: &str,
    items: &[Value],
    allow_dismissed: bool,
    change: impl FnOnce(&mut Map<String, Value>),
) -> Result<(), CoreError> {
    with_lock(ctx, "attention", LockOptions::default(), || {
        let unusable = || {
            CoreError::new(
                Code::Unavailable,
                "The attention store changed while it was being updated",
            )
            .hint("Try again.")
        };
        let mut store = read_store(ctx).ok_or_else(unusable)?;
        let before = js::stringify(&Value::Object(store.clone()));
        let known = items.iter().any(|item| item["id"] == id);
        let dismissed = store
            .get(id)
            .is_some_and(|entry| strict_equal(entry.get("dismissedSince"), entry.get("since")));
        if !known && !(allow_dismissed && dismissed) {
            return Err(CoreError::new(
                Code::UnknownTask,
                format!("unknown attention item \"{id}\""),
            ));
        }
        let entry = store
            .entry(id)
            .or_insert_with(|| json!({"since": js::number(ctx.now)}));
        let Value::Object(entry) = entry else {
            return Err(unusable());
        };
        change(entry);
        let after = js::stringify(&Value::Object(store));
        if before != after {
            write_private(&path(ctx), after.as_bytes())
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        }
        Ok(())
    })
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
}

pub fn attention_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "attention operations require the snapshot probe bridge",
        ))
    })
}

pub async fn attention_dismiss(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let (id, _) = parse(&params, false)?;
    let items = raised(ctx, parts).await?;
    transaction(ctx, &id, &items, true, |entry| {
        match entry.get("since").cloned() {
            Some(since) => {
                entry.insert("dismissedSince".into(), since);
            }
            None => {
                entry.shift_remove("dismissedSince");
            }
        }
    })?;
    Ok(json!({"dismissed": true}))
}

pub async fn attention_snooze(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let (id, duration) = parse(&params, true)?;
    let items = raised(ctx, parts).await?;
    let seconds = match duration {
        "1h" => 3600.0,
        "4h" => 14400.0,
        _ => 86400.0,
    };
    let until = js::number(ctx.now + seconds);
    let value = until.clone();
    transaction(ctx, &id, &items, false, |entry| {
        entry.insert("snoozedUntil".into(), value);
    })?;
    Ok(json!({"until": until}))
}

#[cfg(test)]
mod tests;
