#![allow(clippy::unwrap_used)]

//! Vectors captured by test/session-params-parity.test.ts from TypeScript Zod.
use pacer_sessions::params::{
    bounded_unicode, valid_agent_uuid, valid_draft_uuid, valid_expect_rev, valid_session_id,
    MAX_ATTACHMENTS, MAX_EXECUTOR_LEN, MAX_SESSION_REQUEST,
};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/session-ops/params.json"
    ))
    .unwrap()
}

#[test]
fn session_id_and_uuid_bounds() {
    let golden = golden();
    for row in golden["session_id"].as_array().unwrap() {
        assert_eq!(
            valid_session_id(row["input"].as_str().unwrap()),
            row["valid"].as_bool().unwrap()
        );
    }
    for row in golden["draft_uuid"].as_array().unwrap() {
        assert_eq!(
            valid_draft_uuid(row["input"].as_str().unwrap()),
            row["valid"].as_bool().unwrap()
        );
    }
    for row in golden["agent_uuid"].as_array().unwrap() {
        assert_eq!(
            valid_agent_uuid(row["input"].as_str().unwrap()),
            row["valid"].as_bool().unwrap()
        );
    }
}

#[test]
fn unicode_length_and_expect_rev() {
    let golden = golden();
    for row in golden["request_length"].as_array().unwrap() {
        let text = row["input"].as_str().unwrap();
        let valid = row["valid"].as_bool().unwrap();
        assert_eq!(
            bounded_unicode(text, 1, MAX_SESSION_REQUEST),
            valid,
            "request length: {}",
            text.chars().take(8).collect::<String>()
        );
    }
    for row in golden["expect_rev"].as_array().unwrap() {
        assert_eq!(
            valid_expect_rev(row["input"].as_f64().unwrap()),
            row["valid"].as_bool().unwrap()
        );
    }
    assert!(bounded_unicode("x", 1, MAX_EXECUTOR_LEN));
    assert_eq!(MAX_ATTACHMENTS, 20);
}
