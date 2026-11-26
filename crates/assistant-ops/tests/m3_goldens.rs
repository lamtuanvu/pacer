//! M3 B4-1 goldens: replay the frozen assistant cases entirely in Rust. The same fixtures
//! are recorded by `test/native-assistant-parity.test.ts` (`UPDATE_M3_GOLDENS=1`).
#![allow(clippy::unwrap_used, clippy::result_large_err)]
use pacer_assistant_ops::assistant_ops;
use pacer_foundation::Ctx;
use pacer_store::{TaskStore, assistant};
use serde_json::{Value, json};

const NOW: f64 = 1_700_000_000.0;
const CASES: &[(&str, &str)] = &[
    (
        "settings",
        include_str!("../../../test/fixtures/m3/assistant/settings.json"),
    ),
    (
        "history",
        include_str!("../../../test/fixtures/m3/assistant/history.json"),
    ),
    (
        "cards",
        include_str!("../../../test/fixtures/m3/assistant/cards.json"),
    ),
];

async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
) -> Result<Value, pacer_foundation::api::CoreError> {
    match op {
        "assistant.settings.get" => assistant_ops::assistant_settings_get(ctx, params).await,
        "assistant.settings.set" => assistant_ops::assistant_settings_set(ctx, params).await,
        "assistant.conversations" => assistant_ops::assistant_conversations(ctx, params).await,
        "assistant.card.refresh" => assistant_ops::assistant_card_refresh(ctx, params).await,
        other => panic!("unfrozen op {other}"),
    }
}

#[tokio::test]
async fn m3_assistant_goldens_replay_natively() {
    for (file, text) in CASES {
        let cases: Vec<Value> = serde_json::from_str(text).unwrap();
        assert!(!cases.is_empty(), "{file}: empty golden");
        for case in cases {
            let op = case["op"].as_str().unwrap();
            let params = case["params"].clone();
            let setup = &case["setup"];
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            if let Some(strategy) = setup["strategy"].as_str() {
                std::fs::write(home.join("strategy.yaml"), strategy).unwrap();
            }
            for folder in setup["dirs"].as_array().into_iter().flatten() {
                std::fs::create_dir_all(home.join(folder.as_str().unwrap())).unwrap();
            }
            {
                let mut store = TaskStore::open(home).unwrap();
                let db = assistant::database(&mut store).unwrap();
                for sql in setup["sql"].as_array().into_iter().flatten() {
                    db.execute_batch(sql.as_str().unwrap()).unwrap();
                }
            }
            let env = case["env"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                .collect();
            let ctx = Ctx::with(home.into(), home.into(), env, NOW);
            let expected = &case["expected"];
            let actual = match call(&ctx, op, params).await {
                Ok(result) => json!({"result": result}),
                Err(error) => error.body(),
            };
            let label = format!("{file} {op} {}", case["params"]);
            if case["codeOnly"] == json!(true) {
                assert_eq!(
                    actual["error"]["code"], expected["error"]["code"],
                    "{label}"
                );
                assert_eq!(
                    actual["error"]["message"], expected["error"]["message"],
                    "{label}"
                );
            } else {
                assert_eq!(actual, *expected, "{label}");
            }
            // Every error golden uses the code the frozen message was written for.
            if let Some(code) = expected["error"]["code"].as_str() {
                assert!(
                    actual["error"]["code"].as_str().is_some_and(|c| c == code),
                    "{label}"
                );
                assert_ne!(code, "unavailable", "{label}");
            }
        }
    }
}
