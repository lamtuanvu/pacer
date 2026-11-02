use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
pub mod plugins;
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

/// The HTTP service has the generation-bound Core process adapter; stdio does not.
pub fn service_registry(forward: &str) -> Registry<'static> {
    static ALL: std::sync::OnceLock<Vec<NativeOp>> = std::sync::OnceLock::new();
    Registry::new(
        ALL.get_or_init(|| {
            OPS.iter()
                .map(|op| NativeOp {
                    name: op.name,
                    call: op.call,
                })
                .chain(plugins::operations())
                .collect()
        }),
        forward,
    )
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
        assert!(registry("").get("plugin.install").is_none());
        assert!(registry("plugin.install").get("plugin.install").is_none());
        assert!(registry("").get("task.log").is_some());
        assert!(registry("activity.list").get("activity.list").is_none());
        assert!(registry("activity.list").get("task.log").is_some());
        assert!(registry("*").names().is_empty());
        assert!(registry("").get("task.dismiss").is_none());
        assert!(registry("").get("task.diff").is_none());
    }

    #[test]
    fn service_registers_only_read_operations_with_individual_fallbacks() {
        for name in pacer_plugin_ops::public::OPERATIONS {
            assert!(super::service_registry("").get(name).is_some(), "{name}");
            assert!(super::service_registry(name).get(name).is_none(), "{name}");
        }
        for name in [
            "plugin.install",
            "plugin.enable",
            "plugin.disable",
            "plugin.remove",
            "plugin.ui.render",
            "plugin.ui.action",
            "plugin.ui.visibility",
            "plugin.settings.set",
        ] {
            assert!(super::service_registry("").get(name).is_none(), "{name}");
            assert!(registry("").get(name).is_none(), "{name}");
        }
        assert!(super::service_registry("*").names().is_empty());
        // A stdio child owns a separate TS registry, with no private service adapter.
        assert!(registry("").get("plugin.list").is_none());
    }
}
