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

const MODELS: &str = "planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  acme:
    kind: endpoint
    usage: unmetered
    connection:
      api: openai-compatible
      base_url: https://api.example.com
      key: none
      models:
        - {id: a, context: 64000, output: 32000, tools: true}
        - {id: b, context: 64000, output: 32000, tools: true}
  oc: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
runners:
  claude-code: {}
  codex: {}
  opencode#acme: {model: pacer-acme/a}
  opencode#oc: {model: acme/a}
routing:
  - kinds: [docs]
    executors: [opencode#oc]
  - default: [opencode#acme, codex]
";

fn models_ctx(dir: &tempfile::TempDir) -> Ctx {
    let c = ctx(dir, &[]);
    fs::write(dir.path().join("strategy.yaml"), MODELS).unwrap();
    c
}

fn seed_cache(dir: &tempfile::TempDir, runner: &str, text: &str) {
    let path = pacer_models::cache_file(dir.path(), runner);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn listing(models: &str, fetched_at: f64) -> String {
    format!(
        r#"{{"runner":"opencode#oc","source":"opencode","models":{models},"fetchedAt":{fetched_at}}}"#
    )
}

#[test]
fn runner_set_model_forwards_only_where_typescript_lists_models() {
    let dir = tempfile::tempdir().unwrap();
    let c = models_ctx(&dir);
    let forwards = |params: Value| runner_stays_forwarded(&c, "runner.set", &params);
    // No listing source, connection models, unknown or planner runners: native.
    for params in [
        json!({"id": "codex", "model": "acme/b"}),
        json!({"id": "codex", "enabled": false, "model": "acme/b"}),
        json!({"id": "opencode#acme", "model": "pacer-acme/b"}),
        json!({"id": "acme", "model": "pacer-acme/nope"}),
        json!({"id": "missing", "model": "x"}),
        json!({"id": "claude-code", "model": "x"}),
    ] {
        assert!(!forwards(params.clone()), "{params}");
    }
    // An OpenCode provider without a fresh cache runs `opencode models` in TypeScript.
    let oc = json!({"id": "opencode#oc", "model": "acme/b"});
    assert!(forwards(oc.clone()));
    seed_cache(
        &dir,
        "opencode#oc",
        &listing(r#"[{"id":"acme/a"}]"#, c.now - 600.0),
    );
    assert!(forwards(oc.clone()));
    seed_cache(
        &dir,
        "opencode#oc",
        &listing(r#"[{"id":"acme/a"}]"#, c.now - 599.0),
    );
    assert!(!forwards(oc.clone()));
    // Odd cache entries make TypeScript compare or throw on values natively unrepresented.
    seed_cache(&dir, "opencode#oc", &listing(r#"[null]"#, c.now));
    assert!(forwards(oc.clone()));
    seed_cache(&dir, "codex", &listing(r#"["acme/a"]"#, c.now));
    assert!(forwards(json!({"id": "codex", "model": "acme/b"})));
    // A stale cache for a connection runner lists the declared models natively.
    seed_cache(&dir, "opencode#acme", &listing("[]", c.now - 601.0));
    assert!(!forwards(
        json!({"id": "opencode#acme", "model": "pacer-acme/b"})
    ));
    // A legacy strategy is migrated by TypeScript first; a broken one is reported there.
    fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n",
    )
    .unwrap();
    assert_eq!(load_strategy(dir.path()).unwrap()["legacy"], true);
    assert!(forwards(json!({"id": "codex", "model": "x"})));
    assert!(!forwards(json!({"id": "codex", "enabled": false})));
    fs::write(dir.path().join("strategy.yaml"), "planner: [").unwrap();
    assert!(forwards(json!({"id": "codex", "model": "x"})));
}

#[test]
fn runner_set_with_model_and_invalid_params_stays_native() {
    // Params failing the native runner.set validation keep failing natively
    // with the identical invalid_input error TypeScript produces.
    let long_id = "😀".repeat(65);
    let dir = tempfile::tempdir().unwrap();
    let c = models_ctx(&dir);
    for params in [
        json!({"id": long_id, "model": "", "enabled": null, "max_tasks": 0, "rank": -1}),
        json!({"id": "opencode#oc", "model": ""}),
        json!({"id": "opencode#oc", "model": "acme/b", "max_tasks": 0}),
        json!({"id": "opencode#oc", "model": "acme/b", "rank": 1.5}),
    ] {
        assert!(!runner_set_stays_forwarded(&c, &params), "{params}");
    }
    assert!(runner_set_stays_forwarded(
        &c,
        &json!({"id": "opencode#oc", "model": "acme/b"})
    ));
}

#[test]
fn runner_set_without_model_stays_native() {
    let dir = tempfile::tempdir().unwrap();
    let c = models_ctx(&dir);
    for params in [
        json!({"id": "opencode#oc"}),
        json!({"id": "opencode#oc", "model": null}),
        json!({"id": "opencode#oc", "model": 1}),
        json!({"id": "opencode#oc", "enabled": false}),
        json!({"id": "opencode#oc", "max_tasks": 2}),
    ] {
        assert!(
            !runner_stays_forwarded(&c, "runner.set", &params),
            "{params}"
        );
    }
}

#[tokio::test]
async fn runner_set_checks_models_natively_before_editing() {
    use crate::config_writes::runner_set;
    let dir = tempfile::tempdir().unwrap();
    let c = models_ctx(&dir);
    let path = dir.path().join("strategy.yaml");
    let refused = runner_set(
        &c,
        json!({"id": "opencode#acme", "model": "pacer-acme/nope"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, Code::InvalidInput);
    assert_eq!(refused.message, "pacer-acme/nope is not offered by acme");
    assert_eq!(
        refused.hint.as_deref(),
        Some("Available: pacer-acme/a, pacer-acme/b")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), MODELS);
    // Runner refusals come before the model check.
    let unknown = runner_set(&c, json!({"id": "missing", "model": "x"}))
        .await
        .unwrap_err();
    assert_eq!(unknown.message, "unknown runner");
    let planner = runner_set(&c, json!({"id": "claude-code", "model": "x"}))
        .await
        .unwrap_err();
    assert_eq!(
        (planner.code, planner.message.as_str()),
        (Code::NotAllowed, "cannot edit the planner runner")
    );
    let out = runner_set(&c, json!({"id": "opencode#acme", "model": "pacer-acme/b"}))
        .await
        .unwrap();
    assert_eq!(out, json!({"id": "opencode#acme", "warnings": []}));
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("opencode#acme: {model: pacer-acme/b}")
    );
    // The unchecked-model warning follows the routing warnings.
    seed_cache(
        &dir,
        "opencode#oc",
        &format!(
            r#"{{"runner":"opencode#oc","source":"opencode","models":null,"fetchedAt":{},"note":"seeded"}}"#,
            c.now
        ),
    );
    let out = runner_set(
        &c,
        json!({"id": "opencode#oc", "enabled": false, "model": "acme/zz"}),
    )
    .await
    .unwrap();
    assert_eq!(
        out["warnings"],
        json!([
            "routing rule 'docs' has no enabled executor left",
            "acme/zz could not be checked: seeded"
        ])
    );
    seed_cache(&dir, "opencode#oc", &listing("[]", c.now - 600.0));
    let forwarded = runner_set(&c, json!({"id": "opencode#oc", "model": "acme/a"}))
        .await
        .unwrap_err();
    assert_eq!(forwarded.code, Code::Unavailable);
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
