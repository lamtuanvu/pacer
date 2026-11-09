#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

struct Fake(Vec<Value>);

impl SetupEffects for Fake {
    fn call(&mut self, request: Value) -> pacer_foundation::api::OpFuture<'_> {
        Box::pin(async move {
            let kind = request["kind"].as_str().unwrap_or_default().to_owned();
            self.0.push(request);
            Ok(match kind.as_str() {
                "status_text" => json!({"text": "fixture status"}),
                _ => json!({"opened": true, "target": "terminal", "command": "fixture"}),
            })
        })
    }
}

fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn params_follow_zod_issue_order() {
    let error = parse(&json!({"agent": "x", "from": "", "brief": "😀".repeat(2001), "worktree": "", "request_id": "nope"})).unwrap_err();
    assert_eq!(
        error.message,
        "agent: Invalid option: expected one of \"claude-code\"|\"codex\"|\"cursor\"|\"opencode\"; from: Too small: expected string to have >=1 characters; brief: Too big: expected string to have <=2000 characters; worktree: Too small: expected string to have >=1 characters; request_id: Invalid UUID"
    );
    assert_eq!(parse(&Value::Null).unwrap(), Params::default());
    assert!(zod_uuid("00000000-0000-4000-8000-000000000001"));
    assert!(!zod_uuid("00000000-0000-0000-8000-000000000001"));
}

#[test]
fn a_repeated_request_reuses_its_prompt_and_intent() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let pacer = home.join(".pacer");
    fs::create_dir_all(&pacer).unwrap();
    fs::write(
        pacer.join("strategy.yaml"),
        "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\n",
    )
    .unwrap();
    let ctx = Ctx::with(
        home,
        pacer.clone(),
        HashMap::new(),
        pacer_foundation::ctx::unix_now(),
    );
    let params = json!({"agent": "cursor", "brief": "Help", "request_id": "00000000-0000-4000-8000-000000000001"});
    let mut fake = Fake(vec![]);
    let first = block(strategy_build(&ctx, params.clone(), false, &mut fake)).unwrap();
    let again = block(strategy_build(&ctx, params, false, &mut fake)).unwrap();
    assert_eq!(first, again);
    let kinds: Vec<_> = fake.0.iter().map(|r| r["kind"].clone()).collect();
    assert_eq!(
        kinds,
        ["status_text", "strategy_terminal", "strategy_terminal"]
    );
    let sessions = pacer.join("link/sessions");
    let prompt =
        fs::read_to_string(sessions.join("00000000-0000-4000-8000-000000000001.md")).unwrap();
    assert!(prompt.starts_with("# Build a pacer strategy\n\nHelp\n\nBase: default\n"));
    assert!(prompt.contains("Current status:\nfixture status\n"));
    let changed = json!({"brief": "changed", "request_id": "00000000-0000-4000-8000-000000000001"});
    let error = block(strategy_build(&ctx, changed, false, &mut fake)).unwrap_err();
    assert_eq!(
        error.message,
        "strategy request ID was used with different details"
    );
    assert_eq!(error.hint.as_deref(), Some(HINT));
}
