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
        "task.review",
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
        "dispatch.config.get",
        "dispatch.tree",
        "dispatch.list",
        "dispatch.events",
        "discovery.set",
        "discovery.respond",
        "desktop.reconcile.status",
        "desktop.reconcile.request",
        "desktop.reconcile.cancel",
    ] {
        assert!(registry("").get(name).is_some(), "{name}");
        assert!(registry(name).get(name).is_none(), "{name}");
    }
    for name in [
        "dispatch.submit",
        "dispatch.child",
        "dispatch.wait",
        "dispatch.review",
        "dispatch.retry",
        "dispatch.answer",
        "dispatch.stop",
        "dispatch.dependencies",
        "dispatch.explain",
        "dispatch.models",
        "dispatch.enforcement",
        "discovery.list",
        "discovery.network.get",
        "discovery.network.set",
        "desktop.update.status",
        "desktop.capture.targets",
        "account.list",
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
    assert!(registry("").get("task.retry_options").is_none());
    assert!(registry("").get("task.review").is_some());
    assert!(registry("task.review").get("task.review").is_none());
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
        "task.review",
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
        "dispatch.config.get",
        "dispatch.tree",
        "dispatch.list",
        "dispatch.events",
        "discovery.set",
        "discovery.respond",
        "desktop.reconcile.status",
        "desktop.reconcile.request",
        "desktop.reconcile.cancel",
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
