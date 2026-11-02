#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_sessions::{session_args::parse_session_args, takeover, targets::*};
use serde_json::{Value, json};
fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/control-parity.json"
    ))
    .unwrap()
}
fn observed<T: serde::Serialize, E: std::fmt::Display>(r: Result<T, E>) -> Value {
    match r {
        Ok(v) => json!({"ok":v}),
        Err(e) => json!({"error":e.to_string()}),
    }
}
#[test]
fn cli_session_grammar_matches_ts() {
    for row in golden()["session"].as_array().unwrap() {
        let args: Vec<String> = serde_json::from_value(row["args"].clone()).unwrap();
        assert_eq!(
            observed(parse_session_args(&args)),
            row["result"],
            "{args:?}"
        );
    }
}
#[test]
fn terminal_templates_match_ts() {
    for row in golden()["terminal"].as_array().unwrap() {
        let s = row["setting"].as_str().unwrap();
        assert_eq!(observed(validate_terminal_open(s)), row["result"]);
        assert_eq!(observed(split_argv(s)), row["split"]);
        assert_eq!(
            observed(terminal_recipe(s, "task_1", "linux")),
            row["recipe"]
        );
    }
    for row in golden()["recipes"].as_array().unwrap() {
        assert_eq!(
            json!(
                terminal_recipe(
                    row["setting"].as_str().unwrap(),
                    "t-1",
                    row["platform"].as_str().unwrap()
                )
                .unwrap()
            ),
            row["result"]
        );
    }
}
#[test]
fn takeover_availability_matches_ts() {
    for row in golden()["takeover"].as_array().unwrap() {
        assert_eq!(
            takeover::availability(&row["task"], false),
            row["result"],
            "{}",
            row["task"]
        );
    }
}
#[test]
fn javascript_numeric_and_utf16_boundaries_match_ts() {
    for row in golden()["offsets"].as_array().unwrap() {
        assert_eq!(
            pacer_sessions::control::valid_from(&row["value"]),
            row["valid"].as_bool().unwrap()
        );
    }
    for row in golden()["labels"].as_array().unwrap() {
        assert_eq!(
            json!(pacer_sessions::control::label_units(
                row["label"].as_str().unwrap()
            )),
            row["units"]
        );
    }
}
