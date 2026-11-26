//! Native `taskMessageEvents` / `publishTaskMessages` (`src/messaging/publish.ts`).
//! A human read or send changes what the human's tasks show, so the task and its
//! message attention item are republished under the shared `link` lock.
#![allow(clippy::result_large_err)]
use pacer_foundation::{Ctx, api::CoreError};
use pacer_store::{TaskStore, outbox::read_latest, publish};
use serde_json::{Value, json};

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

fn clip(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        value.to_owned()
    } else {
        let mut out: String = chars[..max.saturating_sub(1)].iter().collect();
        out.push('…');
        out
    }
}

fn coalesce(items: &[&Value]) -> Value {
    items
        .iter()
        .find(|value| !value.is_null())
        .map_or(Value::Null, |value| (*value).clone())
}

/// `taskData` (`src/link/pump.ts:56`) for a record the latest snapshot has not published.
/// Field order matches the TypeScript object, which is the parity contract.
fn task_data(t: &Value) -> Value {
    let attempts = t["attempts"].as_array();
    let last = attempts.and_then(|items| items.last()).unwrap_or(&Value::Null);
    let goal = text(&t["brief"]["goal"]);
    let title = {
        let own = text(&t["title"]);
        if own.trim().is_empty() {
            clip(goal, 60)
        } else {
            clip(own, 60)
        }
    };
    let state = if text(&t["state"]) == "running"
        && t["question"].is_object()
        && t["question"].get("answer").is_none()
    {
        "needs_input"
    } else {
        text(&t["state"])
    };
    let updated = [
        number(Some(&t["createdAt"])),
        number(last.get("startedAt")),
        number(last.get("endedAt")),
        number(Some(&t["attemptStartedAt"])),
        number(t["reviewRequest"].get("at")),
        number(t["stopPending"].get("requestedAt")),
        number(t["question"].get("at")),
        number(t["question"].get("answeredAt")),
    ]
    .into_iter()
    .fold(0.0, f64::max);
    let mut row = json!({
        "id": t["id"],
        "title": title,
        "state": state,
        "goal": clip(goal, 200),
        "executor": coalesce(&[&t["result"]["executor"], &t["executor"], &last["executor"]]),
        "backend": coalesce(&[&t["result"]["backend"], &t["backend"]]),
        "worktree": coalesce(&[&t["result"]["worktree"], &t["worktree"]]),
        "updatedAt": updated,
    });
    if truthy(t["placement"].get("mode")) && t["placement"].get("why").is_some() {
        row["placement"] = json!({"mode": t["placement"]["mode"], "why": t["placement"]["why"]});
    }
    if truthy(Some(&t["question"])) {
        row["question"] = t["question"].clone();
    }
    for key in ["interactionMode", "conversation"] {
        if truthy(t.get(key)) {
            row[key] = t[key].clone();
        }
    }
    let acceptance = if truthy(t["result"].get("acceptance")) {
        if truthy(t["result"]["acceptance"].get("passed")) {
            "passed"
        } else {
            "failed"
        }
    } else if !truthy(t["brief"].get("acceptance")) {
        "none"
    } else if t["progress"]["phase"] == "testing" {
        "running"
    } else {
        "pending"
    };
    row["acceptanceState"] = json!(acceptance);
    for key in [
        "reviewRequest",
        "stopPending",
        "review",
        "resolved",
        "dismissed",
        "retryOf",
        "retriedBy",
        "diagnosticCheck",
        "diagnosticRecheck",
    ] {
        if truthy(t.get(key)) {
            row[key] = t[key].clone();
        }
    }
    if truthy(t["result"].get("brokenReason")) {
        for key in ["brokenExecutor", "brokenReason"] {
            if let Some(value) = t["result"].get(key) {
                row[key] = value.clone();
            }
        }
    }
    if truthy(t.get("attemptStartedAt")) {
        row["attemptStartedAt"] = t["attemptStartedAt"].clone();
    }
    if ["queued", "running"].contains(&text(&t["state"])) {
        if truthy(t.get("progress")) {
            row["progress"] = json!({
                "phase": t["progress"]["phase"],
                "lastOutputAt": t["progress"]["lastOutputAt"],
                "files": t["progress"]["files"],
                "commits": t["progress"]["commits"],
                "logBytes": t["progress"]["logBytes"],
            });
        }
        row["runnerAlive"] = json!(false);
    }
    row
}

/// The events TypeScript builds for one task whose messages the human just changed.
pub fn task_message_events(ctx: &Ctx, store: &mut TaskStore, task_id: &str) -> Vec<Value> {
    let Ok(Some(record)) = store.read(task_id) else {
        return Vec::new();
    };
    if ["workflow", "orchestrate"].contains(&text(&record["kind"])) {
        return Vec::new();
    }
    // Keep what the pump last published, which carries session fields `taskData` lacks.
    let task = read_latest(ctx)["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .cloned()
        .unwrap_or_else(|| task_data(&record));
    let id = format!("message:{task_id}");
    // A read consumes the human's unread messages, so no item is raised: the store is
    // read only here, and the pump owns it, as on the TypeScript path.
    let attention = json!({"type":"entity","data":{"kind":"attention","id":id,"removed":true}});
    vec![json!({"type":"task","data":task}), attention]
}

/// `publishTaskMessages`: deduplicate task ids and publish under the shared lock.
/// Publication failures do not invalidate the committed receipts, matching the
/// `void publishTaskMessages(...)` call in `readMessages`.
pub fn publish_task_messages(
    ctx: &Ctx,
    store: &mut TaskStore,
    task_ids: &[String],
) -> Result<(), CoreError> {
    let mut events = Vec::new();
    let mut seen = Vec::new();
    for id in task_ids {
        if seen.contains(id) {
            continue;
        }
        seen.push(id.clone());
        events.extend(task_message_events(ctx, store, id));
    }
    if events.is_empty() {
        return Ok(());
    }
    let report = publish(ctx, &events);
    if !report.errors.is_empty() {
        eprintln!("pacer: message publication failed: {}", report.errors.join("; "));
    }
    Ok(())
}
