use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
mod config_params;
pub(crate) mod config_sync;
mod config_writes;
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
        name: "strategy.use",
        call: config_writes::strategy_use,
    },
    NativeOp {
        name: "strategy.save",
        call: config_writes::strategy_save,
    },
    NativeOp {
        name: "strategy.remove",
        call: config_writes::strategy_remove,
    },
    NativeOp {
        name: "routing.set",
        call: config_writes::routing_set,
    },
    NativeOp {
        name: "runner.set",
        call: config_writes::runner_set,
    },
    NativeOp {
        name: "runner.reorder",
        call: config_writes::runner_reorder,
    },
    NativeOp {
        name: "runner.remove",
        call: config_writes::runner_remove,
    },
    NativeOp {
        name: "notifications.get",
        call: config_writes::notifications_get,
    },
    NativeOp {
        name: "notifications.set",
        call: config_writes::notifications_set,
    },
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
    endpoint_sync: Option<pacer_foundation::api::OpFuture<'_>>,
) -> Result<Value, CoreError> {
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        if let Some(id) = request_id {
            eprintln!("native {} {}", op.name, id);
        } else {
            eprintln!("native {}", op.name);
        }
    }
    if config_writes::syncs_endpoints(op.name) && endpoint_sync.is_none() {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "endpoint synchronization bridge unavailable",
        ));
    }
    let result = (op.call)(ctx, params).await?;
    if config_writes::syncs_endpoints(op.name)
        && let Some(sync) = endpoint_sync
    {
        sync.await.map_err(|mut error| {
            if op.name == "runner.remove" {
                if error.code == pacer_foundation::api::Code::Internal {
                    error.code = pacer_foundation::api::Code::InvalidInput;
                }
                if error.hint.is_none() {
                    error.hint =
                        Some("Check the runner id, account and host configuration.".into());
                }
            }
            error
        })?;
    }
    config_writes::finish(ctx, op.name, &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::registry;

    #[test]
    fn forward_override_removes_only_selected_native_ops() {
        for name in [
            "strategy.use",
            "strategy.save",
            "strategy.remove",
            "routing.set",
            "runner.set",
            "runner.reorder",
            "runner.remove",
            "notifications.get",
            "notifications.set",
        ] {
            assert!(registry("").get(name).is_some(), "{name}");
            assert!(registry(name).get(name).is_none(), "{name}");
        }
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
            assert!(registry("").get(name).is_none(), "stdio {name}");
        }
        for name in [
            "strategy.use",
            "strategy.save",
            "strategy.remove",
            "routing.set",
            "runner.set",
            "runner.reorder",
            "runner.remove",
            "notifications.get",
            "notifications.set",
        ] {
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
