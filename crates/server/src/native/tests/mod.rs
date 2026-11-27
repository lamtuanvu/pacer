mod config_writes;
use super::registry;

#[test]
fn forward_override_removes_only_selected_native_ops() {
    for name in [
        "strategy.list",
        "strategy.show",
        "strategy.use",
        "strategy.save",
        "strategy.remove",
        "strategy.preview",
        "executor.setup.models",
        "executor.setup.connect",
        "executor.setup.candidates",
        "strategy.build",
        "setup.init",
        "job.list",
        "job.get",
        "job.cancel",
        "routing.get",
        "routing.set",
        "runner.set",
        "runner.reorder",
        "runner.remove",
        "runner.settings.get",
        "runner.settings.save",
        "runner.models.get",
        "runner.models.set",
        "runner.models.set_many",
        "executor.models.available",
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
        "task.retry_options",
        "task.request_review",
        "task.send",
        "task.stop",
        "task.review",
        "task.dismiss",
        "task.diff",
        "task.list",
        "task.get",
        "session.context",
        "snapshot.get",
        "version.get",
        "api.list",
        "api.describe",
        "machine.get",
        "machine.set",
        "machine.rotate",
        "files.search",
        "setup.check",
        "setup.health",
        "doctor.run",
        "onboarding.skip",
        "repo.list",
        "repo.add",
        "repo.remove",
        "project.messaging.get",
        "project.messaging.set",
        "project.messaging.remove",
        "project.strategy.list",
        "project.strategy.get",
        "project.strategy.set",
        "project.strategy.remove",
        "msg.inbox",
        "msg.log",
        "msg.read",
        "msg.policy",
        "tree.status",
        "msg.send",
        "msg.wait",
        "msg.confirm",
        "msg.close",
        "dispatch.config.get",
        "dispatch.tierTargets.get",
        "dispatch.tierTargets.set",
        "dispatch.tree",
        "dispatch.list",
        "dispatch.events",
        "dispatch.submit",
        "dispatch.child",
        "dispatch.wait",
        "dispatch.review",
        "dispatch.retry",
        "dispatch.answer",
        "dispatch.stop",
        "dispatch.dependencies",
        "dispatch.dependencies.waive",
        "dispatch.analytics",
        "dispatch.learning.reset",
        "dispatch.models",
        "dispatch.refresh",
        "dispatch.enforcement.consent",
        "dispatch.enforcement",
        "dispatch.enforcement.probe",
        "dispatch.enforcement.denied",
        "dispatch.preview",
        "dispatch.explain",
        "insights.summary",
        "discovery.set",
        "discovery.respond",
        "desktop.reconcile.status",
        "desktop.reconcile.request",
        "desktop.reconcile.cancel",
        "assistant.status",
        "assistant.settings.get",
        "assistant.settings.set",
        "assistant.candidates",
        "assistant.conversations",
        "assistant.conversation",
        "assistant.turn",
        "assistant.delete",
        "assistant.card.record",
        "assistant.card.refresh",
        "account.list",
        "account.signin",
        "desktop.update.status",
        "desktop.capture.targets",
    ] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
    }
    // No registered-op gaps remain: dispatch.enforcement* and desktop.* are registered above.
    assert!(registry("").get("config.get").is_some());
    assert!(registry("config.get").get("config.get").is_none());
    assert!(registry("").get("activity.list").is_some());
    // Plugin ops need a door's Core channel: both doors use the service registry.
    assert!(registry("").get("plugin.install").is_none());
    for name in pacer_plugin_ops::public::OPERATIONS
        .iter()
        .chain(pacer_plugin_ops::mutations::MUTATION_OPERATIONS)
    {
        assert!(super::service_registry("").get(name).is_some(), "{name}");
        assert!(super::service_registry(name).get(name).is_none(), "{name}");
    }
    assert_eq!(
        pacer_plugin_ops::public::OPERATIONS.len()
            + pacer_plugin_ops::mutations::MUTATION_OPERATIONS.len(),
        12
    );
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
    for op in pacer_task_ops::task_delegation_ops::DELEGATION_OPS {
        assert!(registry("").get(op).is_some());
        assert!(registry(op).get(op).is_none());
    }
    assert!(registry("").get("task.stop").is_some());
    assert!(registry("task.stop").get("task.stop").is_none());
    assert!(registry("").get("task.send").is_some());
    assert!(registry("task.send").get("task.send").is_none());
    assert!(registry("").get("task.wait").is_some());
    assert!(registry("task.wait").get("task.wait").is_none());
    assert!(registry("").get("task.review").is_some());
    assert!(registry("task.review").get("task.review").is_none());
    assert!(registry("").get("limits.refresh").is_some());
    assert!(registry("limits.refresh").get("limits.refresh").is_none());
    assert!(registry("").get("runner.check").is_some());
    assert!(registry("runner.check").get("runner.check").is_none());
    assert!(registry("").get("assistant.ask").is_some());
    assert!(registry("assistant.ask").get("assistant.ask").is_none());
    assert!(registry("").get("assistant.cancel").is_some());
    assert!(
        registry("assistant.cancel")
            .get("assistant.cancel")
            .is_none()
    );
    // `assistant.tool` is native: the front door checks the turn's live grant.
    assert!(registry("").get("assistant.tool").is_some());
    assert!(registry("assistant.tool").get("assistant.tool").is_none());
}

#[test]
fn service_install_and_update_apply_are_native_with_a_core_effects_bridge() {
    for name in ["service.install", "update.apply"] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(super::service_registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
        assert!(super::install_apply_sync::uses_effects(name), "{name}");
    }
    assert!(!super::install_apply_sync::uses_effects("service.status"));
    let ctx = |env: &[(&str, &str)]| {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        pacer_foundation::Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    };
    let grant = ctx(&[("PACER_WORK_GRANT", "g")]);
    let params = serde_json::json!({});
    assert!(super::service_agent_stays_forwarded(
        &grant,
        "service.install",
        &params
    ));
    assert!(super::service_agent_stays_forwarded(
        &grant,
        "update.apply",
        &params
    ));
    assert!(!super::install_apply_sync::stays_forwarded(
        &grant,
        "service.status"
    ));
}

#[test]
fn agent_ops_are_native_with_a_core_effects_bridge() {
    let agent_ops = [
        "agent.preview",
        "agent.connect",
        "agent.undo",
        "agent.disconnect",
    ];
    for name in agent_ops {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(super::service_registry("").get(name).is_some(), "{name}");
        assert!(super::agent_apply_sync::uses_effects(name), "{name}");
    }
    // `agent.detect` stays a pure forward left wholly to TypeScript.
    assert!(!super::agent_apply_sync::uses_effects("agent.detect"));
    assert!(!super::agent_apply_sync::uses_effects("service.status"));
    let ctx = |env: &[(&str, &str)]| {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        pacer_foundation::Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    };
    // A work-grant caller forwards to TypeScript, as the reference path does.
    let grant = ctx(&[("PACER_WORK_GRANT", "g")]);
    for name in agent_ops {
        assert!(
            super::agent_apply_sync::stays_forwarded(&grant, name),
            "{name}"
        );
        let params = serde_json::json!({"agent": "codex"});
        assert!(
            super::agent_apply_sync::admit(&grant, name, &params).is_ok(),
            "{name}"
        );
    }
    assert!(!super::agent_apply_sync::stays_forwarded(
        &ctx(&[]),
        "agent.preview"
    ));
}

#[tokio::test]
async fn install_apply_bridge_names_reach_core_endpoints() {
    // Without a Core target the bridge reports a restarting core, not an unknown bridge.
    for bridge in [
        "service.effects",
        "update.effects",
        "handover.effects",
        "onboarding.effects",
        "host.effects",
    ] {
        let body = serde_json::json!({"request": {}});
        let result = crate::native::core_bridge_sync::http(None, bridge, body).await;
        assert!(
            matches!(&result, Err(error) if error.message == "pacer core is restarting"),
            "{bridge}"
        );
    }
}

#[test]
fn install_apply_bridges_wait_like_the_forwarded_path() {
    use crate::native::core_bridge_sync::deadline;
    assert_eq!(deadline("service.effects"), None);
    assert_eq!(deadline("update.effects"), None);
    assert_eq!(deadline("handover.effects"), None);
    assert_eq!(deadline("onboarding.effects"), None);
    assert_eq!(deadline("host.effects"), None);
    assert_eq!(
        deadline("setup.effects"),
        Some(std::time::Duration::from_secs(120))
    );
}

#[test]
fn service_handover_and_work_are_native_with_a_core_effects_bridge() {
    // service.handover and service.work answer refusals natively and run the
    // reference operation through the handover effects bridge; work-grant callers
    // forward. The stores they read live on the TS side.
    for name in ["service.handover", "service.work"] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(super::service_registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
        assert!(super::handover_sync::uses_effects(name), "{name}");
    }
    assert!(!super::handover_sync::uses_effects("service.status"));
    let ctx = |env: &[(&str, &str)]| {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        pacer_foundation::Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    };
    let grant = ctx(&[("PACER_WORK_GRANT", "g")]);
    let params = serde_json::json!({});
    assert!(super::handover_sync::stays_forwarded(&grant));
    assert!(!super::handover_sync::stays_forwarded(&ctx(&[])));
    assert!(!super::service_agent_stays_forwarded(
        &ctx(&[]),
        "service.handover",
        &params
    ));
    assert!(super::service_agent_stays_forwarded(
        &grant,
        "service.handover",
        &params
    ));
}

#[test]
fn onboarding_try_is_native_with_a_core_effects_bridge() {
    // onboarding.try answers executor refusals natively and runs the whole
    // tryDelegation through the onboarding effects bridge. There is no work-grant
    // scope for Core to check, so no caller forwards.
    assert!(
        registry("").get("onboarding.try").is_some(),
        "onboarding.try"
    );
    assert!(
        super::service_registry("").get("onboarding.try").is_some(),
        "onboarding.try"
    );
    assert!(
        registry("onboarding.try").get("onboarding.try").is_none(),
        "onboarding.try"
    );
    assert!(
        super::onboarding_sync::uses_effects("onboarding.try"),
        "onboarding.try"
    );
    assert!(!super::onboarding_sync::uses_effects("onboarding.skip"));
    let ctx = |env: &[(&str, &str)]| {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        pacer_foundation::Ctx::with("/nonexistent".into(), "/nonexistent".into(), env, 1.0)
    };
    let params = serde_json::json!({});
    let executor = ctx(&[("PACER_ROLE", "executor")]);
    let refused = super::onboarding_sync::admit(&executor, "onboarding.try", &params);
    assert!(
        matches!(
            &refused,
            Err(e) if e.code == pacer_foundation::api::Code::NotAllowed
        ),
        "onboarding.try must refuse executor sessions"
    );
    // Work-grant callers have no scope for Core to check.
    assert!(super::onboarding_sync::admit(&ctx(&[]), "onboarding.try", &params).is_ok());
}

#[test]
fn host_check_clean_repo_setup_and_terminal_are_registered() {
    // host.check, host.clean, host.repo.setup and host.terminal answer refusals
    // natively and run their jobs through Core's whole-operation host effects bridge;
    // the terminal opening itself stays in Core.
    for name in [
        "host.check",
        "host.clean",
        "host.repo.setup",
        "host.terminal",
    ] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(super::service_registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
        assert!(super::needs_host_effects(name), "{name}");
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
        "strategy.preview",
        "executor.setup.models",
        "executor.setup.connect",
        "executor.setup.candidates",
        "strategy.build",
        "setup.init",
        "job.list",
        "job.get",
        "job.cancel",
        "routing.get",
        "routing.set",
        "runner.set",
        "runner.reorder",
        "runner.remove",
        "runner.settings.get",
        "runner.settings.save",
        "runner.models.get",
        "runner.models.set",
        "runner.models.set_many",
        "executor.models.available",
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
        "task.retry_options",
        "task.request_review",
        "task.send",
        "task.stop",
        "task.review",
        "task.dismiss",
        "task.diff",
        "task.list",
        "task.get",
        "session.context",
        "snapshot.get",
        "version.get",
        "api.list",
        "api.describe",
        "machine.get",
        "machine.set",
        "machine.rotate",
        "files.search",
        "setup.check",
        "setup.health",
        "doctor.run",
        "onboarding.skip",
        "repo.list",
        "repo.add",
        "repo.remove",
        "project.messaging.get",
        "project.messaging.set",
        "project.messaging.remove",
        "project.strategy.list",
        "project.strategy.get",
        "project.strategy.set",
        "project.strategy.remove",
        "msg.inbox",
        "msg.log",
        "msg.read",
        "msg.policy",
        "tree.status",
        "msg.send",
        "msg.wait",
        "msg.confirm",
        "msg.close",
        "dispatch.config.get",
        "dispatch.tierTargets.get",
        "dispatch.tierTargets.set",
        "dispatch.tree",
        "dispatch.list",
        "dispatch.events",
        "dispatch.submit",
        "dispatch.child",
        "dispatch.wait",
        "dispatch.review",
        "dispatch.retry",
        "dispatch.answer",
        "dispatch.stop",
        "dispatch.dependencies",
        "dispatch.dependencies.waive",
        "dispatch.analytics",
        "dispatch.learning.reset",
        "dispatch.models",
        "dispatch.refresh",
        "dispatch.enforcement.consent",
        "insights.summary",
        "discovery.set",
        "discovery.respond",
        "desktop.reconcile.status",
        "desktop.reconcile.request",
        "desktop.reconcile.cancel",
        "assistant.status",
        "assistant.settings.get",
        "assistant.settings.set",
        "assistant.candidates",
        "assistant.conversations",
        "assistant.conversation",
        "assistant.turn",
        "assistant.delete",
        "assistant.card.record",
        "assistant.card.refresh",
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
