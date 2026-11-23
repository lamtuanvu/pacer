//! The local `rules` classifier, a port of `plugins/pacer-classify/rules.ts`.
//!
//! A pure classifier over the parsed state: it answers `task_kind`,
//! `difficulty`, `guard`, and `result_check` without any host capability.

use pacer_plugin::{PluginError, js};
use regex::Regex;
use serde_json::{Map, Value, json};

/// Source-compatible task kinds (rules.ts:4-7).
pub const KINDS: &[&str] = &[
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
];

const KEYWORDS: &[(&str, &str)] = &[
    ("tests", r"(?i-u)\b(tests?|testing)\b"),
    ("docs", r"(?i-u)\b(docs?|documentation)\b"),
    ("rename", r"(?i-u)\b(rename|renaming)\b"),
    ("migration", r"(?i-u)\b(migrate|migration|migrating)\b"),
    ("debug", r"(?i-u)\b(debug|debugging|bug|bugs|fix)\b"),
    ("refactor", r"(?i-u)\b(refactor|refactoring)\b"),
    ("performance", r"(?i-u)\b(performance|optimize|optimization|optimizing)\b"),
    ("boilerplate", r"(?i-u)\b(boilerplate|scaffold|scaffolding)\b"),
    ("research", r"(?i-u)\b(research|investigate|investigation)\b"),
];

const BASE_SCORES: &[(&str, f64)] = &[
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
];

const ALLOWED_NAMES: &'static [&'static str] =
    &["Explore", "Plan", "claude-code-guide", "statusline-setup"];
const ALLOWED_PATTERNS: &[&str] = &[
    r"(?i-u)reviewer",
    r"(?i-u)analyzer",
    r"^pr-review-toolkit:",
    r"^pacer[-:]",
    r"-executor$",
];

fn brief_text(input: &Map<String, Value>) -> String {
    ["goal", "scope", "context", "constraints"]
        .iter()
        .filter_map(|key| input.get(*key).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `answer(value, confidence, probabilities?)` (rules.ts:37-39): the fixed
/// latency 0 and cost 0 plus optional probabilities.
fn answer(value: Value, confidence: f64, probabilities: Option<Map<String, Value>>) -> Value {
    let mut object = Map::new();
    object.insert("value".into(), value);
    if let Some(probabilities) = probabilities {
        object.insert("probabilities".into(), Value::Object(probabilities));
    }
    object.insert("confidence".into(), json!(confidence));
    object.insert("latencyMs".into(), json!(0i64));
    object.insert("costUsd".into(), json!(0i64));
    Value::Object(object)
}

/// `rulesClassifier.ask` (rules.ts:44-87), with `client` unknown for the
/// default switch arm.
pub fn ask_rule(question_id: &str, state: &str) -> Result<Value, PluginError> {
    let input = parse_state(state)?;
    let value = match question_id {
        "task_kind" => task_kind(&input),
        "difficulty" => difficulty(&input),
        "guard" => guard(&input),
        "result_check" => result_check(&input),
        other => {
            return Err(PluginError::new("internal", format!("Unknown question id: {other}")))
        }
    };
    Ok(value)
}

/// `parseState` (rules.ts:8); a JSON failure propagates as a plain `Error`
/// (code `internal`) just as `JSON.parse` throws in TS.
fn parse_state(state: &str) -> Result<Map<String, Value>, PluginError> {
    serde_json::from_str(state).map_err(|_| PluginError::new("internal", "state must be valid JSON"))
}

fn task_kind(input: &Map<String, Value>) -> Value {
    if let Some(kind) = input.get("planner_kind").and_then(Value::as_str) {
        if KINDS.contains(&kind) {
            return answer(json!(kind), 1.0, None);
        }
    }
    let text = brief_text(input);
    let matches: Vec<&str> = KEYWORDS
        .iter()
        .filter(|(_, pattern)| regex_is_match(pattern, &text))
        .map(|(kind, _)| *kind)
        .collect();
    if matches.len() == 1 {
        return answer(json!(matches[0]), 0.7, None);
    }
    if matches.is_empty() && regex_is_match(r"(?i-u)\b(add|implement|build|create|support)\b", &text) {
        return answer(json!("feature"), 0.6, None);
    }
    answer(json!("default"), 0.5, None)
}

fn difficulty(input: &Map<String, Value>) -> Value {
    let mut score = input
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|kind| BASE_SCORES.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s))
        .unwrap_or(0.7);
    if js::utf16_len(&brief_text(input)) > 2000 {
        score -= 0.1;
    }
    let scope_items = input
        .get("scope")
        .and_then(Value::as_str)
        .map(|s| {
            s.split(|c| c == ',' || c == '\n')
                .filter(|item| !js::trim(item).is_empty())
                .count()
        })
        .unwrap_or(0);
    if scope_items > 5 {
        score -= 0.1;
    }
    if let Some(files) = input.get("repo_files").and_then(Value::as_f64) {
        if files > 5000.0 {
            score -= 0.1;
        }
    }
    // Math.round(Math.max(0, Math.min(1, score)) * 100) / 100 (rules.ts:67).
    let clamped = score.max(0.0).min(1.0);
    let rounded = (clamped * 100.0).round() / 100.0;
    answer(crate::http::js_number(rounded), 0.6, None)
}

fn guard(input: &Map<String, Value>) -> Value {
    let kind = input
        .get("subagent_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let allowed = ALLOWED_NAMES.contains(&kind)
        || ALLOWED_PATTERNS.iter().any(|pattern| regex_is_match(pattern, kind));
    let execution = !allowed;
    let probabilities = if execution {
        Map::from_iter([
            ("yes".into(), json!(0.9)),
            ("no".into(), json!(0.1)),
        ])
    } else {
        Map::from_iter([
            ("yes".into(), json!(0.1)),
            ("no".into(), json!(0.9)),
        ])
    };
    answer(json!(execution), 0.9, Some(probabilities))
}

fn result_check(input: &Map<String, Value>) -> Value {
    if let Some(acceptance) = input.get("acceptance") {
        if let Some(object) = acceptance.as_object() {
            if let Some(passed) = object.get("passed").and_then(Value::as_bool) {
                let tail = object
                    .get("tail")
                    .and_then(Value::as_str)
                    .map(|s| js::trim(s))
                    .unwrap_or("");
                let confidence = if !tail.is_empty() { 0.95 } else { 0.6 };
                return answer(json!(passed), confidence, None);
            }
        }
    }
    let done = input.get("status").and_then(Value::as_str) == Some("done");
    answer(json!(done), 0.5, None)
}

fn regex_is_match(pattern: &str, text: &str) -> bool {
    Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}