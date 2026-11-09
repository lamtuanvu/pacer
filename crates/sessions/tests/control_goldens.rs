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
#[test]
fn terminal_query_reply_stripping_matches_ts() {
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let rows = golden()["queries"].as_array().unwrap().clone();
    assert!(!rows.is_empty());
    for row in rows {
        let text = row["hex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect();
        let kept =
            pacer_sessions::control::strip_query_replies(&bytes, row["cursor"].as_bool().unwrap());
        assert_eq!(hex(&kept), row["kept"].as_str().unwrap(), "{row}");
    }
}
#[test]
fn pending_line_heuristic_matches_ts() {
    let rows = golden()["pending"].as_array().unwrap().clone();
    assert!(!rows.is_empty());
    for row in rows {
        let text = row["hex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect();
        let from = row["from"].as_u64().unwrap() as usize;
        let (count, typed) = pacer_sessions::control::pending_after(&bytes, from);
        assert_eq!(json!({"count": count, "typed": typed}), row["result"], "{row}");
    }
}
