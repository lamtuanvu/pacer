//! Action cards proposed by the assistant.
//!
//! Port of `buildCard` in `src/assistant/actions.ts` and the `propose_action`
//! branch of `runAssistantTool` in `src/assistant/service.ts`. The title and
//! summary come from the op and its params, never from the model's `why`; the
//! task revision is read when the card is built, never when it is clicked.

use crate::assistant_ops::redact::Redactor;
use pacer_foundation::Ctx;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

const PROPOSABLE: [&str; 10] = [
    "dispatch.retry",
    "task.retry",
    "dispatch.stop",
    "task.stop",
    "dispatch.answer",
    "task.answer",
    "delegation.pause",
    "delegation.resume",
    "dispatch.submit",
    "navigate",
];

/// Read access to the task a card concerns. Injected by the caller.
pub trait CardDeps: Send + Sync {
    fn task(&self, ctx: &Ctx, id: &str) -> Option<CardTask>;
    fn managed(&self, ctx: &Ctx, id: &str) -> bool {
        let _ = ctx;
        let _ = id;
        true
    }
}

#[derive(Clone, Debug)]
pub struct CardTask {
    pub rev: i64,
    pub title: String,
    pub state: String,
}

pub enum CardResult {
    Ok(Value),
    Note(String),
}

impl CardResult {
    pub fn ok(&self) -> bool {
        matches!(self, Self::Ok(_))
    }
}

fn hours_pattern() -> &'static Regex {
    static HOURS: OnceLock<Regex> = OnceLock::new();
    HOURS.get_or_init(|| {
        Regex::new(r"^([1-9]|1\d|2[0-4])h$|^([1-9]\d?|[1-9]\d{2}|1[0-3]\d{2}|1440)m$")
            .unwrap_or_else(|e| panic!("invalid pause pattern: {e}"))
    })
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Reject unknown keys and validate the allowed string fields, matching each
/// zod `.strict()` schema in `actions.ts`.
fn valid_params(key: &str, params: &Map<String, Value>) -> bool {
    let allowed: &[&str] = match key {
        "retry" => &["id", "feedback"],
        "stop" => &["id"],
        "answer" => &["id", "text"],
        "delegation.pause" => &["for", "reason"],
        "delegation.resume" => &[],
        "dispatch.submit" => &["goal", "repo", "title"],
        "navigate" => &["to", "id"],
        _ => return false,
    };
    if params.keys().any(|k| !allowed.contains(&k.as_str())) {
        return false;
    }
    let within = |k: &str, min: usize, max: usize| -> bool {
        match params.get(k) {
            None => min == 0,
            Some(Value::String(s)) => s.chars().count() >= min && s.chars().count() <= max,
            _ => false,
        }
    };
    match key {
        "retry" => within("id", 1, 128) && within("feedback", 0, 2000),
        "stop" => within("id", 1, 128),
        "answer" => within("id", 1, 128) && within("text", 1, 2000),
        "delegation.pause" => {
            let for_ok = text(&Value::Object(params.clone()), "for")
                .is_some_and(|v| hours_pattern().is_match(v));
            for_ok && within("reason", 0, 200)
        }
        "delegation.resume" => true,
        "dispatch.submit" => {
            within("goal", 1, 20000) && within("repo", 1, 4096) && within("title", 0, 500)
        }
        "navigate" => {
            let to_ok = text(&Value::Object(params.clone()), "to")
                .is_some_and(|v| matches!(v, "task" | "tasks" | "needs-you" | "overview" | "settings-assistant"));
            to_ok && within("id", 0, 128)
        }
        _ => false,
    }
}

fn short(title: &str) -> String {
    if title.chars().count() > 60 {
        let mut out: String = title.chars().take(57).collect();
        out.push('…');
        out
    } else {
        title.to_owned()
    }
}

fn card_id() -> String {
    format!("card-{:08x}", rand::random::<u32>())
}

/// Build one card from a proposal. `None` note means it was dropped.
pub fn build_card(
    ctx: &Ctx,
    proposal: &Value,
    deps: &dyn CardDeps,
    redactor: &Redactor,
) -> CardResult {
    let Some(object) = proposal.as_object() else {
        return CardResult::Note("A proposed action was dropped: it was malformed.".into());
    };
    let Some(op) = text(proposal, "op") else {
        return CardResult::Note("A proposed action was dropped: it was malformed.".into());
    };
    if op.chars().count() > 64 {
        return CardResult::Note("A proposed action was dropped: it was malformed.".into());
    }
    let params = match object.get("params") {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => {
            return CardResult::Note("A proposed action was dropped: it was malformed.".into());
        }
    };
    let why = match object.get("why") {
        None => String::new(),
        Some(Value::String(s)) if s.chars().count() <= 600 => s.clone(),
        Some(_) => return CardResult::Note("A proposed action was dropped: it was malformed.".into()),
    };
    if !PROPOSABLE.contains(&op) {
        let cut: String = redactor.text(op).chars().take(40).collect();
        return CardResult::Note(format!(
            "A proposed action was dropped: {cut} is not an action the assistant can propose."
        ));
    }
    let why_ = redactor.text(&why);
    let id = card_id();
    let kind = if op == "navigate" {
        "navigate".to_owned()
    } else {
        op.strip_prefix("dispatch.")
            .or_else(|| op.strip_prefix("task."))
            .unwrap_or(op)
            .to_owned()
    };
    let key = if matches!(
        op,
        "delegation.pause" | "delegation.resume" | "dispatch.submit" | "navigate"
    ) {
        op
    } else {
        kind.as_str()
    };
    if !valid_params(key, &params) {
        return CardResult::Note(format!(
            "A proposed {op} action was dropped: its parameters were invalid."
        ));
    }
    let view = Value::Object(params.clone());

    if op == "navigate" {
        let to = text(&view, "to").unwrap_or_default();
        let target = text(&view, "id");
        if to == "task" && target.is_none() {
            return CardResult::Note("A proposed link was dropped: it named no task.".into());
        }
        let (href, label) = match to {
            "task" => (
                format!("#/tasks/{}", url_encode(target.unwrap_or_default())),
                "Open task",
            ),
            "tasks" => ("#/tasks".to_owned(), "Open tasks"),
            "needs-you" => ("#/needs-you".to_owned(), "Open Needs you"),
            "overview" => ("#/overview".to_owned(), "Open Overview"),
            _ => ("#/settings".to_owned(), "Open assistant settings"),
        };
        return CardResult::Ok(json!({
            "id": id, "op": "navigate", "params": Value::Object(params),
            "title": label, "summary": label, "editable": [], "why": why_,
            "href": href, "state": "pending",
        }));
    }
    if op == "delegation.resume" {
        return CardResult::Ok(json!({
            "id": id, "op": op, "params": {}, "title": "Resume delegation",
            "summary": "Resume delegating new work.", "editable": [], "why": why_, "state": "pending",
        }));
    }
    if op == "delegation.pause" {
        let length = text(&view, "for").unwrap_or_default().to_owned();
        let duration = if length.ends_with('h') {
            format!("{} hours", &length[..length.len() - 1])
        } else {
            format!("{} minutes", &length[..length.len() - 1])
        };
        let reason = text(&view, "reason").map(|r| redactor.text(r));
        let editable = reason
            .as_ref()
            .map(|r| json!([{"name":"reason","label":"Reason","value":r}]))
            .unwrap_or_else(|| json!([]));
        let mut stored = Map::new();
        stored.insert("for".into(), Value::String(length));
        if let Some(reason) = reason {
            stored.insert("reason".into(), Value::String(reason));
        }
        return CardResult::Ok(json!({
            "id": id, "op": op, "params": Value::Object(stored), "title": "Pause delegation",
            "summary": format!("Pause new delegation for {duration}. Running work continues."),
            "editable": editable, "why": why_, "state": "pending",
        }));
    }
    if op == "dispatch.submit" {
        let goal = redactor.text(text(&view, "goal").unwrap_or_default());
        let repo = text(&view, "repo").unwrap_or_default().to_owned();
        let title = text(&view, "title").map(|t| redactor.text(t));
        let mut stored = Map::new();
        stored.insert("goal".into(), Value::String(goal.clone()));
        stored.insert("repo".into(), Value::String(repo));
        if let Some(title) = title {
            stored.insert("title".into(), Value::String(title));
        }
        return CardResult::Ok(json!({
            "id": id, "op": op, "params": Value::Object(stored), "title": "New task",
            "summary": "Open the New task composer with this request filled in. Nothing is submitted until you press Delegate.",
            "editable": [{"name":"goal","label":"Request","value":goal}], "why": why_, "state": "pending",
        }));
    }

    // Task-scoped ops: the revision is read now, when the card is made.
    let task_id = text(&view, "id").unwrap_or_default().to_owned();
    let Some(task) = deps.task(ctx, &task_id) else {
        let cut: String = redactor.text(&task_id).chars().take(40).collect();
        return CardResult::Note(format!(
            "A proposed {kind} action was dropped: there is no task {cut}."
        ));
    };
    let managed = deps.managed(ctx, &task_id);
    let real = format!("{}.{}", if managed { "dispatch" } else { "task" }, kind);
    let name = short(&redactor.text(if task.title.is_empty() { &task_id } else { &task.title }));
    if kind == "retry" {
        let feedback = text(&view, "feedback")
            .filter(|_| managed)
            .map(|f| redactor.text(f));
        let editable = if managed {
            json!([{"name":"feedback","label":"Feedback for the new attempt","value":feedback.clone().unwrap_or_default()}])
        } else {
            json!([])
        };
        let mut stored = Map::new();
        stored.insert("id".into(), Value::String(task_id));
        stored.insert("expect_rev".into(), json!(task.rev));
        if let Some(feedback) = feedback {
            stored.insert("feedback".into(), Value::String(feedback));
        }
        return CardResult::Ok(json!({
            "id": id, "op": real, "params": Value::Object(stored), "title": "Retry task",
            "summary": format!("Retry “{name}” as a new attempt in the same worktree, on the executor pacer routes it to."),
            "editable": editable, "why": why_, "state": "pending",
        }));
    }
    if kind == "stop" {
        return CardResult::Ok(json!({
            "id": id, "op": real,
            "params": {"id": task_id, "expect_rev": task.rev},
            "title": "Stop task", "summary": format!("Stop “{name}” and the work under it."),
            "editable": [], "why": why_, "state": "pending",
        }));
    }
    let answer = redactor.text(text(&view, "text").unwrap_or_default());
    CardResult::Ok(json!({
        "id": id, "op": real,
        "params": {"id": task_id, "expect_rev": task.rev, "text": answer},
        "title": "Answer the executor",
        "summary": format!("Send this answer to the executor working on “{name}”. You can edit it first."),
        "editable": [{"name":"text","label":"Answer","value":answer}], "why": why_, "state": "pending",
    }))
}

/// `encodeURIComponent` for a task id (task ids are safe ASCII, but keep the
/// escaped form so a crafted id cannot break out of the fragment).
fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~'
            | b'*' | b'\'' | b'(' | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
