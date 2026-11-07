//! Native `dispatch.analytics` and `dispatch.learning.reset`, matching
//! `dispatchAnalytics` and `resetLearning` in `src/dispatch/learning.ts`.
//! Callers holding a work grant never reach these handlers.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::AdmissionState;
use rusqlite::{
    Connection, OptionalExtension, Transaction, TransactionBehavior, types::Value as Sql,
};
use serde_json::{Map, Value, json};

use crate::dispatch_ops::{authorize, finish, params_object, string_issues, type_name};

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// A JavaScript number as `JSON.stringify` writes it.
pub(crate) fn num(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `JSON.parse` followed by `JSON.stringify`: integral numbers lose their fraction.
fn js_value(value: Option<&Value>) -> Value {
    match value {
        None => Value::Null,
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => {
            Value::Array(items.iter().map(|v| js_value(Some(v))).collect())
        }
        Some(Value::Object(map)) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), js_value(Some(v))))
                .collect(),
        ),
        Some(other) => other.clone(),
    }
}

pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `+x` for the number fields of a review row; `null` counts as zero.
fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    }
}

fn bind(value: Option<&Value>) -> Sql {
    match value {
        Some(Value::String(s)) => Sql::Text(s.clone()),
        Some(Value::Number(n)) => n
            .as_i64()
            .map_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0)), Sql::Integer),
        Some(Value::Bool(b)) => Sql::Integer(i64::from(*b)),
        _ => Sql::Null,
    }
}

fn open(ctx: &Ctx) -> Result<AdmissionState, CoreError> {
    AdmissionState::open(&ctx.pacer_home).map_err(|error| internal(error.0))
}

fn revision(db: &Connection, repo: &Sql) -> Result<f64, CoreError> {
    db.query_row(
        "SELECT at FROM work_learning_reset WHERE repo=?",
        [repo],
        |r| r.get::<_, Option<f64>>(0),
    )
    .optional()
    .map(|at| at.flatten().unwrap_or(0.0))
    .map_err(internal)
}

/// `rows`: parsed human and requesting-agent reviews outside excluded or reset repositories.
fn reviews(db: &Connection) -> Result<Vec<Map<String, Value>>, CoreError> {
    let mut stmt = db
        .prepare("SELECT data FROM work_reviews")
        .map_err(internal)?;
    let data = stmt
        .query_map([], |r| r.get::<_, Option<String>>(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let mut out = Vec::new();
    for text in data.into_iter().flatten() {
        let Ok(Value::Object(row)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !matches!(
            row.get("provenance").and_then(Value::as_str),
            Some("human" | "requesting-agent")
        ) {
            continue;
        }
        let repo = bind(row.get("repo"));
        let excluded = db
            .query_row(
                "SELECT 1 FROM work_learning_exclusions WHERE repo=?",
                [&repo],
                |_| Ok(()),
            )
            .optional()
            .map_err(internal)?
            .is_some();
        if !excluded && number(row.get("at")) > revision(db, &repo)? {
            out.push(row);
        }
    }
    Ok(out)
}

fn mean(values: &[f64]) -> Value {
    if values.is_empty() {
        Value::Null
    } else {
        num(values.iter().sum::<f64>() / values.len() as f64)
    }
}

/// `aggregate`: Wilson score interval at 95% plus average duration and usage.
fn aggregate(items: &[&Map<String, Value>], out: &mut Map<String, Value>) {
    let n = items.len() as f64;
    let wins = items.iter().filter(|r| truthy(r.get("accepted"))).count() as f64;
    let p = if n > 0.0 { wins / n } else { 0.0 };
    let z = 1.96;
    let center = if n > 0.0 {
        (p + z * z / (2.0 * n)) / (1.0 + z * z / n)
    } else {
        0.5
    };
    let half = if n > 0.0 {
        z * ((p * (1.0 - p) + z * z / (4.0 * n)) / n).sqrt() / (1.0 + z * z / n)
    } else {
        0.5
    };
    // A missing value is `undefined`, which turns the average into NaN (`null` on the wire).
    let present = |key: &str| -> Vec<f64> {
        items
            .iter()
            .filter(|r| r.get(key) != Some(&Value::Null))
            .map(|r| number(r.get(key)))
            .collect()
    };
    let latest = items
        .iter()
        .map(|r| number(r.get("at")))
        .fold(0.0_f64, |a, b| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else {
                a.max(b)
            }
        });
    for (key, value) in [
        ("sampleCount", num(n)),
        ("accepted", num(wins)),
        ("successRate", num(p)),
        ("uncertainty", num(half)),
        ("confidenceLower", num((center - half).max(0.0))),
        ("confidenceUpper", num((center + half).min(1.0))),
        ("averageDurationS", mean(&present("durationS"))),
        ("averageUsagePct", mean(&present("usagePct"))),
        ("latestAt", num(latest)),
    ] {
        out.insert(key.into(), value);
    }
}

fn optional_string(
    p: &Map<String, Value>,
    key: &str,
    max: Option<usize>,
    issues: &mut Vec<String>,
) {
    if p.contains_key(key) {
        if max.is_some() {
            string_issues(key, p.get(key), max, issues);
        } else if let Some(other) = p.get(key).filter(|v| !v.is_string()) {
            issues.push(format!(
                "{key}: Invalid input: expected string, received {}",
                type_name(other)
            ));
        }
    }
}

/// The group key text, its parsed values and the rows in first-seen order.
type Group<'a> = (String, Vec<Value>, Vec<&'a Map<String, Value>>);

pub fn dispatch_analytics(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        optional_string(&p, "repo", None, &mut issues);
        optional_string(&p, "kind", Some(128), &mut issues);
        finish(issues)?;
        let repo = p
            .get("repo")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty());
        let kind = p.get("kind").and_then(Value::as_str);
        let mut state = open(ctx)?;
        let db = state.tasks.connection().map_err(internal)?;
        let rows: Vec<Map<String, Value>> = reviews(db)?
            .into_iter()
            .filter(|r| repo.is_none_or(|repo| r.get("repo").and_then(Value::as_str) == Some(repo)))
            .filter(|r| kind.is_none_or(|kind| r.get("kind").and_then(Value::as_str) == Some(kind)))
            .collect();
        let mut groups: Vec<Group<'_>> = Vec::new();
        for row in &rows {
            let key: Vec<Value> = ["kind", "difficulty", "runner", "model", "settings"]
                .iter()
                .map(|k| js_value(row.get(*k)))
                .collect();
            let text = Value::Array(key.clone()).to_string();
            match groups.iter_mut().find(|(k, _, _)| *k == text) {
                Some((_, _, items)) => items.push(row),
                None => groups.push((text, key, vec![row])),
            }
        }
        groups.sort_by_key(|g| std::cmp::Reverse(g.2.len()));
        let groups: Vec<Value> = groups
            .into_iter()
            .map(|(_, key, items)| {
                let mut out = Map::new();
                for (name, value) in ["kind", "difficulty", "runner", "model", "settings"]
                    .iter()
                    .zip(key)
                {
                    out.insert((*name).into(), value);
                }
                aggregate(&items, &mut out);
                Value::Object(out)
            })
            .collect();
        let strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
        let minimum = strategy
            .pointer("/dispatch/learning/minSamples")
            .filter(|m| !m.is_null())
            .map_or(json!(20), |m| js_value(Some(m)));
        let learning_revision = match repo {
            Some(repo) => num(revision(db, &Sql::Text(repo.into()))?),
            None => Value::Null,
        };
        Ok(json!({
            "groups": groups,
            "totalReviews": rows.len(),
            "minimumSamples": minimum,
            "learningRevision": learning_revision,
        }))
    })
}

pub fn dispatch_learning_reset(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("repo", p.get("repo"), None, &mut issues);
        match p.get("excluded") {
            None | Some(Value::Bool(_)) => {}
            Some(other) => issues.push(format!(
                "excluded: Invalid input: expected boolean, received {}",
                type_name(other)
            )),
        }
        match p.get("expect_rev") {
            Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n < 0.0) => {
                issues.push("expect_rev: Too small: expected number to be >=0".into());
            }
            Some(Value::Number(_)) => {}
            other => issues.push(format!(
                "expect_rev: Invalid input: expected number, received {}",
                other.map_or("undefined", type_name)
            )),
        }
        finish(issues)?;
        let repo = p["repo"].as_str().unwrap_or_default();
        let excluded = p.get("excluded").and_then(Value::as_bool).unwrap_or(false);
        let expect = p["expect_rev"].as_f64().unwrap_or(f64::NAN);
        let now = (ctx.now * 1000.0).floor() / 1000.0;
        let mut state = open(ctx)?;
        let db = state.tasks.connection().map_err(internal)?;
        let tx =
            Transaction::new_unchecked(db, TransactionBehavior::Immediate).map_err(internal)?;
        let current = revision(&tx, &Sql::Text(repo.into()))?;
        if current != expect {
            return Err(CoreError::new(
                Code::Conflict,
                "Learning controls changed; reload before resetting",
            ));
        }
        let next = now.max(current + 0.001);
        tx.execute(
            "INSERT OR REPLACE INTO work_learning_reset(repo,at) VALUES(?,?)",
            rusqlite::params![repo, next],
        )
        .map_err(internal)?;
        let sql = if excluded {
            "INSERT OR IGNORE INTO work_learning_exclusions(repo) VALUES(?)"
        } else {
            "DELETE FROM work_learning_exclusions WHERE repo=?"
        };
        tx.execute(sql, [repo]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(json!({"reset": true, "excluded": excluded, "revision": num(next)}))
    })
}

#[cfg(test)]
#[path = "learning_ops/tests.rs"]
mod tests;
