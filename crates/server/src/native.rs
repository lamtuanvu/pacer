use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
mod config_params;
pub(crate) mod config_sync;
mod config_writes;
mod engine_ops;
mod lifecycle_ops;
pub mod plugins;
mod task_reads;

pub(crate) use config_writes::config_set_stays_forwarded;
pub(crate) use engine_ops::mode_hold_stays_forwarded;

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
        name: "strategy.list",
        call: config_writes::strategy_list,
    },
    NativeOp {
        name: "strategy.show",
        call: config_writes::strategy_show,
    },
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
        name: "routing.get",
        call: config_writes::routing_get,
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
        name: "runner.settings.get",
        call: config_writes::runner_settings_get,
    },
    NativeOp {
        name: "runner.settings.save",
        call: config_writes::runner_settings_save,
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
        name: "config.set",
        call: config_writes::config_set,
    },
    NativeOp {
        name: "activity.list",
        call: task_reads::activity_list,
    },
    NativeOp {
        name: "task.log",
        call: task_reads::task_log,
    },
    NativeOp {
        name: "task.prune",
        call: task_reads::task_prune,
    },
    NativeOp {
        name: "task.restore",
        call: task_reads::task_restore,
    },
    NativeOp {
        name: "delegation.pause",
        call: engine_ops::delegation_pause,
    },
    NativeOp {
        name: "delegation.resume",
        call: engine_ops::delegation_resume,
    },
    NativeOp {
        name: "mode.hold",
        call: engine_ops::mode_hold_op,
    },
    NativeOp {
        name: "mode.release",
        call: engine_ops::mode_release,
    },
    NativeOp {
        name: "limits.report",
        call: engine_ops::limits_report,
    },
    NativeOp {
        name: "task.request_review",
        call: lifecycle_ops::task_request_review,
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
            "strategy.list",
            "strategy.show",
            "strategy.use",
            "strategy.save",
            "strategy.remove",
            "routing.get",
            "routing.set",
            "runner.set",
            "runner.reorder",
            "runner.remove",
            "runner.settings.get",
            "runner.settings.save",
            "notifications.get",
            "notifications.set",
            "config.set",
            "delegation.pause",
            "delegation.resume",
            "mode.hold",
            "mode.release",
            "limits.report",
            "task.request_review",
        ] {
            assert!(registry("").get(name).is_some(), "{name}");
            assert!(registry(name).get(name).is_none(), "{name}");
        }
        assert!(registry("").get("config.get").is_none());
        assert!(registry("").get("activity.list").is_some());
        // Stdio keeps retired install in TypeScript; HTTP registers the refuse.
        assert!(registry("").get("plugin.install").is_none());
        assert!(registry("plugin.install").get("plugin.install").is_none());
        assert!(registry("").get("task.log").is_some());
        assert!(registry("").get("task.prune").is_some());
        assert!(registry("").get("task.restore").is_some());
        assert!(registry("activity.list").get("activity.list").is_none());
        assert!(registry("activity.list").get("task.log").is_some());
        assert!(registry("task.prune").get("task.prune").is_none());
        assert!(registry("task.prune").get("task.restore").is_some());
        assert!(registry("*").names().is_empty());
        assert!(registry("").get("task.dismiss").is_none());
        assert!(registry("").get("task.diff").is_none());
        assert!(registry("").get("task.get").is_none());
        assert!(registry("").get("task.list").is_none());
        assert!(registry("").get("task.delegate").is_none());
        assert!(registry("").get("task.stop").is_none());
        assert!(registry("").get("task.answer").is_none());
        assert!(registry("").get("task.wait").is_none());
        assert!(registry("").get("task.retry").is_none());
        assert!(registry("").get("task.retry_all").is_none());
        assert!(registry("").get("task.retry_options").is_none());
        assert!(registry("").get("task.review").is_none());
        assert!(registry("").get("task.ask").is_none());
        assert!(registry("").get("routing.status").is_none());
        assert!(registry("").get("routing.route").is_none());
        assert!(registry("").get("limits.check").is_none());
        assert!(registry("").get("limits.refresh").is_none());
    }

    #[test]
    fn service_registers_plugin_reads_and_mutations_with_individual_fallbacks() {
        for name in super::plugins::registered_names() {
            assert!(super::service_registry("").get(name).is_some(), "{name}");
            assert!(super::service_registry(name).get(name).is_none(), "{name}");
            assert!(registry("").get(name).is_none(), "stdio {name}");
        }
        for name in [
            "strategy.list",
            "strategy.show",
            "strategy.use",
            "strategy.save",
            "strategy.remove",
            "routing.get",
            "routing.set",
            "runner.set",
            "runner.reorder",
            "runner.remove",
            "runner.settings.get",
            "runner.settings.save",
            "notifications.get",
            "notifications.set",
            "config.set",
            "delegation.pause",
            "delegation.resume",
            "mode.hold",
            "mode.release",
            "limits.report",
            "task.request_review",
        ] {
            assert!(super::service_registry("").get(name).is_some(), "{name}");
            assert!(super::service_registry(name).get(name).is_none(), "{name}");
        }
        assert!(super::service_registry("").get("config.get").is_none());
        // P4d-4: retired install is native HTTP refuse; stdio stays TypeScript.
        assert!(super::service_registry("").get("plugin.install").is_some());
        assert!(
            super::service_registry("plugin.install")
                .get("plugin.install")
                .is_none()
        );
        assert!(registry("").get("plugin.install").is_none());
        assert!(super::service_registry("*").names().is_empty());
        assert!(registry("").get("plugin.list").is_none());
    }
}
