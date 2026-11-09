#![allow(clippy::unwrap_used)]
use crate::{
    js::{REDACTIONS, redact, stringify},
    *,
};
use serde_json::json;
use std::{collections::HashMap, path::Path};

fn ctx(root: &Path) -> Ctx {
    Ctx {
        home: root.join("home"),
        pacer_home: root.join("pacer"),
        env: HashMap::new(),
        now: 1_000.0,
    }
}

fn strategy(ctx: &Ctx, text: &str) {
    std::fs::create_dir_all(&ctx.pacer_home).unwrap();
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), text).unwrap();
}

const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude:\n    kind: claude\n    usage: quota\n  ep:\n    kind: endpoint\n    usage: unmetered\n    connection:\n      api: openai-compatible\n      base_url: https://example.test/v1\n      key: env:EP_KEY\n      models: [{id: m1, context: 1000, output: 100, tools: true}]\nrunners:\n  claude-code: {}\n";

#[test]
fn redactions_compile_and_mask_keys() {
    assert_eq!(REDACTIONS.len(), 4);
    let text = redact("Authorization: Bearer sk-abcdefghijklmnop123456");
    assert!(!text.contains("abcdefghijklmnop"), "{text}");
}

#[test]
fn stringify_matches_javascript() {
    let v = json!({"b": 1.5, "2": [true, null], "a": 1e21, "1": "x"});
    assert_eq!(
        stringify(&v, 0),
        r#"{"1":"x","2":[true,null],"b":1.5,"a":1e+21}"#
    );
}

#[tokio::test]
async fn remove_refuses_and_retires_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path());
    strategy(&ctx, STRATEGY);
    let error = account_remove(&ctx, json!({"name": "claude"}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "account claude is in use");
    let error = account_remove(&ctx, json!({"name": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "unknown account: nope");
    let error = account_remove(&ctx, json!({"name": "ep", "delete_home": true}))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "--delete-home is only available for pacer-managed accounts"
    );
    let reply = account_remove(&ctx, json!({"name": "ep"})).await.unwrap();
    assert_eq!(reply, json!({"removed": true}));
    let text = std::fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).unwrap();
    assert!(!text.contains("  ep:"), "{text}");
    let evidence = std::fs::read_dir(ctx.pacer_home.join("state/evidence")).unwrap();
    assert_eq!(evidence.count(), 1);
}

#[tokio::test]
async fn refusals_cover_missing_accounts_and_keys() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path());
    strategy(&ctx, STRATEGY);
    let error = account_test(&ctx, json!({"name": "claude"}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "a configured endpoint account is required");
    let error = account_models(&ctx, json!({"name": "ep"}))
        .await
        .unwrap_err();
    assert!(error.message.starts_with("Key missing"));
    let error = account_usage_check(&ctx, json!({"account": "ep"}))
        .await
        .unwrap_err();
    assert!(error.message.starts_with("Unmetered"));
    let error = account_usage_check(&ctx, json!({"account": "claude"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("consumes account quota"));
    assert!(account_stays_forwarded(
        &ctx,
        "account.usage.check",
        &json!({"account": "claude", "consent": true})
    ));
    assert!(account_stays_forwarded(
        &ctx,
        "account.add",
        &json!({"name": "x", "kind": "claude"})
    ));
}

#[tokio::test]
async fn endpoint_add_and_edit_write_strategy_and_state() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path());
    strategy(&ctx, STRATEGY);
    let add = json!({"name": "ep2", "kind": "endpoint", "base_url": "https://e.test/v1",
        "key_source": "none", "models": [{"id": "m", "context": 1000, "output": 100, "tools": true}], "usage": "unmetered", "test": false});
    assert!(!account_stays_forwarded(&ctx, "account.add", &add));
    let reply = account_add(&ctx, add).await.unwrap();
    assert_eq!(reply["state"], "not_tested");
    assert_eq!(reply["runner"]["id"], "opencode#ep2");
    assert_eq!(reply["account"]["connection"]["key"], "present");
    let state = std::fs::read_to_string(ctx.pacer_home.join("endpoints/state.json")).unwrap();
    assert!(state.contains("\"ep2\""), "{state}");
    let edit = json!({"name": "ep2", "usage": "metered", "weekly_tokens": 5000});
    let reply = account_edit(&ctx, edit).await.unwrap();
    assert_eq!(reply["account"]["usage"], "metered");
    assert_eq!(reply["account"]["weeklyTokens"], 5000);
    let error = account_edit(&ctx, json!({"name": "claude"}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "a configured endpoint account is required");
}
