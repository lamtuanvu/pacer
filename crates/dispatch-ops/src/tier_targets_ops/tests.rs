#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

const STRATEGY: &str =
    "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\n";

fn seeded(text: &str, env: &[(&str, &str)]) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("strategy.yaml"), text).unwrap();
    let env = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect::<HashMap<_, _>>();
    let ctx = Ctx::with(dir.path().into(), dir.path().into(), env, 1000.0);
    (dir, ctx)
}

fn text(dir: &tempfile::TempDir) -> String {
    fs::read_to_string(dir.path().join("strategy.yaml")).unwrap()
}

async fn refusal(result: OpFuture<'_>) -> (Code, String) {
    let error = result.await.unwrap_err();
    (error.code, error.message)
}

#[tokio::test]
async fn get_returns_defaults_when_unset_and_saved_targets_after_a_save() {
    let (dir, c) = seeded(STRATEGY, &[]);
    assert_eq!(
        dispatch_tier_targets_get(&c, json!({"ignored": 1}))
            .await
            .unwrap(),
        json!({"revision": revision(STRATEGY), "targets": {"simple": "small", "standard": "medium", "complex": "frontier"}})
    );
    let saved = dispatch_tier_targets_set(
        &c,
        json!({"expectedRevision": revision(STRATEGY), "targets": {"complex": "frontier", "simple": "medium"}}),
    )
    .await
    .unwrap();
    let after = text(&dir);
    assert!(
        after.ends_with(
            "dispatch: { tierTargets: { simple: medium, standard: medium, complex: frontier } }\n"
        ),
        "{after}"
    );
    assert_eq!(
        saved,
        json!({"revision": revision(&after), "targets": {"simple": "medium", "standard": "medium", "complex": "frontier"}})
    );
    assert_eq!(
        dispatch_tier_targets_get(&c, Value::Null).await.unwrap(),
        saved
    );
}

#[tokio::test]
async fn set_refuses_stale_revisions_and_decreasing_or_invalid_targets() {
    let (dir, c) = seeded(STRATEGY, &[]);
    let set = |params: Value| dispatch_tier_targets_set(&c, params);
    let stale = set(json!({"expectedRevision": "old", "targets": {}}))
        .await
        .unwrap_err();
    assert_eq!(
        (stale.code, stale.message.as_str(), stale.hint.as_deref()),
        (
            Code::Conflict,
            "Executor settings changed elsewhere.",
            Some("Reload saved settings, then reapply your changes.")
        )
    );
    assert_eq!(
        refusal(set(
            json!({"expectedRevision": "x", "targets": {"simple": "frontier"}})
        ))
        .await,
        (
            Code::InvalidInput,
            "targets: dispatch.tierTargets must not decrease from simple to complex".into()
        )
    );
    assert_eq!(
        refusal(set(json!({"targets": {"simple": "huge", "a": 1, "b": 2}}))).await,
        (
            Code::InvalidInput,
            "expectedRevision: Invalid input: expected string, received undefined; targets.simple: Invalid option: expected one of \"small\"|\"medium\"|\"frontier\"; targets: Unrecognized keys: \"a\", \"b\"".into()
        )
    );
    assert_eq!(
        refusal(set(json!({"expectedRevision": "x", "targets": {"complex": "small", "x": 1}}))).await,
        (
            Code::InvalidInput,
            "targets: Unrecognized key: \"x\"; targets: dispatch.tierTargets must not decrease from simple to complex".into()
        )
    );
    assert_eq!(
        refusal(set(json!({"expectedRevision": "x", "targets": null}))).await,
        (
            Code::InvalidInput,
            "targets: Invalid input: expected object, received null".into()
        )
    );
    assert_eq!(text(&dir), STRATEGY);
}

#[tokio::test]
async fn executor_and_enforcement_identities_are_refused() {
    let (_dir, executor) = seeded(STRATEGY, &[("PACER_ROLE", "executor")]);
    assert_eq!(
        refusal(dispatch_tier_targets_get(&executor, json!({}))).await,
        (Code::NotAllowed, "A scoped work grant is required".into())
    );
    let (_dir, enforcement) = seeded(STRATEGY, &[("PACER_ENFORCEMENT_TOKEN", "t")]);
    assert_eq!(
        refusal(dispatch_tier_targets_set(&enforcement, json!(1)))
            .await
            .0,
        Code::NotAllowed
    );
}

#[tokio::test]
async fn get_refuses_a_strategy_that_changes_between_its_reads() {
    let (dir, c) = seeded(STRATEGY, &[]);
    let other = format!("{STRATEGY}dispatch: {{tierTargets: {{simple: medium}}}}\n");
    let revisions = [revision(STRATEGY), revision(&other)];
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (path, flag) = (dir.path().to_owned(), stop.clone());
    let writer = std::thread::spawn(move || {
        let texts = [STRATEGY.to_owned(), other];
        for i in 0.. {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let tmp = path.join("strategy.yaml.flip");
            fs::write(&tmp, &texts[i % 2]).unwrap();
            fs::rename(&tmp, path.join("strategy.yaml")).unwrap();
        }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut conflict = None;
    while conflict.is_none() && std::time::Instant::now() < deadline {
        match dispatch_tier_targets_get(&c, json!({})).await {
            Ok(out) => assert!(revisions.contains(&out["revision"].as_str().unwrap().to_owned())),
            Err(error) => conflict = Some((error.code, error.message)),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    writer.join().unwrap();
    assert_eq!(conflict, Some((Code::Conflict, CHANGED.to_owned())));
}
