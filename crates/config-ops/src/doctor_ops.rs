//! P9 `setup.health` and `doctor.run`, validated in Rust and executed via the
//! TypeScript core bridge. The doctor checks stay on Core: planner and plugin
//! checks read its in-process plugin registry, the Claude handler probes run the
//! TypeScript hook handlers, and the status checks need `computeStatus`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};

use crate::host_read_ops::invalid;
use crate::repo_registry_ops::params_object;

const TRIGGERS: [&str; 3] = ["startup", "update", "manual"];

pub fn needs_setup_doctor_bridge(op: &str) -> bool {
    matches!(op, "setup.health" | "doctor.run")
}

fn bridge_unavailable() -> OpFuture<'static> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "setup doctor bridge unavailable",
        ))
    })
}

pub fn setup_health_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    bridge_unavailable()
}

pub fn doctor_run_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    bridge_unavailable()
}

/// `trigger: z.enum(["startup", "update", "manual"]).optional()`; other keys are stripped.
fn setup_health_params(params: &Value) -> Result<Map<String, Value>, CoreError> {
    let map = params_object(params)?;
    let mut parsed = Map::new();
    if let Some(trigger) = map.get("trigger") {
        match trigger.as_str() {
            Some(name) if TRIGGERS.contains(&name) => {
                parsed.insert("trigger".into(), name.into());
            }
            _ => {
                return Err(invalid(
                    r#"trigger: Invalid option: expected one of "startup"|"update"|"manual""#,
                ));
            }
        }
    }
    Ok(parsed)
}

/// The Core request: the op and its parsed params.
pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let parsed = match op {
        "doctor.run" => {
            params_object(params)?;
            Map::new()
        }
        "setup.health" => setup_health_params(params)?,
        _ => return Err(invalid("unknown core bridge op")),
    };
    Ok(json!({ "op": op, "params": parsed }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn message(op: &str, params: Value) -> String {
        bridge_params(op, &params).unwrap_err().message
    }

    #[test]
    fn doctor_run_strips_keys_and_reads_null_as_empty() {
        for params in [json!({}), json!(null), json!({"x": 1})] {
            assert_eq!(
                bridge_params("doctor.run", &params).unwrap(),
                json!({"op": "doctor.run", "params": {}})
            );
        }
        assert_eq!(
            message("doctor.run", json!(5)),
            "params: Invalid input: expected object, received number"
        );
        assert_eq!(
            message("doctor.run", json!([])),
            "params: Invalid input: expected object, received array"
        );
    }

    #[test]
    fn setup_health_accepts_only_known_triggers() {
        for trigger in TRIGGERS {
            assert_eq!(
                bridge_params("setup.health", &json!({"trigger": trigger, "y": 2})).unwrap(),
                json!({"op": "setup.health", "params": {"trigger": trigger}})
            );
        }
        assert_eq!(
            bridge_params("setup.health", &json!(null)).unwrap(),
            json!({"op": "setup.health", "params": {}})
        );
        for trigger in [json!("nope"), json!("Startup"), json!(5), json!(null)] {
            let error = bridge_params("setup.health", &json!({ "trigger": trigger })).unwrap_err();
            assert_eq!(error.code, Code::InvalidInput);
            assert_eq!(
                error.message,
                r#"trigger: Invalid option: expected one of "startup"|"update"|"manual""#
            );
        }
        assert_eq!(
            message("setup.health", json!("s")),
            "params: Invalid input: expected object, received string"
        );
    }

    #[tokio::test]
    async fn stubs_report_the_missing_bridge() {
        let ctx = Ctx::with(
            "/nonexistent".into(),
            "/nonexistent".into(),
            Default::default(),
            0.0,
        );
        for stub in [setup_health_stub, doctor_run_stub] {
            let error = stub(&ctx, json!({})).await.unwrap_err();
            assert_eq!(error.code, Code::Unavailable);
        }
    }
}
