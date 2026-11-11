#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn home() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n",
    )
    .unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1.0,
    );
    (dir, ctx)
}

fn message(op: &str, params: Value) -> String {
    parse(op, &params).err().unwrap().message
}

#[test]
fn param_issues_match_zod_text_and_order() {
    assert_eq!(
        message("project.strategy.set", json!({"b": 1})),
        "repo: Invalid input: expected string, received undefined; executors: Invalid input: expected array, received undefined; expect_rev: Invalid input: expected number, received undefined"
    );
    assert_eq!(
        message(
            "project.strategy.set",
            json!({"repo": "", "executors": ["", 1], "expect_rev": -1})
        ),
        "repo: Too small: expected string to have >=1 characters; executors.0: Too small: expected string to have >=1 characters; executors.1: Invalid input: expected string, received number; expect_rev: Too small: expected number to be >=0"
    );
    assert_eq!(
        message("project.strategy.list", json!("x")),
        "params: Invalid input: expected object, received string"
    );
    assert!(parse("project.strategy.list", &Value::Null).is_ok());
}

#[tokio::test]
async fn set_get_list_and_remove_with_revisions() {
    let (dir, ctx) = home();
    let key = "github.com/acme/app";
    let set = json!({"repo": key, "executors": ["cursor", "codex"], "expect_rev": 0});
    let error = project_strategy_set(&ctx, set.clone()).await.unwrap_err();
    assert_eq!(
        error.message,
        "repo must be an absolute path or a registered repo key"
    );
    fs::write(
        dir.path().join(FILE),
        format!(r#"{{"version":1,"projects":{{"{key}":{{"executors":null,"rev":2.0}}}}}}"#),
    )
    .unwrap();
    let conflict = project_strategy_set(&ctx, set.clone()).await.unwrap_err();
    assert_eq!(conflict.code, Code::Conflict);
    assert_eq!(conflict.data.unwrap()["actual"], json!(2));
    let mut set = set;
    set["expect_rev"] = json!(2);
    let saved = project_strategy_set(&ctx, set).await.unwrap();
    assert_eq!(saved["rev"], json!(3));
    assert_eq!(
        saved["executors"],
        json!(["cursor#cursor@local", "codex#codex@local"])
    );
    assert_eq!(saved["repo"], json!({"key": key, "label": key}));
    let labels: Vec<_> = saved["available"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["label"].clone())
        .collect();
    assert_eq!(
        labels,
        [
            json!("Codex · codex · This machine"),
            json!("Cursor · cursor · This machine")
        ]
    );
    assert_eq!(
        fs::read_to_string(dir.path().join(FILE)).unwrap(),
        format!(
            "{{\n  \"version\": 1,\n  \"projects\": {{\n    \"{key}\": {{\n      \"rev\": 3,\n      \"executors\": [\n        \"cursor#cursor@local\",\n        \"codex#codex@local\"\n      ]\n    }}\n  }}\n}}\n"
        )
    );
    let listed = project_strategy_list(&ctx, json!({})).await.unwrap();
    assert_eq!(listed[0]["rev"], json!(3));
    let got = project_strategy_get(&ctx, json!({"repo": key}))
        .await
        .unwrap();
    assert_eq!(got, saved);
    let planner = json!({"repo": key, "executors": ["claude-code"], "expect_rev": 3});
    assert_eq!(
        project_strategy_set(&ctx, planner)
            .await
            .unwrap_err()
            .message,
        "claude-code is the planner"
    );
    let removed = project_strategy_remove(&ctx, json!({"repo": key, "expect_rev": 3}))
        .await
        .unwrap();
    assert_eq!(
        (removed["rev"].clone(), removed["executors"].clone()),
        (json!(4), Value::Null)
    );
    assert_eq!(
        project_strategy_list(&ctx, json!({})).await.unwrap(),
        json!([])
    );
}

#[test]
fn forwards_only_runtime_text() {
    let (dir, ctx) = home();
    let get = "project.strategy.get";
    let forwarded = |op: &str, params: Value| project_strategy_stays_forwarded(&ctx, op, &params);
    assert!(!forwarded(get, json!({"repo": "github.com/a/b"})));
    assert!(!forwarded("repo.list", json!({"repo": "/x"})));
    assert!(!forwarded(get, json!({"repo": "/tmp/checkout"})));
    // Unreadable and invalid policy files fail closed with fixed texts.
    fs::write(dir.path().join(FILE), "{").unwrap();
    assert!(!forwarded(get, json!({"repo": "github.com/a/b"})));
    fs::remove_file(dir.path().join(FILE)).unwrap();
    fs::create_dir(dir.path().join(FILE)).unwrap();
    assert!(!forwarded(get, json!({"repo": "github.com/a/b"})));
    fs::remove_dir(dir.path().join(FILE)).unwrap();
    let fifo = std::process::Command::new("mkfifo")
        .arg(dir.path().join(FILE))
        .status()
        .unwrap();
    assert!(fifo.success());
    assert!(forwarded(get, json!({"repo": "github.com/a/b"})));
    fs::remove_file(dir.path().join(FILE)).unwrap();
    // A missing or schema-invalid strategy is native; YAML syntax errors keep Bun's text.
    fs::write(dir.path().join("strategy.yaml"), "planner: nobody\n").unwrap();
    assert!(!forwarded("project.strategy.list", json!({})));
    fs::remove_file(dir.path().join("strategy.yaml")).unwrap();
    assert!(!forwarded("project.strategy.list", json!({})));
    fs::write(dir.path().join("strategy.yaml"), "planner: [\n").unwrap();
    assert!(forwarded("project.strategy.list", json!({})));
}

#[tokio::test]
async fn unloadable_strategies_are_internal_errors() {
    let (dir, ctx) = home();
    fs::remove_file(dir.path().join("strategy.yaml")).unwrap();
    let error = project_strategy_list(&ctx, json!({})).await.unwrap_err();
    assert_eq!(error.code, Code::Internal);
    assert_eq!(
        error.message,
        format!(
            "no strategy found at {}",
            dir.path().join("strategy.yaml").display()
        )
    );
    assert_eq!(error.hint, None);
    fs::write(dir.path().join("strategy.yaml"), "[]\n").unwrap();
    let error = project_strategy_get(&ctx, json!({"repo": "github.com/a/b"}))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "repo must be an absolute path or a registered repo key"
    );
    fs::write(
        dir.path().join(FILE),
        r#"{"version":1,"projects":{"github.com/a/b":{"rev":1,"executors":null}}}"#,
    )
    .unwrap();
    let error = project_strategy_get(&ctx, json!({"repo": "github.com/a/b"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::Internal);
    assert!(
        error
            .message
            .ends_with(":\n  - top level must be a mapping")
    );
}
