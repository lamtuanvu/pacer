use pacer_assistant_ops::assistant_ops;
use pacer_config_ops::config_get_ops;
use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
pub(crate) mod config_host_sync;
pub(crate) mod config_sync;
use pacer_config_ops::config_writes;
use pacer_config_ops::executor_setup_ops;
pub(crate) mod core_bridge_sync;
mod desktop_reconcile_ops;
use pacer_discovery_ops::{discovery_ops, network_ops};
use pacer_dispatch_ops::dependency_writes;
use pacer_dispatch_ops::dispatch_ops;
use pacer_dispatch_ops::insights_ops;
use pacer_dispatch_ops::learning_ops;
use pacer_dispatch_ops::planning_ops;
mod engine_ops;
use pacer_config_ops::host_mut_ops;
use pacer_task_ops::attention_ops;
use pacer_task_ops::files_search_ops;
use pacer_task_ops::job_ops;
pub(crate) mod host_mut_sync;
use pacer_config_ops::host_read_ops;
pub(crate) mod host_read_sync;
use pacer_machine_ops::machine_identity;
use pacer_machine_ops::machine_ops;
use pacer_task_ops::lifecycle_ops;
use pacer_task_ops::session_context_ops;
mod meta_ops;
pub(crate) use pacer_config_ops::p8_bridge_ops;
pub(crate) use pacer_messaging_ops::msg_ops;
pub mod plugins;
use pacer_config_ops::project_messaging_ops;
use pacer_config_ops::repo_ops;
use pacer_config_ops::runner_ops;
pub(crate) use pacer_task_ops::session_ops;
pub(crate) mod session_sync;
mod setup_ops;
use pacer_task_ops::snapshot_get_ops;
pub(crate) mod snapshot_sync;
pub(crate) mod status_ops;
pub(crate) mod status_sync;
pub(crate) mod task_clean_sync;
use pacer_task_ops::task_diff_ops;
pub(crate) use pacer_task_ops::task_dismiss_ops;
use pacer_task_ops::task_get_ops;
pub(crate) mod task_read_sync;
use pacer_task_ops::task_reads;
use pacer_task_ops::task_review_ops;
pub(crate) mod task_review_sync;
use pacer_task_ops::task_stop_ops;
pub(crate) mod task_stop_sync;
use pacer_task_ops::task_wait_ops;
pub(crate) mod task_wait_sync;

pub use assistant_ops::assistant_stays_forwarded;
pub(crate) use config_get_ops::needs_config_host_bridge;
pub(crate) use config_writes::config_set_stays_forwarded;
pub use dependency_writes::dependencies_waive_stays_forwarded;
pub use desktop_reconcile_ops::desktop_reconcile_stays_forwarded;
pub use discovery_ops::discovery_stays_forwarded;
pub(crate) use engine_ops::mode_hold_stays_forwarded;
pub(crate) use host_read_ops::{needs_host_read_bridge, needs_host_read_injection};
pub use insights_ops::insights_stays_forwarded;
#[doc(hidden)]
pub use machine_identity::set_identity_platform_for_tests;
pub(crate) use msg_ops::msg_stays_forwarded;
pub(crate) use p8_bridge_ops::needs_core_bridge;
use pacer_config_ops::{project_strategy_ops, repo_registry_ops, strategy_preview_ops};
#[doc(hidden)]
pub use pacer_discovery_ops::network::set_probe_outputs_for_tests;
pub use planning_ops::planning_stays_forwarded;
pub(crate) use project_messaging_ops::project_messaging_stays_forwarded;
pub(crate) use repo_ops::repo_remove_stays_forwarded;

/// `repo.list`, `repo.add`, `issue.*` and `project.strategy.*` inputs that only the TypeScript repository reader handles.
pub fn repo_registry_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    repo_registry_ops::repo_list_stays_forwarded(ctx, op)
        || pacer_issues::issue_stays_forwarded(ctx, op)
        || project_strategy_ops::project_strategy_stays_forwarded(ctx, op, params)
}

/// `job.*`, `strategy.preview` and `executor.setup.models` inputs that only TypeScript reproduces.
pub fn job_strategy_setup_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "strategy.preview" => strategy_preview_ops::strategy_preview_stays_forwarded(ctx, params),
        "executor.setup.models" => {
            executor_setup_ops::executor_setup_models_stays_forwarded(ctx, params)
        }
        _ => job_ops::job_stays_forwarded(ctx, op, params),
    }
}

/// `runner.add` and `attention.*` inputs whose effects only the TypeScript core owns.
pub fn runner_attention_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    runner_ops::runner_stays_forwarded(ctx, op, params)
        || attention_ops::attention_stays_forwarded(ctx, op, params)
}
pub(crate) use session_ops::needs_session_probe;
pub(crate) use snapshot_get_ops::needs_snapshot_bridge;
pub(crate) use status_ops::{
    needs_usage_broker, routing_route_stays_forwarded, task_retry_options_stays_forwarded,
};
pub(crate) use task_dismiss_ops::needs_task_clean_bridge;
pub(crate) use task_get_ops::needs_task_read_bridge;
pub(crate) use task_review_ops::needs_task_review_bridge;
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

/// `network.name` is the advertised machine name from the machine identity.
#[allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
fn discovery_list(ctx: &Ctx, params: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(network_ops::discovery_list(ctx, params, move || {
        let machine = machine_identity::machine_get(ctx, &machine_identity::Env::system())?;
        Ok(machine["name"].clone())
    }))
}

fn discovery_network_get(ctx: &Ctx, params: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(network_ops::discovery_network_get(ctx, params))
}

fn discovery_network_set(ctx: &Ctx, params: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(network_ops::discovery_network_set(ctx, params))
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
        name: "strategy.preview",
        call: strategy_preview_ops::strategy_preview_stub,
    },
    NativeOp {
        name: "executor.setup.models",
        call: executor_setup_ops::executor_setup_models,
    },
    NativeOp {
        name: "executor.setup.connect",
        call: executor_setup_ops::executor_setup_connect,
    },
    NativeOp {
        name: "job.list",
        call: job_ops::job_list,
    },
    NativeOp {
        name: "job.get",
        call: job_ops::job_get,
    },
    NativeOp {
        name: "job.cancel",
        call: job_ops::job_cancel,
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
        name: "runner.add",
        call: runner_ops::runner_add,
    },
    NativeOp {
        name: "runner.block",
        call: runner_ops::runner_block,
    },
    NativeOp {
        name: "runner.unblock",
        call: runner_ops::runner_unblock,
    },
    NativeOp {
        name: "runner.list",
        call: runner_ops::runner_list_stub,
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
        name: "session.context",
        call: session_context_ops::session_context,
    },
    NativeOp {
        name: "snapshot.get",
        call: snapshot_get_ops::snapshot_get_stub,
    },
    NativeOp {
        name: "attention.dismiss",
        call: attention_ops::attention_stub,
    },
    NativeOp {
        name: "attention.snooze",
        call: attention_ops::attention_stub,
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
        name: "task.retry_options",
        call: status_ops::task_retry_options_stub,
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
        name: "task.review",
        call: task_review_ops::task_review_stub,
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
        call: machine_ops::machine_get,
    },
    NativeOp {
        name: "machine.set",
        call: machine_ops::machine_set,
    },
    NativeOp {
        name: "machine.rotate",
        call: machine_ops::machine_rotate,
    },
    NativeOp {
        name: "files.search",
        call: files_search_ops::files_search_op,
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
        call: repo_registry_ops::repo_list,
    },
    NativeOp {
        name: "repo.add",
        call: repo_registry_ops::repo_add,
    },
    NativeOp {
        name: "repo.remove",
        call: repo_ops::repo_remove,
    },
    NativeOp {
        name: "issue.import",
        call: pacer_issues::issue_import,
    },
    NativeOp {
        name: "issue.search",
        call: pacer_issues::issue_search,
    },
    NativeOp {
        name: "project.messaging.get",
        call: project_messaging_ops::project_messaging_get,
    },
    NativeOp {
        name: "project.messaging.set",
        call: project_messaging_ops::project_messaging_set,
    },
    NativeOp {
        name: "project.messaging.remove",
        call: project_messaging_ops::project_messaging_remove,
    },
    NativeOp {
        name: "project.strategy.list",
        call: project_strategy_ops::project_strategy_list,
    },
    NativeOp {
        name: "project.strategy.get",
        call: project_strategy_ops::project_strategy_get,
    },
    NativeOp {
        name: "project.strategy.set",
        call: project_strategy_ops::project_strategy_set,
    },
    NativeOp {
        name: "project.strategy.remove",
        call: project_strategy_ops::project_strategy_remove,
    },
    NativeOp {
        name: "msg.inbox",
        call: msg_ops::msg_inbox,
    },
    NativeOp {
        name: "msg.log",
        call: msg_ops::msg_log,
    },
    NativeOp {
        name: "msg.read",
        call: msg_ops::msg_read,
    },
    NativeOp {
        name: "msg.policy",
        call: msg_ops::msg_policy,
    },
    NativeOp {
        name: "tree.status",
        call: msg_ops::tree_status,
    },
    NativeOp {
        name: "dispatch.config.get",
        call: dispatch_ops::dispatch_config_get,
    },
    NativeOp {
        name: "dispatch.tree",
        call: dispatch_ops::dispatch_tree,
    },
    NativeOp {
        name: "dispatch.list",
        call: dispatch_ops::dispatch_list,
    },
    NativeOp {
        name: "dispatch.events",
        call: dispatch_ops::dispatch_events,
    },
    NativeOp {
        name: "dispatch.dependencies",
        call: dependency_writes::dispatch_dependencies,
    },
    NativeOp {
        name: "dispatch.dependencies.waive",
        call: dependency_writes::dispatch_dependencies_waive,
    },
    NativeOp {
        name: "dispatch.analytics",
        call: learning_ops::dispatch_analytics,
    },
    NativeOp {
        name: "dispatch.learning.reset",
        call: learning_ops::dispatch_learning_reset,
    },
    NativeOp {
        name: "dispatch.models",
        call: planning_ops::dispatch_models,
    },
    NativeOp {
        name: "dispatch.refresh",
        call: planning_ops::dispatch_refresh,
    },
    NativeOp {
        name: "dispatch.enforcement.consent",
        call: planning_ops::dispatch_enforcement_consent,
    },
    NativeOp {
        name: "insights.summary",
        call: insights_ops::insights_summary,
    },
    NativeOp {
        name: "discovery.set",
        call: discovery_ops::discovery_set,
    },
    NativeOp {
        name: "discovery.respond",
        call: discovery_ops::discovery_respond,
    },
    NativeOp {
        name: "discovery.list",
        call: discovery_list,
    },
    NativeOp {
        name: "discovery.network.get",
        call: discovery_network_get,
    },
    NativeOp {
        name: "discovery.network.set",
        call: discovery_network_set,
    },
    NativeOp {
        name: "desktop.reconcile.status",
        call: desktop_reconcile_ops::desktop_reconcile_status,
    },
    NativeOp {
        name: "desktop.reconcile.request",
        call: desktop_reconcile_ops::desktop_reconcile_unavailable,
    },
    NativeOp {
        name: "desktop.reconcile.cancel",
        call: desktop_reconcile_ops::desktop_reconcile_unavailable,
    },
    NativeOp {
        name: "assistant.status",
        call: assistant_ops::assistant_status,
    },
    NativeOp {
        name: "assistant.settings.get",
        call: assistant_ops::assistant_settings_get,
    },
    NativeOp {
        name: "assistant.settings.set",
        call: assistant_ops::assistant_settings_set,
    },
    NativeOp {
        name: "assistant.candidates",
        call: assistant_ops::assistant_candidates,
    },
    NativeOp {
        name: "assistant.conversations",
        call: assistant_ops::assistant_conversations,
    },
    NativeOp {
        name: "assistant.conversation",
        call: assistant_ops::assistant_conversation,
    },
    NativeOp {
        name: "assistant.turn",
        call: assistant_ops::assistant_turn,
    },
    NativeOp {
        name: "assistant.delete",
        call: assistant_ops::assistant_delete,
    },
    NativeOp {
        name: "assistant.card.record",
        call: assistant_ops::assistant_card_record,
    },
    NativeOp {
        name: "assistant.card.refresh",
        call: assistant_ops::assistant_card_refresh,
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
    task_review_probe: Option<Value>,
    task_review_effects: Option<pacer_foundation::api::OpFuture<'_>>,
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
    if needs_task_review_bridge(op.name)
        && (task_review_probe.is_none() || task_review_effects.is_none())
    {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "task review bridge unavailable",
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
            "task.retry_options" => status_ops::task_retry_options(ctx, params, parts).await?,
            "strategy.preview" => {
                strategy_preview_ops::strategy_preview(ctx, params, parts).await?
            }
            "runner.list" => runner_ops::runner_list(ctx, params, parts).await?,
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
            "attention.dismiss" => attention_ops::attention_dismiss(ctx, params, parts).await?,
            "attention.snooze" => attention_ops::attention_snooze(ctx, params, parts).await?,
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
    } else if needs_task_review_bridge(op.name) {
        let probe = task_review_probe.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task review bridge unavailable",
            )
        })?;
        let effects = task_review_effects.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "task review effects bridge unavailable",
            )
        })?;
        match op.name {
            "task.review" => task_review_ops::task_review(ctx, params, probe, effects).await?,
            _ => unreachable!("needs_task_review_bridge"),
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
            if op.name == "runner.remove" || op.name == "runner.add" {
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
mod tests;
