//! M3 B4-1: an Orca workspace caller is an executor session only when the strategy has a
//! matching provider. This lives in its own test binary because it changes the process cwd.
#![allow(clippy::unwrap_used)]
use pacer_assistant_ops::assistant_ops::assistant_conversation;
use pacer_foundation::{Ctx, api::Code};
use pacer_store::{TaskStore, assistant};
use serde_json::json;

// A legacy provider strategy: `providers` cannot be combined with `accounts` or `runners`.
const MATCHING: &str = "planner: claude-code\nproviders: {codex: {}}\nrouting: []\n";
const OTHER: &str = "planner: claude-code\nproviders: {opencode: {}}\nrouting: []\n";
const EXECUTOR: &str =
    "PACER_ROLE=executor: executors cannot use the assistant or read its history.";

fn home_with_conversation(dir: &std::path::Path, strategy: &str) -> Ctx {
    std::fs::write(dir.join("strategy.yaml"), strategy).unwrap();
    {
        let mut store = TaskStore::open(dir).unwrap();
        let db = assistant::database(&mut store).unwrap();
        db.execute(
            "INSERT OR IGNORE INTO assistant_conversations(id,title,created_at,updated_at) VALUES('c-a','Alpha',1,1)",
            [],
        )
        .unwrap();
    }
    Ctx::with(dir.into(), dir.into(), Default::default(), 1_700_000_000.0)
}

#[test]
fn orca_workspace_caller_uses_the_strategy_provider() {
    let original = std::env::current_dir().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let work = dir
        .path()
        .join("orca/workspaces/ws/pacer-t-20231114-010203-abcd-codex");
    std::fs::create_dir_all(&work).unwrap();
    std::env::set_current_dir(&work).unwrap();
    let ctx = home_with_conversation(dir.path(), MATCHING);
    let error = runtime
        .block_on(assistant_conversation(&ctx, json!({"id":"c-a"})))
        .unwrap_err();
    assert_eq!(
        (error.code, error.message),
        (Code::NotAllowed, EXECUTOR.into())
    );

    // The provider stops at the next '/', as the TypeScript regex does.
    let nested = work.join("src/lib");
    std::fs::create_dir_all(&nested).unwrap();
    std::env::set_current_dir(&nested).unwrap();
    let error = runtime
        .block_on(assistant_conversation(&ctx, json!({"id":"c-a"})))
        .unwrap_err();
    assert_eq!(
        (error.code, error.message),
        (Code::NotAllowed, EXECUTOR.into())
    );

    // A different provider or a malformed task/provider separator is an ordinary caller.
    let ctx = home_with_conversation(dir.path(), OTHER);
    let reply = runtime
        .block_on(assistant_conversation(&ctx, json!({"id":"c-a"})))
        .unwrap();
    assert_eq!(reply, json!({"id":"c-a","turns":[]}));
    let malformed = dir
        .path()
        .join("orca/workspaces/ws/pacer-t-20231114-010203-abcdXcodex");
    std::fs::create_dir_all(&malformed).unwrap();
    std::env::set_current_dir(&malformed).unwrap();
    let ctx = home_with_conversation(dir.path(), MATCHING);
    let reply = runtime
        .block_on(assistant_conversation(&ctx, json!({"id":"c-a"})))
        .unwrap();
    assert_eq!(reply, json!({"id":"c-a","turns":[]}));

    // An orchestrator is not an executor, even in its own task worktree.
    let own = dir.path().join("worktrees/repo/t-20231114-010203-abcd/src");
    std::fs::create_dir_all(&own).unwrap();
    std::env::set_current_dir(&own).unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        [("PACER_ROLE".to_owned(), "orchestrator".to_owned())]
            .into_iter()
            .collect(),
        1_700_000_000.0,
    );
    let reply = runtime
        .block_on(assistant_conversation(&ctx, json!({"id":"c-a"})))
        .unwrap();
    assert_eq!(reply, json!({"id":"c-a","turns":[]}));
    std::env::set_current_dir(original).unwrap();
}
