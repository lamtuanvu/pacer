//! HTTP bodies serde_json rejects may still be JSON to Core: `TextDecoder`
//! replaces invalid UTF-8 and drops a BOM, and `JSON.parse` accepts unpaired
//! surrogate escapes and numbers past the f64 range. These op groups still
//! own their TypeScript readers; B2-11 removed only the dispatch lifecycle
//! ops from this shared forward (and the `assistant.ask`/`assistant.cancel`
//! bridge keeps its own arm until B4).
pub(crate) fn needs_core_body_forward(op: &str) -> bool {
    op == "config.set"
        || pacer_task_ops::session_lifecycle_ops::uses_admission(op)
        || pacer_task_ops::task_delegation_ops::is_delegation_op(op)
        || crate::native::client_ops::is_client_op(op)
        || crate::native::terminal_ops::uses_bridge(op)
}
