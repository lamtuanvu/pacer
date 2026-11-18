//! Learned fit (`applyLearnedFit` in `src/dispatch/learning.ts`) over the review
//! rows of the read-only task store (`readOnlyReviewReader`). A store without
//! the tables yields no history rather than creating them.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::{Code, CoreError};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

use crate::hash::decision_hash;
use crate::js::{Object, js_string, num, object, strict_eq, to_number, truthy};
use crate::readonly::{ReadOnlyStore, parse_cell};

/// `dispatchSettingsHash(strategy, executor)`.
pub(crate) fn settings_hash(strategy: &Value, executor: &str) -> String {
    let runner = strategy["runners"].get(executor);
    let field = |key: &str| runner.and_then(|r| r.get(key)).cloned();
    decision_hash(&object([
        ("agent", field("agent")),
        ("account", field("account")),
        ("host", field("host")),
        ("provider", strategy["providers"].get(executor).cloned()),
        ("dispatch", strategy["dispatch"].get("engine").cloned()),
    ]))
}

/// `SELECT at FROM work_learning_reset` as `?.at ?? 0` reads it.
fn reset_cell(cell: ValueRef<'_>) -> f64 {
    match cell {
        ValueRef::Null => 0.0,
        ValueRef::Integer(n) => n as f64,
        ValueRef::Real(n) => n,
        ValueRef::Text(text) => to_number(Some(&json!(String::from_utf8_lossy(text)))),
        ValueRef::Blob(_) => f64::NAN,
    }
}

/// `rows(ctx, readOnlyReviewReader(store))`: human and requesting-agent reviews
/// outside excluded repositories and newer than the repository's reset.
fn reviews(store: &ReadOnlyStore) -> Result<Vec<Object>, CoreError> {
    if !store.has("work_reviews") {
        return Ok(Vec::new());
    }
    let cells = store.query("SELECT data FROM work_reviews", [], |row| {
        Ok(parse_cell(row.get_ref(0)?))
    })?;
    let mut rows = Vec::new();
    for row in cells.into_iter().flatten() {
        match row {
            Value::Object(row) => {
                let provenance = row.get("provenance").and_then(Value::as_str);
                if matches!(provenance, Some("human" | "requesting-agent")) {
                    rows.push(row);
                }
            }
            // `null.provenance` throws in TypeScript.
            Value::Null => {
                return Err(CoreError::new(Code::Internal, "A work review row is null"));
            }
            _ => {}
        }
    }
    let mut kept = Vec::new();
    for row in rows {
        let repo = row.get("repo").and_then(Value::as_str);
        let excluded = match repo {
            Some(repo) if store.has("work_learning_exclusions") => {
                let sql = "SELECT 1 FROM work_learning_exclusions WHERE repo=?";
                !store.query(sql, [repo], |_| Ok(()))?.is_empty()
            }
            _ => false,
        };
        if !excluded {
            kept.push(row);
        }
    }
    let mut out = Vec::new();
    for row in kept {
        let reset = match row.get("repo").and_then(Value::as_str) {
            Some(repo) if store.has("work_learning_reset") => {
                let sql = "SELECT at FROM work_learning_reset WHERE repo=?";
                let at = store.query(sql, [repo], |r| Ok(reset_cell(r.get_ref(0)?)))?;
                at.first().copied().unwrap_or(0.0)
            }
            _ => 0.0,
        };
        if to_number(row.get("at")) > reset {
            out.push(row);
        }
    }
    Ok(out)
}

/// `aggregate`'s acceptance rate and the half-width of its 95% Wilson interval.
fn wilson(items: &[&Object]) -> (f64, f64, f64) {
    let n = items.len() as f64;
    let wins = items.iter().filter(|r| truthy(r.get("accepted"))).count() as f64;
    let p = if n > 0.0 { wins / n } else { 0.0 };
    let z = 1.96_f64;
    let half = if n > 0.0 {
        z * ((p * (1.0 - p) + z * z / (4.0 * n)) / n).sqrt() / (1.0 + z * z / n)
    } else {
        0.5
    };
    (p, n, half)
}

/// `applyLearnedFit(ctx, strategy, candidates, task.kind, task.difficulty, readOnlyReviewReader(store))`:
/// with `dispatch.learning.enabled`, a candidate with an actual model and at
/// least `minSamples` comparable reviews from the last `maxAgeDays` gains a
/// `learnedFit`. Reviews are read only when learning is enabled.
pub fn apply_learned_fit(
    strategy: &Value,
    candidates: Vec<Object>,
    task: &Value,
    now: f64,
    store: &ReadOnlyStore,
) -> Result<Vec<Object>, CoreError> {
    let config = &strategy["dispatch"]["learning"];
    if !truthy(config.get("enabled")) {
        return Ok(candidates);
    }
    let since = now - to_number(config.get("maxAgeDays")) * 86400.0;
    let reviews: Vec<Object> = reviews(store)?
        .into_iter()
        .filter(|r| to_number(r.get("at")) >= since)
        .collect();
    let minimum = to_number(config.get("minSamples"));
    let fit = |mut candidate: Object| {
        let model = candidate.get("actualModel");
        if !truthy(model) {
            return candidate;
        }
        let runner = candidate.get("runner");
        let settings = json!(settings_hash(strategy, &js_string(runner)));
        let comparable: Vec<&Object> = reviews
            .iter()
            .filter(|r| {
                strict_eq(r.get("kind"), task.get("kind"))
                    && strict_eq(r.get("difficulty"), task.get("difficulty"))
                    && strict_eq(r.get("runner"), runner)
                    && strict_eq(r.get("model"), model)
                    && strict_eq(r.get("settings"), Some(&settings))
            })
            .collect();
        if (comparable.len() as f64) < minimum {
            return candidate;
        }
        let (rate, samples, uncertainty) = wilson(&comparable);
        let fit = json!({"successRate": num(rate), "sampleCount": num(samples),
            "uncertainty": num(uncertainty)});
        candidate.insert("learnedFit".into(), fit);
        candidate
    };
    Ok(candidates.into_iter().map(fit).collect())
}
