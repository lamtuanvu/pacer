#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    Ctx::with(
        dir.path().into(),
        dir.path().into(),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        1_700_000_000.0,
    )
}

#[tokio::test]
async fn block_and_unblock_rewrite_blocked_json_like_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    fs::write(
        dir.path().join("blocked.json"),
        r#"{"old":{"until":1,"reason":"x"},"keep":{"until":null,"reason":"y","extra":1.0}}"#,
    )
    .unwrap();
    let out = runner_block(&c, json!({"id":"codex","for":"2h","reason":"  "}))
        .await
        .unwrap();
    assert_eq!(out, json!({"ok": true}));
    assert_eq!(
        fs::read_to_string(dir.path().join("blocked.json")).unwrap(),
        r#"{"keep":{"until":null,"reason":"y","extra":1},"codex":{"until":1700007200,"reason":"Paused by user"}}"#
    );
    runner_unblock(&c, json!({"id":"codex"})).await.unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("blocked.json")).unwrap(),
        r#"{"keep":{"until":null,"reason":"y","extra":1}}"#
    );
}

#[tokio::test]
async fn block_refusals_match_typescript_order_and_text() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    let unknown = runner_block(&c, json!({"id":"zzz","for":"0m"}))
        .await
        .unwrap_err();
    assert_eq!(unknown.code, Code::UnknownExecutor);
    assert_eq!(unknown.hint.as_deref(), Some("configured: codex"));
    for duration in ["0m", "5x", "m", "1.5h", "-1d"] {
        let error = runner_block(&c, json!({"id":"codex","for":duration}))
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "duration must be a positive number followed by s, m, h or d"
        );
    }
    let big = format!("{}d", "9".repeat(400));
    let error = runner_block(&c, json!({"id":"codex","for":big}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "invalid duration");
    let params = runner_block(&c, json!({"for": 1})).await.unwrap_err();
    assert_eq!(
        params.message,
        "id: Invalid input: expected string, received undefined; for: Invalid input: expected string, received number"
    );
    let enforcement = ctx(&dir, &[("PACER_ENFORCEMENT_TOKEN", "t")]);
    assert_eq!(
        runner_unblock(&enforcement, json!("x"))
            .await
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
}

#[tokio::test]
async fn list_composes_blocks_breaks_and_eligibility() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    fs::write(
        dir.path().join("broken.json"),
        r#"{"codex":{"until":1800000000,"reason":"bad cli"}}"#,
    )
    .unwrap();
    let parts = json!({"providers":[{"id":"codex","eligibility":{"state":"ineligible","budget":"exhausted","validUntil":5,"reasons":[{"code":"budget_exhausted"},{"code":"x"}]}}]});
    let list = |parts: Value| runner_list(&c, json!({"a":1}), Box::pin(async move { Ok(parts) }));
    let rows = list(parts.clone()).await.unwrap();
    assert_eq!(rows[0]["state"], "broken");
    assert_eq!(rows[0]["reason"], "bad cli");
    fs::remove_file(dir.path().join("broken.json")).unwrap();
    let rows = list(parts).await.unwrap();
    assert_eq!(
        rows,
        json!([{"id":"codex","eligibility":{"state":"ineligible","budget":"exhausted","validUntil":5,"reasons":[{"code":"budget_exhausted"},{"code":"x"}]},"state":"exhausted","until":5,"reason":"Budget exhausted; paid execution is not allowed; Execution evidence needs attention"}])
    );
    let rows = list(json!({"providers":[]})).await.unwrap();
    assert_eq!(
        rows,
        json!([{"id":"codex","state":"ok","until":null,"reason":null}])
    );
}

#[test]
fn add_forwards_check_jobs_terminals_invalid_params_and_unparsable_strategies() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    assert!(!runner_stays_forwarded(
        &c,
        "runner.add",
        &json!({"agent":"codex","test":false,"kinds":["docs"],"rank":0})
    ));
    for params in [
        json!({"agent":"codex"}),
        json!({"agent":"codex","test":true}),
        json!({"agent":"codex","test":false,"interactive":"runner-add"}),
        json!({"agent":"nope","test":false}),
        json!({"agent":"codex","test":false,"rank":-1}),
        json!({"agent":"codex","test":false,"kinds":[]}),
        json!({"agent":"codex","test":false,"account":""}),
        json!("x"),
    ] {
        assert!(
            runner_stays_forwarded(&c, "runner.add", &params),
            "{params}"
        );
    }
    assert!(!runner_stays_forwarded(&c, "runner.list", &json!("x")));
    fs::write(dir.path().join("strategy.yaml"), "planner: [").unwrap();
    assert!(runner_stays_forwarded(
        &c,
        "runner.add",
        &json!({"agent":"codex","test":false})
    ));
}

#[test]
fn runner_set_with_model_forwards() {
    // A runner.set carrying a string model must reach TypeScript, which alone can
    // consult the provider model listing (a fork of closestModels/isOffered).
    assert!(runner_set_stays_forwarded(
        &json!({"id": "codex", "model": "acme/b"})
    ));
    assert!(runner_set_stays_forwarded(
        &json!({"id": "codex", "enabled": false, "model": "acme/b"})
    ));
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    assert!(runner_stays_forwarded(
        &c,
        "runner.set",
        &json!({"id": "codex", "model": "acme/b"})
    ));
}

#[test]
fn runner_set_with_model_and_invalid_params_stays_native() {
    // A string model alone does not forward: params failing the native
    // runner.set parameter validation keep failing natively with the identical
    // invalid_input error TypeScript produces, instead of a forward marker.
    let long_id = "😀".repeat(65);
    for params in [
        json!({"id": long_id, "model": "", "enabled": null, "max_tasks": 0, "rank": -1}),
        json!({"id": "codex", "model": ""}),
    ] {
        assert!(!runner_set_stays_forwarded(&params), "{params}");
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(&dir, &[]);
        assert!(
            !runner_stays_forwarded(&c, "runner.set", &params),
            "{params}"
        );
    }
    // Valid params with a string model still forward.
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    assert!(runner_stays_forwarded(
        &c,
        "runner.set",
        &json!({"id": "codex", "enabled": false, "model": "acme/b"})
    ));
    // A string model with another invalid field stays native too.
    assert!(!runner_set_stays_forwarded(
        &json!({"id": "codex", "model": "acme/b", "max_tasks": 0})
    ));
}

#[test]
fn runner_set_without_model_stays_native() {
    // Without a string model there is nothing to check against a listing, so
    // runner.set stays on the native write path like every other option.
    assert!(!runner_set_stays_forwarded(&json!({"id": "codex"})));
    assert!(!runner_set_stays_forwarded(
        &json!({"id": "codex", "model": null})
    ));
    assert!(!runner_set_stays_forwarded(
        &json!({"id": "codex", "model": 1})
    ));
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    assert!(!runner_stays_forwarded(
        &c,
        "runner.set",
        &json!({"id": "codex", "enabled": false})
    ));
    assert!(!runner_stays_forwarded(
        &c,
        "runner.set",
        &json!({"id": "codex", "max_tasks": 2})
    ));
    assert!(!runner_stays_forwarded(
        &c,
        "runner.set",
        &json!({"id": "codex", "model": null})
    ));
}

#[tokio::test]
async fn add_declares_routes_and_refuses_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  codex: {}\n",
    )
    .unwrap();
    let out = runner_add(
        &c,
        json!({"agent":"cursor","test":false,"kinds":["docs"],"max_tasks":2}),
    )
    .await
    .unwrap();
    assert_eq!(out, json!({"id":"cursor"}));
    let text = fs::read_to_string(dir.path().join("strategy.yaml")).unwrap();
    assert!(
        text.ends_with("  cursor: { max_tasks: 2, test: false }\nrouting: [ { kinds: [ docs ], executors: [ cursor ] }, { default: [ claude-code, codex ] } ]\n"),
        "{text}"
    );
    let again = runner_add(&c, json!({"agent":"cursor","test":false}))
        .await
        .unwrap_err();
    assert_eq!(again.message, "runner cursor already exists");
    assert_eq!(again.hint.as_deref(), Some(RUNNER_HINT));
    let dup = runner_add(
        &c,
        json!({"agent":"codex","test":false,"kinds":["docs","docs"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(dup.message, "kinds must be a nonempty set");
    assert!(dup.hint.is_none());
}
