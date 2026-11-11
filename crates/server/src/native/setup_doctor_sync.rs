//! Core bridge routes for `setup.health` and `doctor.run`. The planner and plugin
//! checks read Core's in-process plugin registry and the Claude handler probes run
//! the TypeScript hook handlers, so both reports are produced by Core.
use serde_json::{Value, json};

pub(crate) fn routes(op: &str) -> bool {
    pacer_config_ops::doctor_ops::needs_setup_doctor_bridge(op)
}

/// Serve already knows its link is reachable, as the HTTP op deps say for the
/// forwarded `setup.health`; stdio leaves the snapshot probe to Core's default.
pub(crate) fn serve_body(mut body: Value) -> Value {
    if body.get("op").and_then(Value::as_str) == Some("setup.health")
        && let Value::Object(map) = &mut body
    {
        map.insert("snapshotProbe".into(), json!(false));
    }
    body
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::native::core_bridge_sync::request_body;
    use crate::native::p8_bridge_ops::bridge_params;

    #[test]
    fn routes_only_the_setup_doctor_ops() {
        assert!(routes("setup.health"));
        assert!(routes("doctor.run"));
        assert!(!routes("setup.check"));
        assert!(!routes("setup.effects"));
    }

    #[test]
    fn bridge_body_carries_the_op_and_parsed_params() {
        let health = bridge_params("setup.health", &json!({"trigger": "update", "x": 1})).unwrap();
        assert_eq!(
            request_body("setup.health", &health).unwrap(),
            json!({"op": "setup.health", "params": {"trigger": "update"}})
        );
        assert_eq!(
            serve_body(health),
            json!({"op": "setup.health", "params": {"trigger": "update"}, "snapshotProbe": false})
        );
        let doctor = bridge_params("doctor.run", &json!({})).unwrap();
        assert_eq!(
            serve_body(doctor.clone()),
            json!({"op": "doctor.run", "params": {}})
        );
        assert_eq!(request_body("doctor.run", &doctor).unwrap(), doctor);
    }
}
