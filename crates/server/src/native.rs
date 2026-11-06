use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
mod config_get_ops;
pub(crate) mod config_host_sync;
mod config_params;
pub(crate) mod config_sync;
mod config_writes;
pub(crate) mod core_bridge_sync;
mod engine_ops;
mod host_mut_ops;
pub(crate) mod host_mut_sync;
mod host_read_ops;
pub(crate) mod host_read_sync;
mod lifecycle_ops;
mod meta_ops;
pub(crate) mod p8_bridge_ops;
pub mod plugins;
mod repo_ops;
pub(crate) mod session_ops;
pub(crate) mod session_sync;
mod setup_ops;
mod snapshot_get_ops;
pub(crate) mod snapshot_sync;
pub(crate) mod status_ops;
pub(crate) mod status_sync;
pub(crate) mod task_clean_sync;
mod task_diff_ops;
pub(crate) mod task_dismiss_ops;
mod task_get_ops;
pub(crate) mod task_read_sync;
mod task_reads;
mod task_stop_ops;
pub(crate) mod task_stop_sync;
mod task_wait_ops;
pub(crate) mod task_wait_sync;

pub(crate) use config_get_ops::needs_config_host_bridge;
pub(crate) use config_writes::config_set_stays_forwarded;
pub(crate) use engine_ops::mode_hold_stays_forwarded;
pub(crate) use host_read_ops::{needs_host_read_bridge, needs_host_read_injection};
pub(crate) use p8_bridge_ops::needs_core_bridge;
pub(crate) use repo_ops::repo_remove_stays_forwarded;
pub(crate) use session_ops::needs_session_probe;
pub(crate) use snapshot_get_ops::needs_snapshot_bridge;
pub(crate) use status_ops::{needs_usage_broker, routing_route_stays_forwarded};
pub(crate) use task_dismiss_ops::needs_task_clean_bridge;
pub(crate) use task_get_ops::needs_task_read_bridge;
pub(crate) use task_stop_ops::needs_task_stop_bridge;

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
        name: "config.get",
        call: config_get_ops::config_get_stub,
    },
    NativeOp {
        name: "host.suggest",
        call: host_read_ops::host_suggest,
    },
    NativeOp {
        name: "host.list",
        call: host_read_ops::host_list_stub,
    },
    NativeOp {
        name: "host.get",
        call: host_read_ops::host_get_stub,
    },
    NativeOp {
        name: "host.add",
        call: host_mut_ops::host_add,
    },
    NativeOp {
        name: "host.set",
        call: host_mut_ops::host_set_stub,
    },
    NativeOp {
        name: "host.remove",
        call: host_mut_ops::host_remove,
    },
    NativeOp {
        name: "host.repo.map",
        call: host_mut_ops::host_repo_map,
    },
    NativeOp {
        name: "host.account.add",
        call: host_mut_ops::host_account_add,
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
        name: "task.list",
        call: session_ops::task_list_stub,
    },
    NativeOp {
        name: "task.get",
        call: task_get_ops::task_get_stub,
    },
    NativeOp {
        name: "snapshot.get",
        call: snapshot_get_ops::snapshot_get_stub,
    },
    NativeOp {
        name: "version.get",
        call: meta_ops::version_get,
    },
    NativeOp {
        name: "api.list",
        call: meta_ops::api_list,
    },
    NativeOp {
        name: "api.describe",
        call: meta_ops::api_describe,
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
        name: "limits.check",
        call: status_ops::limits_check_stub,
    },
    NativeOp {
        name: "routing.status",
        call: status_ops::routing_status_stub,
    },
    NativeOp {
        name: "routing.route",
        call: status_ops::routing_route_stub,
    },
    NativeOp {
        name: "task.request_review",
        call: lifecycle_ops::task_request_review,
    },
    NativeOp {
        name: "task.stop",
        call: task_stop_ops::task_stop_stub,
    },
    NativeOp {
        name: "task.wait",
        call: task_wait_ops::task_wait,
    },
    NativeOp {
        name: "task.dismiss",
        call: task_dismiss_ops::task_dismiss_stub,
    },
    NativeOp {
        name: "task.diff",
        call: task_diff_ops::task_diff_op,
    },
    NativeOp {
        name: "machine.get",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "machine.set",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "machine.rotate",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "files.search",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "setup.check",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "onboarding.skip",
        call: setup_ops::onboarding_skip,
    },
    NativeOp {
        name: "repo.list",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "repo.add",
        call: p8_bridge_ops::bridge_stub,
    },
    NativeOp {
        name: "repo.remove",
        call: repo_ops::repo_remove,
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

#[allow(clippy::result_large_err, clippy::too_many_arguments)]
pub async fn call_native(
    ctx: &Ctx,
    op: &NativeOp,
    params: Value,
    request_id: Option<&Value>,
    endpoint_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    broker_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    session_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    task_read_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    config_host_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    snapshot_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    task_clean_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    host_read_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    core_bridge_sync: Option<pacer_foundation::api::OpFuture<'_>>,
    task_stop_probe: Option<Value>,
    task_stop_effects: Option<pacer_foundation::api::OpFuture<'_>>,
) -> Result<Value, CoreError> {
    let mut host_read_bridge = host_read_sync;
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        if let Some(id) = request_id {
            eprintln!("native {} {}", op.name, id);
        } else {
            eprintln!("native {}", op.name);
        }
    }
    if config_writes::syncs_endpoints(op.name)
        && endpoint_sync.is_none()
        && !(op.name == "host.set" && host_read_bridge.is_some())
    {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "endpoint synchronization bridge unavailable",
        ));
    }
    if needs_task_clean_bridge(op.name) && task_clean_sync.is_none() {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "task clean bridge unavailable",
        ));
    }
    if needs_task_stop_bridge(op.name) && (task_stop_probe.is_none() || task_stop_effects.is_none())
    {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "task stop bridge unavailable",
        ));
    }
    let mut host_set_alias: Option<String> = None;
    let result = if op.name == "host.set" {
        host_set_alias = Some(host_mut_ops::host_set_write(ctx, params).await?);
        Value::Null
    } else if needs_usage_broker(op.name) {
        let parts = broker_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "usage broker bridge unavailable",
            )
        })?;
        match op.name {
            "limits.check" => status_ops::limits_check(ctx, params, parts.await?).await?,
            "routing.status" => status_ops::routing_status(ctx, params, parts.await?).await?,
            "routing.route" => status_ops::routing_route(ctx, params, parts.await?).await?,
            _ => unreachable!("needs_usage_broker"),
        }
    } else if needs_task_read_bridge(op.name) {
        let parts = task_read_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task read bridge unavailable",
            )
        })?;
        match op.name {
            "task.get" => task_get_ops::task_get(ctx, params, parts.await?).await?,
            _ => unreachable!("needs_task_read_bridge"),
        }
    } else if needs_snapshot_bridge(op.name) {
        let parts = snapshot_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "snapshot probe bridge unavailable",
            )
        })?;
        match op.name {
            "snapshot.get" => snapshot_get_ops::snapshot_get(ctx, params, parts.await?).await?,
            _ => unreachable!("needs_snapshot_bridge"),
        }
    } else if needs_session_probe(op.name) {
        let parts = session_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "session probe bridge unavailable",
            )
        })?;
        let probe = session_ops::parse_probe_parts(parts.await?)?;
        match op.name {
            "task.list" => session_ops::task_list(ctx, params, probe).await?,
            _ => unreachable!("needs_session_probe"),
        }
    } else if needs_config_host_bridge(op.name) {
        let parts = config_host_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "config host bridge unavailable",
            )
        })?;
        match op.name {
            "config.get" => config_get_ops::config_get(ctx, params, parts.await?).await?,
            _ => unreachable!("needs_config_host_bridge"),
        }
    } else if needs_host_read_bridge(op.name) {
        let parts = host_read_bridge
            .take()
            .ok_or_else(|| {
                CoreError::new(
                    pacer_foundation::api::Code::Unavailable,
                    "host read bridge unavailable",
                )
            })?
            .await?;
        match op.name {
            "host.list" => host_read_ops::host_list(ctx, params, parts).await?,
            "host.get" => host_read_ops::host_get(ctx, params, parts).await?,
            _ => unreachable!("needs_host_read_bridge"),
        }
    } else if needs_task_clean_bridge(op.name) {
        let clean = task_clean_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task clean bridge unavailable",
            )
        })?;
        match op.name {
            "task.dismiss" => task_dismiss_ops::task_dismiss(ctx, params, clean).await?,
            _ => unreachable!("needs_task_clean_bridge"),
        }
    } else if needs_task_stop_bridge(op.name) {
        let probe = task_stop_probe.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task stop bridge unavailable",
            )
        })?;
        let effects = task_stop_effects.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task stop effects bridge unavailable",
            )
        })?;
        match op.name {
            "task.stop" => task_stop_ops::task_stop(ctx, params, probe, effects).await?,
            _ => unreachable!("needs_task_stop_bridge"),
        }
    } else if needs_core_bridge(op.name) {
        let _ = p8_bridge_ops::bridge_params(op.name, &params)?;
        let parts = core_bridge_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "core bridge unavailable",
            )
        })?;
        parts.await?
    } else {
        (op.call)(ctx, params).await?
    };
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
    let result = if let Some(alias) = host_set_alias {
        let parts = host_read_bridge
            .take()
            .ok_or_else(|| {
                CoreError::new(
                    pacer_foundation::api::Code::Unavailable,
                    "host read bridge unavailable",
                )
            })?
            .await?;
        host_mut_ops::host_set_summary(parts, &alias)?
    } else {
        result
    };
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
            "config.get",
            "config.set",
            "host.suggest",
            "host.list",
            "host.get",
            "host.add",
            "host.set",
            "host.remove",
            "host.repo.map",
            "host.account.add",
            "delegation.pause",
            "delegation.resume",
            "mode.hold",
            "mode.release",
            "limits.report",
            "limits.check",
            "routing.status",
            "routing.route",
            "task.request_review",
            "task.stop",
            "task.dismiss",
            "task.diff",
            "task.list",
            "task.get",
            "snapshot.get",
            "version.get",
            "api.list",
            "api.describe",
            "machine.get",
            "machine.set",
            "machine.rotate",
            "files.search",
            "setup.check",
            "onboarding.skip",
            "repo.list",
            "repo.add",
            "repo.remove",
        ] {
            assert!(registry("").get(name).is_some(), "{name}");
            assert!(registry(name).get(name).is_none(), "{name}");
        }
        assert!(registry("").get("config.get").is_some());
        assert!(registry("config.get").get("config.get").is_none());
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
        assert!(registry("").get("task.dismiss").is_some());
        assert!(registry("task.dismiss").get("task.dismiss").is_none());
        assert!(registry("").get("task.diff").is_some());
        assert!(registry("task.diff").get("task.diff").is_none());
        assert!(registry("task.list").get("task.list").is_none());
        assert!(registry("task.get").get("task.get").is_none());
        assert!(registry("task.list").get("task.get").is_some());
        assert!(registry("snapshot.get").get("snapshot.get").is_none());
        assert!(registry("snapshot.get").get("task.list").is_some());
        assert!(registry("").get("task.delegate").is_none());
        assert!(registry("").get("task.stop").is_some());
        assert!(registry("task.stop").get("task.stop").is_none());
        assert!(registry("").get("task.answer").is_none());
        assert!(registry("").get("task.wait").is_some());
        assert!(registry("task.wait").get("task.wait").is_none());
        assert!(registry("").get("task.retry").is_none());
        assert!(registry("").get("task.retry_all").is_none());
        assert!(registry("").get("task.retry_options").is_none());
        assert!(registry("").get("task.review").is_none());
        assert!(registry("").get("task.ask").is_none());
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
            "config.get",
            "config.set",
            "host.suggest",
            "host.list",
            "host.get",
            "host.add",
            "host.set",
            "host.remove",
            "host.repo.map",
            "host.account.add",
            "delegation.pause",
            "delegation.resume",
            "mode.hold",
            "mode.release",
            "limits.report",
            "limits.check",
            "routing.status",
            "routing.route",
            "task.request_review",
            "task.stop",
            "task.dismiss",
            "task.diff",
            "task.list",
            "task.get",
            "snapshot.get",
            "version.get",
            "api.list",
            "api.describe",
            "machine.get",
            "machine.set",
            "machine.rotate",
            "files.search",
            "setup.check",
            "onboarding.skip",
            "repo.list",
            "repo.add",
            "repo.remove",
        ] {
            assert!(super::service_registry("").get(name).is_some(), "{name}");
            assert!(super::service_registry(name).get(name).is_none(), "{name}");
        }
        assert!(super::service_registry("").get("config.get").is_some());
        assert!(
            super::service_registry("config.get")
                .get("config.get")
                .is_none()
        );
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
