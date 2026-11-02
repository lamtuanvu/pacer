use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
mod task_reads;

#[cfg(feature = "test-ops")]
fn echo(_: &Ctx, params: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(async move {
        if std::env::var("PACER_TEST_ECHO_BREAK").as_deref() == Ok("1") {
            Ok(serde_json::json!({"broken": true}))
        } else {
            Ok(params)
        }
    })
}

#[cfg(feature = "test-ops")]
fn debug(_: &Ctx, _: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(async move {
        let forward = std::env::var("PACER_FORWARD_OPS").unwrap_or_default();
        Ok(serde_json::json!(registry(&forward).names()))
    })
}

static OPS: &[NativeOp] = &[
    NativeOp {
        name: "activity.list",
        call: task_reads::activity_list,
    },
    NativeOp {
        name: "task.log",
        call: task_reads::task_log,
    },
    #[cfg(feature = "test-ops")]
    NativeOp {
        name: "test.echo",
        call: echo,
    },
    #[cfg(feature = "test-ops")]
    NativeOp {
        name: "_debug.native",
        call: debug,
    },
];

pub fn registry(forward: &str) -> Registry<'static> {
    Registry::new(OPS, forward)
}

#[allow(clippy::result_large_err)]
pub async fn call_native(
    ctx: &Ctx,
    op: &NativeOp,
    params: Value,
    request_id: Option<&Value>,
) -> Result<Value, CoreError> {
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        if let Some(id) = request_id {
            eprintln!("native {} {}", op.name, id);
        } else {
            eprintln!("native {}", op.name);
        }
    }
    (op.call)(ctx, params).await
}

#[cfg(test)]
mod tests {
    use super::registry;

    #[test]
    fn forward_override_removes_only_selected_native_ops() {
        assert!(registry("").get("activity.list").is_some());
        assert!(registry("").get("task.log").is_some());
        assert!(registry("activity.list").get("activity.list").is_none());
        assert!(registry("activity.list").get("task.log").is_some());
        assert!(registry("*").names().is_empty());
        assert!(registry("").get("task.dismiss").is_none());
        assert!(registry("").get("task.diff").is_none());
    }
}
