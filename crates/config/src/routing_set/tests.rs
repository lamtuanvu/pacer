#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs};

fn setup() -> (tempfile::TempDir, Ctx, Value, String) {
    let temp = tempfile::tempdir().unwrap();
    let pacer = temp.path().join(".pacer");
    fs::create_dir_all(&pacer).unwrap();
    let yaml = "# keep layout\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex] # keep rule\npacing: {order: [codex], policy: priority}\n".to_owned();
    fs::write(pacer.join("strategy.yaml"), &yaml).unwrap();
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
    (
        temp,
        ctx,
        json!({"rules":[{"executors":["claude-code"]}]}),
        yaml,
    )
}

#[tokio::test]
async fn active_switch_before_lock_conflicts_without_writes() {
    let (_temp, ctx, params, yaml) = setup();
    let result = set_op_with(&ctx, params, || {
        fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
        fs::write(ctx.pacer_home.join("strategies/alternate.yaml"), &yaml).unwrap();
        fs::write(ctx.pacer_home.join("active"), "alternate\n").unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err().code, Code::Conflict);
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).unwrap(),
        yaml
    );
    assert!(!ctx.pacer_home.join("opencode/opencode.json").exists());
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}

#[tokio::test]
async fn source_change_before_lock_conflicts_without_writes() {
    let (_temp, ctx, params, yaml) = setup();
    let changed = yaml.replace("# keep layout", "# another header");
    let result = set_op_with(&ctx, params, || {
        fs::write(ctx.pacer_home.join("strategy.yaml"), &changed).unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err().code, Code::Conflict);
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("strategy.yaml")).unwrap(),
        changed
    );
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn opencode_symlink_is_rejected_without_following_it() {
    use std::os::unix::fs::symlink;
    let (temp, ctx, params, _yaml) = setup();
    let outside = temp.path().join("outside.json");
    fs::write(&outside, "untouched").unwrap();
    fs::create_dir_all(ctx.pacer_home.join("opencode")).unwrap();
    symlink(&outside, ctx.pacer_home.join("opencode/opencode.json")).unwrap();
    let result = set_op_with(&ctx, params, || {}).await;
    assert_eq!(result.unwrap_err().code, Code::InvalidInput);
    assert_eq!(fs::read_to_string(&outside).unwrap(), "untouched");
    assert!(!ctx.pacer_home.join("state/activity.jsonl").exists());
}
