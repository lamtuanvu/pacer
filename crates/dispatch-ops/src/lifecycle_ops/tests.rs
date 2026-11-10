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
fn valid_requests_forward_to_core() {
    let ctx = ctx(&[]);
    for (op, params) in [
        ("dispatch.submit", json!({"goal": "g", "repo": "/r"})),
        ("dispatch.child", json!({"goal": "g", "requestId": "r1"})),
        ("dispatch.wait", json!({"id": "t", "timeout_s": 3000})),
        (
            "dispatch.review",
            json!({"id": "t", "accepted": false, "note": "n", "expect_rev": 2}),
        ),
        (
            "dispatch.retry",
            json!({"id": "t", "expect_rev": 1, "requestId": "r", "feedback": ""}),
        ),
        (
            "dispatch.answer",
            json!({"id": "t", "expect_rev": 1, "requestId": "r", "text": "yes"}),
        ),
        ("dispatch.stop", json!({"id": "t"})),
        (
            "dispatch.stop",
            json!({"id": "t", "expect_rev": 3, "extra": 1}),
        ),
    ] {
        assert!(lifecycle_stays_forwarded(&ctx, op, &params), "{op}");
    }
    assert!(!lifecycle_stays_forwarded(
        &ctx,
        "dispatch.tree",
        &json!({"id": "t"})
    ));
}

#[test]
fn options_forward_whatever_the_other_fields_hold() {
    let ctx = ctx(&[]);
    assert!(lifecycle_stays_forwarded(
        &ctx,
        "dispatch.submit",
        &json!({"goal": 1, "options": {"bogus": true}})
    ));
    assert!(lifecycle_stays_forwarded(
        &ctx,
        "dispatch.child",
        &json!({"options": null})
    ));
    assert!(!lifecycle_stays_forwarded(
        &ctx,
        "dispatch.wait",
        &json!({"options": {}})
    ));
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
        message("dispatch.wait", json!({"id": "t", "timeout_s": 1.5})),
        "timeout_s: Invalid input: expected int, received number"
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
        assert!(!lifecycle_stays_forwarded(
            &ctx,
            "dispatch.submit",
            &json!({})
        ));
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
