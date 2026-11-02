#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_sessions::attach::{Action, AttachKeys};
use serde_json::{Value, json};

fn decode_hex(s: &str) -> Vec<u8> {
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[test]
fn attach_keys_match_typescript_golden() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/keys-parity.json"
    ))
    .unwrap();
    for row in rows {
        let mut keys = AttachKeys::new(row["takeover"].as_bool().unwrap_or(false));
        let mut actions = Vec::new();
        let mut detached = Vec::new();
        for step in row["steps"].as_array().unwrap() {
            let value = &step[1];
            match step[0].as_str().unwrap() {
                "push" => {
                    detached.push(keys.push(&decode_hex(value.as_str().unwrap()), &mut actions))
                }
                "take" => keys.take(value.as_bool().unwrap(), &mut actions),
                "state" => keys.control_state(
                    value["you"].as_bool() == Some(true),
                    value["controller"].as_str(),
                    value["reason"].as_str(),
                    &mut actions,
                ),
                _ => panic!("unknown step"),
            }
        }
        let frames: Vec<Value> = actions
            .iter()
            .filter_map(|a| {
                if let Action::Frame(kind, bytes) = a {
                    Some(json!({"type":kind,"hex":hex(bytes)}))
                } else {
                    None
                }
            })
            .collect();
        let prompts: Vec<&str> = actions
            .iter()
            .filter_map(|a| {
                if let Action::Prompt(s) = a {
                    Some(s.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(json!(frames), row["frames"], "{}", row["name"]);
        assert_eq!(json!(prompts), row["prompts"], "{}", row["name"]);
        assert_eq!(json!(detached), row["detached"], "{}", row["name"]);
    }
}
