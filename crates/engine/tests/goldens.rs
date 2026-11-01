#![allow(clippy::unwrap_used)]
use pacer_engine::{
    active_hours_left, binding_window, evaluate_eligibility, evaluate_window, machine_guard,
    pace_pct, rank_executors,
};
use serde_json::Value;

fn near(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let a = a.as_f64().unwrap();
            let b = b.as_f64().unwrap();
            assert!((a - b).abs() <= 1e-9, "{path}: {a} != {b}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                near(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (key, b) in b {
                near(&a[key], b, &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
#[test]
fn typescript_parity() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../test/fixtures/engine/goldens.json")).unwrap();
    for case in fixture["pace"].as_array().unwrap() {
        let offset = if case["zone"] == "UTC" { 0 } else { 7 };
        let input = &case["input"];
        let usage = &input["usage"];
        let now = input["now"].as_f64().unwrap();
        let end = usage["resetsAt"].as_f64().unwrap_or(now);
        let start = end - usage["lengthS"].as_f64().unwrap();
        near(
            &serde_json::json!(pace_pct(start, end, now, &input["profile"], offset)),
            &case["output"]["pacePct"],
            "pacePct",
        );
        near(
            &serde_json::json!(active_hours_left(now, end, &input["profile"], offset)),
            &case["output"]["activeHoursLeft"],
            "activeHoursLeft",
        );
        near(
            &evaluate_window(input, offset),
            &case["output"]["window"],
            case["name"].as_str().unwrap(),
        );
    }
    for case in fixture["eligibility"].as_array().unwrap() {
        near(
            &evaluate_eligibility(&case["input"]),
            &case["output"],
            case["name"].as_str().unwrap(),
        );
    }
    for case in fixture["machine"].as_array().unwrap() {
        near(
            &machine_guard(&case["input"]),
            &case["output"],
            case["name"].as_str().unwrap(),
        );
    }
    for case in fixture["rank"].as_array().unwrap() {
        near(
            &rank_executors(&case["input"]),
            &case["output"],
            case["name"].as_str().unwrap(),
        );
    }
    near(
        &binding_window(fixture["binding"]["input"].as_array().unwrap()),
        &fixture["binding"]["output"],
        "binding",
    );
}
