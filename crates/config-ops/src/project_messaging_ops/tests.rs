#![allow(clippy::unwrap_used)]
use super::*;

fn message(op: &str, params: Value) -> String {
    parse(op, params).unwrap_err().message
}

#[test]
fn param_issues_match_zod_text_and_order() {
    let get = "project.messaging.get";
    let remove = "project.messaging.remove";
    let set = "project.messaging.set";
    assert_eq!(
        message(get, json!({"x":1})),
        "repo: Invalid input: expected string, received undefined; params: Unrecognized key: \"x\""
    );
    assert_eq!(
        message(get, json!("x")),
        "params: Invalid input: expected object, received string"
    );
    assert_eq!(
        message(get, json!({"repo":"a/b/c","x":1,"y":2})),
        "params: Unrecognized keys: \"x\", \"y\""
    );
    assert_eq!(
        message(get, json!({"repo":"a".repeat(4097)})),
        "repo: Too big: expected string to have <=4096 characters"
    );
    assert!(parse(get, json!({"repo":"\u{1F600}".repeat(2049)})).is_ok());
    assert_eq!(
        message(
            remove,
            json!({"repo":"a/b/c","expect_rev":-9007199254740992.0})
        ),
        "expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >=0; expect_rev: Too small: expected int to be >=-9007199254740991"
    );
    assert_eq!(
        message(remove, json!({"repo":"a/b/c","expect_rev":1e300})),
        "expect_rev: Too big: expected int to be <=9007199254740991; expect_rev: Too big: expected int to be <=9007199254740991"
    );
    assert_eq!(
        message(remove, json!({"repo":"a/b/c","expect_rev":1.5})),
        "expect_rev: Invalid input: expected int, received number"
    );
    assert_eq!(
        message(set, json!({"b":1,"a":2})),
        "repo: Invalid input: expected string, received undefined; expect_rev: Invalid input: expected number, received undefined; rules: Invalid input: expected array, received undefined; params: Unrecognized keys: \"b\", \"a\""
    );
    assert_eq!(
        message(
            set,
            json!({"repo":"a/b/c","expect_rev":0,"rules":[],"max_turns":-1e18})
        ),
        "max_turns: Too small: expected int to be >=-9007199254740991; max_turns: Too small: expected number to be >0"
    );
    assert_eq!(
        message(
            set,
            json!({"repo":"a/b/c","expect_rev":0,"rules":vec![json!({"effect":"allow"}); 51]})
        ),
        "rules: Too big: expected array to have <=50 items"
    );
}

#[test]
fn set_params_normalize_to_schema_order() {
    let p = parse(
        "project.messaging.set",
        json!({"liveness":{"nudge_in_modes":["strict"],"interval_s":10.0},"max_turns":5,"rules":[{"limits":{"confirm":true,"per_minute":2},"effect":"deny","relation":["self"]}],"expect_rev":0,"repo":"a/b/c"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&p).unwrap(),
        r#"{"repo":"a/b/c","expect_rev":0,"rules":[{"effect":"deny","relation":["self"],"limits":{"per_minute":2,"confirm":true}}],"max_turns":5,"liveness":{"interval_s":10,"nudge_in_modes":["strict"]}}"#
    );
}

#[test]
fn forwards_paths_nested_issues_and_unusable_files() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1.0,
    );
    let set = "project.messaging.set";
    let base = json!({"repo":"github.com/a/b","expect_rev":0,"rules":[]});
    assert!(!project_messaging_stays_forwarded(&ctx, set, &base));
    assert!(!project_messaging_stays_forwarded(
        &ctx,
        "config.set",
        &json!({"repo":"/x"})
    ));
    assert!(project_messaging_stays_forwarded(
        &ctx,
        "project.messaging.get",
        &json!({"repo":"/tmp/checkout"})
    ));
    let mut bad_rule = base.clone();
    bad_rule["rules"] = json!([{"effect":"maybe"}]);
    assert!(project_messaging_stays_forwarded(&ctx, set, &bad_rule));
    let mut bad_liveness = base.clone();
    bad_liveness["liveness"] = json!({"interval_s":1});
    assert!(project_messaging_stays_forwarded(&ctx, set, &bad_liveness));
    std::fs::write(dir.path().join("project-messaging.json"), "{}").unwrap();
    assert!(project_messaging_stays_forwarded(&ctx, set, &base));
}

#[tokio::test]
async fn relative_repo_is_rejected_like_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1.0,
    );
    let error = project_messaging_get(&ctx, json!({"repo":"checkout"}))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "repo must be an absolute path or a repository key"
    );
    assert!(error.hint.is_none());
}
