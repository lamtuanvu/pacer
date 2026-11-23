//! Adapter surface tests for `pacer-classify`, ported from
//! `test/plugins-classify-adapters.test.ts` (C6). This file drives the golden
//! table of fixed, pre-extraction decision outputs across every question and
//! edge state through `rules::ask_rule`, and covers the `ask("{")` reject
//! that mirrors `JSON.parse` throwing in the TypeScript client.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_classify::rules;
use serde_json::{Map, Value, json};

const QUESTIONS: [&str; 4] = ["task_kind", "difficulty", "guard", "result_check"];

/// The 28 edge states from `test/plugins-classify-adapters.test.ts:17`.
fn states() -> Vec<Value> {
    let mut states: Vec<Value> = vec![json!({})];
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
        states.push(json!({ "planner_kind": kind, "goal": "tests docs" }));
    }
    for goal in [
        "Write tests",
        "Update docs",
        "Rename symbol",
        "Migrate data",
        "Fix bug",
        "Refactor",
        "Optimize performance",
        "Generate boilerplate",
        "Research protocol",
        "Add pagination",
        "Add tests and docs",
    ] {
        states.push(json!({ "goal": goal }));
    }
    states.push(json!({
        "kind": "performance",
        "goal": "x".repeat(2001),
        "scope": "a,b,c,d,e,f",
        "repo_files": 5001,
    }));
    states.push(json!({ "subagent_type": "pacer:reviewer" }));
    states.push(json!({ "subagent_type": "general-purpose" }));
    states.push(json!({ "acceptance": { "passed": false }, "status": "done" }));
    states.push(json!({ "status": "done" }));
    states
}

/// The fixed golden table, verbatim from `test/plugins-classify-adapters.test.ts`
/// lines 18-46 (fixed outputs captured from the pre-extraction implementation).
/// Row i is `[task_kind, difficulty, guard, result_check]` for `states()[i]`.
fn golden() -> Vec<[Value; 4]> {
    use serde_json::json;
    let row = |task_kind: Value, difficulty: Value, guard: Value, result_check: Value| {
        [task_kind, difficulty, guard, result_check]
    };
    vec![
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"boilerplate","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"tests","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"docs","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"rename","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"migration","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"feature","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"debug","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"refactor","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"performance","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"unfamiliar-code","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"research","confidence":1,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"tests","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"docs","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"rename","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"migration","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"debug","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"refactor","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"performance","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"boilerplate","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"research","confidence":0.7,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"feature","confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.15,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":false,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.1,"no":0.9}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":false,"confidence":0.6,"latencyMs":0,"costUsd":0}),
        ),
        row(
            json!({"value":"default","confidence":0.5,"latencyMs":0,"costUsd":0}),
            json!({"value":0.7,"confidence":0.6,"latencyMs":0,"costUsd":0}),
            json!({"value":true,"confidence":0.9,"latencyMs":0,"costUsd":0,"probabilities":{"yes":0.9,"no":0.1}}),
            json!({"value":true,"confidence":0.5,"latencyMs":0,"costUsd":0}),
        ),
    ]
}

#[test]
fn rules_preserve_captured_pre_extraction_decisions_over_all_questions_and_edge_states() {
    let states = states();
    let golden = golden();
    assert_eq!(states.len(), 28, "golden table has 28 edge states");
    assert_eq!(golden.len(), 28, "golden table has 28 rows");
    for (i, state) in states.iter().enumerate() {
        let state_json = state.to_string();
        for (j, question) in QUESTIONS.iter().enumerate() {
            let answer = rules::ask_rule(question, &state_json).unwrap();
            assert_eq!(
                &norm(&answer),
                &norm(&golden[i][j]),
                "row {i} ({state_json}) / question {question}"
            );
        }
    }
}

// JS `toEqual` treats `1` and `1.0` as the same number; serde_json's `Value`
// distinguishes the integer 1 from the float 1.0. Normalize every number to
// a float when comparing so the golden table stays faithful to the upstream
// `expect(...).toEqual(...)` assertion.
fn norm(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap_or(f64::NAN)),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), norm(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(norm).collect()),
        other => other.clone(),
    }
}

// TS: plugins-classify-adapters.test.ts:47 — `JSON.parse` throws on `{`.
#[test]
fn unparsable_state_rejects_with_internal_error() {
    let error = rules::ask_rule("task_kind", "{").unwrap_err();
    assert_eq!(error.code, "internal");
}