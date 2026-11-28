//! Replay the TypeScript reducer + controller goldens (recorded by
//! `test/fixtures/dashboard-frame/controller.ts`) against the Rust ports.

#![allow(clippy::unwrap_used)]
use pacer_tui::controller::{DashClient, DashData, DashError, Dashboard, DashboardDeps};
use pacer_tui::state::{KeyContext, KeyResult, UiState};
use pacer_tui::theme::PLAIN_THEME;
use serde_json::Value;

#[derive(Clone)]
struct FakeClient {
    snapshot: Value,
    ops: Vec<String>,
    connection: &'static str,
}

impl DashClient for FakeClient {
    fn call(&self, _op: &str, _params: Value) -> Result<Value, DashError> {
        Ok(Value::Null)
    }
    fn snapshot(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "seq": 1, "snapshot": self.snapshot }))
    }
    fn supports(&self, op: &str) -> bool {
        self.ops.is_empty() || self.ops.iter().any(|o| o == op)
    }
    fn hello(&self) -> Result<Value, DashError> {
        Ok(serde_json::json!({ "ops": self.ops }))
    }
    fn kind(&self) -> &'static str {
        self.connection
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/dashboard-frame/controller.json"
    ))
    .unwrap()
}

#[test]
fn reducer_goldens_match_the_typescript_reference() {
    let g = golden();
    let mut failures = Vec::new();
    for case in g["reducer"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut state: UiState = serde_json::from_value(case["state"].clone()).unwrap();
        let ctx: KeyContext = serde_json::from_value(case["ctx"].clone()).unwrap();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let key = step["key"].as_str().unwrap();
            let result: KeyResult = pacer_tui::state::reduce_key(&state, key, &ctx);
            let expected_state: UiState = serde_json::from_value(step["state"].clone()).unwrap();
            let expected_effect: Option<pacer_tui::state::Effect> =
                serde_json::from_value(step["effect"].clone()).unwrap();
            let expected_quit = step["quit"].as_bool().unwrap_or(false);
            let expected_refresh = step["refresh"].as_bool().unwrap_or(false);
            if result.state != expected_state {
                failures.push(format!(
                    "{name} step {i} ({key}) state mismatch:\n  actual:   {}\n  expected: {}",
                    serde_json::to_string(&result.state).unwrap(),
                    serde_json::to_string(&expected_state).unwrap()
                ));
            }
            if result.effect != expected_effect {
                failures.push(format!(
                    "{name} step {i} ({key}) effect mismatch:\n  actual:   {:?}\n  expected: {:?}",
                    result.effect, expected_effect
                ));
            }
            if result.quit != expected_quit || result.refresh != expected_refresh {
                failures.push(format!(
                    "{name} step {i} ({key}) flags mismatch: actual ({},{}) expected ({},{})",
                    result.quit, result.refresh, expected_quit, expected_refresh
                ));
            }
            state = expected_state;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn controller_frames_match_the_typescript_reference() {
    let g = golden();
    let snapshot = g["snapshot"].clone();
    let details: DashData = DashData {
        details: serde_json::from_value(g["details"].clone()).unwrap(),
        history: None,
        settings: serde_json::from_value(g["settings"].clone()).unwrap(),
    };
    let mut failures = Vec::new();
    for case in g["controller"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let ops: Vec<String> = serde_json::from_value(case["ops"].clone()).unwrap();
        let connection = case["connection"].as_str().unwrap();
        let client = FakeClient {
            snapshot: snapshot.clone(),
            ops,
            connection: match connection {
                "http" | "live" => "http",
                _ => "inprocess",
            },
        };
        let deps = DashboardDeps {
            theme: PLAIN_THEME,
            version: case["version"].as_str().unwrap_or("0.0.0-test").to_string(),
            cwd: "/tmp/repo".to_string(),
            now: case["now"].as_f64().unwrap(),
            width: case["width"].as_u64().unwrap() as u16,
            height: case["height"].as_u64().unwrap() as u16,
            time_zone: case["timeZone"].as_str().map(str::to_string),
            update: case
                .get("update")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        let mut dash = Dashboard::new(client, deps);
        dash.data = details.clone();
        dash.state = serde_json::from_value(case["state"].clone()).unwrap();
        dash.snapshot = snapshot.clone();
        dash.ops = Some(match &case["ops"] {
            Value::Array(a) => a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        });
        dash.connection = connection.to_string();
        if let Some(message) = case.get("message").filter(|m| !m.is_null()) {
            dash.report(
                message["text"].as_str().unwrap_or(""),
                message["tone"].as_str().unwrap_or("info"),
            );
        }
        let actual = dash.render();
        let expected = case["frame"].as_str().unwrap();
        if actual != expected {
            let diff = actual
                .lines()
                .zip(expected.lines())
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(i, (a, b))| format!("  row {i}:\n    actual:   {a:?}\n    expected: {b:?}"))
                .collect::<Vec<_>>()
                .join("\n");
            failures.push(format!("{name}:\n{diff}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
