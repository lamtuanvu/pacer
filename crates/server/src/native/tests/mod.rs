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
        "account.list",
        "account.signin",
    ] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
    }
    for name in [
        "dispatch.explain",
        "dispatch.preview",
        "dispatch.enforcement",
        "dispatch.enforcement.probe",
        "dispatch.enforcement.denied",
        "desktop.update.status",
        "desktop.capture.targets",
    ] {
        assert!(registry("").get(name).is_none(), "{name}");
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
    assert!(registry("").get("task.review").is_some());
    assert!(registry("task.review").get("task.review").is_none());
    assert!(registry("").get("task.ask").is_none());
    assert!(registry("").get("limits.refresh").is_some());
    assert!(registry("limits.refresh").get("limits.refresh").is_none());
    assert!(registry("").get("assistant.ask").is_none());
    assert!(registry("").get("assistant.cancel").is_none());
}

#[test]
fn service_install_is_not_a_registered_native_op() {
    // service.install stays on TypeScript until Core has a 'service.effects'
    // bridge; TS owns install consent and the in-job self-reload.
    assert!(registry("").get("service.install").is_none());
    assert!(super::service_registry("").get("service.install").is_none());
}

#[test]
fn service_handover_and_work_are_not_registered_native_ops() {
    // service.handover and service.work stay on TypeScript until Core serves a
    // real handover.effects bridge (/_internal/handover-effects,
    // _internal.handover.effects); the stores they read live on the TS side.
    for name in ["service.handover", "service.work"] {
        assert!(registry("").get(name).is_none(), "{name}");
        assert!(super::service_registry("").get(name).is_none(), "{name}");
    }
}

#[test]
fn host_check_clean_and_setup_are_not_registered_native_ops() {
    // host.check, host.clean and host.repo.setup stay on TypeScript until Core
    // serves a real host effects bridge; unregistering them makes forwarding
    // structural on every transport instead of a per-front-door predicate.
    for name in ["host.check", "host.clean", "host.repo.setup"] {
        assert!(registry("").get(name).is_none(), "{name}");
        assert!(super::service_registry("").get(name).is_none(), "{name}");
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
