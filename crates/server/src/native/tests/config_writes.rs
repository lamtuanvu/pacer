#![allow(clippy::unwrap_used)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};

#[tokio::test]
async fn failed_endpoint_sync_keeps_saved_edit_but_does_not_publish_success() {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        fixture["initial"].as_str().unwrap(),
    )
    .unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let op = registry.get("runner.remove").unwrap();
    let error = crate::native::call_native(
        &ctx,
        op,
        json!({"id":"cursor"}),
        None,
        Some(Box::pin(async {
            Err(CoreError::new(Code::PluginRefused, "fixture refused"))
        })),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::PluginRefused);
    assert_eq!(
        error.hint.as_deref(),
        Some("Check the runner id, account and host configuration.")
    );
    assert!(!dir.path().join("link/outbox.jsonl").exists());
    let strategy = pacer_config::strategy::load_strategy(dir.path()).unwrap();
    assert!(strategy["runners"].get("cursor").is_none());
}

#[tokio::test]
async fn host_account_add_missing_endpoint_bridge_refuses_before_write() {
    let dir = tempfile::tempdir().unwrap();
    write_fixture_strategy(&dir);
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        0.0,
    );
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("host.account.add").unwrap(),
        json!({"alias":"devbox","account":"team","home":"~/.codex-team"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    let text = std::fs::read_to_string(dir.path().join("strategy.yaml")).unwrap();
    assert!(!text.contains("~/.codex-team"));
}

fn write_fixture_strategy(dir: &tempfile::TempDir) {
    std::fs::write(
        dir.path().join("strategy.yaml"),
        "planner: codex\nproviders: {codex: {}}\naccounts: {team: {kind: codex}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n",
    )
    .unwrap();
}

#[tokio::test]
async fn host_add_missing_endpoint_bridge_refuses_before_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        0.0,
    );
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("host.add").unwrap(),
        json!({"alias":"box","ssh":"box-ssh"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(!dir.path().join("strategy.yaml").exists());
}

#[tokio::test]
async fn missing_bridge_refuses_before_mutating_the_document() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        0.0,
    );
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("runner.set").unwrap(),
        json!({"id":"codex","rank":1}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert!(!dir.path().join("strategy.yaml").exists());
}

#[test]
fn empty_xdg_config_home_uses_relative_orca_directory_on_linux() {
    let ctx = Ctx::with(
        "/fixture".into(),
        "/fixture".into(),
        [("XDG_CONFIG_HOME".into(), "".into())].into(),
        0.0,
    );
    assert_eq!(
        crate::native::config_writes::legacy_dir_for_platform(&ctx, false),
        std::path::PathBuf::from("orca/plugins-data/lamtuanvu.pacer")
    );
}

#[tokio::test]
async fn strategy_list_and_show_read_named_files_without_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let yaml = "# A work plan\nplanner: codex\nproviders:\n  codex: {}\n";
    std::fs::write(home.join("strategy.yaml"), yaml).unwrap();
    std::fs::create_dir(home.join("strategies")).unwrap();
    std::fs::write(home.join("strategies/work.yaml"), yaml).unwrap();
    std::fs::write(home.join("strategies/broken.yaml"), "planner: [oops\n").unwrap();
    let ctx = Ctx::with(home.into(), home.into(), Default::default(), 0.0);
    let registry = crate::native::registry("");
    let list = crate::native::call_native(
        &ctx,
        registry.get("strategy.list").unwrap(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(list[0]["name"], "default");
    assert_eq!(list[0]["active"], true);
    assert_eq!(
        list[1],
        json!({"name":"broken","active":false,"summary":"Invalid or missing strategy","description":""})
    );
    assert_eq!(list[2]["name"], "work");
    assert_eq!(list[2]["description"], "A work plan");
    assert_eq!(list[2]["active"], false);
    let show = crate::native::call_native(
        &ctx,
        registry.get("strategy.show").unwrap(),
        json!({"name":"work"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(show["yaml"], yaml);
    assert_eq!(show["active"], false);
    assert!(show["summary"].as_str().unwrap().contains("Codex"));
    let missing = crate::native::call_native(
        &ctx,
        registry.get("strategy.show").unwrap(),
        json!({"name":"missing"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, Code::InvalidInput);
    assert_eq!(missing.message, "unknown strategy \"missing\"");
    assert_eq!(
        missing.hint.as_deref(),
        Some("Use strategy.list to choose a strategy and strategy.preview to validate a draft.")
    );
    assert!(!home.join("link/outbox.jsonl").exists());
}

#[tokio::test]
async fn pure_config_set_writes_publishes_and_strips_notes() {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        fixture["initial"].as_str().unwrap(),
    )
    .unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let result = crate::native::call_native(
        &ctx,
        registry.get("config.set").unwrap(),
        json!({"key":"update_check","value":false}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["key"], "update_check");
    assert_eq!(result["value"], false);
    assert!(result.get("notes").is_none());
    assert!(dir.path().join("link/outbox.jsonl").exists());
}

fn goldens_ctx(env: &[(&str, &str)]) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        fixture["initial"].as_str().unwrap(),
    )
    .unwrap();
    let env = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ctx = Ctx::with(dir.path().into(), dir.path().into(), env, 1_700_000_000.0);
    (dir, ctx)
}

#[allow(clippy::result_large_err)]
async fn config_set(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    let registry = crate::native::registry("");
    crate::native::call_native(
        ctx,
        registry.get("config.set").unwrap(),
        params,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
}

fn config_events(ctx: &Ctx) -> usize {
    std::fs::read_to_string(ctx.pacer_home.join("link/outbox.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|line| line.contains(r#""type":"config""#))
        .count()
}

#[test]
fn only_changed_planner_installs_and_orca_without_env_stay_forwarded() {
    let forwarded = crate::native::config_set_stays_forwarded;
    let (_dir, plain) = goldens_ctx(&[]);
    assert!(forwarded(
        &plain,
        &json!({"key":"planner","value":"codex","integrations":"install"})
    ));
    assert!(forwarded(
        &plain,
        &json!({"key":"execution.backend","value":"orca"})
    ));
    for native in [
        json!({"key":"planner","value":"claude-code","integrations":"install"}),
        json!({"key":"planner","value":"codex","integrations":"skip"}),
        json!({"key":"planner","value":"codex"}),
        json!({"key":"planner","value":"Not A Runner","integrations":"install"}),
        json!({"key":"planner","value":"codex#missing","integrations":"install"}),
        json!({"key":"execution.backend","value":"direct"}),
        json!({"key":"execution.backend","value":"elsewhere"}),
        json!({"key":"update_check","value":false}),
    ] {
        assert!(!forwarded(&plain, &native), "{native}");
    }
    let (_dir, env) = goldens_ctx(&[("PACER_BACKEND", "direct")]);
    assert!(!forwarded(
        &env,
        &json!({"key":"execution.backend","value":"orca"})
    ));
    let (_dir, executor) = goldens_ctx(&[("PACER_ROLE", "executor")]);
    assert!(!forwarded(
        &executor,
        &json!({"key":"planner","value":"codex","integrations":"install"})
    ));
}

#[tokio::test]
async fn planner_skip_and_unchanged_install_run_natively() {
    let (dir, ctx) = goldens_ctx(&[]);
    let path = dir.path().join("strategy.yaml");
    let before = std::fs::read_to_string(&path).unwrap();
    let unchanged = config_set(
        &ctx,
        json!({"key":"planner","value":"claude-code","integrations":"install"}),
    )
    .await
    .unwrap();
    assert_eq!(
        unchanged,
        json!({"key":"planner","value":"claude-code","previous":"claude-code","diff":"","undo":"pacer config set planner claude-code"})
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    assert_eq!(config_events(&ctx), 1);
    let skipped = config_set(
        &ctx,
        json!({"key":"planner","value":"codex","integrations":"skip"}),
    )
    .await
    .unwrap();
    assert_eq!(skipped["value"], "codex");
    assert_eq!(skipped["undo"], "pacer config set planner claude-code");
    assert!(skipped.get("notes").is_none());
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("planner: codex\n")
    );
    assert_eq!(config_events(&ctx), 2);
}

#[tokio::test]
async fn planner_and_backend_refusals_run_natively_without_writes() {
    let (dir, ctx) = goldens_ctx(&[]);
    let (_executor_dir, executor) = goldens_ctx(&[("PACER_ROLE", "executor")]);
    let before = std::fs::read_to_string(dir.path().join("strategy.yaml")).unwrap();
    let cases = [
        (
            &ctx,
            json!({"key":"planner","value":"codex"}),
            Code::InvalidInput,
            "planner requires an integration choice",
            Some("integrations: \"install\" or \"skip\""),
        ),
        (
            &executor,
            json!({"key":"planner","value":"codex","integrations":"skip"}),
            Code::NotAllowed,
            "PACER_ROLE=executor: changing the planner with config.set connects real agent folders; run it outside a delegated task.",
            None,
        ),
        (
            &ctx,
            json!({"key":"planner","value":"Not A Runner","integrations":"install"}),
            Code::InvalidInput,
            "planner requires a runner id",
            None,
        ),
        (
            &ctx,
            json!({"key":"execution.backend","value":"elsewhere"}),
            Code::InvalidInput,
            "execution.backend must be orca or direct",
            None,
        ),
    ];
    for (ctx, params, code, message, hint) in cases {
        let error = config_set(ctx, params.clone()).await.unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str(), error.hint.as_deref()),
            (code, message, hint),
            "{params}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("strategy.yaml")).unwrap(),
        before
    );
    assert_eq!(config_events(&ctx) + config_events(&executor), 0);
}

#[tokio::test]
async fn backend_direct_and_env_override_run_natively_with_hint() {
    let (_dir, ctx) = goldens_ctx(&[]);
    let direct = config_set(&ctx, json!({"key":"execution.backend","value":"direct"}))
        .await
        .unwrap();
    assert_eq!(direct["value"], "direct");
    assert!(direct.get("hint").is_none());
    let (_dir, env) = goldens_ctx(&[("PACER_BACKEND", "direct")]);
    let orca = config_set(&env, json!({"key":"execution.backend","value":"orca"}))
        .await
        .unwrap();
    assert_eq!(orca["value"], "orca");
    assert_eq!(
        orca["hint"],
        "PACER_BACKEND overrides the saved task backend setting."
    );
    assert!(orca.get("notes").is_none());
    assert_eq!(config_events(&env), 1);
}

#[cfg(unix)]
#[test]
#[allow(clippy::result_large_err)]
fn concurrent_edits_of_one_setting_conflict_and_release_the_key() {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let (dir, ctx) = goldens_ctx(&[]);
    let path = dir.path().join("strategy.yaml");
    let yaml = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let run = |ctx: Ctx, value: &'static str| {
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(config_set(
                    &ctx,
                    json!({"key":"pacing.policy","value":value}),
                ))
        })
    };
    // The first edit claims its key, then blocks reading the FIFO; its invalid value fails after that one read.
    let first = run(ctx.clone(), "not-a-policy");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut writer = loop {
        let opened = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(&path);
        match opened {
            Ok(writer) => break writer,
            Err(_) if std::time::Instant::now() < deadline && !first.is_finished() => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => panic!("first edit never read the strategy: {error}"),
        }
    };
    let second = run(ctx.clone(), "even").join().unwrap().unwrap_err();
    assert_eq!(second.code, Code::Conflict);
    assert_eq!(second.message, "This setting is already being changed");
    assert_eq!(second.hint.as_deref(), Some("Refresh and retry."));
    writer.write_all(yaml.as_bytes()).unwrap();
    drop(writer);
    let first = first.join().unwrap().unwrap_err();
    assert_eq!(first.code, Code::InvalidInput);
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, &yaml).unwrap();
    for value in ["even", "priority"] {
        let done = run(ctx.clone(), value).join().unwrap().unwrap();
        assert_eq!(done["value"], value);
    }
    assert_eq!(config_events(&ctx), 2);
}

#[tokio::test]
async fn runner_settings_get_and_save_publish_runners_without_endpoint_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let yaml = "# keep\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n";
    std::fs::write(dir.path().join("strategy.yaml"), yaml).unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1_700_000_000.0,
    );
    let registry = crate::native::registry("");
    let base = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.get").unwrap(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(!dir.path().join("link/outbox.jsonl").exists());
    assert_eq!(base["order"], json!(["codex"]));

    let saved = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.save").unwrap(),
        json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": [{"id": "codex", "enabled": false, "maxTasks": 3}],
        }),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_ne!(saved["revision"], base["revision"]);
    assert_eq!(saved["runners"][0]["enabled"], false);
    assert_eq!(saved["runners"][0]["maxTasks"], 3);
    assert_eq!(saved["warnings"].as_array().unwrap().len(), 2);
    assert!(dir.path().join("link/outbox.jsonl").exists());
    let outbox = std::fs::read_to_string(dir.path().join("link/outbox.jsonl")).unwrap();
    assert!(outbox.contains("\"area\":\"runners\""));

    let conflict = crate::native::call_native(
        &ctx,
        registry.get("runner.settings.save").unwrap(),
        json!({
            "expectedRevision": base["revision"],
            "order": base["order"],
            "runners": [{"id": "codex", "enabled": true, "maxTasks": 1}],
        }),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.code, Code::Conflict);
    assert_eq!(conflict.message, "Executor settings changed elsewhere.");
    assert_eq!(
        conflict.hint.as_deref(),
        Some("Reload saved settings, then reapply your changes.")
    );
}

#[tokio::test]
async fn cookie_presets_flag_rejects_custom_terminal_open_templates() {
    let dir = tempfile::tempdir().unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        fixture["initial"].as_str().unwrap(),
    )
    .unwrap();
    let mut env = std::collections::HashMap::new();
    env.insert("PACER_TERMINAL_PRESETS_ONLY".into(), "1".into());
    let ctx = Ctx::with(dir.path().into(), dir.path().into(), env, 0.0);
    let registry = crate::native::registry("");
    let error = crate::native::call_native(
        &ctx,
        registry.get("config.set").unwrap(),
        json!({"key":"terminal.open","value":"custom-{cmd}"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert!(error.message.contains("preset"));
}
