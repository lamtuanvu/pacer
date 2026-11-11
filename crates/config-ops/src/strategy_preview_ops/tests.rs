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
    let rows = json!({"accounts": [], "providers": []});
    Box::pin(async move { Ok(json!({"current": rows, "draft": rows})) })
}

#[tokio::test]
async fn drafts_stay_native_unless_only_typescript_reads_them() {
    let (_dir, ctx) = home();
    let draft = |set: Value| json!({"draft": {"from": "default", "set": set}});
    assert!(!strategy_preview_stays_forwarded(
        &ctx,
        &draft(json!({"pacing.policy": "nope"}))
    ));
    // Valid drafts that change provider inputs used to forward.
    for set in [
        json!({"pacing.order": ["codex", "claude-code"]}),
        json!({"pacing.planner_reserve": 40}),
        json!({"planner": "codex"}),
    ] {
        let params = draft(set);
        assert!(matches!(
            preview_draft(&ctx.pacer_home, &params["draft"]),
            DraftPreview::Valid { .. }
        ));
        assert!(!strategy_preview_stays_forwarded(&ctx, &params));
    }
    assert!(!strategy_preview_stays_forwarded(&ctx, &json!({})));
    fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: [x\n").unwrap();
    assert!(strategy_preview_stays_forwarded(&ctx, &draft(json!({}))));
    fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: nobody\n").unwrap();
    assert!(!strategy_preview_stays_forwarded(&ctx, &draft(json!({}))));
    fs::remove_file(ctx.pacer_home.join("strategy.yaml")).unwrap();
    assert!(!strategy_preview_stays_forwarded(&ctx, &draft(json!({}))));
    // A listed draft source Bun may read differently forwards; an unknown one never is read.
    fs::write(ctx.pacer_home.join("strategy.yaml"), BASE).unwrap();
    fs::create_dir(ctx.pacer_home.join("strategies")).unwrap();
    fs::write(
        ctx.pacer_home.join("strategies/tabs.yaml"),
        format!("{BASE}\t# x\n"),
    )
    .unwrap();
    let from = |name: &str| json!({"draft": {"from": name, "set": {}}});
    assert!(strategy_preview_stays_forwarded(&ctx, &from("tabs")));
    assert!(!strategy_preview_stays_forwarded(
        &ctx,
        &from("strategies/tabs")
    ));
    fs::write(ctx.pacer_home.join("active"), "/nonexistent/work").unwrap();
    assert!(strategy_preview_stays_forwarded(&ctx, &from("default")));
}

#[tokio::test]
async fn unloadable_base_strategies_are_invalid_input_with_the_strategy_hint() {
    let (dir, ctx) = home();
    fs::remove_file(dir.path().join("strategy.yaml")).unwrap();
    let pending = || -> OpFuture<'static> { Box::pin(async { panic!("rows requested") }) };
    let error = strategy_preview(&ctx, json!({"draft": {"from": "default"}}), pending())
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message, error.hint.as_deref()),
        (
            Code::InvalidInput,
            format!(
                "no strategy found at {}",
                dir.path().join("strategy.yaml").display()
            ),
            Some(STRATEGY_HINT)
        )
    );
    fs::write(dir.path().join("strategy.yaml"), "planner: claude-code\n").unwrap();
    let error = strategy_preview(&ctx, json!({"draft": {"from": "default"}}), pending())
        .await
        .unwrap_err();
    assert!(error.message.starts_with("invalid strategy "));
    assert_eq!(error.hint.as_deref(), Some(STRATEGY_HINT));
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

#[test]
fn broker_params_carry_only_the_draft() {
    let draft = json!({"from": "default", "set": {"planner": "codex"}});
    assert_eq!(
        broker_params(&json!({"draft": draft, "extra": 1})),
        json!({"draft": draft})
    );
    for params in [
        json!({}),
        json!(null),
        json!({"draft": []}),
        json!({"draft": "x"}),
    ] {
        assert_eq!(broker_params(&params), json!({}));
    }
}

#[tokio::test]
async fn each_strategy_ranks_over_its_own_parts() {
    let (_dir, ctx) = home();
    let row = |id: &str| {
        json!({"id": id, "account": id.trim_end_matches("-code"), "usage": "quota", "windows": [],
            "binding": null, "verdict": "OK", "agent": id, "installed": true, "stale": false,
            "eligibility": {"state": "eligible", "reasons": []}})
    };
    let current = json!({"accounts": [], "providers": [row("claude-code"), row("codex")]});
    let draft =
        json!({"accounts": [], "providers": [row("claude-code"), row("codex"), row("cursor")]});
    let both = json!({"current": current, "draft": draft});
    let reply = |parts: Value| -> OpFuture<'static> { Box::pin(async move { Ok(parts) }) };
    // A saved strategy with another account is a draft source whose provider rows differ.
    fs::create_dir(ctx.pacer_home.join("strategies")).unwrap();
    fs::write(
        ctx.pacer_home.join("strategies/wide.yaml"),
        BASE.replace(
            "  codex: {kind: codex}\n",
            "  codex: {kind: codex}\n  cursor: {kind: cursor}\n",
        )
        .replace("  codex: {}\n", "  codex: {}\n  cursor: {}\n"),
    )
    .unwrap();
    let request = json!({"draft": {"from": "wide", "set": {"pacing.order": ["cursor", "codex", "claude-code"]}}});
    let out = strategy_preview(&ctx, request.clone(), reply(both))
        .await
        .unwrap();
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["ranking"]["current"], json!(["codex"]), "{out}");
    assert_eq!(out["ranking"]["draft"], json!(["cursor", "codex"]), "{out}");
    // A draft whose status fails after validation reports the bridge's errors.
    let failed = strategy_preview(
        &ctx,
        request.clone(),
        reply(json!({"current": current, "errors": ["boom"]})),
    )
    .await
    .unwrap();
    assert_eq!(
        (&failed["ok"], &failed["errors"], &failed["summary"]),
        (&json!(false), &json!(["boom"]), &json!(""))
    );
    assert_eq!(failed["routing"]["draft"], json!([]));
    assert!(!failed["yaml"].as_str().unwrap().is_empty());
    for parts in [
        json!({"accounts": [], "providers": []}),
        json!({"current": current}),
    ] {
        let error = strategy_preview(&ctx, request.clone(), reply(parts))
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            (Code::Unavailable, "invalid usage broker response")
        );
    }
}
