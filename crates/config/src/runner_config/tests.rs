#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs};

const YAML: &str = "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [codex, cursor], policy: priority}\n";

fn setup() -> (tempfile::TempDir, Ctx) {
    let temp = tempfile::tempdir().unwrap();
    let pacer = temp.path().join(".pacer");
    fs::create_dir_all(&pacer).unwrap();
    fs::write(pacer.join("strategy.yaml"), YAML).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            pacer.join("strategy.yaml"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let ctx = Ctx::with(temp.path().into(), pacer, HashMap::new(), 1_700_000_000.0);
    (temp, ctx)
}

fn params() -> Value {
    json!({"ids":["cursor","codex"]})
}

#[tokio::test]
async fn source_change_while_waiting_for_strategy_lock_conflicts_without_writes() {
    let (_temp, ctx) = setup();
    let edited = YAML.replace(
        "planner: claude-code",
        "# external edit\nplanner: claude-code",
    );
    let result = edit_with(&ctx, "runner.reorder", params(), || {
        fs::write(ctx.pacer_home.join("strategy.yaml"), &edited).unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err().code, Code::Conflict);
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).unwrap(),
        edited
    );
    assert!(!ctx.pacer_home.join("opencode/opencode.json").exists());
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}

#[tokio::test]
async fn active_switch_while_waiting_for_strategy_lock_conflicts_without_writes() {
    let (_temp, ctx) = setup();
    let result = edit_with(&ctx, "runner.reorder", params(), || {
        fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        fs::write(ctx.pacer_home.join("strategies/research.yaml"), YAML).unwrap();
        fs::write(ctx.pacer_home.join("active"), "research\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                ctx.pacer_home.join("strategies/research.yaml"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
    })
    .await;
    assert_eq!(result.unwrap_err().code, Code::Conflict);
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).unwrap(),
        YAML
    );
    assert!(!ctx.pacer_home.join("opencode/opencode.json").exists());
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_strategy_remains_core_owned_without_following_it() {
    use std::os::unix::fs::symlink;
    let (temp, ctx) = setup();
    let outside = temp.path().join("outside.yaml");
    fs::write(&outside, YAML).unwrap();
    fs::remove_file(ctx.pacer_home.join("strategy.yaml")).unwrap();
    symlink(&outside, ctx.pacer_home.join("strategy.yaml")).unwrap();
    assert!(requires_core_runner_parser(
        &ctx,
        "runner.reorder",
        &params()
    ));
    assert_eq!(fs::read_to_string(&outside).unwrap(), YAML);
}
