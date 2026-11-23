#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Map, Value};

#[derive(Clone)]
struct Fake {
    snapshot: Value,
    ops: Vec<String>,
    kind: &'static str,
    answers: std::collections::BTreeMap<String, Value>,
    fail_ops: std::collections::BTreeSet<String>,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Fake {
    fn new(snapshot: Value, ops: &[&str]) -> Self {
        Self {
            snapshot,
            ops: ops.iter().map(|s| s.to_string()).collect(),
            kind: "http",
            answers: std::collections::BTreeMap::new(),
            fail_ops: std::collections::BTreeSet::new(),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn answer(mut self, op: &str, value: Value) -> Self {
        self.answers.insert(op.to_string(), value);
        self
    }
    fn fail(mut self, op: &str) -> Self {
        self.fail_ops.insert(op.to_string());
        self
    }
    fn seen(&self) -> Vec<(String, Value)> {
        self.calls.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl DashClient for Fake {
    fn call(&self, op: &str, params: Value) -> Result<Value, DashError> {
        self.calls
            .lock()
            .map(|mut c| c.push((op.to_string(), params)))
            .ok();
        if self.fail_ops.contains(op) {
            return Err(DashError {
                code: "not_allowed".to_string(),
                message: "not allowed".to_string(),
                hint: Some("Use the sandbox".to_string()),
            });
        }
        Ok(self
            .answers
            .get(op)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})))
    }
    fn snapshot(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "protocol": "3.0.0", "seq": 1, "snapshot": self.snapshot }))
    }
    fn supports(&self, op: &str) -> bool {
        self.ops.iter().any(|o| o == op)
    }
    fn hello(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "ops": self.ops }))
    }
    fn kind(&self) -> &'static str {
        self.kind
    }
}

fn empty_snapshot() -> Value {
    serde_json::json!({
        "v": 1, "seq": 120, "at": 1_800_000_000, "tasks": [], "repos": [], "counts": {},
        "setup": { "complete": true, "ready": true }, "attention": []
    })
}

fn dash(client: Fake) -> Dashboard<Fake> {
    Dashboard::new(client, DashboardDeps::default())
}

#[test]
fn refresh_loads_snapshot_ops_and_sets_connection() {
    let mut d = dash(Fake::new(empty_snapshot(), &["task.get", "task.list"]));
    d.refresh().unwrap();
    assert_eq!(
        d.ops.as_deref(),
        Some(&["task.get".to_string(), "task.list".to_string()][..])
    );
    assert_eq!(d.connection, "live");
    assert_eq!(d.snapshot["seq"], 120);
    assert!(!d.frames.is_empty());
}

#[test]
fn action_effects_call_the_right_op_with_success_copy() {
    let client = Fake::new(empty_snapshot(), &["task.delegate"])
        .answer("task.delegate", serde_json::json!({ "task_id": "t-9000" }));
    let mut d = dash(client);
    d.refresh().unwrap();
    let mut params = Map::new();
    params.insert("goal".to_string(), Value::String("Fix it".to_string()));
    let action = Action {
        label: "Delegated".into(),
        op: "task.delegate".into(),
        params,
        style: None,
        confirm: None,
    };
    d.run(Effect::Action {
        action,
        fallback: None,
    });
    assert_eq!(d.calls.last().map(|c| c.0.as_str()), Some("task.delegate"));
    assert!(
        d.frames
            .last()
            .is_some_and(|f| f.contains("Delegated · t-9000 queued"))
    );
}

#[test]
fn config_set_success_copy_includes_undo_line() {
    let client = Fake::new(empty_snapshot(), &["config.set"]).answer(
        "config.set",
        serde_json::json!({ "undo": "pacer config set pacing.planner_reserve 10" }),
    );
    let mut d = dash(client);
    d.refresh().unwrap();
    let mut params = Map::new();
    params.insert(
        "key".to_string(),
        Value::String("pacing.planner_reserve".to_string()),
    );
    params.insert("value".to_string(), serde_json::json!(15));
    d.run(Effect::Action {
        action: Action {
            label: "Saved".into(),
            op: "config.set".into(),
            params,
            style: None,
            confirm: None,
        },
        fallback: None,
    });
    assert!(
        d.frames
            .last()
            .is_some_and(|f| f.contains("Saved. Undo: pacer config set pacing.planner_reserve 10"))
    );
}

#[test]
fn errors_are_reported_in_the_footer() {
    let client = Fake::new(empty_snapshot(), &["host.check"]).fail("host.check");
    let mut d = dash(client);
    d.refresh().unwrap();
    let action = Action {
        label: "Run checks".into(),
        op: "host.check".into(),
        params: Map::new(),
        style: None,
        confirm: None,
    };
    d.run(Effect::Action {
        action,
        fallback: None,
    });
    assert!(
        d.frames
            .last()
            .is_some_and(|f| f.contains("✕ not allowed (Use the sandbox)"))
    );
}

#[test]
fn managed_fallback_runs_the_fallback_steps_in_order() {
    let mut calls = Vec::new();
    let primary = ManagedStep {
        op: "task.answer".into(),
        params: Map::new(),
    };
    let steps = vec![
        ManagedStep {
            op: "dispatch.answer".into(),
            params: Map::new(),
        },
        ManagedStep {
            op: "dispatch.retry".into(),
            params: Map::new(),
        },
    ];
    let result = with_managed_fallback(
        |op, _| {
            calls.push(op.to_string());
            if op == "task.answer" {
                Err(DashError::new("not_allowed", "use dispatch.answer instead"))
            } else {
                Ok(serde_json::json!({ "ok": true }))
            }
        },
        &primary,
        &steps,
        |e| e.message.contains("use dispatch."),
    );
    assert!(result.is_ok());
    assert_eq!(
        calls,
        vec!["task.answer", "dispatch.answer", "dispatch.retry"]
    );
}

#[test]
fn settings_resources_load_from_their_op() {
    let client = Fake::new(empty_snapshot(), &["config.get"]).answer(
        "config.get",
        serde_json::json!({ "keys": {}, "planners": [] }),
    );
    let mut d = dash(client);
    d.refresh().unwrap();
    d.state.screen = "settings".to_string();
    d.state.section = "config".to_string();
    d.load_needs();
    assert!(d.data.settings.contains_key("config"));
    assert_eq!(
        d.client.seen().last().map(|c| c.0.as_str()),
        Some("config.get")
    );
}

#[test]
fn rendering_a_scripted_state_produces_a_frame() {
    let d = dash(Fake::new(empty_snapshot(), &[]));
    let frame = crate::frame(&d);
    assert!(frame.contains("pacer"), "frame: {frame}");
    assert_eq!(frame.lines().count(), 40);
}

// --- with_fallback (src/dashboard/data.ts) --------------------------------

struct TransportFail;
impl DashClient for TransportFail {
    fn call(&self, _op: &str, _params: Value) -> Result<Value, DashError> {
        Err(DashError::transport("fetch failed"))
    }
    fn snapshot(&self) -> Result<Value, DashError> {
        Err(DashError::transport("fetch failed"))
    }
    fn supports(&self, op: &str) -> bool {
        op == "task.get"
    }
    fn hello(&self) -> Result<Value, DashError> {
        Err(DashError::transport("fetch failed"))
    }
    fn kind(&self) -> &'static str {
        "http"
    }
}

struct Local;
impl DashClient for Local {
    fn call(&self, _op: &str, _params: Value) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "task_id": "t" }))
    }
    fn snapshot(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "seq": 8, "snapshot": {} }))
    }
    fn supports(&self, op: &str) -> bool {
        op == "task.get"
    }
    fn hello(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "ops": ["task.get"] }))
    }
    fn kind(&self) -> &'static str {
        "inprocess"
    }
}

#[test]
fn fallback_switches_once_on_transport_error_and_preserves_api_errors() {
    let client = FallbackClient::new(TransportFail, || Local);
    assert!(!client.switched());
    // Reads retry locally.
    let snap = client.snapshot().unwrap();
    assert_eq!(snap["seq"], 8);
    assert_eq!(client.seq(), 8);
    assert!(client.switched());
    assert_eq!(client.kind(), "inprocess");
    // Operations surface the local result.
    assert_eq!(
        client.call("task.list", serde_json::json!({})).unwrap()["task_id"],
        "t"
    );
}

#[test]
fn fallback_keeps_api_errors_and_does_not_switch() {
    struct ApiFail;
    impl DashClient for ApiFail {
        fn call(&self, _op: &str, _params: Value) -> Result<Value, DashError> {
            Err(DashError::new("conflict", "busy"))
        }
        fn snapshot(&self) -> Result<Value, DashError> {
            Err(DashError::new("conflict", "busy"))
        }
        fn supports(&self, op: &str) -> bool {
            op == "task.get"
        }
        fn hello(&self) -> Result<Value, DashError> {
            Err(DashError::new("conflict", "busy"))
        }
        fn kind(&self) -> &'static str {
            "http"
        }
    }
    let client = FallbackClient::new(ApiFail, || Local);
    assert_eq!(
        client
            .call("task.list", serde_json::json!({}))
            .unwrap_err()
            .code,
        "conflict"
    );
    assert!(!client.switched());
}
