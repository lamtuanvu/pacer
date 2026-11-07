//! Notification candidates and delivery acknowledgement decisions.
use crate::{
    a,
    attention::Item,
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
pub fn candidates(items: &[Item], level: &str, ledger: &Value) -> Vec<Candidate> {
    if level == "off" {
        return vec![];
    }
    let mut seen: HashSet<_> = ledger
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let mut out = vec![];
    for item in items {
        let key = format!("{}:{}", s(item.get("id")), js::number(n(item.get("since"))));
        if seen.contains(&key) || level == "important" && item.get("notify") != "important" {
            continue;
        }
        seen.insert(key.clone());
        out.push(Candidate {
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
        });
    }
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
pub fn record_delivery(ledger: &mut Value, key: &str, time: f64, delivered: bool) {
    if delivered {
        ledger[key] = json!(time);
    }
}
