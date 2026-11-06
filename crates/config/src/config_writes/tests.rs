use super::resolve;
use serde_json::json;

#[test]
fn resolves_every_runner_reference_form() {
    let strategy = json!({
        "accounts": {
            "work": {"name":"work","kind":"codex","home":null,"orcaAccount":null},
            "named": {"name":"named","kind":"codex","home":"/sandbox/named","orcaAccount":null},
            "api": {"name":"api","kind":"endpoint","home":null,"orcaAccount":null}
        },
        "runners": {
            "codex": {"id":"codex"},
            "codex#named": {"id":"codex#named"},
            "codex@remote": {"id":"codex@remote"},
            "opencode#api": {"id":"opencode#api"}
        },
        "runnerAliases": {"fast":"codex#named"}
    });
    for (reference, canonical) in [
        ("codex", "codex"),
        ("codex#work", "codex"),
        ("codex#work@local", "codex"),
        ("codex@remote", "codex@remote"),
        ("codex#work@remote", "codex@remote"),
        ("fast", "codex#named"),
        ("api", "opencode#api"),
        ("opencode#api", "opencode#api"),
    ] {
        assert_eq!(
            resolve(&strategy, reference),
            strategy["runners"].get(canonical)
        );
    }
    for reference in [
        "missing",
        "codex@missing",
        "codex#other",
        "codex##work",
        "CODEX",
        "codex@remote@other",
        "opencode",
    ] {
        assert!(resolve(&strategy, reference).is_none(), "{reference}");
    }
}

#[test]
#[allow(clippy::unwrap_used)]
fn selected_strategy_switch_during_edit_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/config-writes-goldens.json"
    ))
    .unwrap();
    let yaml = fixture["initial"].as_str().unwrap();
    std::fs::write(dir.path().join("strategy.yaml"), yaml).unwrap();
    std::fs::create_dir(dir.path().join("strategies")).unwrap();
    std::fs::write(dir.path().join("strategies/other.yaml"), yaml).unwrap();
    let error = super::edit(dir.path(), |doc, _| {
        doc.set_in(&[json!("pacing"), json!("policy")], &json!("even"))
            .unwrap();
        std::fs::write(dir.path().join("active"), "other\n").unwrap();
        Ok(())
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Your settings changed while they were being updated. Try again."
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("strategy.yaml")).unwrap(),
        yaml
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("strategies/other.yaml")).unwrap(),
        yaml
    );
}

#[test]
#[allow(clippy::unwrap_used)]
fn get_routing_returns_rules_and_available_ids() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("strategy.yaml"),
        "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [claude-code, codex]\n",
    )
    .unwrap();
    let got = super::get_routing(dir.path()).unwrap();
    assert_eq!(
        got["rules"],
        json!([
            {"kinds": ["docs"], "executors": ["codex"]},
            {"executors": ["claude-code", "codex"]},
        ])
    );
    let available = got["available"].as_array().unwrap();
    assert!(available.iter().any(|v| v == "claude-code"));
    assert!(available.iter().any(|v| v == "codex"));
}
