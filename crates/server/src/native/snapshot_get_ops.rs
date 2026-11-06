#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_read_model::{
    ActiveSession, Probes, ReadModel, SessionProbe, SnapshotInput, StatusInput,
};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

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

pub(crate) fn needs_snapshot_bridge(op: &str) -> bool {
    matches!(op, "snapshot.get")
}

fn parse_params(params: &Value) -> Result<(), CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(())
}

fn truth(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

pub(crate) struct SnapshotBridgeParts {
    pub(crate) probes: Probes,
    pub(crate) status: StatusInput,
    pub(crate) alive_pids: HashSet<i64>,
}

pub(crate) fn parse_snapshot_parts(value: Value) -> Result<SnapshotBridgeParts, CoreError> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid("snapshot probe bridge returned a non-object payload"))?;
    let active = map
        .get("active")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("snapshot probe bridge missing active sessions"))?;
    let mut sessions = Vec::with_capacity(active.len());
    for (index, row) in active.iter().enumerate() {
        let Some(obj) = row.as_object() else {
            return Err(invalid(format!(
                "active.{index}: Invalid input: expected object, received {}",
                type_name(row)
            )));
        };
        let task_id = obj.get("task_id").and_then(Value::as_str).ok_or_else(|| {
            invalid(format!(
                "active.{index}.task_id: Invalid input: expected string, received undefined"
            ))
        })?;
        let executor = obj.get("executor").and_then(Value::as_str).ok_or_else(|| {
            invalid(format!(
                "active.{index}.executor: Invalid input: expected string, received undefined"
            ))
        })?;
        sessions.push(ActiveSession {
            task_id: task_id.into(),
            executor: executor.into(),
        });
    }
    let revision = map
        .get("revision")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let alive_pids = map
        .get("alivePids")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("snapshot probe bridge missing alivePids"))?
        .iter()
        .filter_map(|v| v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0))
        .map(|n| n as i64)
        .collect();
    let setup = map
        .get("setup")
        .cloned()
        .ok_or_else(|| invalid("snapshot probe bridge missing setup"))?;
    let policy = map
        .get("policy")
        .cloned()
        .ok_or_else(|| invalid("snapshot probe bridge missing policy"))?;
    let machine = map
        .get("machine")
        .cloned()
        .ok_or_else(|| invalid("snapshot probe bridge missing machine"))?;
    let service = map
        .get("service")
        .cloned()
        .ok_or_else(|| invalid("snapshot probe bridge missing service"))?;
    let desktop_updates = array(
        map.get("desktopUpdates")
            .ok_or_else(|| invalid("snapshot probe bridge missing desktopUpdates"))?,
    );
    let service_installed = map
        .get("serviceInstalled")
        .map(truth)
        .unwrap_or(false);
    let can_pair = map.get("canPair").map(truth).unwrap_or(false);
    let status = if let Some(message) = map.get("statusError").and_then(Value::as_str) {
        StatusInput::Failure(message.into())
    } else {
        StatusInput::Provided(
            map.get("status")
                .cloned()
                .ok_or_else(|| invalid("snapshot probe bridge missing status"))?,
        )
    };
    Ok(SnapshotBridgeParts {
        probes: Probes {
            setup,
            policy,
            machine,
            service,
            desktop_updates,
            service_installed,
            can_pair,
            sessions: SessionProbe {
                revision,
                active: sessions,
            },
        },
        status,
        alive_pids,
    })
}

fn model() -> &'static Mutex<ReadModel> {
    static MODEL: OnceLock<Mutex<ReadModel>> = OnceLock::new();
    MODEL.get_or_init(|| Mutex::new(ReadModel::new()))
}

fn local_zone(ctx: &Ctx) -> chrono_tz::Tz {
    if let Some(name) = ctx.env.get("TZ") {
        if let Ok(zone) = name.parse() {
            return zone;
        }
    }
    std::env::var("TZ")
        .ok()
        .and_then(|name| name.parse().ok())
        .unwrap_or(chrono_tz::UTC)
}

pub(super) fn snapshot_get_stub(_: &Ctx, _: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "snapshot.get requires the snapshot probe bridge",
        ))
    })
}

pub(crate) async fn snapshot_get(
    ctx: &Ctx,
    params: Value,
    parts: Value,
) -> Result<Value, CoreError> {
    parse_params(&params)?;
    let bridge = parse_snapshot_parts(parts)?;
    let alive_pids = bridge.alive_pids;
    let alive = move |pid: i64| alive_pids.contains(&pid);
    let input = SnapshotInput::new(&bridge.probes, bridge.status);
    let result = model()
        .lock()
        .map_err(|_| CoreError::new(Code::Internal, "read model lock poisoned"))?
        .snapshot(&ctx, input, local_zone(ctx), &alive)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    Ok(result.wire(3))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_snapshot_parts_builds_probes_and_alive_set() {
        let parts = parse_snapshot_parts(json!({
            "revision": "abc",
            "active": [{"task_id": "t-1", "executor": "codex"}],
            "alivePids": [42.0],
            "setup": {"open": 0, "items": []},
            "policy": {},
            "machine": {"os": "linux", "arch": "x64"},
            "service": {"version": "0.0.0", "protocol": "3.0.0", "pid": 1, "startedAt": 0, "notifier": null},
            "desktopUpdates": [],
            "serviceInstalled": false,
            "canPair": true,
            "status": {"generatedAt": 1.0, "strategy": "s", "planner": "p", "mode": "normal", "disabled": false, "calendarPace": false, "providers": [], "executors": {"ranked": [], "excluded": []}},
        }))
        .unwrap();
        assert!(parts.probes.can_pair);
        assert!(parts.alive_pids.contains(&42));
    }
}
