//! Store-only `taskDetail` composition for a later native `task.get` registration.
//! Git diffstat/branch probes, token roll-ups, retry options, dispatch `work` /
//! `managedSkip`, agent-check acceptance gating and the activity timeline tail
//! stay on TypeScript until their bridges exist.
use crate::{Error, js::truth, snapshot::ActiveCounts, tasks::api_task_page};
use pacer_foundation::Ctx;
use pacer_store::{TaskFilter, TaskStore};
use serde_json::{Value, json};

const TERMINAL: &[&str] = &[
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn array(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn executor_display(id: &str) -> &str {
    match id {
        "claude-code" => "Claude",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "agy" => "Antigravity",
        "byteplus" => "BytePlus",
        "opencode" => "OpenCode",
        "local" => "Local model",
        _ => "the executor",
    }
}

fn overlaps(account: Option<&str>, a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    account.is_some_and(|acct| !acct.is_empty()) && a0 < b1 && b0 < a1
}

/// Match `src/core/task-detail.ts` `costFor` using only stored task records.
pub fn executor_cost(task: &Value, peers: &[Value], now: f64) -> Value {
    let attempts = array(&task["attempts"]);
    let last = attempts.last().unwrap_or(&Value::Null);
    let pending = task.get("pendingAttempt").filter(|v| !v.is_null());
    let attempt = if pending.is_some() { None } else { Some(last) };
    let start = pending
        .and_then(|p| p.get("usageAtStart"))
        .or_else(|| attempt.and_then(|a| a.get("usageAtStart")));
    let Some(start) = start.filter(|s| s.is_object()) else {
        return json!({"executor": Value::Null, "planner": Value::Null});
    };
    let end = attempt.and_then(|a| a.get("usageAtEnd"));
    let from = attempt
        .and_then(|a| a.get("startedAt").and_then(Value::as_f64))
        .or_else(|| task["run"]["startedAt"].as_f64())
        .or_else(|| task["attemptStartedAt"].as_f64())
        .or_else(|| start["at"].as_f64())
        .unwrap_or(now);
    let until = attempt
        .and_then(|a| a.get("endedAt").and_then(Value::as_f64))
        .unwrap_or(now);
    let shared = peers.iter().any(|other| {
        if other["id"] == task["id"] {
            return false;
        }
        if array(&other["attempts"]).iter().any(|a| {
            overlaps(
                a["usageAtStart"]["account"]
                    .as_str()
                    .or(a["usageAtEnd"]["account"].as_str()),
                num(&a["startedAt"]),
                num(&a["endedAt"]),
                from,
                until,
            ) || overlaps(
                a["usageAtEnd"]["account"].as_str(),
                num(&a["startedAt"]),
                num(&a["endedAt"]),
                from,
                until,
            )
        }) {
            return true;
        }
        text(&other["state"]) == "running"
            && overlaps(
                other["pendingAttempt"]["usageAtStart"]["account"].as_str(),
                other["run"]["startedAt"]
                    .as_f64()
                    .or(other["attemptStartedAt"].as_f64())
                    .or(other["createdAt"].as_f64())
                    .unwrap_or(now),
                now,
                from,
                until,
            )
    });
    let comparable = end.filter(|e| e.is_object()).is_some_and(|e| {
        start["account"] == e["account"]
            && start["window"] == e["window"]
            && start["usedPct"].as_f64().is_some()
            && e["usedPct"].as_f64().is_some_and(|end_pct| {
                start["usedPct"]
                    .as_f64()
                    .is_some_and(|start_pct| end_pct >= start_pct)
            })
    });
    let reason = if shared {
        Some("shared")
    } else if comparable {
        None
    } else {
        Some("no_reading")
    };
    let delta = if reason.is_some() {
        Value::Null
    } else if let Some(end) = end {
        let end_pct = end["usedPct"].as_f64().unwrap_or(0.0);
        let start_pct = start["usedPct"].as_f64().unwrap_or(0.0);
        json!(((end_pct - start_pct) * 10.0).round() / 10.0)
    } else {
        Value::Null
    };
    let mut executor = json!({
        "account": start["account"].clone(),
        "window": start["window"].clone(),
        "deltaPct": delta,
    });
    if let Some(r) = reason {
        executor["reason"] = json!(r);
    }
    json!({"executor": executor, "planner": Value::Null})
}

fn known_branch(task: &Value) -> Option<Value> {
    if let Some(branch) = task["run"]["remoteBranch"].as_str() {
        return Some(json!(branch));
    }
    if task["run"]["mode"] == "new" {
        return Some(json!(format!("pacer/{}", text(&task["id"]))));
    }
    None
}

/// Store timeline without the bounded activity tail (`readActivity`).
pub fn timeline_store(task: &Value) -> Vec<Value> {
    let mut timeline = Vec::new();
    let attempts = array(&task["attempts"]);
    let synthetic = json!({
        "startedAt": task["run"]["startedAt"].clone(),
        "routing": task["pendingAttempt"]["routing"].clone(),
    });
    let first_started = attempts
        .first()
        .and_then(|a| a.get("startedAt").cloned())
        .or_else(|| task["run"].get("startedAt").cloned())
        .or_else(|| task.get("attemptStartedAt").cloned())
        .unwrap_or_else(|| task["createdAt"].clone());
    let rows: Vec<&Value> = if attempts.is_empty() {
        vec![&synthetic]
    } else {
        attempts.iter().collect()
    };
    for attempt in &rows {
        if let Some(routing) = attempt.get("routing").filter(|r| r.is_object()) {
            let chosen = text(&routing["chosen"]);
            timeline.push(json!({
                "at": attempt["startedAt"].clone(),
                "text": format!("Routed to {} · {}", executor_display(chosen), text(&routing["why"])),
            }));
        }
    }
    if task.get("worktree").is_some() || task["run"]["mode"] == "new" {
        let base = task["baseBranch"].as_str().unwrap_or("HEAD");
        timeline.push(json!({
            "at": first_started,
            "text": format!("Worktree created from {base}"),
        }));
    }
    if let Some(commits) = task["progress"]["commits"].as_f64().filter(|n| *n > 0.0) {
        let at = task["progress"]["lastChangeAt"]
            .as_f64()
            .or_else(|| task["progress"]["updatedAt"].as_f64())
            .unwrap_or(0.0);
        timeline.push(json!({
            "at": at,
            "text": format!("{} commit{}", commits as i64, if commits == 1.0 { "" } else { "s" }),
        }));
    }
    if task["progress"]["phase"] == "testing" {
        timeline.push(json!({
            "at": task["progress"]["updatedAt"].clone(),
            "text": "Testing",
        }));
    }
    if TERMINAL.contains(&text(&task["state"])) {
        let ended = attempts
            .last()
            .and_then(|a| a["endedAt"].as_f64())
            .unwrap_or(num(&task["createdAt"]));
        let progress_at = task["progress"]["updatedAt"].as_f64().unwrap_or(0.0);
        timeline.push(json!({
            "at": ended.max(progress_at),
            "text": text(&task["state"]),
        }));
    }
    timeline.sort_by(|a, b| num(&a["at"]).total_cmp(&num(&b["at"])));
    timeline
}

fn acceptance_detail(task: &Value, omit_result: bool) -> Value {
    let acceptance = if omit_result {
        None
    } else {
        task["result"]["acceptance"]
            .as_object()
            .filter(|_| truth(&task["result"]["acceptance"]))
    };
    let cmd = acceptance
        .and_then(|a| a.get("cmd").cloned())
        .or_else(|| task["brief"]["acceptance"].as_str().map(|s| json!(s)))
        .unwrap_or(Value::Null);
    let state = if let Some(a) = acceptance {
        if a.get("passed").is_some_and(|v| v.as_bool() == Some(true)) {
            "passed"
        } else {
            "failed"
        }
    } else if cmd.is_null() || (cmd.as_str().is_some_and(str::is_empty)) {
        "none"
    } else if task["progress"]["phase"] == "testing" {
        "running"
    } else {
        "pending"
    };
    let tail_bytes = acceptance
        .and_then(|a| a.get("tail"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let tail = if tail_bytes.len() > 4096 {
        tail_bytes[tail_bytes.len().saturating_sub(4096)..].to_string()
    } else {
        tail_bytes.to_string()
    };
    let mut out = json!({
        "cmd": cmd,
        "state": state,
        "tail": tail,
        "machine": acceptance.and_then(|a| a.get("machine")).cloned().unwrap_or(Value::Null),
    });
    if let Some(a) = acceptance {
        if let Some(duration) = a.get("durationS") {
            out["durationS"] = duration.clone();
        }
        if let Some(summary) = a.get("summary") {
            out["summary"] = summary.clone();
        }
    }
    out
}

fn attempts_for_detail(task: &Value) -> Vec<Value> {
    array(&task["attempts"])
        .iter()
        .map(|a| {
            let mut row = a.clone();
            if row.get("log").is_none() {
                row["log"] = json!("");
            }
            row
        })
        .collect()
}

fn terminal(task: &Value) -> bool {
    TERMINAL.contains(&text(&task["state"]))
}

/// Largest store-only `task.get` payload; callers merge activity/git/token/work slices later.
pub fn task_detail_store(
    ctx: &Ctx,
    active: &ActiveCounts,
    task: &Value,
    store: &mut TaskStore,
    alive: &dyn Fn(i64) -> bool,
    peers: &[Value],
    omit_result_acceptance: bool,
) -> Result<Value, Error> {
    let api = api_task_page(ctx, active, std::slice::from_ref(task), store, alive)?
        .into_iter()
        .next()
        .ok_or(Error::Store(pacer_store::StoreError::InvalidRecord))?;
    let attempts = array(&task["attempts"]);
    let last = attempts.last().unwrap_or(&Value::Null);
    let branch = known_branch(task);
    let mut detail = api.as_object().cloned().unwrap_or_default();
    detail.insert("brief".into(), task["brief"].clone());
    detail.insert("attempts".into(), json!(attempts_for_detail(task)));
    let routing = if truth(&task["pendingAttempt"]["routing"]) {
        task["pendingAttempt"]["routing"].clone()
    } else {
        last.get("routing").cloned().unwrap_or(Value::Null)
    };
    detail.insert("routing".into(), routing);
    detail.insert("cost".into(), executor_cost(task, peers, ctx.now));
    detail.insert(
        "acceptance".into(),
        acceptance_detail(task, omit_result_acceptance),
    );
    detail.insert("summary".into(), task["result"]["report"].clone());
    detail.insert("branch".into(), branch.clone().unwrap_or(Value::Null));
    detail.insert("base".into(), task["baseBranch"].clone());
    detail.insert("machine".into(), task["run"]["host"].clone());
    detail.insert(
        "startedAt".into(),
        attempts
            .first()
            .and_then(|a| a.get("startedAt"))
            .or_else(|| task["run"].get("startedAt"))
            .or_else(|| task.get("attemptStartedAt"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    detail.insert(
        "endedAt".into(),
        if terminal(task) {
            last.get("endedAt").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    detail.insert("files".into(), json!([]));
    detail.insert("retryOptions".into(), json!([]));
    detail.insert("timeline".into(), json!(timeline_store(task)));
    detail.insert(
        "derived".into(),
        json!({
            "files": "unavailable",
            "branch": if branch.is_some() { "ready" } else { "unavailable" },
            "retryOptions": "cached",
            "timeline": "partial",
        }),
    );
    if truth(&task["managedSkip"]) {
        detail.insert(
            "managedSkip".into(),
            json!({"reason": task["managedSkip"]["reason"].clone()}),
        );
    }
    Ok(Value::Object(detail))
}

/// Load one task and compose the store-only detail document.
pub fn task_detail_by_id(
    ctx: &Ctx,
    active: &ActiveCounts,
    store: &mut TaskStore,
    id: &str,
    alive: &dyn Fn(i64) -> bool,
    omit_result_acceptance: bool,
) -> Result<Value, Error> {
    let task = store
        .read(id)?
        .ok_or(Error::Store(pacer_store::StoreError::UnknownTask(
            id.into(),
        )))?;
    let peers = store.list(&TaskFilter {
        all: true,
        ..TaskFilter::default()
    })?;
    task_detail_store(
        ctx,
        active,
        &task,
        store,
        alive,
        &peers,
        omit_result_acceptance,
    )
}
