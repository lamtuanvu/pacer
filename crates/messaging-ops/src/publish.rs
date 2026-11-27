//! Native counterpart of `src/messaging/publish.ts`. A human read receipt changes
//! what a task shows in the read model, so Rust republishes the task and its message
//! attention item instead of asking the TypeScript bridge to do it.
use pacer_foundation::{
    Ctx,
    api::CoreError,
    fsutil::read_json,
};
use pacer_store::{TaskStore, read_latest};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// `isEngineOwnedKind` in `src/tasks/engine-owned.ts`.
fn engine_owned(kind: Option<&Value>) -> bool {
    kind.and_then(Value::as_str).is_some_and(|k| k == "orchestrate" || k == "workflow-root")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// `visibleTaskState`: an unanswered question makes a running task `needs_input`.
fn visible_state(task: &Value) -> &str {
    if task["state"].as_str() == Some("running")
        && task.get("question").is_some_and(|q| q.is_object() && q.get("answer").is_none())
    {
        "needs_input"
    } else {
        task["state"].as_str().unwrap_or_default()
    }
}

/// `repoFor` for an unregistered task path: `local:<sha256(path)[..12]>` (`src/core/repos.ts`).
fn repo_ref(task: &Value) -> Value {
    if let Some(repo) = task.get("repo").filter(|value| value.is_object()) {
        return repo.clone();
    }
    let path = task["brief"]["repo"].as_str().unwrap_or_default();
    let digest = Sha256::digest(path.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    json!({
        "key": format!("local:{}", &hex[..12]),
        "label": path.rsplit('/').next().unwrap_or(path),
        "path": path,
        "identityUnverified": true,
    })
}

/// The task row TypeScript falls back to when the pump has not published this task yet
/// (`taskData(record)` in `src/link/pump.ts`). Kept local: `pacer-read-model` is a higher
/// layer than this crate.
fn task_data(task: &Value) -> Value {
    let last = task["attempts"].as_array().and_then(|a| a.last()).unwrap_or(&Value::Null);
    let coalesce = |values: &[Option<&Value>]| -> Value {
        values
            .iter()
            .find_map(|v| v.filter(|v| !v.is_null()))
            .map(|v| v.clone())
            .unwrap_or(Value::Null)
    };
    let updated = [
        &task["createdAt"],
        &last["startedAt"],
        &last["endedAt"],
        &task["attemptStartedAt"],
        &task["reviewRequest"]["at"],
        &task["stopPending"]["requestedAt"],
        &task["question"]["at"],
        &task["question"]["answeredAt"],
    ]
    .iter()
    .filter_map(|v| v.as_f64())
    .fold(0.0, f64::max);
    let goal = task["brief"]["goal"].as_str().unwrap_or_default();
    let title = if task["title"].as_str().is_some_and(|t| !t.trim().is_empty()) {
        task["title"].clone()
    } else {
        json!(clip(goal, 60))
    };
    let state = visible_state(task);
    let acceptance = if task["result"].get("acceptance").is_some_and(|a| a.is_object()) {
        if task["result"]["acceptance"]["passed"].as_bool() == Some(true) { "passed" } else { "failed" }
    } else if !truthy(task["brief"].get("acceptance")) {
        "none"
    } else if task["progress"]["phase"].as_str() == Some("testing") {
        "running"
    } else {
        "pending"
    };
    let mut row = json!({
        "id": task["id"],
        "title": title,
        "state": state,
        "goal": clip(goal, 200),
        "executor": coalesce(&[task.get("result").and_then(|r| r.get("executor")), task.get("executor"), last.get("executor")]),
        "backend": coalesce(&[task.get("result").and_then(|r| r.get("backend")), task.get("backend")]),
        "worktree": coalesce(&[task.get("result").and_then(|r| r.get("worktree")), task.get("worktree")]),
        "updatedAt": json!(updated),
        "acceptanceState": acceptance,
    });
    for key in ["question", "interactionMode", "conversation", "reviewRequest", "stopPending",
        "review", "resolved", "dismissed", "retryOf", "retriedBy", "attemptStartedAt",
        "diagnosticCheck", "diagnosticRecheck"]
    {
        if truthy(task.get(key)) {
            let value = if key == "dismissed" { Value::Bool(true) } else { task[key].clone() };
            row[key] = value;
        }
    }
    if let Some(placement) = task.get("placement")
        && truthy(placement.get("mode"))
        && placement.get("why").is_some()
    {
        row["placement"] = json!({"mode": placement["mode"], "why": placement["why"]});
    }
    if matches!(state, "running" | "queued") {
        row["runnerAlive"] = json!(truthy(task.get("runnerPid")));
    }
    if matches!(state, "running" | "queued")
        && let Some(progress) = task.get("progress")
    {
        row["progress"] = json!({
            "phase": progress["phase"], "lastOutputAt": progress["lastOutputAt"],
            "files": progress["files"], "commits": progress["commits"], "logBytes": progress["logBytes"],
        });
    }
    row
}

/// The `message:<taskId>` item `deriveItems` raises (`src/attention/rules.ts:105-116`),
/// with the read-only attention store's dismiss/snooze state applied. `None` means the
/// publisher must send a `removed` entity, as TypeScript's `applyStore` does.
fn attention_item(ctx: &Ctx, store: &mut TaskStore, task_id: &str, task: &Value) -> Option<Value> {
    // `unreadCounts` in `src/messaging/store.ts`: pending/delivered, no reports, no limit.
    let database = store.connection().ok()?;
    let mut statement = database
        .prepare("SELECT id,kind,body,created_at FROM messages WHERE recipient=?1 AND status IN ('pending','delivered') AND kind<>'report' AND task_id=?2 ORDER BY id")
        .ok()?;
    let unread: Vec<Value> = statement
        .query_map(["human", task_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "body": row.get::<_, String>(2)?,
                "createdAt": row.get::<_, Option<f64>>(3)?.unwrap_or_default(),
            }))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();
    drop(statement);
    drop(database);
    if unread.is_empty() || truthy(task.get("dismissed")) {
        return None;
    }
    // An open, unanswered legacy question already raises the `question` item.
    let legacy_question = visible_state(task) == "needs_input" && !truthy(task.get("retriedBy"));
    if legacy_question {
        return None;
    }
    let question = unread.iter().find(|message| message["kind"].as_str() == Some("question"));
    let since = question
        .map(|message| message["createdAt"].clone())
        .unwrap_or_else(|| task["updatedAt"].clone());
    let detail = match question {
        Some(message) => clip(message["body"].as_str().unwrap_or_default(), 200),
        None => format!(
            "{} unread message{}",
            unread.len(),
            if unread.len() == 1 { "" } else { "s" }
        ),
    };
    let answerable = question.is_some()
        && !truthy(task.get("review"))
        && task["state"].as_str() != Some("stopped");
    let action = if answerable {
        json!({"label": "Answer", "op": "ui.open", "params": {"view": "task", "id": task_id, "tab": "answer"}, "style": "primary"})
    } else {
        json!({"label": "Open task", "op": "ui.open", "params": {"view": "task", "id": task_id}, "style": "primary"})
    };
    let id = format!("message:{task_id}");
    let goal = task["brief"]["goal"].as_str().unwrap_or_default();
    let title = clip(goal, 200);
    let repo = repo_ref(task);
    let mut item = json!({
        "id": id, "kind": "message",
        "severity": if question.is_some() { "blocked" } else { "decide" },
        "repo": repo, "title": title, "detail": detail,
        "raisedAt": since.clone(), "since": since, "actions": [action], "notify": "important",
        "taskId": task_id,
    });
    if let Some(Value::Object(entries)) = read_json::<Value>(&ctx.pacer_home.join("state/attention.json"))
        && let Some(entry) = entries.get(&id)
    {
        let entry_since = entry.get("since").cloned().unwrap_or_else(|| item["since"].clone());
        if entry.get("dismissedSince") == Some(&entry_since) {
            return None;
        }
        if entry["snoozedUntil"].as_f64().is_some_and(|until| until > ctx.now) {
            return None;
        }
        item["since"] = entry_since;
        if let Some(until) = entry.get("snoozedUntil") {
            item["snoozedUntil"] = until.clone();
        }
    }
    Some(item)
}

/// `taskMessageEvents`: republish the task (its event carries unread messages) and its
/// message attention item. The published task row keeps the pump's last snapshot value.
pub fn task_message_events(ctx: &Ctx, store: &mut TaskStore, task_id: &str) -> Vec<Value> {
    let Some(task) = store.read(task_id).ok().flatten() else {
        return Vec::new();
    };
    if engine_owned(task.get("kind")) {
        return Vec::new();
    }
    let data = read_latest(ctx)["tasks"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"].as_str() == Some(task_id)).cloned())
        .unwrap_or_else(|| task_data(&task));
    let id = format!("message:{task_id}");
    let attention = match attention_item(ctx, store, task_id, &task) {
        Some(value) => json!({"type": "entity", "data": {"kind": "attention", "id": id, "value": value}}),
        None => json!({"type": "entity", "data": {"kind": "attention", "id": id, "removed": true}}),
    };
    vec![json!({"type": "task", "data": data}), attention]
}

/// `publishTaskMessages`: deduplicate task ids and publish their events under the link lock.
/// Publication is best effort at the call sites; the read receipts themselves are durable.
pub fn publish_task_messages(
    ctx: &Ctx,
    store: &mut TaskStore,
    task_ids: &[String],
) -> Result<(), CoreError> {
    let mut seen = HashSet::new();
    let mut events = Vec::new();
    for id in task_ids {
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        events.extend(task_message_events(ctx, store, id));
    }
    pacer_store::publish(ctx, &events);
    Ok(())
}
