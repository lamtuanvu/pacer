#![allow(clippy::unwrap_used)]
//! Transcribed from test/install-policy.test.ts.
use pacer_plugin::install::policy_text;
use serde_json::Value;

const GOLDEN: &str = include_str!("fixtures/install/policy-text.json");

fn golden<'a>(text: &'a Value, planner: &str) -> &'a str {
    text[planner].as_str().unwrap()
}

// test/install-policy.test.ts:13 policy explains responsibilities, modes and lifecycle
#[test]
fn policy_explains_responsibilities_modes_lifecycle() {
    let full: Value = serde_json::from_str(GOLDEN).unwrap();
    for (planner, name) in [
        ("claude-code", "Claude Code"),
        ("codex", "Codex"),
        ("cursor", "Cursor"),
        ("opencode", "OpenCode"),
    ] {
        let text = policy_text(planner);
        assert_eq!(
            text.lines().next().unwrap(),
            "This applies only when you are the planner pacer is configured for; if pacer started you as an executor (PACER_ROLE=executor), ignore it."
        );
        assert_eq!(text, golden(&full, planner));
        assert!(text.contains(&format!(
            "# pacer delegation policy ({name} is the planner)\n"
        )));
        assert!(text.contains("plan, decide and review; delegate execution"));
        assert!(text.contains("## Modes\n"));
        assert!(text.contains("| strict/emergency |"));
        assert!(text.contains("| normal |"));
        assert!(text.contains("| relaxed |"));
        for command in [
            "pacer route <kind> --json",
            "pacer delegate --brief-file <path|-> --json",
            "pacer review <id> --accept|--reject",
        ] {
            assert!(text.contains(command));
        }
        assert!(text.contains("installed `pacer` skill"));
        assert!(text.contains("verify before reporting done"));
        assert!(text.contains("run `pacer review <id> --accept|--reject [--kind <k>]`"));
        assert!(text.contains("PACER=off"));
        assert!(text.contains("Use `pacer msg send <id> \"…\"` for follow-ups; it continues the same agent and worktree."));
    }
}

// test/install-policy.test.ts:31 policy gives budget and subagent guard
#[test]
fn policy_gives_budget_and_subagent_guard() {
    for (planner, name) in [
        ("claude-code", "Claude Code"),
        ("codex", "Codex"),
        ("cursor", "Cursor"),
        ("opencode", "OpenCode"),
    ] {
        let text = policy_text(planner);
        if planner == "claude-code" || planner == "codex" {
            assert!(text.contains("block arrives at session start"));
        } else {
            assert!(text.contains("At the start of every session, run `pacer status --json`"));
        }
        let subagents = if planner == "claude-code" {
            "Claude-model subagents (general-purpose, Sonnet, Haiku, …)".to_string()
        } else {
            format!("{name} subagents")
        };
        assert!(text.contains(&format!("**{subagents} count as you doing the work**")));
        let enforcement = if planner == "opencode" {
            "Do not use them for execution work unless"
        } else {
            "A hook blocks them for execution work unless"
        };
        assert!(text.contains(&format!(
            "{enforcement} the mode is `relaxed`, no executor is available, or `PACER=off`."
        )));
        assert!(text.contains("Read-only helpers and reviewers stay allowed."));
    }
}
