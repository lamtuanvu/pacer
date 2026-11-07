//! Native `insights.summary`, matching `insightsSummary` in `src/insights/summary.ts`.
//! A pure read over the task store, the first-settle index and the attempt usage index.
#![allow(clippy::result_large_err)]
use std::{cmp::Ordering, collections::HashMap, collections::HashSet};

use icu_collator::CollatorBorrowed;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::AdmissionState;
use rusqlite::{Connection, types::Value as Sql};
use serde_json::{Map, Value, json};

use crate::dispatch_ops::{finish, params_object, type_name};
use crate::learning_ops::num;

const AGENTS: [&str; 5] = ["claude-code", "codex", "cursor", "agy", "opencode"];
const DAY: f64 = 86400.0;
/// Integral inputs above this print differently in `JSON.stringify` and serde_json.
const MAX_EXACT: f64 = 1e15;

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// Requests whose echoed numbers only TypeScript formats.
pub fn insights_stays_forwarded(op: &str, params: &Value) -> bool {
    op == "insights.summary"
        && ["from", "to"].iter().any(|key| {
            params
                .get(key)
                .and_then(Value::as_f64)
                .is_some_and(|n| n.abs() >= MAX_EXACT)
        })
}

fn segment(s: &str) -> bool {
    let mut bytes = s.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `parseRunnerId(executor)?.agent ?? executor`.
fn agent_of(executor: &str) -> &str {
    let (rest, host) = match executor.split_once('@') {
        Some((rest, host)) => (rest, Some(host)),
        None => (executor, None),
    };
    let (agent, account) = match rest.split_once('#') {
        Some((agent, account)) => (agent, Some(account)),
        None => (rest, None),
    };
    let valid = segment(agent)
        && account.is_none_or(segment)
        && host.is_none_or(segment)
        && AGENTS.contains(&agent);
    if valid { agent } else { executor }
}

/// `Object.fromEntries`: integer-like keys come first in ascending order.
fn js_object(entries: Vec<(String, Value)>) -> Value {
    let index = |k: &str| {
        (k == "0"
            || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())))
        .then(|| k.parse::<u64>().ok())
        .flatten()
        .filter(|n| *n < u64::from(u32::MAX))
    };
    let mut indexed: Vec<_> = entries
        .iter()
        .filter_map(|(k, v)| Some((index(k)?, k, v)))
        .collect();
    indexed.sort_by_key(|(n, _, _)| *n);
    let mut out = Map::new();
    for (_, k, v) in indexed {
        out.insert(k.clone(), v.clone());
    }
    for (k, v) in entries {
        if index(&k).is_none() {
            out.insert(k, v);
        }
    }
    Value::Object(out)
}

/// `String(x)` for parsed JSON values.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(f64::NAN)).to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                v => js_string(Some(v)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String.prototype.slice(0, n)` for strings whose cut does not split a surrogate pair.
fn slice_units(s: &str, max: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

fn opt_num(value: &Sql) -> Option<f64> {
    match value {
        Sql::Integer(n) => Some(*n as f64),
        Sql::Real(n) => Some(*n),
        _ => None,
    }
}

fn text(value: &Sql) -> Option<&str> {
    match value {
        Sql::Text(s) => Some(s),
        _ => None,
    }
}

#[derive(Default, Clone)]
struct Sums {
    total: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    measured: f64,
    partial: f64,
    unknown: f64,
}

impl Sums {
    fn add(&mut self, r: &Row) {
        self.total += r.total;
        self.input += r.input;
        self.output += r.output;
        self.cache_read += r.cache_read;
        self.cache_write += r.cache_write;
        match r.coverage.as_str() {
            "measured" => self.measured += 1.0,
            "partial" => self.partial += 1.0,
            _ => self.unknown += 1.0,
        }
    }
    fn write(&self, out: &mut Map<String, Value>) {
        for (key, value) in [
            ("total", self.total),
            ("input", self.input),
            ("output", self.output),
            ("cacheRead", self.cache_read),
            ("cacheWrite", self.cache_write),
            ("measuredAttempts", self.measured),
            ("partialAttempts", self.partial),
            ("unknownAttempts", self.unknown),
        ] {
            out.insert(key.into(), num(value));
        }
    }
}

struct Row {
    task_id: String,
    attempt: f64,
    root_id: String,
    executor: String,
    kind: Option<String>,
    outcome: Option<String>,
    ladder_rule: Option<String>,
    ended_at: f64,
    coverage: String,
    total: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    skipped: Sql,
    fallback: Option<String>,
    why: Option<String>,
}

type Ids = HashSet<String>;

#[derive(Default)]
struct Agent {
    tasks: HashSet<String>,
    roots: HashSet<String>,
    children: HashSet<String>,
    attempts: f64,
    sums: Sums,
    accepted: f64,
    judged: f64,
}

fn rows(db: &Connection, from: f64, to: f64, repo: &str) -> Result<Vec<Row>, CoreError> {
    let mut stmt = db.prepare("SELECT u.task_id,u.attempt,u.root_id,u.executor,u.kind,u.outcome,u.ladder_rule,u.ended_at,u.coverage,u.total,u.input,u.output,u.cache_read,u.cache_write,
       json_extract(t.record,'$.attempts['||(u.attempt-1)||'].routing.skipped') AS skipped,
       json_extract(t.record,'$.attempts['||(u.attempt-1)||'].routing.fallback') AS fallback,
       json_extract(t.record,'$.attempts['||(u.attempt-1)||'].routing.why') AS why
     FROM attempt_usage u LEFT JOIN tasks t ON t.id=u.task_id WHERE u.ended_at>=? AND u.ended_at<? AND (?='' OR u.repo_key=?)").map_err(internal)?;
    let rows = stmt
        .query_map(rusqlite::params![from, to, repo, repo], |r| {
            let v = |i: usize| r.get::<_, Sql>(i);
            let s = |i: usize| -> rusqlite::Result<Option<String>> {
                Ok(text(&v(i)?).map(str::to_owned))
            };
            let n = |i: usize| -> rusqlite::Result<f64> { Ok(opt_num(&v(i)?).unwrap_or(0.0)) };
            Ok(Row {
                task_id: s(0)?.unwrap_or_default(),
                attempt: n(1)?,
                root_id: s(2)?.unwrap_or_default(),
                executor: s(3)?.unwrap_or_default(),
                kind: s(4)?,
                outcome: s(5)?,
                ladder_rule: s(6)?,
                ended_at: n(7)?,
                coverage: s(8)?.unwrap_or_default(),
                total: n(9)?,
                input: n(10)?,
                output: n(11)?,
                cache_read: n(12)?,
                cache_write: n(13)?,
                skipped: v(14)?,
                fallback: s(15)?,
                why: s(16)?,
            })
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(rows)
}

/// `for (const s of JSON.parse(r.skipped))`, stopping where TypeScript throws.
fn skip_entries(skipped: &Sql) -> Vec<(String, String)> {
    let parsed = match skipped {
        Sql::Text(s) if !s.is_empty() => serde_json::from_str::<Value>(s).ok(),
        _ => None,
    };
    let entry = |s: Option<&Value>| {
        let field = |k: &str| s.and_then(|s| s.as_object()).and_then(|m| m.get(k));
        (
            agent_of(&js_string(field("executor"))).to_owned(),
            slice_units(&js_string(field("reason")), 200),
        )
    };
    match parsed {
        Some(Value::Array(items)) => items
            .iter()
            .take_while(|item| !item.is_null())
            .map(|item| entry(Some(item)))
            .collect(),
        Some(Value::String(s)) => s.chars().map(|_| entry(None)).collect(),
        _ => Vec::new(),
    }
}

fn period(
    db: &Connection,
    from: f64,
    to: f64,
    repo: &str,
    step: f64,
) -> Result<Map<String, Value>, CoreError> {
    let collator = CollatorBorrowed::new_root(Default::default());
    let compare = |a: &str, b: &str| collator.compare(a, b);
    let mut roots = db.prepare("SELECT t.id, json_extract(t.record,'$.review.accepted') AS accepted FROM tasks t JOIN task_first_settle f ON f.task_id=t.id
     LEFT JOIN work_nodes n ON n.task_id=t.id
     WHERE f.at>=? AND f.at<? AND (n.task_id IS NULL OR n.parent_id IS NULL) AND (?='' OR json_extract(t.record,'$.repo.key')=?)").map_err(internal)?;
    let roots = roots
        .query_map(rusqlite::params![from, to, repo, repo], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Sql>(1)?))
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let mut in_tree = db.prepare("SELECT t.id AS task_id, COALESCE(n.root_id,t.id) AS root_id, json_array_length(t.record,'$.attempts') AS attempts FROM tasks t LEFT JOIN work_nodes n ON n.task_id=t.id WHERE COALESCE(n.root_id,t.id)=?").map_err(internal)?;
    let (mut attempts_in_trees, mut retry_attempts, mut accepted_first_try, mut reviewed) =
        (0.0, 0.0, 0.0, 0.0);
    for (id, accepted) in &roots {
        let attempts = in_tree
            .query_map([id], |r| Ok(opt_num(&r.get::<_, Sql>(2)?).unwrap_or(0.0)))
            .map_err(internal)?
            .collect::<rusqlite::Result<Vec<f64>>>()
            .map_err(internal)?;
        attempts_in_trees += attempts.iter().sum::<f64>();
        retry_attempts += attempts.iter().map(|n| (n - 1.0).max(0.0)).sum::<f64>();
        if !matches!(accepted, Sql::Null) {
            reviewed += 1.0;
        }
        if opt_num(accepted) == Some(1.0) && attempts.iter().all(|n| *n <= 1.0) {
            accepted_first_try += 1.0;
        }
    }
    let rows = rows(db, from, to, repo)?;
    let mut all = Sums::default();
    let mut agents: Vec<(String, Agent)> = Vec::new();
    let mut series: Vec<(f64, Vec<(String, f64)>)> = Vec::new();
    let mut kinds: Vec<(String, Vec<(String, Ids)>)> = Vec::new();
    let mut ladder: Vec<(String, f64)> = Vec::new();
    let mut steps: HashMap<&str, f64> = HashMap::new();
    let mut skips: Vec<(String, String, f64)> = Vec::new();
    let (mut retry_total, mut retry_unknown, mut retry_count) = (0.0, 0.0, 0.0);
    let mut root_ids = HashSet::new();
    let mut child_ids = HashSet::new();
    fn slot<K: PartialEq, V: Default>(list: &mut Vec<(K, V)>, key: K) -> &mut V {
        let at = match list.iter().position(|(k, _)| *k == key) {
            Some(at) => at,
            None => {
                list.push((key, V::default()));
                list.len() - 1
            }
        };
        &mut list[at].1
    }
    for r in &rows {
        root_ids.insert(r.root_id.clone());
        if r.task_id != r.root_id {
            child_ids.insert(r.task_id.clone());
        }
        all.add(r);
        let agent = agent_of(&r.executor).to_owned();
        let g = slot(&mut agents, agent.clone());
        g.tasks.insert(r.task_id.clone());
        g.roots.insert(r.root_id.clone());
        g.attempts += 1.0;
        g.sums.add(r);
        if r.task_id != r.root_id {
            g.children.insert(r.task_id.clone());
        }
        match r.outcome.as_deref() {
            Some("accepted") => {
                g.judged += 1.0;
                g.accepted += 1.0;
            }
            Some("rejected") => g.judged += 1.0,
            _ => {}
        }
        let at = (r.ended_at / step).floor() * step;
        *slot(slot(&mut series, at), agent.clone()) += r.total;
        let kind = r.kind.clone().unwrap_or_else(|| "other".into());
        slot(slot(&mut kinds, kind), agent.clone()).insert(r.task_id.clone());
        if let Some(rule) = r.ladder_rule.as_ref().filter(|rule| !rule.is_empty()) {
            *slot(&mut ladder, rule.clone()) += 1.0;
            let busy = r.why.as_deref().is_some_and(|why| why.contains("busy"));
            let key = if r.fallback.as_deref() == Some("uncertain") || busy {
                "2"
            } else {
                "1"
            };
            *steps.entry(key).or_default() += 1.0;
        }
        if r.attempt > 1.0 {
            retry_total += r.total;
            if r.coverage == "unknown" {
                retry_unknown += 1.0;
            }
            retry_count += 1.0;
        }
        for (agent, reason) in skip_entries(&r.skipped) {
            match skips
                .iter_mut()
                .find(|(a, s, _)| *a == agent && *s == reason)
            {
                Some(entry) => entry.2 += 1.0,
                None => skips.push((agent, reason, 1.0)),
            }
        }
    }
    let by_total = |a: f64, b: f64| b.partial_cmp(&a).unwrap_or(Ordering::Equal);
    agents.sort_by(|(an, a), (bn, b)| {
        by_total(a.sums.total, b.sums.total).then_with(|| compare(an, bn))
    });
    let spread: Vec<Value> = agents
        .iter()
        .map(|(name, g)| {
            let mut out = Map::new();
            out.insert("agent".into(), json!(name));
            out.insert("rootTasks".into(), json!(g.roots.len()));
            out.insert("tasks".into(), json!(g.tasks.len()));
            out.insert("subtasks".into(), json!(g.children.len()));
            out.insert("attempts".into(), num(g.attempts));
            g.sums.write(&mut out);
            let tasks = g.tasks.len() as f64;
            let share = if all.total > 0.0 {
                num(g.sums.total / all.total)
            } else {
                Value::Null
            };
            let per_task = if tasks > 0.0 {
                num(js_round(g.sums.total / tasks))
            } else {
                Value::Null
            };
            let rate = if g.judged > 0.0 {
                num(g.accepted / g.judged)
            } else {
                Value::Null
            };
            out.insert("share".into(), share);
            out.insert("tokensPerTask".into(), per_task);
            out.insert("acceptanceRate".into(), rate);
            Value::Object(out)
        })
        .collect();
    series.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let daily: Vec<Value> = series
        .into_iter()
        .map(|(at, m)| json!({"at": num(at), "byAgent": js_object(m.into_iter().map(|(a, n)| (a, num(n))).collect())}))
        .collect();
    kinds.sort_by(|a, b| compare(&a.0, &b.0));
    let kind_by_agent: Vec<Value> = kinds
        .into_iter()
        .map(|(kind, m)| json!({"kind": kind, "byAgent": js_object(m.into_iter().map(|(a, s)| (a, json!(s.len()))).collect())}))
        .collect();
    let names = [
        ("1", "Capable model with spare capacity"),
        ("2", "Usable fallback"),
        ("P", "Kept on the planner"),
        ("Q", "Queued until an agent was free"),
    ];
    let ladder_steps: Vec<Value> = names
        .iter()
        .filter_map(|(k, name)| {
            steps
                .get(k)
                .map(|count| json!({"step": k, "name": name, "count": num(*count)}))
        })
        .collect();
    ladder.sort_by(|a, b| by_total(a.1, b.1).then_with(|| compare(&a.0, &b.0)));
    let rules: Vec<Value> = ladder
        .into_iter()
        .map(|(rule, count)| json!({"rule": rule, "count": num(count)}))
        .collect();
    skips.sort_by(|a, b| by_total(a.2, b.2).then_with(|| compare(&a.1, &b.1)));
    let skip_reasons: Vec<Value> = skips
        .into_iter()
        .take(20)
        .map(
            |(agent, reason, count)| json!({"agent": agent, "reason": reason, "count": num(count)}),
        )
        .collect();
    let mut tokens = Map::new();
    all.write(&mut tokens);
    tokens.insert("attempts".into(), json!(rows.len()));
    tokens.insert(
        "lowerBound".into(),
        json!(all.unknown > 0.0 || all.partial > 0.0),
    );
    let mut out = Map::new();
    for (key, value) in [
        ("rootTasksHandled", json!(root_ids.len())),
        ("subtasks", json!(child_ids.len())),
        ("attempts", num(attempts_in_trees)),
        ("retryAttempts", num(retry_attempts)),
        ("acceptedFirstTry", num(accepted_first_try)),
        ("reviewedRoots", num(reviewed)),
        (
            "acceptedFirstTryRate",
            if reviewed > 0.0 {
                num(accepted_first_try / reviewed)
            } else {
                Value::Null
            },
        ),
        ("tokens", Value::Object(tokens)),
        ("spread", Value::Array(spread)),
        ("daily", Value::Array(daily)),
        ("kindByAgent", Value::Array(kind_by_agent)),
        ("ladder", Value::Array(ladder_steps)),
        ("rules", Value::Array(rules)),
        (
            "retryTokens",
            json!({"attempts": num(retry_count), "total": num(retry_total), "unknownAttempts": num(retry_unknown)}),
        ),
        ("skipReasons", Value::Array(skip_reasons)),
    ] {
        out.insert(key.into(), value);
    }
    Ok(out)
}

/// `Math.round`: halves round towards positive infinity.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

struct Input {
    from: f64,
    to: f64,
    repo: Option<String>,
    bucket: &'static str,
}

/// `insightsInputSchema`: field issues in shape order, unknown keys, then the period refinements.
fn input(params: &Value) -> Result<Input, CoreError> {
    let p = params_object(params)?;
    let mut issues = Vec::new();
    let mut number = |key: &str, positive: bool| -> Option<f64> {
        match p.get(key) {
            Some(Value::Number(n)) => {
                let n = n.as_f64().unwrap_or(f64::NAN);
                if positive && n <= 0.0 {
                    issues.push(format!("{key}: Too small: expected number to be >0"));
                } else if !positive && n < 0.0 {
                    issues.push(format!("{key}: Too small: expected number to be >=0"));
                }
                Some(n)
            }
            other => {
                issues.push(format!(
                    "{key}: Invalid input: expected number, received {}",
                    other.map_or("undefined", type_name)
                ));
                None
            }
        }
    };
    let from = number("from", false);
    let to = number("to", true);
    let repo = match p.get("repo") {
        None => None,
        Some(Value::String(s)) => {
            let units = s.chars().count();
            if units < 1 {
                issues.push("repo: Too small: expected string to have >=1 characters".into());
            } else if units > 512 {
                issues.push("repo: Too big: expected string to have <=512 characters".into());
            }
            Some(s.clone())
        }
        Some(other) => {
            issues.push(format!(
                "repo: Invalid input: expected string, received {}",
                type_name(other)
            ));
            None
        }
    };
    let bucket = match p.get("bucket").map(Value::as_str) {
        None | Some(Some("day")) => "day",
        Some(Some("week")) => "week",
        Some(_) => {
            issues.push("bucket: Invalid option: expected one of \"day\"|\"week\"".into());
            "day"
        }
    };
    let field_issues = !issues.is_empty();
    let unknown: Vec<String> = p
        .keys()
        .filter(|k| !["from", "to", "repo", "bucket"].contains(&k.as_str()))
        .map(|k| format!("\"{k}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
    if !field_issues && let (Some(from), Some(to)) = (from, to) {
        if to <= from {
            issues.push("params: to must be after from".into());
        }
        if to - from > 400.0 * DAY {
            issues.push("params: period is limited to 400 days".into());
        }
    }
    finish(issues)?;
    Ok(Input {
        from: from.unwrap_or_default(),
        to: to.unwrap_or_default(),
        repo,
        bucket,
    })
}

pub fn insights_summary(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        if ctx
            .env
            .get("PACER_ENFORCEMENT_TOKEN")
            .is_some_and(|t| !t.is_empty())
        {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Enforcement identity only reports a native child denial",
            ));
        }
        let Input {
            from,
            to,
            repo,
            bucket,
        } = input(&params)?;
        let step = if bucket == "week" { 7.0 * DAY } else { DAY };
        let mut state = AdmissionState::open(&ctx.pacer_home).map_err(|e| internal(e.0))?;
        let db = state.tasks.connection().map_err(internal)?;
        let key = repo.as_deref().unwrap_or("");
        let current = period(db, from, to, key, step)?;
        let span = to - from;
        let previous = period(db, from - span, from, key, step)?;
        let mut out = Map::new();
        out.insert("from".into(), num(from));
        out.insert("to".into(), num(to));
        out.insert("bucket".into(), json!(bucket));
        if let Some(repo) = repo {
            out.insert("repo".into(), json!(repo));
        }
        out.extend(current);
        out.insert("planner".into(), json!({"coverage": "unknown"}));
        out.insert("decision".into(), json!({"coverage": "unknown"}));
        out.insert("ranOutsidePlanner".into(), Value::Null);
        let mut prev = Map::new();
        for key in [
            "rootTasksHandled",
            "subtasks",
            "retryAttempts",
            "acceptedFirstTryRate",
            "tokens",
        ] {
            prev.insert(
                key.into(),
                previous.get(key).cloned().unwrap_or(Value::Null),
            );
        }
        out.insert("previous".into(), Value::Object(prev));
        Ok(Value::Object(out))
    })
}

#[cfg(test)]
#[path = "insights_ops/tests.rs"]
mod tests;
