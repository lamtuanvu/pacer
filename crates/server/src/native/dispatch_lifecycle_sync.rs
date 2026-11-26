//! Core hand-off for the `dispatch.*` lifecycle ops. B2-9 serves submit/child
//! and B2-10 serves wait/review/stop natively; `retry` and `answer` still go to
//! Core unchanged. Bodies serde_json rejects are forwarded verbatim until the
//! remaining lifecycle ops are ported.
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
    op == "config.set"
        || lifecycle_ops::LIFECYCLE_OPS.contains(&op)
        || pacer_task_ops::session_lifecycle_ops::uses_admission(op)
        || pacer_task_ops::task_delegation_ops::is_delegation_op(op)
        || crate::native::client_ops::is_client_op(op)
        || crate::native::terminal_ops::uses_bridge(op)
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
        // B2-10 answers wait, review and stop natively; retry/answer still go to Core.
        assert!(!dispatch_lifecycle_stays_forwarded(
            &ctx,
            "dispatch.wait",
            &json!({"id": "t"})
        ));
        assert!(dispatch_lifecycle_stays_forwarded(
            &ctx,
            "dispatch.retry",
            &json!({"id": "t", "expect_rev": 1, "requestId": "r"})
        ));
        assert!(!dispatch_lifecycle_stays_forwarded(
            &ctx,
            "task.wait",
            &json!({"id": "t"})
        ));
    }

    #[test]
    fn only_forwarded_ops_and_config_set_forward_bodies_serde_rejects() {
        const TERMINAL: [&str; 4] = [
            "terminal.list",
            "terminal.create",
            "terminal.rename",
            "terminal.close",
        ];
        for op in lifecycle_ops::LIFECYCLE_OPS
            .iter()
            .chain(&["config.set"])
            .chain(crate::native::client_ops::CLIENT_OPS)
            .chain(TERMINAL.iter())
        {
            assert!(forwards_undecodable_body(op));
        }
        assert!(
            TERMINAL
                .iter()
                .all(|op| crate::native::terminal_ops::uses_bridge(op))
        );
        assert!(!forwards_undecodable_body("dispatch.tree"));
        assert!(!forwards_undecodable_body("task.wait"));
    }
}
