//! Service action projection, shared by tray and native notifications.
use crate::logic;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Dispatch {
    Open(String),
    Op { op: String, params: Value },
}
pub fn dispatch(action: &Value) -> Option<Dispatch> {
    let op = action["op"].as_str()?;
    let params = action.get("params").filter(|p| p.is_object())?.clone();
    if op == "ui.open" {
        let screen = match params["view"].as_str()? {
            "task" => "tasks",
            "review" => "review",
            "session" => "session",
            "settings" => "settings",
            _ => return None,
        };
        let suffix = params["id"].as_str().or_else(|| params["section"].as_str());
        let raw = suffix.map_or_else(|| format!("/{screen}"), |id| format!("/{screen}/{id}"));
        Some(Dispatch::Open(logic::route(&raw)?))
    } else if valid_op(op) {
        Some(Dispatch::Op {
            op: op.into(),
            params,
        })
    } else {
        None
    }
}
pub fn pause(paused: bool) -> Value {
    if paused {
        json!({"op":"delegation.resume","params":{}})
    } else {
        json!({"op":"delegation.pause","params":{"for":"1h"}})
    }
}
pub fn attention_route(item: &Value) -> String {
    item["actions"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|action| match dispatch(action) {
            Some(Dispatch::Open(route)) => Some(route),
            _ => None,
        })
        .or_else(|| {
            item["taskId"]
                .as_str()
                .and_then(|id| logic::route(&format!("/tasks/{id}")))
        })
        .unwrap_or_else(|| "#/".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operations_preserve_params_and_cannot_escape_route() {
        assert_eq!(
            dispatch(&pause(false)),
            Some(Dispatch::Op {
                op: "delegation.pause".into(),
                params: json!({"for":"1h"})
            })
        );
        assert_eq!(
            dispatch(&pause(true)),
            Some(Dispatch::Op {
                op: "delegation.resume".into(),
                params: json!({})
            })
        );
        assert_eq!(
            dispatch(&json!({"op":"strategy.use","params":{"name":"my strategy"}})),
            Some(Dispatch::Op {
                op: "strategy.use".into(),
                params: json!({"name":"my strategy"})
            })
        );
        assert!(dispatch(&json!({"op":"../x","params":{}})).is_none());
    }
    #[test]
    fn navigation_is_local_and_maps_task_view() {
        assert_eq!(
            dispatch(&json!({"op":"ui.open","params":{"view":"task","id":"t-1"}})),
            Some(Dispatch::Open("#/tasks/t-1".into()))
        );
        assert_eq!(
            dispatch(&json!({"op":"ui.open","params":{"view":"settings","section":"accounts"}})),
            Some(Dispatch::Open("#/settings/accounts".into()))
        );
        assert!(dispatch(&json!({"op":"ui.open","params":{"view":"task","id":"../x"}})).is_none());
    }
}

/// Op names are dotted identifiers (`task.retry`): no empty, dot-only or leading-digit segments,
/// so an op can never become a path segment such as `.` or `..`.
pub fn valid_op(op: &str) -> bool {
    let mut parts = 0;
    for part in op.split('.') {
        let mut bytes = part.bytes();
        match bytes.next() {
            Some(c) if c.is_ascii_lowercase() => {}
            _ => return false,
        }
        if !bytes.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_') {
            return false;
        }
        parts += 1;
    }
    parts >= 2
}

#[cfg(test)]
mod op_name_tests {
    use super::valid_op;
    #[test]
    fn op_names_are_dotted_identifiers() {
        for ok in [
            "task.retry",
            "attention.dismiss",
            "delegation.pause",
            "strategy.use",
        ] {
            assert!(valid_op(ok), "{ok}");
        }
        for bad in [
            "",
            ".",
            "..",
            "a..b",
            "task",
            ".task",
            "task.",
            "Task.retry",
            "1a.b",
            "a/b.c",
            "a.b/../c",
        ] {
            assert!(!valid_op(bad), "{bad}");
        }
    }
}
