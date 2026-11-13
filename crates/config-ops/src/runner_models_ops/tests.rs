#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

const STRATEGY: &str = "planner: claude-code#claude\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  ep: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: \"http://127.0.0.1:1/v1\", key: none, models: [{id: m1, context: 1000, output: 100, tools: true}, {id: m2, context: 1000, output: 100, tools: false}]}}\n  oc: {kind: endpoint, source: opencode, provider: acme, usage: metered}\nrunners:\n  claude-code#claude: {}\n  codex: {model: gpt-5}\n  \"opencode#ep\": {model: pacer-ep/m1}\n  \"opencode#oc\": {model: acme/one}\n";

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    Ctx::with(
        dir.path().into(),
        dir.path().into(),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        1_700_000_000.0,
    )
}

fn seeded(text: &str) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("strategy.yaml"), text).unwrap();
    let c = ctx(&dir, &[]);
    (dir, c)
}

fn text(dir: &tempfile::TempDir) -> String {
    fs::read_to_string(dir.path().join("strategy.yaml")).unwrap()
}

#[tokio::test]
async fn get_reads_default_models_and_revision() {
    let (dir, c) = seeded(STRATEGY);
    let out = runner_models_get(&c, json!({"id": "codex"})).await.unwrap();
    assert_eq!(
        out,
        json!({"revision": revision(&text(&dir)), "runner": "codex", "default": "gpt-5", "models": []})
    );
    let unknown = runner_models_get(&c, json!({"id": "zzz"}))
        .await
        .unwrap_err();
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        (Code::InvalidInput, "unknown runner zzz")
    );
    let params = runner_models_get(&c, json!({"id": "", "x": 1}))
        .await
        .unwrap_err();
    assert_eq!(
        params.message,
        "id: Too small: expected string to have >=1 characters"
    );
    let shape = runner_models_get(&c, json!([1])).await.unwrap_err();
    assert_eq!(
        shape.message,
        "params: Invalid input: expected object, received array"
    );
}

#[tokio::test]
async fn set_writes_default_and_tiered_models_then_clears_them() {
    let (dir, c) = seeded(STRATEGY);
    let before = revision(&text(&dir));
    let out = runner_models_set(
        &c,
        json!({"id": "opencode#ep", "expectedRevision": before, "default": "pacer-ep/m2",
            "models": [{"id": "pacer-ep/m2", "tier": "small", "strengths": []}, {"id": "pacer-ep/m1", "strengths": ["code"], "tier": "frontier"}]}),
    )
    .await
    .unwrap();
    let after = text(&dir);
    assert!(after.contains("\"opencode#ep\": {model: pacer-ep/m2, models: [ { id: pacer-ep/m2, tier: small }, { id: pacer-ep/m1, tier: frontier, strengths: [ code ] } ]}"), "{after}");
    assert_eq!(out["revision"], revision(&after));
    assert_eq!(
        out["models"],
        json!([{"id": "pacer-ep/m2", "tier": "small", "strengths": []}, {"id": "pacer-ep/m1", "tier": "frontier", "strengths": ["code"]}])
    );
    assert_eq!(out["warnings"], json!([]));
    let cleared = runner_models_set(
        &c,
        json!({"id": "opencode#ep", "expectedRevision": revision(&after), "default": "pacer-ep/m1", "models": []}),
    )
    .await
    .unwrap();
    assert_eq!(cleared["models"], json!([]));
    assert!(text(&dir).contains("\"opencode#ep\": {model: pacer-ep/m1}"));
}

#[tokio::test]
async fn set_refuses_stale_planner_unknown_and_unoffered_models() {
    let (dir, c) = seeded(STRATEGY);
    let rev = revision(STRATEGY);
    let set = |id: &str, expected: &str, default: &str| {
        runner_models_set(
            &c,
            json!({"id": id, "expectedRevision": expected, "default": default, "models": []}),
        )
    };
    let stale = set("codex", "old", "x").await.unwrap_err();
    assert_eq!(
        (stale.code, stale.message.as_str(), stale.hint.as_deref()),
        (
            Code::Conflict,
            "Executor settings changed elsewhere.",
            Some("Reload saved settings, then reapply your changes.")
        )
    );
    let planner = set("claude-code", &rev, "x").await.unwrap_err();
    assert_eq!(
        (planner.code, planner.message.as_str()),
        (Code::NotAllowed, "cannot edit the planner runner")
    );
    let unknown = set("zzz", &rev, "x").await.unwrap_err();
    assert_eq!(unknown.message, "unknown runner zzz");
    let unoffered = set("opencode#ep", &rev, "pacer-ep/m3").await.unwrap_err();
    assert_eq!(
        (unoffered.message.as_str(), unoffered.hint.as_deref()),
        (
            "pacer-ep/m3 is not offered by ep",
            Some("Available: pacer-ep/m1, pacer-ep/m2")
        )
    );
    assert_eq!(text(&dir), STRATEGY);
    let enforcement = ctx(&dir, &[("PACER_ENFORCEMENT_TOKEN", "t")]);
    assert_eq!(
        runner_models_get(&enforcement, json!({"id": "codex"}))
            .await
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
}

#[tokio::test]
async fn set_many_commits_every_runner_or_none() {
    let (dir, c) = seeded(STRATEGY);
    let rev = revision(STRATEGY);
    let duplicate = runner_models_set_many(
        &c,
        json!({"expectedRevision": rev, "runners": [{"id": "codex", "default": "a", "models": []}, {"id": "codex", "default": "b", "models": []}]}),
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.message, "duplicate runner ids");
    let one_bad = runner_models_set_many(
        &c,
        json!({"expectedRevision": rev, "runners": [{"id": "codex", "default": "gpt-6", "models": []}, {"id": "opencode#ep", "default": "nope", "models": []}]}),
    )
    .await
    .unwrap_err();
    assert_eq!(one_bad.message, "nope is not offered by ep");
    assert_eq!(text(&dir), STRATEGY);
    let out = runner_models_set_many(
        &c,
        json!({"expectedRevision": rev, "runners": [{"id": "codex", "default": "gpt-6", "models": [{"id": "gpt-6", "tier": "unknown"}]}, {"id": "opencode#ep", "default": "pacer-ep/m2", "models": []}]}),
    )
    .await
    .unwrap();
    let after = text(&dir);
    assert_eq!(out["revision"], revision(&after));
    assert_eq!(out["runners"][0]["revision"], revision(&after));
    assert_eq!(out["runners"][1]["default"], "pacer-ep/m2");
    assert_eq!(
        out["warnings"],
        json!(["runners.codex: model \"gpt-6\" is unrated (tier unknown)"])
    );
    let many: Vec<Value> = (0..65)
        .map(|i| json!({"id": format!("r{i}"), "default": "m", "models": []}))
        .collect();
    let too_many = runner_models_set_many(&c, json!({"expectedRevision": "x", "runners": many}))
        .await
        .unwrap_err();
    assert_eq!(
        too_many.message,
        "runners: Too big: expected array to have <=64 items"
    );
    let empty = runner_models_set_many(&c, json!({"runners": [1]}))
        .await
        .unwrap_err();
    assert_eq!(
        empty.message,
        "expectedRevision: Invalid input: expected string, received undefined; runners.0: Invalid input: expected object, received number"
    );
}

#[tokio::test]
async fn set_many_refuses_a_stale_revision_and_writes_nothing() {
    let (dir, c) = seeded(STRATEGY);
    let first = revision(STRATEGY);
    let runners = json!([{"id": "codex", "default": "gpt-6", "models": []}, {"id": "opencode#ep", "default": "pacer-ep/m2", "models": []}]);
    runner_models_set(
        &c,
        json!({"id": "codex", "expectedRevision": first, "default": "gpt-7", "models": []}),
    )
    .await
    .unwrap();
    let saved = text(&dir);
    for expected in [first.as_str(), "stale"] {
        let stale = runner_models_set_many(
            &c,
            json!({"expectedRevision": expected, "runners": runners}),
        )
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
        assert_eq!(text(&dir), saved);
    }
}

#[test]
fn saves_forward_whole_when_any_runner_needs_discovery() {
    let (_dir, c) = seeded(STRATEGY);
    let set = |id: &str| json!({"id": id, "expectedRevision": "x", "default": "m", "models": []});
    assert!(runner_models_stays_forwarded(
        &c,
        "runner.models.set",
        &set("opencode#oc")
    ));
    assert!(!runner_models_stays_forwarded(
        &c,
        "runner.models.set",
        &set("codex")
    ));
    assert!(!runner_models_stays_forwarded(
        &c,
        "runner.models.get",
        &json!({"id": "opencode#oc"})
    ));
    assert!(runner_models_stays_forwarded(
        &c,
        "runner.models.set_many",
        &json!({"expectedRevision": "x", "runners": [set("codex"), set("opencode#oc")]})
    ));
    assert!(!runner_models_stays_forwarded(
        &c,
        "runner.models.set",
        &json!({"id": "opencode#oc"})
    ));
}

/// Flips the strategy between two texts by rename until the returned guard drops.
fn flipping(dir: &tempfile::TempDir, texts: [String; 2]) -> impl Drop {
    struct Flip(
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        Option<std::thread::JoinHandle<()>>,
    );
    impl Drop for Flip {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(writer) = self.1.take() {
                writer.join().unwrap();
            }
        }
    }
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (path, flag) = (dir.path().to_owned(), stop.clone());
    let writer = std::thread::spawn(move || {
        for i in 0.. {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let tmp = path.join("strategy.yaml.flip");
            fs::write(&tmp, &texts[i % 2]).unwrap();
            fs::rename(&tmp, path.join("strategy.yaml")).unwrap();
        }
    });
    Flip(stop, Some(writer))
}

#[tokio::test]
async fn get_refuses_a_strategy_that_changes_between_its_reads() {
    let (dir, c) = seeded(STRATEGY);
    let other = STRATEGY.replace("gpt-5", "gpt-4");
    let revisions = [revision(STRATEGY), revision(&other)];
    let _flip = flipping(&dir, [STRATEGY.to_owned(), other]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut conflicts = 0;
    while conflicts == 0 && std::time::Instant::now() < deadline {
        match runner_models_get(&c, json!({"id": "codex"})).await {
            Ok(out) => assert!(revisions.contains(&out["revision"].as_str().unwrap().to_owned())),
            Err(error) => {
                assert_eq!(
                    (error.code, error.message.as_str()),
                    (Code::Conflict, CHANGED)
                );
                conflicts += 1;
            }
        }
    }
    assert_eq!(conflicts, 1);
}
