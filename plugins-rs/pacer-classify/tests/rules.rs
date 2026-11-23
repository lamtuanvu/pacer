//! Delivery tests for the local `rules` classifier, ported from
//! `test/classify-rules.test.ts` and `test/plugins-classify-adapters.test.ts`
//! (C6). `ask` here drives `rules::ask_rule` with a question id and JSON state.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::rules;
use serde_json::{Value, json};

// `rulesClassifier.ask` with a 3000 ms timeout (test/classify-rules.test.ts:3).
fn ask(decision: &str, state: Value) -> Value {
    rules::ask_rule(decision, &state.to_string()).unwrap()
}

#[test]
fn rules_reports_zero_latency_and_cost_for_every_decision() {
    for decision in ["task_kind", "difficulty", "guard", "result_check"] {
        let answer = ask(decision, json!({}));
        assert_eq!(answer["latencyMs"], json!(0));
        assert_eq!(answer["costUsd"], json!(0));
    }
}

// TS: classify-rules.test.ts:19 — an explicit planner kind wins over keywords.
#[test]
fn planner_kind_wins_over_conflicting_keywords() {
    for kind in [
        "boilerplate",
        "tests",
        "docs",
        "rename",
        "migration",
        "feature",
        "debug",
        "refactor",
        "performance",
        "unfamiliar-code",
        "research",
    ] {
        let answer = ask("task_kind", json!({ "planner_kind": kind, "goal": "tests docs" }));
        assert_eq!(answer["value"], json!(kind));
        assert_eq!(answer["confidence"], json!(1.0));
    }
}

// TS: classify-rules.test.ts:24 — one keyword match selects the kind.
#[test]
fn one_keyword_match_selects_the_kind() {
    for (goal, kind) in [
        ("Write tests", "tests"),
        ("Update documentation", "docs"),
        ("Rename a symbol", "rename"),
        ("Migrate the database", "migration"),
        ("Debug the bug", "debug"),
        ("Refactor the module", "refactor"),
        ("Improve performance", "performance"),
        ("Generate boilerplate", "boilerplate"),
        ("Research the protocol", "research"),
    ] {
        let answer = ask(
            "task_kind",
            json!({ "goal": goal, "planner_kind": "invalid" }),
        );
        assert_eq!(answer["value"], json!(kind));
        assert_eq!(answer["confidence"], json!(0.7));
    }
}

// TS: classify-rules.test.ts:34.
#[test]
fn two_keyword_matches_give_default_even_with_a_feature_verb() {
    let answer = ask("task_kind", json!({ "goal": "Add tests and docs" }));
    assert_eq!(answer["value"], json!("default"));
    assert_eq!(answer["confidence"], json!(0.5));
}

// TS: classify-rules.test.ts:38.
#[test]
fn keywords_consider_scope_context_and_constraints() {
    for field in ["scope", "context", "constraints"] {
        let answer = ask(
            "task_kind",
            json!({ "goal": "Work on the module", field: "tests" }),
        );
        assert_eq!(answer["value"], json!("tests"));
        assert_eq!(answer["confidence"], json!(0.7));
    }
}

// TS: classify-rules.test.ts:44 — a standalone feature verb selects feature.
#[test]
fn feature_verb_selects_feature_only_without_a_keyword_match() {
    for verb in ["add", "implement", "build", "create", "support"] {
        let upper = verb.to_uppercase();
        let standalone = ask("task_kind", json!({ "goal": format!("{upper} pagination") }));
        assert_eq!(standalone["value"], json!("feature"));
        assert_eq!(standalone["confidence"], json!(0.6));

        let with_keyword = ask("task_kind", json!({ "goal": format!("{verb} tests") }));
        assert_eq!(with_keyword["value"], json!("tests"));
        assert_eq!(with_keyword["confidence"], json!(0.7));
    }
}

// TS: classify-rules.test.ts:51.
#[test]
fn no_keyword_or_feature_verb_gives_default() {
    for goal in [
        "Inspect the module",
        "address the issue",
        "rebuild the widget",
        "creative layout",
    ] {
        let answer = ask("task_kind", json!({ "goal": goal }));
        assert_eq!(answer["value"], json!("default"));
        assert_eq!(answer["confidence"], json!(0.5));
    }
}

// TS: classify-rules.test.ts:57 — difficulty base scores.
#[test]
fn difficulty_base_scores() {
    for (kind, value) in [
        ("boilerplate", 0.9),
        ("docs", 0.9),
        ("rename", 0.9),
        ("tests", 0.8),
        ("migration", 0.7),
        ("feature", 0.7),
        ("refactor", 0.6),
        ("debug", 0.5),
        ("research", 0.5),
        ("performance", 0.45),
        ("unfamiliar-code", 0.4),
    ] {
        let answer = ask("difficulty", json!({ "kind": kind }));
        assert_eq!(answer["value"], json!(value), "kind {kind}");
        assert_eq!(answer["confidence"], json!(0.6));
    }
    // An unknown kind defaults to 0.7 (TS: [null, 0.7]).
    let answer = ask("difficulty", json!({ "kind": Value::Null }));
    assert_eq!(answer["value"], json!(0.7));
}

// TS: classify-rules.test.ts:67.
#[test]
fn difficulty_penalizes_text_only_above_2000_characters() {
    let at = ask("difficulty", json!({ "kind": "feature", "goal": "x".repeat(2000) }));
    assert_eq!(at["value"], json!(0.7));
    let over = ask("difficulty", json!({ "kind": "feature", "goal": "x".repeat(2001) }));
    assert_eq!(over["value"], json!(0.6));
    let across_fields =
        ask("difficulty", json!({ "kind": "feature", "goal": "x".repeat(1000), "context": "x".repeat(1001) }));
    assert_eq!(across_fields["value"], json!(0.6));
}

// TS: classify-rules.test.ts:73.
#[test]
fn difficulty_penalizes_more_than_five_scope_items() {
    for separator in [",", "\n"] {
        let five_items = ["a", "b", "c", "d", "e"].join(separator);
        let five = ask("difficulty", json!({ "kind": "tests", "scope": five_items }));
        assert_eq!(five["value"], json!(0.8));

        let six_items = ["a", "b", "c", "d", "e", "f"].join(separator);
        let six = ask("difficulty", json!({ "kind": "tests", "scope": six_items }));
        assert_eq!(six["value"], json!(0.7));
    }
}

// TS: classify-rules.test.ts:80.
#[test]
fn difficulty_penalizes_repo_files_only_above_5000() {
    let at = ask("difficulty", json!({ "kind": "feature", "repo_files": 5000 }));
    assert_eq!(at["value"], json!(0.7));
    let over = ask("difficulty", json!({ "kind": "feature", "repo_files": 5001 }));
    assert_eq!(over["value"], json!(0.6));
}

// TS: classify-rules.test.ts:85.
fn penalized(kind: &str) -> Value {
    serde_json::from_str(
        &format!(
            r#"{{"kind":{kind:?},"goal":"{}","scope":"a,b,c,d,e,f","repo_files":5001}}"#,
            "x".repeat(2001)
        ),
    )
    .unwrap()
}

#[test]
fn difficulty_combines_penalties_rounds_and_clamps() {
    let performance = ask("difficulty", penalized("performance"));
    assert_eq!(performance["value"], json!(0.15));
    assert_eq!(performance["confidence"], json!(0.6));
    let unfamiliar = ask("difficulty", penalized("unfamiliar-code"));
    assert_eq!(unfamiliar["value"], json!(0.1));
    for kind in ["boilerplate", "unfamiliar-code"] {
        for state in [json!({ "kind": kind }), penalized(kind)] {
            let answer = ask("difficulty", state);
            let v = answer["value"].as_f64().unwrap();
            assert!((0.0..=1.0).contains(&v));
        }
    }
}

// TS: classify-rules.test.ts:98 — guard allows named subagent types.
fn assert_guard(value: bool, subagent_type: &str) {
    let answer = ask("guard", json!({ "subagent_type": subagent_type, "prompt": "x" }));
    assert_eq!(answer["value"], json!(value), "subagent_type {subagent_type}");
    assert_eq!(answer["confidence"], json!(0.9));
    let probs = answer["probabilities"].as_object().unwrap();
    assert_eq!(probs["yes"], json!(if value { 0.9 } else { 0.1 }));
    assert_eq!(probs["no"], json!(if value { 0.1 } else { 0.9 }));
}

#[test]
fn guard_allows_named_subagent_types() {
    for subagent_type in [
        "Explore",
        "Plan",
        "claude-code-guide",
        "statusline-setup",
        "code-reviewer",
        "SECURITY-REVIEWER",
        "analyzer",
        "Data-Analyzer",
        "pr-review-toolkit:code",
        "pacer-worker",
        "pacer:worker",
        "codex-executor",
    ] {
        assert_guard(false, subagent_type);
    }
}

// TS: classify-rules.test.ts:104.
#[test]
fn guard_classifies_general_purpose_and_near_misses_as_execution() {
    for subagent_type in [
        "general-purpose",
        "explore",
        "plan",
        "xpr-review-toolkit:code",
        "xpacer:worker",
        "pacer",
        "codex-executor-extra",
        "executor",
        "",
    ] {
        assert_guard(true, subagent_type);
    }
}

// TS: classify-rules.test.ts:110.
#[test]
fn result_check_uses_acceptance_when_present_even_if_status_disagrees() {
    let passed = ask("result_check", json!({ "status": "failed", "acceptance": { "passed": true, "tail": "ok" } }));
    assert_eq!(passed["value"], json!(true));
    assert_eq!(passed["confidence"], json!(0.95));
    let failed = ask("result_check", json!({ "status": "done", "acceptance": { "passed": false, "tail": "2 failed" } }));
    assert_eq!(failed["value"], json!(false));
    assert_eq!(failed["confidence"], json!(0.95));
}

// TS: classify-rules.test.ts:115.
#[test]
fn result_check_lowers_confidence_without_output_tail() {
    for state in [
        json!({ "status": "partial", "acceptance": { "passed": false, "tail": "" } }),
        json!({ "status": "done", "acceptance": { "passed": true, "tail": "" } }),
        json!({ "status": "partial", "acceptance": { "passed": false } }),
    ] {
        let answer = ask("result_check", state);
        assert_eq!(answer["confidence"], json!(0.6));
    }
}

// TS: classify-rules.test.ts:122.
#[test]
fn result_check_without_acceptance_passes_only_done() {
    for status in ["done", "partial", "failed", "limit", "stopped"] {
        let answer = ask("result_check", json!({ "status": status }));
        assert_eq!(answer["value"], json!(status == "done"));
        assert_eq!(answer["confidence"], json!(0.5));
    }
    let cmd_only = ask("result_check", json!({ "status": "done", "acceptance": { "cmd": "bun test" } }));
    assert_eq!(cmd_only["value"], json!(true));
    assert_eq!(cmd_only["confidence"], json!(0.5));
}

// TS: classify-rules.test.ts:129.
#[test]
fn unknown_question_id_throws() {
    let error = rules::ask_rule("unknown", "{}").unwrap_err();
    assert_eq!(error.code, "internal");
    assert!(error.message.contains("unknown"));
}

// Unparsable state propagates an internal error, as `JSON.parse` throws in TS
// (rules.ts:8). The goldentable adapter test drives `ask("{")` to reject.
#[test]
fn unparsable_state_rejects() {
    let error = rules::ask_rule("task_kind", "{").unwrap_err();
    assert_eq!(error.code, "internal");
}