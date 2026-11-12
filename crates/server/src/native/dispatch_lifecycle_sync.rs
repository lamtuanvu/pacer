//! Core hand-off for the `dispatch.*` lifecycle ops. Worker spawn, queue drain,
//! runner supervision and the review, retry, answer and stop transactions stay
//! in Core, so a request Rust would not refuse is forwarded unchanged rather
//! than replayed over an internal bridge: Core sees the caller's own request
//! and auth, and `dispatch.wait` may block past the 120 s bridge timeout.
use pacer_dispatch_ops::lifecycle_ops;
use pacer_foundation::Ctx;
use serde_json::Value;

pub(crate) fn dispatch_lifecycle_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    lifecycle_ops::lifecycle_stays_forwarded(ctx, op, params)
}

/// An HTTP body serde_json rejects may still be JSON to Core: `TextDecoder`
/// replaces invalid UTF-8 and drops a BOM, and `JSON.parse` accepts unpaired
/// surrogate escapes and numbers past the f64 range.
pub(crate) fn forwards_undecodable_body(op: &str) -> bool {
    op == "config.set" || lifecycle_ops::LIFECYCLE_OPS.contains(&op)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_requests_rust_would_refuse_stay_native() {
        let home = std::env::temp_dir();
        let ctx = Ctx::with(home.clone(), home.join(".pacer"), Default::default(), 0.0);
        let executor = Ctx::with(
            home.clone(),
            home.join(".pacer"),
            [("PACER_ROLE".to_string(), "executor".to_string())].into(),
            0.0,
        );
        for op in lifecycle_ops::LIFECYCLE_OPS {
            assert!(!dispatch_lifecycle_stays_forwarded(
                &executor,
                op,
                &json!({})
            ));
            assert!(!dispatch_lifecycle_stays_forwarded(&ctx, op, &json!("x")));
        }
        assert!(dispatch_lifecycle_stays_forwarded(
            &ctx,
            "dispatch.wait",
            &json!({"id": "t"})
        ));
        assert!(!dispatch_lifecycle_stays_forwarded(
            &ctx,
            "task.wait",
            &json!({"id": "t"})
        ));
    }

    #[test]
    fn only_lifecycle_ops_and_config_set_forward_bodies_serde_rejects() {
        for op in lifecycle_ops::LIFECYCLE_OPS.iter().chain(&["config.set"]) {
            assert!(forwards_undecodable_body(op));
        }
        assert!(!forwards_undecodable_body("dispatch.tree"));
        assert!(!forwards_undecodable_body("task.wait"));
    }
}
