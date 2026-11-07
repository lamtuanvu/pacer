//! Frozen operation visibility and schema projection.
use super::{object_without, spread};
use serde_json::{Value, json};

pub const V3_ONLY_OPS: &[&str] = &[
    "service.handover",
    "service.work",
    "snapshot.get",
    "client.control.enroll",
    "client.control.targets",
    "client.control.request",
    "client.control.result",
    "client.control.claim",
    "client.control.complete",
    "api.list",
    "api.describe",
    "runner.settings.get",
    "runner.settings.save",
    "desktop.capture.register",
    "desktop.capture.targets",
    "desktop.capture.request",
    "desktop.capture.claim",
    "desktop.capture.complete",
    "desktop.capture.result",
    "desktop.update.adopt",
    "desktop.update.adoptCancel",
    "desktop.update.status",
    "desktop.update.check",
    "desktop.update.download",
    "desktop.update.restart",
    "desktop.update.cancel",
    "desktop.update.configure",
    "task.takeover",
    "task.hand_back",
    "service.install",
    "onboarding.skip",
    "onboarding.try",
    "doctor.run",
    "project.strategy.list",
    "project.strategy.get",
    "project.strategy.set",
    "project.strategy.remove",
    "task.prune",
    "task.restore",
    "plugin.list",
    "plugin.enable",
    "plugin.disable",
    "plugin.remove",
    "plugin.doctor",
    "plugin.ui.list",
    "plugin.ui.render",
    "plugin.ui.action",
    "plugin.ui.visibility",
    "plugin.settings.get",
    "plugin.settings.set",
    "files.search",
    "issue.import",
    "issue.search",
    "desktop.reconcile.status",
    "desktop.reconcile.request",
    "desktop.reconcile.cancel",
    "dispatch.config.get",
    "dispatch.preview",
    "dispatch.explain",
    "dispatch.submit",
    "dispatch.child",
    "dispatch.tree",
    "dispatch.list",
    "dispatch.events",
    "dispatch.wait",
    "dispatch.review",
    "dispatch.retry",
    "dispatch.answer",
    "dispatch.stop",
    "dispatch.dependencies",
    "dispatch.dependencies.waive",
    "dispatch.models",
    "dispatch.refresh",
    "dispatch.analytics",
    "dispatch.enforcement",
    "dispatch.enforcement.probe",
    "dispatch.enforcement.denied",
    "dispatch.enforcement.consent",
    "dispatch.learning.reset",
    "setup.health",
    "account.usage.check",
    "limits.refresh",
    "session.draft.create",
    "session.prepare",
    "session.create",
    "session.context",
    "session.end",
    "session.resume",
    "session.attachment.prepare",
    "session.file.read",
    "insights.summary",
    "machine.get",
    "machine.set",
    "machine.rotate",
    "discovery.list",
    "discovery.set",
    "discovery.respond",
    "discovery.network.get",
    "discovery.network.set",
    "terminal.list",
    "terminal.create",
    "terminal.rename",
    "terminal.close",
    "assistant.status",
    "assistant.ask",
    "assistant.cancel",
    "assistant.conversations",
    "assistant.conversation",
    "assistant.turn",
    "assistant.delete",
    "assistant.settings.get",
    "assistant.settings.set",
    "assistant.candidates",
    "assistant.card.record",
    "assistant.card.refresh",
    "msg.send",
    "msg.inbox",
    "msg.wait",
    "msg.log",
    "msg.read",
    "msg.confirm",
    "msg.close",
    "msg.policy",
    "tree.status",
    "liveness.status",
    "project.messaging.get",
    "project.messaging.set",
    "project.messaging.remove",
    "session.agent.list",
    "session.agent.get",
    "session.agent.create",
    "session.agent.end",
    "session.agent.retry",
    "session.agent.resume",
];
pub const V2_PROTOCOL: &str = "2.8.0";
pub const V2_EVENT_TYPES: &[&str] = &[
    "budget",
    "task",
    "mode",
    "alert",
    "config",
    "pause",
    "reset",
    "executor",
    "account",
    "host",
    "repo",
    "counts",
    "attention",
    "activity",
    "job",
    "notify",
];

pub fn hello(input: &Value) -> Value {
    let mut out = object_without(input, &["previous", "coreBuild"]);
    out["protocol"] = json!(V2_PROTOCOL);
    out["ops"] = Value::Array(
        input["ops"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|op| !is_v3_only_op(op.as_str().unwrap_or("")))
            .cloned()
            .collect(),
    );
    out["events"] = json!(V2_EVENT_TYPES);
    out
}

pub fn is_v3_only_op(name: &str) -> bool {
    V3_ONLY_OPS.contains(&name)
}

pub fn op_schemas(input: &Value) -> Value {
    let mut out = spread(input);
    if let Some(map) = out.as_object_mut() {
        for op in V3_ONLY_OPS {
            map.shift_remove(*op);
        }
    }
    for (op, field) in [
        ("task.delegate", "dispatch"),
        ("client.register", "capture"),
    ] {
        if let Some(map) = out[op]["params"]["properties"].as_object_mut() {
            map.shift_remove(field);
        }
    }
    out["task.list"]["description"] = json!(
        "Recent tasks, newest first. Cursor/filter params return a page; limit alone keeps the legacy array until 3.0."
    );
    out["client.register"]["description"] =
        json!("Register a client with an optional notifier lease; heartbeat every 30 seconds.");
    let review = &mut out["task.review"]["params"];
    review["properties"]["accepted"] = json!({"type":"boolean"});
    let source = review["properties"].clone();
    review["properties"] = object_without(&source, &["executor", "kind", "note", "expect_state"]);
    for key in ["executor", "kind", "note", "expect_state"] {
        if let Some(value) = source.get(key) {
            review["properties"][key] = value.clone();
        }
    }
    if let Some(required) = review["required"].as_array_mut() {
        required.retain(|key| key != "verdict");
    }
    out
}
