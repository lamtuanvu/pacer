//! Native `attention.dismiss` and `attention.snooze` (`src/core/attention.ts`,
//! `src/attention/store.ts`): the raised items come from the read model over
//! the snapshot probe bridge, and the `state/attention.json` transaction is
//! Rust's.
//!
//! Every raised item is answered here: `discovery-network` comes from B7's native
//! radio state, dismissing a task item also dismisses the task with native
//! auto-clean, and the store files follow the TypeScript transaction (including
//! its "Attempted to assign to readonly property." text).
#![allow(clippy::result_large_err)]
use crate::snapshot_get_ops::{local_zone, model, parse_snapshot_parts};
use pacer_delegation::Runtime;
use pacer_discovery_ops::network::{radio_available, radio_network};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_read_model::{SnapshotInput, StatusInput, js};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

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

/// The JSON shape `readJson(path) ?? {}` yields. Arrays accept a named property
/// but never serialize it; primitives reject the assignment with the Bun error.
#[derive(Clone, Copy, PartialEq)]
enum StoreKind {
    Plain,
    Array,
    Primitive,
}

fn read_store(ctx: &Ctx) -> (Map<String, Value>, StoreKind) {
    let Ok(bytes) = std::fs::read(path(ctx)) else {
        return (Map::new(), StoreKind::Plain);
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Err(_) | Ok(Value::Null) => (Map::new(), StoreKind::Plain),
        Ok(Value::Object(store)) => (store, StoreKind::Plain),
        Ok(Value::Array(_)) => (Map::new(), StoreKind::Array),
        Ok(_) => (Map::new(), StoreKind::Primitive),
    }
}

/// `discoveryRuleInput(ctx, now).network` in `src/discovery/prompts.ts`: the
/// radio's current network only while it is available and still unanswered.
fn discovery_network_item(ctx: &Ctx) -> Option<Value> {
    if !radio_available() {
        return None;
    }
    let net = radio_network()?;
    let state: Value = std::fs::read_to_string(ctx.pacer_home.join("discovery/state.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    if state["enabled"] == false {
        return None;
    }
    let entry = &state["networks"][net.key.as_str()];
    if !entry.is_object() || !entry.get("advertise").is_some_and(Value::is_null) {
        return None;
    }
    let name = std::fs::read_to_string(ctx.pacer_home.join("identity/machine.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?["name"]
        .as_str()
        .map(str::to_owned)?;
    let rev = state["networksRev"].clone();
    let mut actions = vec![json!({
        "label": "Allow",
        "op": "discovery.network.set",
        "params": {"network": net.key, "advertise": true, "expect_rev": rev},
        "style": "primary",
    })];
    actions.push(json!({
        "label": "Not on this network",
        "op": "discovery.network.set",
        "params": {"network": net.key, "advertise": false, "expect_rev": rev},
    }));
    Some(json!({
        "id": format!("discovery-network:{}", net.key),
        "kind": "discovery-network",
        "severity": "decide",
        "repo": Value::Null,
        "title": format!("Let your other machines find this one on {}?", net.label),
        "detail": format!("It will appear as {name}."),
        "raisedAt": js::number(ctx.now),
        "since": js::number(ctx.now),
        "actions": actions,
        "notify": "all",
    }))
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
    let mut items = result.raised;
    if let Some(item) = discovery_network_item(ctx) {
        items.push(item);
    }
    Ok(items)
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
/// A primitive store or entry reproduces Bun's "Attempted to assign to readonly
/// property." instead of forwarding; an array accepts the entry but never persists it.
fn transaction(
    ctx: &Ctx,
    id: &str,
    items: &[Value],
    allow_dismissed: bool,
    change: impl FnOnce(&mut Map<String, Value>),
) -> Result<(), CoreError> {
    with_lock(ctx, "attention", LockOptions::default(), || {
        let (mut store, kind) = read_store(ctx);
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
        if kind == StoreKind::Primitive
            || store.get(id).is_some_and(|entry| !entry.is_object())
        {
            return Err(CoreError::new(
                Code::Internal,
                "Attempted to assign to readonly property.",
            ));
        }
        let entry = store
            .entry(id)
            .or_insert_with(|| json!({"since": js::number(ctx.now)}));
        let Value::Object(entry) = entry else {
            unreachable!("checked above")
        };
        change(entry);
        let after = js::stringify(&Value::Object(store));
        if kind == StoreKind::Plain && before != after {
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
    runtime: Option<&Runtime>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let (id, _) = parse(&params, false)?;
    let items = raised(ctx, parts).await?;
    // `dismissItem` calls `dismissTasks` for every raised item with a `taskId`
    // (`src/core/attention.ts:46`), which covers the task kinds and prompt_wait.
    let task_id = items
        .iter()
        .find(|item| item["id"] == id)
        .and_then(|item| item["taskId"].as_str())
        .map(str::to_owned);
    let already = {
        let (store, _) = read_store(ctx);
        store
            .get(&id)
            .is_some_and(|entry| strict_equal(entry.get("dismissedSince"), entry.get("since")))
    };
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
    // `dismiss` in `src/core/attention.ts:44-49`: task-kind items also dismiss
    // the task with native auto-clean (`src/core/tasks.ts:298-309`).
    if !already
        && let (Some(task_id), Some(runtime)) = (task_id, runtime)
    {
        let ids = vec![task_id];
        let clean = crate::task_dismiss_ops::auto_clean(ctx, runtime, &ids);
        crate::task_dismiss_ops::task_dismiss(ctx, json!({"ids": ids}), clean).await?;
    }
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
