#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn ctx(env: &[(&str, &str)]) -> Ctx {
    let home = std::env::temp_dir();
    Ctx::with(
        home.clone(),
        home.join(".pacer"),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect::<HashMap<_, _>>(),
        1_700_000_000.0,
    )
}

fn message(op: &str, params: Value) -> String {
    check(&ctx(&[]), op, &params).unwrap_err().message
}

#[test]
fn every_lifecycle_op_is_admitted_without_forwarding() {
    let ctx = ctx(&[]);
    // B2-9 owned submit/child, B2-10 added wait/review/stop and B2-11 adds
    // retry/answer. A request Rust would not refuse runs every op natively.
    for (op, params) in [
        ("dispatch.submit", json!({"goal": "g", "repo": "/r"})),
        ("dispatch.child", json!({"goal": "g", "requestId": "r1"})),
        ("dispatch.submit", json!({"goal": "g", "repo": "/r", "options": {"allowDelegation": true}})),
        ("dispatch.child", json!({"goal": "g", "requestId": "r1", "difficulty": "simple", "model": "x"})),
        ("dispatch.wait", json!({"id": "t", "timeout_s": 3000})),
        (
            "dispatch.review",
            json!({"id": "t", "accepted": false, "note": "n", "expect_rev": 2}),
        ),
        ("dispatch.stop", json!({"id": "t"})),
        (
            "dispatch.stop",
            json!({"id": "t", "expect_rev": 3, "extra": 1}),
        ),
        (
            "dispatch.retry",
            json!({"id": "t", "expect_rev": 1, "requestId": "r", "feedback": ""}),
        ),
        (
            "dispatch.answer",
            json!({"id": "t", "expect_rev": 1, "requestId": "r", "text": "yes"}),
        ),
    ] {
        assert!(check(&ctx, op, &params).is_ok(), "{op} {params}");
    }
    assert_eq!(
        check(&ctx, "dispatch.tree", &json!({"id": "t"}))
            .unwrap_err()
            .code,
        Code::UnknownOp
    );
}

#[test]
fn work_options_validate_natively_and_interleave_with_field_issues() {
    let ctx = ctx(&[]);
    // Unknown `workOptionsSchema` key is refused natively (not forwarded).
    assert!(check(
        &ctx,
        "dispatch.submit",
        &json!({"goal": 1, "options": {"bogus": true}})
    )
    .is_err());
    let text = message(
        "dispatch.submit",
        json!({"goal": "", "options": {"bogus": true}}),
    );
    assert!(
        text.contains("options: Unrecognized key: \"bogus\"") && text.contains("goal: Too small"),
        "{text}"
    );
    let child = message(
        "dispatch.child",
        json!({"goal": "g", "requestId": "r", "difficulty": "hard", "model": 7}),
    );
    assert!(
        child.contains("difficulty: Invalid option: expected one of \"simple\"|\"standard\"|\"complex\"")
            && child.contains("model: Invalid input: expected string"),
        "{child}"
    );
    // `options` on `wait` is an unknown key, not a work option, so that op
    // publishes its own shape issue natively.
    assert!(check(&ctx, "dispatch.wait", &json!({"options": {}})).is_err());
}

#[test]
fn numbers_are_validated_natively_without_forwarding() {
    let ctx = ctx(&[]);
    let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap();
    // With the lifecycle forward deleted, every decodable number is answered
    // by the native Zod issue text rather than reaching Core.
    assert!(check(
        &ctx,
        "dispatch.wait",
        &parse(r#"{"id": "t", "timeout_s": 3000.0}"#)
    )
    .is_ok());
    for body in [
        r#"{"id": "t", "timeout_s": 1.5}"#,
        r#"{"id": "", "timeout_s": 99999999999999999999}"#,
        r#"{"id": "", "timeout_s": 18446744073709551615}"#,
        r#"{"id": "", "timeout_s": -9223372036854775808}"#,
        r#"{"id": "", "extra": 1.5}"#,
    ] {
        let params = parse(body);
        let result = check(&ctx, "dispatch.wait", &params);
        assert!(result.is_err(), "{body}");
        assert_eq!(result.unwrap_err().code, Code::InvalidInput, "{body}");
    }
}

#[test]
fn issues_follow_zod_key_order_and_text() {
    assert_eq!(
        message("dispatch.submit", json!({})),
        "goal: Invalid input: expected string, received undefined; repo: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message(
            "dispatch.submit",
            json!({"goal": "", "repo": "r", "title": "t".repeat(501), "acceptance_timeout_min": 121, "requestId": null})
        ),
        "goal: Too small: expected string to have >=1 characters; title: Too big: expected string to have <=500 characters; acceptance_timeout_min: Too big: expected number to be <=120; requestId: Invalid input: expected string, received null"
    );
    assert_eq!(
        message("dispatch.child", json!({"goal": "g"})),
        "requestId: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message("dispatch.wait", json!({"id": "t", "timeout_s": 3001})),
        "timeout_s: Too big: expected number to be <=3000"
    );
    assert_eq!(
        message(
            "dispatch.review",
            json!({"id": "t", "accepted": "yes", "expect_rev": 0})
        ),
        "accepted: Invalid input: expected boolean, received string; expect_rev: Too small: expected number to be >0"
    );
    assert_eq!(
        message("dispatch.review", json!({"id": "t"})),
        "accepted: Invalid input: expected boolean, received undefined; expect_rev: Invalid input: expected number, received undefined"
    );
    assert_eq!(
        message(
            "dispatch.retry",
            json!({"id": "x".repeat(129), "expect_rev": 1, "requestId": "r", "feedback": "é".repeat(2001)})
        ),
        "id: Too big: expected string to have <=128 characters; feedback: Too big: expected string to have <=2000 characters"
    );
    assert_eq!(
        message(
            "dispatch.answer",
            json!({"id": "t", "expect_rev": 1, "requestId": "r", "text": ""})
        ),
        "text: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        message("dispatch.stop", json!({"id": "t", "expect_rev": "1"})),
        "expect_rev: Invalid input: expected number, received string"
    );
    assert_eq!(
        message("dispatch.stop", json!([1])),
        "params: Invalid input: expected object, received array"
    );
}

#[test]
fn code_points_bound_text_like_zod() {
    assert!(
        check(
            &ctx(&[]),
            "dispatch.answer",
            &json!({"id": "t", "expect_rev": 1, "requestId": "r", "text": "😀".repeat(2000)})
        )
        .is_ok()
    );
}

#[tokio::test]
async fn callers_without_a_grant_are_refused_before_params() {
    for (env, text) in [
        (
            ("PACER_ENFORCEMENT_TOKEN", "pet_x"),
            "Enforcement identity only reports a native child denial",
        ),
        (
            ("PACER_ROLE", "executor"),
            "A scoped work grant is required",
        ),
    ] {
        let ctx = ctx(&[env]);
        let err = dispatch_submit(&ctx, json!("bad")).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Code::NotAllowed, text));
    }
}

#[tokio::test]
async fn a_request_core_must_run_is_unavailable_natively() {
    let ctx = ctx(&[]);
    let err = dispatch_stop(&ctx, json!({"id": "t"})).await.unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    let err = dispatch_wait(&ctx, Value::Null).await.unwrap_err();
    assert_eq!(err.code, Code::InvalidInput);
}

