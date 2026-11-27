#![allow(clippy::unwrap_used)]
//! Per-fact tests over temporary homes. Nothing here reads the real pacer
//! install: `Ctx.home` and `Ctx.pacer_home` are the temp dir, so the service
//! backend's plist/unit probe cannot see the maintainer's launchd label.
use super::*;
use std::collections::HashMap;

struct Fixture {
    entries: Vec<Value>,
    status: Value,
}

impl SetupHost for Fixture {
    fn plugins<'a>(&'a mut self, _ctx: &'a Ctx) -> EntriesFuture<'a> {
        let entries = self.entries.clone();
        Box::pin(async move { Ok(entries) })
    }
    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        let status = self.status.clone();
        Box::pin(async move { Ok(status) })
    }
}

fn fixture() -> Fixture {
    Fixture {
        entries: Vec::new(),
        status: json!({"executors": {"ranked": [], "excluded": []}, "planner": "codex", "providers": [{"id": "codex", "verdict": "OK"}]}),
    }
}

fn ctx(root: &tempfile::TempDir, path: &str) -> Ctx {
    let home = root.path().to_path_buf();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), path.to_owned());
    Ctx::with(home.clone(), home.join(".pacer"), env, 1_700_000_000.0)
}

fn bin(root: &tempfile::TempDir, name: &str) {
    let dir = root.path().join("bin");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
    }
}

#[tokio::test]
async fn a_missing_strategy_sets_the_error_and_null_planner() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut fixture()).await;
    assert!(facts["errors"]["strategy"].is_string());
    assert_eq!(facts["planner"], Value::Null);
    assert_eq!(facts["connected"], json!(false));
}

#[tokio::test]
async fn an_absent_service_plist_reads_as_not_installed_or_running() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut fixture()).await;
    assert_eq!(facts["service"], json!({"installed": false, "running": false}));
}

#[tokio::test]
async fn without_a_snapshot_probe_the_link_is_already_true() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut fixture()).await;
    assert_eq!(facts["link"], json!(true));
    assert!(facts["errors"].get("link").is_none());
}

#[tokio::test]
async fn agents_keep_typescript_order_and_read_cli_presence_from_the_context_path() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    for name in ["claude", "codex", "cursor-agent"] {
        bin(&root, name);
    }
    let path = format!("{}:/usr/bin:/bin", root.path().join("bin").display());
    let facts = setup_facts(&ctx(&root, &path), false, &mut fixture()).await;
    let agents = facts["agents"].as_array().unwrap();
    assert_eq!(
        agents.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(),
        ["claude-code", "codex", "cursor", "opencode"]
    );
    assert_eq!(
        agents.iter().map(|row| row["cliInstalled"].as_bool().unwrap()).collect::<Vec<_>>(),
        [true, true, true, false]
    );
    assert!(agents.iter().all(|row| row["installed"] == json!(false)));
}

#[tokio::test]
async fn an_onboarding_skipped_marker_makes_the_fact_true() {
    let root = tempfile::tempdir().unwrap();
    let pacer_home = root.path().join(".pacer");
    std::fs::create_dir_all(pacer_home.join("onboarding")).unwrap();
    std::fs::write(pacer_home.join("onboarding/skipped"), "").unwrap();
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut fixture()).await;
    assert_eq!(facts["skipped"], json!(true));
}

#[tokio::test]
async fn status_and_policy_entries_are_read_from_the_host() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    std::fs::write(
        root.path().join(".pacer/strategy.yaml"),
        "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {}\nrouting:\n  - default: [codex]\n",
    )
    .unwrap();
    let mut host = fixture();
    host.status = json!({"executors": {"ranked": [{"id": "codex"}], "excluded": []}, "planner": "codex", "providers": [{"id": "codex", "verdict": "OK"}]});
    host.entries = vec![json!({"id": "fx-policy", "state": "ready", "manifest": {"contributes": {"policy": {}}}})];
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut host).await;
    assert_eq!(facts["executors"], json!({"ranked": [{"id": "codex"}], "excluded": []}));
    assert_eq!(facts["verdict"], json!("OK"));
    assert_eq!(facts["policy"], json!({"mode": "open", "plugins": 1}));
}

#[tokio::test]
async fn a_driver_facts_override_is_returned_verbatim() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".pacer")).unwrap();
    struct Override(Value);
    impl SetupHost for Override {
        fn plugins<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
            Box::pin(async { Ok(vec![]) })
        }
        fn cached_status_parts(&mut self) -> OpFuture<'_> {
            Box::pin(async { Ok(Value::Null) })
        }
        fn facts_override(&mut self) -> Option<Value> {
            Some(self.0.clone())
        }
    }
    let expected = json!({"version": "1.0.0", "planner": "codex", "policy": {"mode": "open", "plugins": 0}});
    let facts = setup_facts(&ctx(&root, "/nonexistent"), false, &mut Override(expected.clone())).await;
    assert_eq!(facts, expected);
}

#[test]
fn integration_hashes_follow_the_manifest_and_use_javascript_stringify() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    std::fs::write(
        home.join("install-manifest.json"),
        r#"{"version":1,"planners":{"z":{"planner":"codex","files":[]},"a":{"planner":"claude-code","files":[]}}}"#,
    )
    .unwrap();
    let hashes = integration_hashes(home);
    let map = hashes.as_object().unwrap();
    assert_eq!(map.len(), 2);
    assert!(map.values().all(|value| value.as_str().is_some_and(|s| s.len() == 64)));
}
