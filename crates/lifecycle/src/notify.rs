//! Notification candidates and delivery acknowledgement decisions.
use crate::{
    a,
    attention::{self, Item},
    js::{self, Text},
    n, s, truth,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;
#[derive(Clone, Debug, Serialize)]
pub struct Data {
    pub key: String,
    pub title: Text,
    pub body: Text,
    pub actions: Vec<Value>,
    pub url: String,
    /// Presenter ids when the host published to clients. Dispatch selection
    /// lives in `src/notify/decide.ts`; this field is the serialized host value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipients: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub key: String,
    pub data: Data,
    /// Extra ledger keys acked with this send (same-task siblings).
    #[serde(rename = "ackKeys", skip_serializing_if = "Option::is_none")]
    pub ack_keys: Option<Vec<String>>,
}
fn view(item: &Item) -> String {
    if let Some(section) = a(item.get("actions"))
        .iter()
        .find(|a| a["op"] == "ui.open" && a["params"]["view"] == "settings")
        .and_then(|a| a["params"]["section"].as_str())
    {
        return format!("settings/{}", js::encode(section));
    }
    if item.get("kind") == "update" {
        return "settings/updates".into();
    }
    if truth(item.get("taskId")) {
        return format!("tasks/{}", js::encode(s(item.get("taskId"))));
    }
    if truth(item.get("executor")) {
        return "settings/executors".into();
    }
    if truth(item.get("account")) {
        return "settings/accounts".into();
    }
    if truth(item.get("host")) {
        return format!("settings/hosts/{}", js::encode(s(item.get("host"))));
    }
    String::new()
}
fn item_key(item: &Item) -> String {
    format!("{}:{}", s(item.get("id")), js::number(n(item.get("since"))))
}

/// Latest delivery time for an attention id: exact key or any `${id}:${since}` entry.
fn last_notified_at(ledger: &Value, id: &str) -> Option<f64> {
    let prefix = format!("{id}:");
    let mut latest: Option<f64> = None;
    if let Some(entries) = ledger.as_object() {
        for (key, at) in entries {
            if key != id && !key.starts_with(&prefix) {
                continue;
            }
            let at = n(at);
            if latest.map_or(true, |prev| at > prev) {
                latest = Some(at);
            }
        }
    }
    latest
}

/// True when `now` is set and this attention id was delivered within the cooldown window.
fn in_cooldown(ledger: &Value, id: &str, now: f64) -> bool {
    if now <= 0.0 {
        return false;
    }
    last_notified_at(ledger, id).map_or(false, |last| now - last < attention::NOTIFY_COOLDOWN_S)
}

/// The planner kind in a caller participant (`external:claude-code:<session>` → `claude-code`).
fn caller_label(caller: &str) -> &str {
    let Some(rest) = caller.strip_prefix("external:") else {
        return "the caller";
    };
    let end = rest
        .find(|c: char| !(c.is_ascii_lowercase() || c == '-'))
        .unwrap_or(rest.len());
    let label = &rest[..end];
    if label.is_empty() {
        "the caller"
    } else {
        label
    }
}

fn candidate_from_item(item: &Item) -> Candidate {
    let key = item_key(item);
    Candidate {
        key: key.clone(),
        data: Data {
            key,
            title: Text::new(s(item.get("title"))),
            body: item.detail.clone(),
            actions: a(item.get("actions")).iter().take(2).cloned().collect(),
            url: format!("/app/#/{}", view(item)),
            recipients: None,
            client_id: None,
        },
        ack_keys: None,
    }
}

/// One candidate per taskId; ack_keys cover same-task siblings (TS onePerTask).
fn one_per_task(items: &[&Item]) -> Vec<Candidate> {
    let mut keys_by_task: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for item in items {
        if !truth(item.get("taskId")) {
            continue;
        }
        keys_by_task
            .entry(s(item.get("taskId")).to_owned())
            .or_default()
            .push(item_key(item));
    }
    let mut seen_task = HashSet::new();
    let mut out = vec![];
    for item in items {
        if !truth(item.get("taskId")) {
            out.push(candidate_from_item(item));
            continue;
        }
        let task_id = s(item.get("taskId"));
        if !seen_task.insert(task_id.to_owned()) {
            continue;
        }
        let mut c = candidate_from_item(item);
        if let Some(keys) = keys_by_task.get(task_id)
            && keys.len() > 1
        {
            c.ack_keys = Some(keys[1..].to_vec());
        }
        out.push(c);
    }
    out
}

/// Group important stalled items by waitingOn into one banner per caller.
fn caller_gone_candidates(items: &[&Item], ledger: &Value, now: f64) -> Vec<Candidate> {
    // A Vec keeps the JS Map's first-seen caller order without a new dependency.
    let mut by_caller: Vec<(String, Vec<&Item>)> = vec![];
    for &item in items {
        if item.get("kind") != "stalled"
            || item.get("notify") != "important"
            || !truth(item.get("waitingOn"))
        {
            continue;
        }
        let caller = s(item.get("waitingOn"));
        if let Some((_, members)) = by_caller.iter_mut().find(|(key, _)| key == caller) {
            members.push(item);
        } else {
            by_caller.push((caller.to_owned(), vec![item]));
        }
    }
    let mut grouped = vec![];
    for (caller, members) in by_caller {
        // Caller-only key: cooldown (not a permanent since-keyed id) lets a newly
        // joining member re-banner after NOTIFY_COOLDOWN_S.
        let key = format!("caller_gone:{caller}");
        let skipped = if now > 0.0 {
            in_cooldown(ledger, &key, now)
        } else {
            ledger.get(&key).is_some()
        };
        if skipped {
            continue;
        }
        let head = members[0];
        let count = members.len();
        grouped.push(Candidate {
            key: key.clone(),
            data: Data {
                key,
                title: Text::new(&format!("{} has not responded", caller_label(&caller))),
                body: Text::new(&format!(
                    "{} delegated task{} waiting",
                    count,
                    if count == 1 { "" } else { "s" }
                )),
                actions: a(head.get("actions")).iter().take(2).cloned().collect(),
                url: format!("/app/#/{}", view(head)),
                recipients: None,
                client_id: None,
            },
            ack_keys: Some(members.iter().map(|item| item_key(item)).collect()),
        });
    }
    grouped
}

/// Level filter, per-id cooldown, one-per-task and grouped caller-gone banners.
/// `ack_keys` on a candidate are ledger-acked with the sent key so suppressed
/// siblings do not fire on the next pass.
pub fn candidates(items: &[Item], level: &str, ledger: &Value, now: f64) -> Vec<Candidate> {
    if level == "off" {
        return vec![];
    }
    let mut sorted = items.to_vec();
    attention::sort(&mut sorted);
    let mut eligible: Vec<&Item> = vec![];
    for item in &sorted {
        if ledger.get(&item_key(item)).is_some()
            || level == "important" && item.get("notify") != "important"
            || in_cooldown(ledger, s(item.get("id")), now)
        {
            continue;
        }
        eligible.push(item);
    }
    let grouped = caller_gone_candidates(&eligible, ledger, now);
    // Caller-gone members stay out of per-task even when the group was skipped.
    let caller_gone: HashSet<&str> = eligible
        .iter()
        .filter(|item| {
            item.get("kind") == "stalled"
                && item.get("notify") == "important"
                && truth(item.get("waitingOn"))
        })
        .map(|item| s(item.get("id")))
        .collect();
    let mut out = grouped;
    let remaining: Vec<&Item> = eligible
        .into_iter()
        .filter(|item| !caller_gone.contains(s(item.get("id"))))
        .collect();
    out.extend(one_per_task(&remaining));
    out
}
pub fn retain(ledger: &Value, time: f64) -> Value {
    json!(
        ledger
            .as_object()
            .map(|m| m
                .iter()
                .filter(|(_, at)| at.is_number() && n(at) >= time - 7.0 * 86400.0)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>())
            .unwrap_or_default()
    )
}
pub fn transitions(candidates: &mut Vec<Candidate>, items: &[Item], level: &str, events: &[Value]) {
    if level != "all" {
        return;
    }
    for event in events {
        let d = &event["data"];
        let (key, title, body, url) = if event["type"] == "mode" && !d["previous"].is_null() {
            let mode = s(&d["mode"]);
            (
                format!("mode:{mode}:{}", js::number(n(&d["at"]))),
                format!("Budget mode changed to {mode}"),
                format!("{} → {mode}", s(&d["previous"])),
                "/app/#/".into(),
            )
        } else if event["type"] == "task"
            && ["done", "partial", "failed", "limit", "stopped"].contains(&s(&d["state"]))
            && !items.iter().any(|i| i.get("taskId") == &d["id"])
        {
            (
                format!(
                    "task:{}:{}:{}",
                    s(&d["id"]),
                    s(&d["state"]),
                    js::number(n(&d["updatedAt"]))
                ),
                format!("Task {}", s(&d["state"])),
                s(&d["goal"]).into(),
                format!("/app/#/tasks/{}", js::encode(s(&d["id"]))),
            )
        } else {
            continue;
        };
        candidates.push(Candidate {
            key: key.clone(),
            data: Data {
                key,
                title: Text::new(&title),
                body: Text::new(&body),
                actions: vec![],
                url,
                recipients: None,
                client_id: None,
            },
            ack_keys: None,
        });
    }
}
#[derive(Debug, Serialize)]
pub struct NotificationEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub data: EventData,
}
#[derive(Debug, Serialize)]
pub struct EventData {
    pub kind: &'static str,
    pub id: String,
    pub value: Data,
}
#[derive(Debug, Serialize)]
pub struct Delivery {
    pub id: String,
    pub data: Data,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub candidates: Vec<Candidate>,
    pub sent: Vec<NotificationEvent>,
    pub deliveries: Vec<Delivery>,
    pub publications: Vec<Vec<NotificationEvent>>,
    pub state: Value,
}

/// Records presenter targeting on a notify payload. Returns false when the
/// presenter set is empty so the caller keeps plugin fallback and does not
/// publish a client event. `client_id` is the os presenter when one is
/// selected, otherwise the first recipient. Host dispatch I/O is
/// `src/notify/decide.ts`.
pub fn assign_presenters(data: &mut Data, presenters: &[Value]) -> bool {
    if presenters.is_empty() {
        return false;
    }
    let recipients: Vec<String> = presenters
        .iter()
        .map(|presenter| s(&presenter["client_id"]).to_owned())
        .collect();
    let Some(first) = recipients.first().cloned() else {
        return false;
    };
    let client_id = presenters
        .iter()
        .find(|presenter| presenter["medium"] == "os" && presenter["client_id"].is_string())
        .map(|presenter| s(&presenter["client_id"]).to_owned())
        .unwrap_or(first);
    data.recipients = Some(recipients);
    data.client_id = Some(client_id);
    true
}
/// The client outbox keeps the full message; only the bounded notifier plugin
/// protocol clips title/body, using JavaScript UTF-16 slice semantics.
pub fn plugin_message(full: &Data) -> Data {
    let mut data = full.clone();
    data.title = data.title.clip(256);
    data.body = data.body.clip(2048);
    data
}
/// Plugin fallback order uses JS Array.sort's UTF-16 ordering, not localeCompare.
pub fn provider_order(ids: &[String]) -> Vec<String> {
    let mut ids = ids.to_vec();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    ids
}
/// Failed delivery remains retryable. This updates only the supplied snapshot.
/// A successful send also stamps the candidate's ack keys (siblings/group members).
pub fn record_delivery(
    ledger: &mut Value,
    key: &str,
    time: f64,
    delivered: bool,
    ack_keys: Option<&[String]>,
) {
    if delivered {
        ledger[key] = json!(time);
        for ack in ack_keys.unwrap_or_default() {
            ledger[ack.as_str()] = json!(time);
        }
    }
}
