#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

const BASE: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\npacing: {policy: priority, order: [claude-code, codex]}\n";

fn home() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("strategy.yaml"), BASE).unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1.0,
    );
    (dir, ctx)
}

fn parts() -> OpFuture<'static> {
    Box::pin(async { Ok(json!({"accounts": [], "providers": []})) })
}

#[tokio::test]
async fn ranking_only_drafts_stay_native_and_others_forward() {
    let (_dir, ctx) = home();
    let draft = |set: Value| json!({"draft": {"from": "default", "set": set}});
    assert!(!strategy_preview_stays_forwarded(
        &ctx,
        &draft(json!({"pacing.order": ["codex", "claude-code"]}))
    ));
    assert!(!strategy_preview_stays_forwarded(
        &ctx,
        &draft(json!({"pacing.policy": "nope"}))
    ));
    assert!(strategy_preview_stays_forwarded(
        &ctx,
        &draft(json!({"pacing.planner_reserve": 40}))
    ));
    assert!(!strategy_preview_stays_forwarded(&ctx, &json!({})));
    fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: [x\n").unwrap();
    assert!(strategy_preview_stays_forwarded(&ctx, &draft(json!({}))));
}

#[tokio::test]
async fn preview_reports_yaml_summary_and_problems() {
    let (_dir, ctx) = home();
    let out = strategy_preview(
        &ctx,
        json!({"draft": {"from": "default", "set": {"pacing.order": ["codex", "claude-code"]}}}),
        parts(),
    )
    .await
    .unwrap();
    assert_eq!(out["ok"], true);
    assert!(out["yaml"].as_str().unwrap().ends_with('\n'));
    assert!(out["summary"].as_str().unwrap().starts_with("Codex first"));
    let missing = strategy_preview(&ctx, json!({"draft": {"from": "gone"}}), parts())
        .await
        .unwrap();
    assert_eq!(
        (&missing["ok"], &missing["errors"], &missing["yaml"]),
        (
            &json!(false),
            &json!(["unknown strategy \"gone\""]),
            &json!("")
        )
    );
    assert_eq!(missing["ranking"]["draft"], json!([]));
    assert_eq!(
        strategy_preview(&ctx, json!({}), parts())
            .await
            .err()
            .unwrap()
            .message,
        "draft: Invalid input: expected object, received undefined"
    );
}
