#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn planners_are_local_planner_agents() {
    for id in ["codex", "codex#work", "cursor@local", "opencode#a-1@local"] {
        assert!(local_planner(id), "{id}");
    }
    for id in [
        "agy",
        "codex@devbox",
        "codex#",
        "Codex",
        "codex#a#b",
        "nope",
    ] {
        assert!(!local_planner(id), "{id}");
    }
}

#[test]
fn ollama_host_matches_fetch_urls() {
    let env = |host: &str| HashMap::from([("OLLAMA_HOST".to_owned(), host.to_owned())]);
    assert_eq!(
        ollama_target(&HashMap::new()),
        Some(("127.0.0.1".into(), "127.0.0.1:11434".into(), 11434))
    );
    assert_eq!(
        ollama_target(&env("0.0.0.0")),
        Some(("0.0.0.0".into(), "0.0.0.0:11434".into(), 11434))
    );
    assert_eq!(
        ollama_target(&env("http://Box:8080/x")),
        Some(("box".into(), "box:8080".into(), 8080))
    );
    assert_eq!(ollama_target(&env("http://box")).unwrap().2, 80);
    assert_eq!(ollama_target(&env("https://box")), None);
}

#[test]
fn starter_strategy_matches_typescript_text() {
    let clis = BINS
        .iter()
        .map(|b| (*b, ["codex", "opencode", "ollama"].contains(b)))
        .collect();
    let d = Detection {
        clis,
        ollama: Some("qwen3:8b".into()),
        lmstudio: None,
    };
    assert_eq!(
        starter(&d, "claude-code"),
        "planner: claude-code\nproviders:\n  codex: {usage: quota, allow_paid: false}\n  ollama: {via: opencode, model: \"ollama/qwen3:8b\", usage: unmetered}\n  claude-code: {usage: quota}\n# To add opencode-go: use via: opencode, model: opencode-go/<model>,\n# usage: metered, and budget.weekly_tokens (e.g. budget: {weekly_tokens: 20M}).\npacing: {policy: priority, planner_reserve: 15}\nrouting:\n  - default: [codex, ollama]\n"
    );
}
