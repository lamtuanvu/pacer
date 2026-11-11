#![allow(clippy::unwrap_used)]
use std::collections::HashMap;

use pacer_foundation::{Ctx, api::Code};
use serde_json::json;

use super::{PendingEdit, config_set, config_set_stays_forwarded};

fn ctx(env: &[(&str, &str)]) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".pacer");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("strategy.yaml"),
        "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n",
    )
    .unwrap();
    let env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    let ctx = Ctx::with(dir.path().into(), home, env, 1_700_000_000.0);
    (dir, ctx)
}

#[test]
fn only_changed_planner_installs_and_orca_without_env_forward() {
    let (_dir, plain) = ctx(&[]);
    let forwarded = |ctx: &Ctx, params| config_set_stays_forwarded(ctx, &params);
    assert!(forwarded(
        &plain,
        json!({"key": "planner", "value": "codex", "integrations": "install"})
    ));
    assert!(forwarded(
        &plain,
        json!({"key": "execution.backend", "value": "orca"})
    ));
    for native in [
        json!({"key": "planner", "value": "claude-code", "integrations": "install"}),
        json!({"key": "planner", "value": "codex", "integrations": "skip"}),
        json!({"key": "planner", "value": "codex"}),
        json!({"key": "planner", "value": "nobody", "integrations": "install"}),
        json!({"key": "planner", "value": "Not A Runner", "integrations": "install"}),
        json!({"key": "execution.backend", "value": "direct"}),
        json!({"key": "execution.backend", "value": "elsewhere"}),
        json!({"key": "pacing.policy", "value": "even"}),
        json!({"key": "nope", "value": 1}),
    ] {
        assert!(!forwarded(&plain, native.clone()), "{native}");
    }
    let (_dir, env) = ctx(&[("PACER_BACKEND", "orca")]);
    assert!(!forwarded(
        &env,
        json!({"key": "execution.backend", "value": "orca"})
    ));
    let (_dir, executor) = ctx(&[("PACER_ROLE", "executor")]);
    assert!(!forwarded(
        &executor,
        json!({"key": "planner", "value": "codex", "integrations": "install"})
    ));
}

#[test]
fn planner_changed_after_the_predicate_replies_like_a_strategy_changed_during_edit() {
    let (_dir, plain) = ctx(&[]);
    let params = json!({"key": "planner", "value": "claude-code", "integrations": "install"});
    assert!(!config_set_stays_forwarded(&plain, &params));
    let path = plain.pacer_home.join("strategy.yaml");
    let raced = "planner: codex\nproviders: {claude-code: {}, codex: {}}\n";
    std::fs::write(&path, raced).unwrap();
    let error = config_set(&plain, &params).unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "Strategy changed during edit");
    assert_eq!(error.hint.as_deref(), Some("Refresh and retry."));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), raced);
}

#[test]
fn pending_edit_key_is_released_on_drop_and_unwind() {
    let key = "test:pending-edit".to_string();
    let first = PendingEdit::claim(key.clone()).unwrap();
    assert!(PendingEdit::claim(key.clone()).is_none());
    drop(first);
    let unwound = std::panic::catch_unwind(|| {
        let _held = PendingEdit::claim("test:pending-edit".into()).unwrap();
        panic!("handler failed");
    });
    assert!(unwound.is_err());
    assert!(PendingEdit::claim(key).is_some());
}

#[test]
fn held_key_refuses_a_second_edit_of_the_same_setting() {
    let (_dir, plain) = ctx(&[]);
    let path = plain.pacer_home.join("strategy.yaml");
    let _held = PendingEdit::claim(format!("{}:pacing.policy", path.display())).unwrap();
    let params = json!({"key": "pacing.policy", "value": "even"});
    let error = config_set(&plain, &params).unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.message, "This setting is already being changed");
    assert_eq!(error.hint.as_deref(), Some("Refresh and retry."));
    let other = json!({"key": "pacing.order", "value": ["codex"]});
    assert!(config_set(&plain, &other).is_ok());
}
