#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs};

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    let env = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect::<HashMap<_, _>>();
    Ctx::with(dir.path().into(), dir.path().into(), env, 1000.0)
}

async fn message(result: Result<Value, CoreError>) -> (Code, String) {
    let error = result.unwrap_err();
    (error.code, error.message)
}

#[tokio::test]
async fn executor_and_enforcement_identities_are_refused_before_params() {
    let dir = tempfile::tempdir().unwrap();
    let executor = ctx(&dir, &[("PACER_ROLE", "executor")]);
    assert_eq!(
        message(dispatch_list(&executor, json!({"limit": 0})).await).await,
        (Code::NotAllowed, "A scoped work grant is required".into())
    );
    let enforcement = ctx(
        &dir,
        &[("PACER_ENFORCEMENT_TOKEN", "x"), ("PACER_ROLE", "executor")],
    );
    assert_eq!(
        message(dispatch_tree(&enforcement, json!({})).await).await,
        (
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial".into()
        )
    );
    let empty_token = ctx(&dir, &[("PACER_ENFORCEMENT_TOKEN", "")]);
    assert_eq!(
        message(dispatch_events(&empty_token, json!({})).await)
            .await
            .1,
        "id: Invalid input: expected string, received undefined"
    );
}

#[tokio::test]
async fn params_report_zod_issues_in_schema_order() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    for (params, expected) in [
        (
            json!({"id": ""}),
            "id: Too small: expected string to have >=1 characters",
        ),
        (
            json!({"id": "😀".repeat(129)}),
            "id: Too big: expected string to have <=128 characters",
        ),
        (
            json!({"id": 5, "after": -1}),
            "id: Invalid input: expected string, received number; after: Too small: expected number to be >=0",
        ),
        (
            json!({"id": "x", "after": 1.5}),
            "after: Invalid input: expected int, received number",
        ),
        (
            json!({"id": "x", "after": null}),
            "after: Invalid input: expected number, received null",
        ),
        (
            json!([]),
            "params: Invalid input: expected object, received array",
        ),
    ] {
        assert_eq!(
            message(dispatch_events(&c, params).await).await,
            (Code::InvalidInput, expected.into())
        );
    }
    for (params, expected) in [
        (
            json!({"relation": "x", "state": "archived"}),
            "relation: Invalid option: expected one of \"roots\"|\"children\"|\"all\"; state: Invalid option: expected one of \"queued\"|\"running\"|\"done\"|\"partial\"|\"failed\"|\"limit\"|\"stopped\"|\"needs_input\"",
        ),
        (
            json!({"repo": "", "before": "", "limit": 101}),
            "repo: Too small: expected string to have >=1 characters; before: Too small: expected string to have >=1 characters; limit: Too big: expected number to be <=100",
        ),
        (
            json!({"limit": 9_007_199_254_740_992_u64}),
            "limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=100",
        ),
    ] {
        assert_eq!(
            message(dispatch_list(&c, params).await).await,
            (Code::InvalidInput, expected.into())
        );
    }
    assert!(
        dispatch_tree(&c, json!({"id": "😀".repeat(128)}))
            .await
            .unwrap_err()
            .code
            == Code::UnknownTask
    );
}

#[tokio::test]
async fn config_get_reports_strategy_and_built_in_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    let (code, text) = message(dispatch_config_get(&c, Value::Null).await).await;
    assert_eq!(code, Code::Internal);
    assert!(text.starts_with("no strategy found at "), "{text}");
    fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\nproviders: {claude-code: {}}\n",
    )
    .unwrap();
    let built_in = dispatch_config_get(&c, json!({"ignored": 1}))
        .await
        .unwrap();
    assert_eq!(built_in["strategy"], "default");
    assert_eq!(built_in["planner"], "claude-code");
    assert_eq!(built_in["plannerAccount"], "claude-code");
    assert_eq!(built_in["source"], "built-in");
    assert_eq!(built_in["config"], default_dispatch_config());
    assert_eq!(built_in["config"]["engine"], "ladder");
    fs::write(
        dir.path().join("strategy.yaml"),
        "accounts:\n  work: {kind: claude}\nplanner: claude-code#work\nrouting: []\ndispatch: {timeoutMs: 2500}\n",
    )
    .unwrap();
    let configured = dispatch_config_get(&c, json!({})).await.unwrap();
    assert_eq!(configured["plannerAccount"], "work");
    assert_eq!(configured["source"], "strategy");
    assert_eq!(configured["config"]["timeoutMs"], 2500);
}

#[tokio::test]
async fn work_reads_open_the_shared_task_database() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    assert_eq!(
        message(dispatch_tree(&c, json!({"id": "t-20261110-190000-aaaa"})).await).await,
        (Code::UnknownTask, "Unknown work".into())
    );
    assert_eq!(
        dispatch_list(&c, json!({})).await.unwrap(),
        json!({"tasks": [], "next": null})
    );
}
