#![allow(clippy::unwrap_used)]
use super::*;

const STRATEGY: &str = "accounts:\n  claude: {kind: claude}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: \"http://127.0.0.1:1/v1\", key: none, models: [{id: m1, name: Model One, context: 1000, output: 100, tools: true}, {id: m2, context: 1000, output: 100, tools: false}]}}\n  bare: {kind: endpoint, usage: unmetered}\nplanner: claude-code#claude\nrunners: {\"opencode#ep\": {model: pacer-ep/m2}}\nrouting: [{default: [opencode#ep]}]\n";

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
}

#[test]
fn strategy_endpoints_and_candidates_follow_endpoint_for() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    let strategy = strategy(&ctx(&dir, &[])).unwrap();
    assert!(endpoint_ok(&strategy, "ep", None));
    assert!(endpoint_ok(&strategy, "ep", Some("opencode#ep")));
    assert!(!endpoint_ok(&strategy, "bare", None));
    assert!(!endpoint_ok(&strategy, "claude", None));
    assert!(!endpoint_ok(&strategy, "missing", None));
    assert_eq!(
        Value::Array(candidates(&strategy)).to_string(),
        r#"[{"account":"ep","models":[{"id":"m1","name":"Model One"},{"id":"m2","name":"m2"}],"runners":[{"id":"opencode#ep","model":"pacer-ep/m2"}],"isPlanner":false}]"#
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
        r#"{"available":false,"configured":false,"reason":"The assistant is not set up.","hint":"Choose an account in Settings › Assistant.","limits":{"maxInputTokens":32000,"maxOutputTokens":8000,"maxToolRounds":6,"turnsPerDay":50,"deadlineMs":120000},"retention":{"days":30,"conversations":200},"rev":1,"today":{"turns":0,"input":0,"output":0}}"#
    );
    // A configured, admissible assistant needs the cached usage status.
    std::fs::write(dir.path().join("strategy.yaml"), STRATEGY).unwrap();
    let saved =
        assistant_settings_set(&plain, json!({"runner":null,"account":"ep","expect_rev":1}))
            .await
            .unwrap();
    assert_eq!(saved["rev"], 2);
    assert!(assistant_stays_forwarded(
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
    // Settings TypeScript would reject while parsing stay forwarded.
    with_db(&plain, |db| {
        db.execute("UPDATE assistant_settings SET retention='{\"days\":0}'", [])?;
        Ok(())
    })
    .unwrap();
    for op in [
        "assistant.settings.get",
        "assistant.conversations",
        "assistant.status",
    ] {
        assert!(assistant_stays_forwarded(&plain, op, &json!({})), "{op}");
    }
    let set = json!({"runner":null,"account":null,"expect_rev":2});
    assert!(assistant_stays_forwarded(
        &plain,
        "assistant.settings.set",
        &set
    ));
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
