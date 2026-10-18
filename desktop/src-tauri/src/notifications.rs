use crate::{actions, logic};
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct Notification {
    pub title: String,
    pub body: String,
    pub route: String,
    pub actions: Vec<Value>,
}
/// Attention notifications are selected by the service's flag and preference.
/// Notify events have already been filtered and assigned to a notifier by the service.
pub fn from_attention(item: &Value, level: &str) -> Option<Notification> {
    if level == "off"
        || !matches!(item["notify"].as_str(), Some("important" | "all"))
        || (level != "all" && item["notify"] != "important")
    {
        return None;
    }
    Some(project(item, "detail", actions::attention_route(item)))
}
pub fn from_event(data: &Value, client_id: &str) -> Option<Notification> {
    if data["client_id"].as_str() != Some(client_id) {
        return None;
    }
    let route = data["url"]
        .as_str()
        .and_then(|url| url.strip_prefix("/app/#"))
        .and_then(|hash| logic::route(&format!("/{}", hash.trim_start_matches('/'))))
        .unwrap_or_else(|| "#/".into());
    // Newer services may carry an attention item directly.
    if data.get("notify").is_some() {
        return from_attention(data, "all");
    }
    Some(project(data, "body", route))
}
fn project(data: &Value, body: &str, route: String) -> Notification {
    Notification {
        title: clean(data["title"].as_str().unwrap_or("pacer"), 120),
        body: clean(data[body].as_str().unwrap_or(""), 400),
        route,
        actions: data["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| actions::dispatch(a).is_some())
            .take(2)
            .cloned()
            .collect(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn flags_detail_and_two_action_limit() {
        let item = json!({"title":"Review","detail":"Ready","taskId":"t-1","notify":"all","actions":[
            {"label":"Open","op":"ui.open","params":{"view":"review","id":"t-1"}},
            {"label":"Dismiss","op":"attention.dismiss","params":{"id":"review:t-1"}},
            {"label":"Stop","op":"task.stop","params":{"id":"t-1"}}]});
        assert!(from_attention(&item, "off").is_none());
        assert!(from_attention(&item, "important").is_none());
        let n = from_attention(&item, "all").unwrap();
        assert_eq!(n.body, "Ready");
        assert_eq!(n.route, "#/review/t-1");
        assert_eq!(n.actions.len(), 2);
        assert!(from_attention(&json!({"notify":false}), "all").is_none());
        assert!(from_attention(&json!({"notify":"important"}), "important").is_some());
    }
    #[test]
    fn only_targeted_notify_events_are_delivered() {
        let data =
            json!({"client_id":"mine","url":"/app/#/sessions/t-1","title":"Ready","body":"Detail"});
        assert!(from_event(&data, "other").is_none());
        let n = from_event(&data, "mine").unwrap();
        assert_eq!(n.route, "#/sessions/t-1");
        assert_eq!(n.body, "Detail");
    }
}

/// Service text reaches the OS notification centre: drop control characters and cap the length.
pub fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

#[cfg(test)]
mod clean_tests {
    #[test]
    fn strips_control_characters_and_caps_on_char_boundaries() {
        assert_eq!(super::clean("a\u{1b}[31mb\nc", 10), "a[31mbc");
        assert_eq!(super::clean("ééé", 2), "éé");
    }
}
