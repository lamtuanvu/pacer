use pacer_assistant_ops::assistant_ops;
use pacer_config_ops::config_get_ops;
use pacer_foundation::{
    Ctx,
    api::{CoreError, NativeOp, Registry},
};
use serde_json::Value;
pub(crate) mod account_list_sync;
pub(crate) use account_list_ops::needs_account_list_bridge;
use pacer_account_ops::account_list_ops;
use pacer_config_ops::config_writes;
use pacer_config_ops::doctor_ops;
use pacer_config_ops::executor_setup_ops;
pub(crate) use pacer_core_bridge::config_host_sync;
pub(crate) use pacer_core_bridge::config_sync;
pub(crate) use pacer_core_bridge::core_bridge_sync;
pub(crate) use pacer_core_bridge::dispatch_parts_sync;
use pacer_discovery_ops::{discovery_ops, network_ops};
use pacer_dispatch_ops::dependency_writes;
use pacer_dispatch_ops::dispatch_ops;
use pacer_dispatch_ops::insights_ops;
use pacer_dispatch_ops::learning_ops;
use pacer_dispatch_ops::lifecycle_ops as dispatch_lifecycle_ops;
use pacer_dispatch_ops::planning_ops;
mod engine_ops;
use pacer_config_ops::host_check_clean_setup_ops;
use pacer_config_ops::host_mut_ops;
use pacer_config_ops::host_read_ops;
use pacer_config_ops::limits_refresh_ops;
pub(crate) use pacer_core_bridge::host_mut_sync;
pub(crate) use pacer_core_bridge::host_read_sync;
use pacer_task_ops::attention_ops;
use pacer_task_ops::files_search_ops;
use pacer_task_ops::job_ops;
pub(crate) mod host_mut_sync;
use pacer_config_ops::host_read_ops;
use pacer_config_ops::limits_refresh_ops;
pub(crate) mod host_read_sync;
use pacer_machine_ops::machine_identity;
use pacer_machine_ops::machine_ops;
use pacer_task_ops::lifecycle_ops;
use pacer_task_ops::session_context_ops;
mod meta_ops;
pub(crate) mod msg_ops;
pub(crate) mod p8_bridge_ops;
pub mod plugins;
mod setup_ops;
pub(crate) mod session_ops;
pub(crate) mod session_sync;
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
pub(crate) mod task_stop_sync;
mod task_stop_ops;
pub(crate) mod task_wait_sync;
mod task_wait_ops;

pub use assistant_ops::assistant_stays_forwarded;
pub(crate) use config_get_ops::needs_config_host_bridge;
pub use config_writes::config_set_stays_forwarded;
pub use dependency_writes::dependencies_waive_stays_forwarded;
pub use desktop_reconcile_ops::desktop_reconcile_stays_forwarded;
pub use discovery_ops::discovery_stays_forwarded;
pub(crate) use engine_ops::mode_hold_stays_forwarded;
#[allow(unused_imports)]
pub(crate) use host_check_clean_setup_ops::{
    host_stays_forwarded, needs_host_effects_bridge, uses_host_effects,
};
pub(crate) use host_read_ops::{needs_host_read_bridge, needs_host_read_injection};
pub(crate) use msg_ops::msg_stays_forwarded;
pub(crate) use p8_bridge_ops::needs_core_bridge;
pub use pacer_account_ops::account_stays_forwarded;
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
        "strategy.build" | "executor.setup.candidates" | "setup.init" => {
            pacer_config_ops::setup_effects::setup_stays_forwarded(ctx, op, params)
        }
        _ => job_ops::job_stays_forwarded(ctx, op, params),
    }
}

/// `service.status`, `update.check`, `agent.detect` and `limits.refresh` inputs only TypeScript answers.
pub fn service_agent_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "agent.detect" => pacer_install::agent_detect_stays_forwarded(ctx, params),
        "limits.refresh" => limits_refresh_ops::limits_refresh_stays_forwarded(ctx, params),
        _ => pacer_update::service_update_stays_forwarded(ctx, op),
    }
}

/// `runner.add` and `attention.*` inputs whose effects only the TypeScript core owns.
pub fn runner_attention_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    runner_ops::runner_stays_forwarded(ctx, op, params)
        || runner_check_ops::runner_check_stays_forwarded(ctx, op, params)
        || attention_ops::attention_stays_forwarded(ctx, op, params)
}

/// `runner.models.*`, `dispatch.tierTargets.*` and `executor.models.available`
/// requests whose strategy only TypeScript loads, or whose runners only
/// TypeScript can list.
pub fn strategy_settings_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    matches!(
        op,
        "runner.models.get"
            | "runner.models.set"
            | "runner.models.set_many"
            | "dispatch.tierTargets.get"
            | "dispatch.tierTargets.set"
            | "executor.models.available"
    ) && (pacer_config_ops::active_strategy_needs_core(&ctx.pacer_home)
        || runner_models_ops::runner_models_stays_forwarded(ctx, op, params)
        || available_ops::executor_models_available_stays_forwarded(ctx, op, params))
}
pub(crate) use session_ops::needs_session_probe;
pub(crate) use snapshot_get_ops::needs_snapshot_bridge;
pub(crate) use status_ops::needs_usage_broker;

/// The usage-broker parts params an op's request needs; `{}` asks for the active strategy's parts.
pub(crate) fn usage_broker_params(op: &str, params: &Value) -> Value {
    match op {
        "strategy.preview" => strategy_preview_ops::broker_params(params),
        _ => serde_json::json!({}),
    }
}

/// `mode.hold`, `routing.route` and `task.retry_options` inputs only TypeScript answers.
pub fn status_residue_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "mode.hold" => engine_ops::mode_hold_stays_forwarded(ctx, params),
        "routing.route" => status_ops::routing_route_stays_forwarded(ctx, params),
        "task.retry_options" => status_ops::task_retry_options_stays_forwarded(ctx),
        _ => false,
    }
}
pub(crate) use task_dismiss_ops::needs_task_clean_bridge;
pub(crate) use task_get_ops::needs_task_read_bridge;
pub(crate) use repo_ops::repo_remove_stays_forwarded;
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
        name: "executor.setup.candidates",
        call: pacer_config_ops::setup_effects::effects_stub,
    },
    NativeOp {
        name: "strategy.build",
        call: pacer_config_ops::setup_effects::effects_stub,
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
        name: "runner.check",
        call: runner_check_ops::runner_check,
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
        name: "runner.models.get",
        call: runner_models_ops::runner_models_get,
    },
    NativeOp {
        name: "runner.models.set",
        call: runner_models_ops::runner_models_set,
    },
    NativeOp {
        name: "runner.models.set_many",
        call: runner_models_ops::runner_models_set_many,
    },
    NativeOp {
        name: "executor.models.available",
        call: available_ops::executor_models_available,
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
        name: "host.check",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "host.clean",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "host.repo.setup",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "host.account.add",
        call: host_mut_ops::host_account_add,
    },
    NativeOp {
        name: "host.check",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "host.clean",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "host.repo.setup",
        call: host_check_clean_setup_ops::host_effects_stub,
    },
    NativeOp {
        name: "config.set",
        call: config_writes::config_set,
    },
    NativeOp {
        name: "account.add",
        call: pacer_account_ops::account_add,
    },
    NativeOp {
        name: "account.edit",
        call: pacer_account_ops::account_edit,
    },
    NativeOp {
        name: "account.adopt",
        call: pacer_account_ops::account_adopt,
    },
    NativeOp {
        name: "account.remove",
        call: pacer_account_ops::account_remove,
    },
    NativeOp {
        name: "account.models",
        call: pacer_account_ops::account_models,
    },
    NativeOp {
        name: "account.test",
        call: pacer_account_ops::account_test,
    },
    NativeOp {
        name: "account.usage.check",
        call: pacer_account_ops::account_usage_check,
    },
    NativeOp {
        name: "account.list",
        call: account_list_ops::account_list_stub,
    },
    NativeOp {
        name: "account.signin",
        call: account_list_ops::account_signin_stub,
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
        name: engine_ops::ops()[0].name,
        call: engine_ops::ops()[0].call,
    },
    NativeOp {
        name: engine_ops::ops()[1].name,
        call: engine_ops::ops()[1].call,
    },
    NativeOp {
        name: engine_ops::ops()[2].name,
        call: engine_ops::ops()[2].call,
    },
    NativeOp {
        name: engine_ops::ops()[3].name,
        call: engine_ops::ops()[3].call,
    },
    NativeOp {
        name: engine_ops::ops()[4].name,
        call: engine_ops::ops()[4].call,
    },
    NativeOp {
        name: status_ops::ops()[0].name,
        call: status_ops::ops()[0].call,
    },
    NativeOp {
        name: "limits.refresh",
        call: limits_refresh_ops::limits_refresh,
    },
    NativeOp {
        name: "routing.status",
        call: status_ops::routing_status_stub,
    },
    NativeOp {
        name: status_ops::ops()[1].name,
        call: status_ops::ops()[1].call,
    },
    NativeOp {
        name: status_ops::ops()[2].name,
        call: status_ops::ops()[2].call,
    },
    NativeOp {
        name: status_ops::ops()[3].name,
        call: status_ops::ops()[3].call,
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
        name: "setup.health",
        call: doctor_ops::setup_health_stub,
    },
    NativeOp {
        name: "doctor.run",
        call: doctor_ops::doctor_run_stub,
    },
    NativeOp {
        name: setup_ops::ops()[0].name,
        call: setup_ops::ops()[0].call,
    },
    NativeOp {
        name: "setup.init",
        call: pacer_config_ops::setup_init_ops::setup_init,
    },
    NativeOp {
        name: "service.status",
        call: pacer_update::service_status,
    },
    NativeOp {
        name: "update.check",
        call: pacer_update::update_check,
    },
    NativeOp {
        name: "agent.detect",
        call: pacer_install::agent_detect,
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

/// Operations a front door answers without a Core plugin channel (examples, parity tools).
pub fn registry(forward: &str) -> Registry<'static> {
    Registry::new(OPS, forward)
}

/// What both front doors answer: [`registry`] plus the plugin operations, which
/// each door composes over its own private Core channel. `PACER_FORWARD_OPS`
/// (the `forward` list) keeps any of them, plugin ops included, in TypeScript.
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
    if needs_task_stop_bridge(op.name) && (task_stop_probe.is_none() || task_stop_effects.is_none()) {
        return Err(CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "task stop bridge unavailable",
        ));
    }
    let mut host_set_alias: Option<String> = None;
    let result = if op.name == "host.set" {
        host_set_alias = Some(host_mut_ops::host_set_write(ctx, params).await?);
        Value::Null
    } else if op.name == "mode.hold" {
        engine_ops::mode_hold(ctx, params, broker_sync).await?
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
            "routing.route" => status_ops::routing_route(ctx, params, parts).await?,
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
    } else if host_check_clean_setup_ops::uses_host_effects(op.name) {
        let effects = host_effects_sync.ok_or_else(|| {
            CoreError::new(
                pacer_foundation::api::Code::Unavailable,
                "host effects bridge unavailable",
            )
        })?;
        match op.name {
            "host.check" => host_check_clean_setup_ops::host_check(ctx, params, effects).await?,
            "host.clean" => host_check_clean_setup_ops::host_clean(ctx, params, effects).await?,
            "host.repo.setup" => {
                host_check_clean_setup_ops::host_repo_setup(ctx, params, effects).await?
            }
            _ => unreachable!("uses_host_effects"),
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
    } else if needs_host_effects(op.name) {
        host_check_clean_setup_ops::call(ctx, op.name, params, core_bridge_sync).await?
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
            "project.messaging.get",
            "project.messaging.set",
            "project.messaging.remove",
            "msg.inbox",
            "msg.log",
            "msg.read",
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
        for name in [
            "msg.send",
            "msg.wait",
            "msg.confirm",
            "msg.close",
            "msg.policy",
        ] {
            assert!(registry("").get(name).is_none(), "{name}");
        }
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
            "project.messaging.get",
            "project.messaging.set",
            "project.messaging.remove",
            "msg.inbox",
            "msg.log",
            "msg.read",
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
