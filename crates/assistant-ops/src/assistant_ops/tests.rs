#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::assistant_ops::admission::{self, AssistantHost};

/// The door seam in unit tests: the plugin snapshot and the cached usage parts the core would supply.
struct Fake {
    entries: Vec<Value>,
    parts: Value,
}

impl AssistantHost for Fake {
    fn plugins<'a>(&'a mut self, _: &'a Ctx) -> pacer_plugin_ops::extension::EntriesFuture<'a> {
        let entries = self.entries.clone();
        Box::pin(async move {
            entries
                .into_iter()
                .map(|value| Ok(serde_json::from_value(value).expect("entry")))
                .collect()
        })
    }
    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        let parts = self.parts.clone();
        Box::pin(async move { Ok(parts) })
    }
}

fn plugin(id: &str, contribution: Value) -> Value {
    json!({
        "id": id, "manifest": {"contributes": contribution}, "bundled": false, "grant": {},
        "state": "ready", "error": null, "pid": null, "served": [], "protocol": null, "restarts": 0,
    })
}

fn reply(backend: &str) -> Value {
    plugin("assistant-reply", json!({"assistant": {"backend": backend, "reply": true}}))
}

fn entry(value: Value) -> pacer_plugin_ops::public::Entry {
    serde_json::from_value(value).expect("entry")
}

const ADMISSION_STRATEGY: &str = STRATEGY;

fn admission_ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    let c = ctx(dir, env);
    std::fs::write(c.pacer_home.join("strategy.yaml"), ADMISSION_STRATEGY).unwrap();
    c
}

fn save_for_admission(c: &Ctx, account: &str, backend: &str, turns: i64) {
    let limits = format!("{{\"turnsPerDay\":{turns}}}");
    with_db(c, |db| {
        db.execute(
            "INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,NULL,?,?,?,'{\"conversations\":200,\"days\":30}',1) ON CONFLICT(id) DO UPDATE SET account=excluded.account,backend=excluded.backend,limits=excluded.limits",
            [account, backend, &limits],
        )?;
        Ok(())
    })
    .unwrap();
}

fn clear_parts() -> Value {
    json!({"accounts":[{"name":"ep","verdict":"UNKNOWN","usedPct":null}],"mode":"normal"})
}

async fn admitted(c: &Ctx, mut fake: Fake) -> Admission {
    admission::admit(c, &mut fake).await.unwrap()
}

const STRATEGY: &str = "accounts:\n  claude: {kind: claude, source: default}\n  cl: {kind: claude, home: \"~/cl\"}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: \"http://127.0.0.1:1/v1\", key: none, models: [{id: m1, name: Model One, context: 1000, output: 100, tools: true}, {id: m2, context: 1000, output: 100, tools: false}]}}\n  bare: {kind: endpoint, usage: unmetered}\nplanner: claude-code#claude\nrunners: {\"opencode#ep\": {model: pacer-ep/m2}}\nrouting: [{default: [opencode#ep]}]\n";

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    Ctx::with(
        dir.path().into(),
        dir.path().into(),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        1_700_000_000.0,
    )
}

fn message(op: &str, params: Value) -> String {
    match parse(op, params) {
        Err(error) => error.message,
        Ok(_) => "ok".into(),
    }
}

#[test]
fn param_issues_match_zod_text_and_order() {
    let set = "assistant.settings.set";
    assert_eq!(
        message(set, json!({})),
        "runner: Invalid input: expected string, received undefined; account: Invalid input: expected string, received undefined; expect_rev: Invalid input: expected number, received undefined"
    );
    assert_eq!(
        message(
            set,
            json!({"runner":1,"account":true,"expect_rev":1.5,"limits":[],"retention":null})
        ),
        "runner: Invalid input: expected string, received number; account: Invalid input: expected string, received boolean; limits: Invalid input: expected object, received array; retention: Invalid input: expected object, received null; expect_rev: Invalid input: expected int, received number"
    );
    assert_eq!(
        message(
            set,
            json!({"runner":null,"account":null,"expect_rev":-1e300,"limits":{"maxInputTokens":1e300,"maxToolRounds":-1e300}})
        ),
        "limits.maxInputTokens: Too big: expected int to be <=9007199254740991; limits.maxInputTokens: Too big: expected number to be <=200000; limits.maxToolRounds: Too small: expected int to be >=-9007199254740991; limits.maxToolRounds: Too small: expected number to be >=0; expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >0"
    );
    assert_eq!(
        message(
            set,
            json!({"runner":"","account":"a".repeat(65),"expect_rev":0})
        ),
        "runner: Too small: expected string to have >=1 characters; account: Too big: expected string to have <=64 characters; expect_rev: Too small: expected number to be >0"
    );
    let Params::Settings(p) = parse(set, json!({"runner":null,"account":null,"expect_rev":1,"limits":{"maxInputTokens":5000,"x":1},"extra":1})).unwrap() else {
        panic!("settings")
    };
    assert_eq!(p.limits, Some(vec![5000, 8000, 6, 50, 120_000]));
    assert_eq!(p.retention, None);
    assert_eq!(
        message("assistant.settings.get", json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(message("assistant.settings.get", Value::Null), "ok");
    assert_eq!(
        message("assistant.conversations", json!({"before":"x","limit":0})),
        "before: Invalid input: expected number, received string; limit: Too small: expected number to be >=1"
    );
    assert_eq!(
        message("assistant.conversations", json!({"before":1e300})),
        "ok"
    );
    assert_eq!(
        message("assistant.turn", json!({"turnId":"\u{1F600}".repeat(129)})),
        "turnId: Too big: expected string to have <=128 characters"
    );
    assert_eq!(
        message("assistant.turn", json!({"turnId":"\u{1F600}".repeat(128)})),
        "ok"
    );
    assert_eq!(
        message("assistant.delete", json!({"id":null})),
        "id: Invalid input: expected string, received null"
    );
    assert_eq!(
        message("assistant.card.record", json!({})),
        "turnId: Invalid input: expected string, received undefined; cardId: Invalid input: expected string, received undefined; state: Invalid option: expected one of \"done\"|\"failed\"|\"dismissed\"|\"stale\""
    );
    assert_eq!(
        message(
            "assistant.card.record",
            json!({"turnId":"t","cardId":"c","state":"done","result":""})
        ),
        "ok"
    );
    // `backend: z.enum(["pacer","executor"]).optional()`: absent is fine, anything else is one issue, last.
    assert_eq!(
        message(
            set,
            json!({"runner":null,"account":null,"expect_rev":1,"backend":"executor"})
        ),
        "ok"
    );
    for backend in [json!("x"), json!(5), json!(null)] {
        assert_eq!(
            message(
                set,
                json!({"runner":null,"account":null,"expect_rev":1,"backend":backend})
            ),
            "backend: Invalid option: expected one of \"pacer\"|\"executor\""
        );
    }
}

#[test]
fn strategy_endpoints_and_candidates_follow_endpoint_for() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    let c = ctx(&dir, &[]);
    let strategy = strategy(&c).unwrap();
    assert!(endpoint_ok(&c, &strategy, "ep", None, false));
    assert!(endpoint_ok(&c, &strategy, "ep", Some("opencode#ep"), false));
    assert!(!endpoint_ok(&c, &strategy, "bare", None, false));
    assert!(!endpoint_ok(&c, &strategy, "claude", None, false));
    assert!(!endpoint_ok(&c, &strategy, "missing", None, false));
    // The executor backend needs an ask-mode adapter: opencode, Claude Code or Codex.
    assert_eq!(
        ask_adapter(&c, &strategy["accounts"]["ep"]),
        Some("opencode")
    );
    assert_eq!(
        ask_adapter(&c, &strategy["accounts"]["bare"]),
        Some("opencode")
    );
    assert_eq!(
        ask_adapter(&c, &strategy["accounts"]["claude"]),
        Some("claude-code")
    );
    assert_eq!(ask_adapter(&c, &strategy["accounts"]["missing"]), None);
    assert!(endpoint_ok(&c, &strategy, "ep", None, true));
    assert!(endpoint_ok(&c, &strategy, "bare", None, true));
    assert!(endpoint_ok(&c, &strategy, "claude", None, true));
    assert!(!endpoint_ok(&c, &strategy, "missing", None, true));
    assert_eq!(
        Value::Array(admission::candidate_rows(&c, &strategy, &[])).to_string(),
        r#"[{"account":"ep","backend":"pacer","available":false,"liveTools":false,"reason":"Pacer's assistant needs an update or repair: its native binary is missing or outdated.","models":[{"id":"m1","name":"Model One"},{"id":"m2","name":"m2"}],"runners":[{"id":"opencode#ep","model":"pacer-ep/m2"}],"isPlanner":false}]"#
    );
    assert!(
        array_index("0") && array_index("42") && !array_index("01") && !array_index("4294967295")
    );
}

#[test]
fn local_midnight_matches_set_hours() {
    let zone: chrono_tz::Tz = "Asia/Ho_Chi_Minh".parse().unwrap();
    // 2023-11-14T22:13:20Z is 05:13:20 on the 15th in UTC+7.
    assert_eq!(local_midnight(1_700_000_000.0, zone), Some(1_699_981_200.0));
    // America/Santiago skipped 2022-09-11 00:00 to 01:00; JavaScript lands on 01:00 (04:00Z).
    let santiago: chrono_tz::Tz = "America/Santiago".parse().unwrap();
    assert_eq!(
        local_midnight(1_662_908_400.0, santiago),
        Some(1_662_868_800.0)
    );
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        local_zone(&ctx(&dir, &[("TZ", "UTC")])),
        Some(chrono_tz::UTC)
    );
    assert_eq!(local_zone(&ctx(&dir, &[("TZ", "UTC+7")])), None);
}

#[tokio::test]
async fn callers_settings_and_status_route_like_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let plain = ctx(&dir, &[("TZ", "UTC")]);
    let executor = ctx(&dir, &[("PACER_ROLE", "executor")]);
    let error = assistant_settings_get(&executor, json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (Code::NotAllowed, EXECUTOR)
    );
    assert!(!assistant_stays_forwarded(
        &executor,
        "assistant.settings.get",
        &json!({})
    ));
    assert!(assistant_stays_forwarded(
        &ctx(&dir, &[("PACER_WORK_GRANT", "pwg")]),
        "assistant.turn",
        &json!({})
    ));
    assert!(!assistant_stays_forwarded(
        &plain,
        "assistant.ask",
        &json!({})
    ));
    let status = assistant_status(&plain, json!({})).await.unwrap();
    assert_eq!(
        status.to_string(),
        r#"{"available":false,"configured":false,"liveTools":false,"reason":"The assistant is not set up.","hint":"Choose an account in Settings › Assistant.","limits":{"maxInputTokens":32000,"maxOutputTokens":8000,"maxToolRounds":6,"turnsPerDay":50,"deadlineMs":120000},"retention":{"days":30,"conversations":200},"rev":1,"today":{"turns":0,"input":0,"output":0}}"#
    );
    // A configured, admissible assistant needs the cached usage status.
    std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    let saved =
        assistant_settings_set(&plain, json!({"runner":null,"account":"ep","expect_rev":1}))
            .await
            .unwrap();
    assert_eq!(saved["rev"], 2);
    // Status is native now: admission is answered here over the host seam.
    assert!(!assistant_stays_forwarded(
        &plain,
        "assistant.status",
        &json!({})
    ));
    let conflict =
        assistant_settings_set(&plain, json!({"runner":null,"account":null,"expect_rev":1}))
            .await
            .unwrap_err();
    assert_eq!(
        (conflict.code, conflict.data.unwrap()["rev"].clone()),
        (Code::Conflict, json!(2))
    );
    let refused = assistant_settings_set(
        &plain,
        json!({"runner":null,"account":"bare","expect_rev":2}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused.hint.as_deref(),
        Some("Add one in Settings › Accounts.")
    );
    // Unusable stored settings are an internal error here, with the schema detail.
    with_db(&plain, |db| {
        db.execute("UPDATE assistant_settings SET retention='{\"days\":0}'", [])?;
        Ok(())
    })
    .unwrap();
    for op in ["assistant.settings.get", "assistant.conversations"] {
        assert!(!assistant_stays_forwarded(&plain, op, &json!({})), "{op}");
    }
    assert!(!assistant_stays_forwarded(
        &plain,
        "assistant.status",
        &json!({})
    ));
    let error = assistant_settings_get(&plain, json!({})).await.unwrap_err();
    assert_eq!(
        (error.code, error.message),
        (
            Code::Internal,
            "assistant settings are unreadable: retention.days is outside 1..=365".into()
        )
    );
    // Param issues are reported natively, as TypeScript reports them before reading settings.
    assert!(!assistant_stays_forwarded(
        &plain,
        "assistant.settings.set",
        &json!({})
    ));
    assert!(!assistant_stays_forwarded(
        &plain,
        "assistant.delete",
        &json!({})
    ));
}

fn saved_at_rev4(c: &Ctx, account: &str) {
    std::fs::write(c.pacer_home.join("strategy.yaml"), STRATEGY).unwrap();
    with_db(c, |db| {
        db.execute(
            "INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,'opencode#ep',?,'pacer','{\"turnsPerDay\":3}','{\"conversations\":200,\"days\":30}',4) ON CONFLICT(id) DO UPDATE SET runner=excluded.runner,account=excluded.account,backend=excluded.backend,limits=excluded.limits,retention=excluded.retention,rev=excluded.rev",
            [account],
        )?;
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn executor_backend_saves_every_ask_adapter_account() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("cl")).unwrap();
    let c = ctx(&dir, &[]);
    for account in ["cl", "claude", "bare", "ep"] {
        saved_at_rev4(&c, "ep");
        let saved = assistant_settings_set(
            &c,
            json!({"runner":null,"account":account,"expect_rev":4,"backend":"executor"}),
        )
        .await
        .unwrap();
        assert_eq!(
            (saved["account"].clone(), saved["rev"].clone()),
            (json!(account), json!(5)),
            "{account}"
        );
        assert_eq!(saved["backend"], json!("executor"));
    }
    saved_at_rev4(&c, "ep");
    let error = assistant_settings_set(
        &c,
        json!({"runner":null,"account":"nope","expect_rev":4,"backend":"executor"}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message, error.hint),
        (
            Code::InvalidInput,
            "Choose an opencode, Claude Code or Codex account.".into(),
            Some("Add one in Settings › Accounts.".into())
        )
    );
}

#[tokio::test]
async fn unusable_settings_and_untitled_cards_are_internal() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    with_db(&c, |db| {
        db.execute(
            "INSERT INTO assistant_settings(id,runner,account,backend,limits,retention,rev) VALUES(1,NULL,'ep','pacer','{\"turnsPerDay\":0}','{\"conversations\":200,\"days\":30}',4) ON CONFLICT(id) DO UPDATE SET limits=excluded.limits,rev=excluded.rev",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let error = assistant_settings_get(&c, json!({})).await.unwrap_err();
    assert_eq!(
        (error.code, error.message),
        (
            Code::Internal,
            "assistant settings are unreadable: limits.turnsPerDay is outside 1..=1000".into()
        )
    );
    assert!(!assistant_stays_forwarded(
        &c,
        "assistant.settings.get",
        &json!({})
    ));

    let dir2 = tempfile::tempdir().unwrap();
    let c2 = ctx(&dir2, &[]);
    with_db(&c2, |db| {
        db.execute_batch(
            "INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES('c-a','Alpha',1,1);
             INSERT INTO assistant_turns(id,conversation_id,seq,at,question,answer,state,error,account,scope,cards,citations) VALUES('turn-1','c-a',1,1,'q',NULL,'done',NULL,'ep','{}','[{\"id\":\"card-1\",\"op\":\"x\",\"params\":{\"id\":\"t-20231114-010203-abcd\"},\"state\":\"stale\"}]','[]');
             INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES('t-20231114-010203-abcd',3,'done',1,1,'{\"id\":\"t-20231114-010203-abcd\",\"rev\":3,\"state\":\"done\"}',0);",
        )?;
        Ok(())
    })
    .unwrap();
    let error = assistant_card_refresh(&c2, json!({"turnId":"turn-1","cardId":"card-1"}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message),
        (
            Code::Internal,
            "task t-20231114-010203-abcd has no title or goal".into()
        )
    );
}

// ---- B4-2: native admission in TypeScript's branch order ---------------------------------------

#[tokio::test]
async fn admission_refuses_in_typescript_order() {
    let dir = tempfile::tempdir().unwrap();

    // 1. No account.
    let c = admission_ctx(&dir, &[]);
    let got = admitted(&c, Fake { entries: vec![], parts: clear_parts() }).await;
    assert_eq!(got, Admission {
        ok: false,
        reason: Some("The assistant is not set up.".into()),
        hint: Some("Choose an account in Settings › Assistant.".into()),
    });

    // 2. Executor backend without a reply plugin.
    save_for_admission(&c, "ep", "executor", 50);
    let got = admitted(&c, Fake { entries: vec![], parts: clear_parts() }).await;
    assert_eq!(got.reason.as_deref(), Some("No plugin answers the assistant's executor backend."));
    assert_eq!(got.hint.as_deref(), Some("Choose pacer's agent in Settings › Assistant."));

    // 3. Account no longer in the strategy (pacer reply is present, so this branch is next).
    save_for_admission(&c, "gone", "pacer", 50);
    let got = admitted(&c, Fake { entries: vec![reply("pacer")], parts: clear_parts() }).await;
    assert_eq!(got.reason.as_deref(), Some("The account chosen for the assistant is no longer available."));
    assert_eq!(got.hint.as_deref(), Some("Choose another account in Settings › Assistant."));

    // 4. Native plugin host cannot carry the ask-mode config binding.
    save_for_admission(&c, "ep", "executor", 50);
    let host = ctx(&dir, &[("PACER_HOST_SOCKET", "/tmp/pacer-test.sock")]);
    let got = admitted(&host, Fake { entries: vec![reply("executor")], parts: clear_parts() }).await;
    assert_eq!(got.reason.as_deref(), Some("The executor backend is not available with the native plugin host yet."));

    // 5. No recorded ask-mode check.
    let got = admitted(&c, Fake { entries: vec![reply("executor")], parts: clear_parts() }).await;
    assert_eq!(got.reason.as_deref(), Some("ep has not passed the ask-mode check yet."));
    assert_eq!(got.hint.as_deref(), Some("Run the ask-mode check in Settings › Assistant."));

    // 6. Daily turn limit.
    save_for_admission(&c, "ep", "pacer", 1);
    with_db(&c, |db| {
        db.execute(
            "INSERT INTO assistant_usage(turn_id,conversation_id,at,account) VALUES('turn-limit','c',?,'ep')",
            [c.now],
        )?;
        Ok(())
    })
    .unwrap();
    let got = admitted(&c, Fake { entries: vec![reply("pacer")], parts: clear_parts() }).await;
    assert_eq!(got.reason.as_deref(), Some("The assistant reached its limit of 1 turns today."));
    assert_eq!(got.hint.as_deref(), Some("The limit resets at midnight, or raise it in Settings."));

    // 7. Exhausted account.
    save_for_admission(&c, "ep", "pacer", 50);
    let parts = json!({"accounts":[{"name":"ep","verdict":"EXHAUSTED","usedPct":100}],"mode":"normal"});
    let got = admitted(&c, Fake { entries: vec![reply("pacer")], parts }).await;
    assert_eq!(got.reason.as_deref(), Some("ep has no capacity left."));

    // 8. Within the planner's reserve.
    let mut reserve = ADMISSION_STRATEGY.to_owned();
    reserve.push_str("dispatch:\n  reservePct: 10\n");
    std::fs::write(c.pacer_home.join("strategy.yaml"), &reserve).unwrap();
    assert!(strategy(&c).is_some(), "reserve strategy did not load");
    let parts = json!({"accounts":[{"name":"ep","verdict":"AHEAD","usedPct":95}],"mode":"normal"});
    let got = admitted(&c, Fake { entries: vec![reply("pacer")], parts }).await;
    assert_eq!(got.reason.as_deref(), Some("ep is within its 10% reserve."));

    // 9. Strict planner on the same account.
    let strict = ADMISSION_STRATEGY.replace("planner: claude-code#claude", "planner: opencode#ep");
    std::fs::write(c.pacer_home.join("strategy.yaml"), &strict).unwrap();
    assert!(strategy(&c).is_some(), "strict strategy did not load");
    // `computeStatus` reads the hold file, not a caller-supplied `mode` field.
    std::fs::create_dir_all(c.pacer_home.join("state")).unwrap();
    std::fs::write(
        c.pacer_home.join("state/mode-hold.json"),
        json!({"mode":"strict","until":c.now + 1000.0}).to_string(),
    )
    .unwrap();
    let parts = json!({"accounts":[{"name":"ep","verdict":"AHEAD","usedPct":10}]});
    let got = admitted(&c, Fake { entries: vec![reply("pacer")], parts }).await;
    assert_eq!(got.reason.as_deref(), Some("OpenCode is in Strict mode. The assistant is paused to save the planner's budget."));
    assert_eq!(got.hint, None);

    // 10. All clear.
    let c2 = admission_ctx(&dir, &[]);
    save_for_admission(&c2, "ep", "pacer", 50);
    let got = admitted(&c2, Fake { entries: vec![reply("pacer")], parts: clear_parts() }).await;
    assert_eq!(got, Admission { ok: true, reason: None, hint: None });
}

#[test]
fn a_passing_self_test_keeps_live_tools_and_skips_leading_blank_version_lines() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cli = bin.join("opencode");
    std::fs::write(&cli, "#!/bin/sh\nprintf '\\nfake 1.0\\n'\n").unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    let c = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        [("PATH".into(), bin.to_string_lossy().into_owned())].into_iter().collect(),
        1_700_000_000.0,
    );
    std::fs::create_dir_all(c.pacer_home.join("state")).unwrap();
    std::fs::write(
        c.pacer_home.join("state/assistant-selftest.json"),
        json!({"ep": {"version": "fake 1.0", "passed": true, "liveTools": true, "at": 1.0}}).to_string(),
    )
    .unwrap();
    assert_eq!(admission::self_test_status(&c, "ep", "opencode"), (true, None));
    let check = selftest_read::check(&c, "ep", "opencode");
    assert!(check.live_tools);
}

#[test]
fn accounts_without_an_ask_adapter_get_no_executor_row() {
    let dir = tempfile::tempdir().unwrap();
    let c = admission_ctx(&dir, &[]);
    std::fs::write(
        c.pacer_home.join("strategy.yaml"),
        ADMISSION_STRATEGY.replace(
            "  bare: {kind: endpoint, usage: unmetered}",
            "  bare: {kind: endpoint, usage: unmetered}\n  cursor-acct: {kind: cursor}",
        ),
    )
    .unwrap();
    let strategy = strategy(&c).unwrap();
    let entries = vec![entry(reply("pacer")), entry(reply("executor"))];
    let rows = admission::candidate_rows(&c, &strategy, &entries);
    assert!(rows.iter().all(|r| r["account"] != "cursor-acct"), "{rows:?}");
}

#[tokio::test]
async fn candidates_include_executor_rows_and_status_uses_the_chosen_row() {
    let dir = tempfile::tempdir().unwrap();
    let c = admission_ctx(&dir, &[]);
    let entries = vec![reply("pacer"), reply("executor")];
    let mut fake = Fake { entries: entries.clone(), parts: clear_parts() };
    let candidates = admission::assistant_candidates_with(&c, json!({}), &mut fake).await.unwrap();
    let rows = candidates["accounts"].as_array().unwrap();
    let pacer = rows.iter().find(|r| r["account"] == "ep" && r["backend"] == "pacer").unwrap();
    assert_eq!(pacer["available"], true);
    assert_eq!(pacer["liveTools"], true);
    let executor = rows.iter().find(|r| r["account"] == "ep" && r["backend"] == "executor").unwrap();
    assert_eq!(executor["available"], false);
    assert_eq!(executor["reason"], "ep has not passed the ask-mode check yet.");
    assert_eq!(executor["cli"], "opencode");
    // Pacer rows come first (Object.entries order within each backend).
    assert!(rows.iter().position(|r| r == pacer).unwrap() < rows.iter().position(|r| r == executor).unwrap());
    assert_eq!(candidates["reads"], json!(READS));

    save_for_admission(&c, "ep", "executor", 50);
    let mut fake = Fake { entries, parts: clear_parts() };
    let status = admission::assistant_status_with(&c, json!({}), &mut fake).await.unwrap();
    assert_eq!(status["available"], false);
    assert_eq!(status["configured"], true);
    assert_eq!(status["liveTools"], false);
    assert_eq!(status["cli"], "opencode");
    assert_eq!(status["reason"], "ep has not passed the ask-mode check yet.");
    assert_eq!(status["hint"], "Run the ask-mode check in Settings › Assistant.");
}
