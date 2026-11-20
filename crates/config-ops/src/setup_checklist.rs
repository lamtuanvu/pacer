//! Checklist rules of `src/setup/checklist.ts` and the reply of `checkSetup`
//! (`src/setup/check.ts`), over the facts Core gathers. Key order matches TypeScript.
use serde_json::{Map, Value, json};

const PLANNERS: [&str; 4] = ["claude-code", "codex", "cursor", "opencode"];

/// A fact that JavaScript reads as truthy text.
fn text<'a>(value: Option<&'a Value>) -> Option<&'a str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

#[derive(Default)]
struct Row<'a> {
    detail: Option<&'a str>,
    command: Option<&'a str>,
    action: Option<&'a str>,
    error: Option<&'a str>,
}

fn item(id: &str, title: &str, required: bool, done: bool, row: Row<'_>) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("id".into(), id.into());
    map.insert("title".into(), title.into());
    map.insert("required".into(), required.into());
    let status = match (row.error.is_some(), done) {
        (true, _) => "failed",
        (false, true) => "done",
        (false, false) => "pending",
    };
    map.insert("status".into(), status.into());
    if let Some(detail) = row.error.or(row.detail.filter(|d| !d.is_empty())) {
        map.insert("detail".into(), detail.into());
    }
    if !done || row.error.is_some() {
        if let Some(command) = row.command.filter(|c| !c.is_empty()) {
            map.insert("command".into(), command.into());
        }
        if let Some(action) = row.action {
            map.insert("action".into(), action.into());
        }
    }
    map
}

/// `updateChecklist`: the status-derived rows, in place.
fn update_items(items: &mut [Map<String, Value>], facts: &Value) {
    let list = |key: &str| {
        facts
            .pointer(&format!("/executors/{key}"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let (ranked, excluded) = (list("ranked"), list("excluded"));
    let field = |entry: &Value, key: &str| entry[key].as_str().unwrap_or("").to_owned();
    let verdict = text(facts.get("verdict")).is_some_and(|verdict| verdict != "UNKNOWN");
    let reviewed = facts["reviewed"] == json!(true);
    let skipped = facts["skipped"] == json!(true);
    for row in items {
        match row["id"].as_str().unwrap_or("") {
            "executor" => {
                let has = !ranked.is_empty();
                row.insert("status".into(), if has { "done" } else { "pending" }.into());
                let detail = if has {
                    let ids: Vec<_> = ranked.iter().map(|e| field(e, "id")).collect();
                    ids.join(", ")
                } else if !excluded.is_empty() {
                    let why: Vec<_> = excluded
                        .iter()
                        .map(|e| format!("{}: {}", field(e, "id"), field(e, "reason")))
                        .collect();
                    why.join("; ")
                } else {
                    "no executor configured".to_owned()
                };
                row.insert("detail".into(), detail.into());
                if !has {
                    row.insert("command".into(), "pacer runner add".into());
                    row.insert("action".into(), "nav:add-executor".into());
                }
            }
            "usage" => {
                row.insert(
                    "status".into(),
                    if verdict { "done" } else { "pending" }.into(),
                );
            }
            "first" if reviewed || skipped => {
                row.insert("status".into(), "done".into());
                row.shift_remove("action");
                if skipped {
                    row.insert("detail".into(), "Skipped".into());
                }
            }
            _ => {}
        }
    }
}

fn planner_item(facts: &Value, planner: Option<&str>, agents: &[Value]) -> Map<String, Value> {
    let error = text(facts.pointer("/errors/strategy"));
    let Some(planner) = planner else {
        let mut row = item(
            "planner",
            "Planner",
            true,
            false,
            Row {
                detail: Some("Choose which agent plans your work"),
                command: Some("pacer init"),
                action: Some("setup.init"),
                error: None,
            },
        );
        let options: Vec<Value> = PLANNERS
            .into_iter()
            .filter(|id| {
                agents
                    .iter()
                    .any(|a| a["id"] == json!(id) && a["cliInstalled"] == json!(true))
            })
            .map(Value::from)
            .collect();
        row.insert("options".into(), options.into());
        return row;
    };
    let signed_out = facts["signedIn"] == json!(false);
    let detail = format!("{planner}{}", if signed_out { " · signed out" } else { "" });
    item(
        "planner",
        "Planner",
        true,
        !signed_out,
        Row {
            detail: Some(&detail),
            command: facts["loginCommand"].as_str(),
            action: None,
            error,
        },
    )
}

fn connect_item(
    facts: &Value,
    planner: Option<&str>,
    agent: Option<&str>,
    agents: &[Value],
) -> Map<String, Value> {
    let connected = facts["connected"] != json!(false);
    let mut row = item(
        "connect",
        "Connect planner",
        true,
        planner.is_some() && connected,
        Row {
            detail: Some(if connected {
                "Connected"
            } else {
                "Integration missing or changed"
            }),
            command: Some("pacer init"),
            action: Some("agent.connect"),
            error: text(facts.pointer("/errors/connect")),
        },
    );
    if let Some(agent) = agent {
        row.insert("agent".into(), agent.into());
        let installed = agents
            .iter()
            .find(|a| a["id"] == json!(agent))
            .and_then(|a| a["cliInstalled"].as_bool())
            .unwrap_or(false);
        row.insert("installed".into(), installed.into());
    }
    row
}

fn agent_item(agent: &Value) -> Map<String, Value> {
    let id = agent["id"].as_str().unwrap_or("");
    let installed = agent["installed"] == json!(true);
    let mut row = item(
        &format!("agent:{id}"),
        agent["name"].as_str().unwrap_or(""),
        false,
        installed,
        Row {
            detail: Some(if installed {
                "Connected"
            } else {
                "Optional · not connected"
            }),
            command: Some("pacer init"),
            action: Some("agent.connect"),
            error: None,
        },
    );
    row.insert("agent".into(), id.into());
    if let Some(cli) = agent.get("cliInstalled") {
        row.insert("installed".into(), cli.clone());
    }
    row
}

fn checklist_items(facts: &Value) -> Vec<Map<String, Value>> {
    let planner = text(facts.get("planner"));
    let plan_agent = planner.and_then(|p| p.split(['#', '@']).next());
    let agents = facts["agents"].as_array().cloned().unwrap_or_default();
    let version = text(facts.get("version"));
    let service =
        facts["service"]["installed"] == json!(true) && facts["service"]["running"] == json!(true);
    let usage_detail = format!(
        "Start a session in {} once",
        planner.unwrap_or("your planner")
    );
    let reviewed = facts["reviewed"] == json!(true);
    let skipped = facts["skipped"] == json!(true);
    let verdict = text(facts.get("verdict")).is_some_and(|verdict| verdict != "UNKNOWN");
    let mut items = vec![
        item(
            "binary",
            "pacer",
            true,
            version.is_some(),
            Row {
                detail: version,
                command: Some("pacer init"),
                action: None,
                error: text(facts.pointer("/errors/binary")),
            },
        ),
        planner_item(facts, planner, &agents),
        item(
            "service",
            "Background service",
            true,
            service,
            Row {
                command: Some("pacer service install"),
                action: Some("service.install"),
                error: text(facts.pointer("/errors/service")),
                ..Row::default()
            },
        ),
        connect_item(facts, planner, plan_agent, &agents),
        item(
            "link",
            "Link",
            true,
            facts["link"] == json!(true),
            Row {
                command: Some("pacer init"),
                error: text(facts.pointer("/errors/link")),
                ..Row::default()
            },
        ),
        item("executor", "Executor", false, false, Row::default()),
        item(
            "usage",
            "Budget data",
            false,
            verdict,
            Row {
                detail: Some(&usage_detail),
                ..Row::default()
            },
        ),
        item(
            "first",
            "First delegation",
            false,
            reviewed || skipped,
            Row {
                detail: skipped.then_some("Skipped"),
                action: Some("onboarding.try"),
                ..Row::default()
            },
        ),
    ];
    items.extend(
        agents
            .iter()
            .filter(|a| a["id"].as_str() != plan_agent)
            .map(agent_item),
    );
    update_items(&mut items, facts);
    items
}

/// The `setup.check` reply for Core's facts.
pub fn checklist(facts: &Value, checked_at: Value) -> Value {
    let mut items = checklist_items(facts);
    let connected = facts["connected"] == json!(true);
    if connected && let Some(row) = items.iter_mut().find(|row| row["id"] == json!("connect")) {
        row.insert(
            "detail".into(),
            "Configured · runtime invocation unverified. Run Settings Diagnostics for checks."
                .into(),
        );
    }
    let done = |row: &Map<String, Value>| row["status"] == json!("done");
    let complete = items
        .iter()
        .filter(|row| row["required"] == json!(true))
        .all(done);
    let ready = complete
        && ["executor", "first"]
            .iter()
            .all(|id| items.iter().any(|row| row["id"] == json!(id) && done(row)));
    let mut reply = Map::new();
    reply.insert("checkedAt".into(), checked_at);
    reply.insert("complete".into(), complete.into());
    reply.insert("ready".into(), ready.into());
    reply.insert(
        "items".into(),
        items.into_iter().map(Value::Object).collect(),
    );
    if let Some(policy) = facts.get("policy") {
        reply.insert("policy".into(), policy.clone());
    }
    reply.insert(
        "integration".into(),
        json!({
            "configuration": if connected { "configured" } else { "unverified" },
            "invocation": "unverified",
        }),
    );
    Value::Object(reply)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn facts() -> Value {
        json!({
            "version": "1.0.0", "planner": "codex#work", "signedIn": true, "connected": true,
            "service": {"installed": true, "running": true}, "link": true,
            "executors": {"ranked": [{"id": "claude-code"}], "excluded": []}, "verdict": "OK",
            "reviewed": true, "skipped": false, "errors": {},
            "agents": [
                {"id": "codex", "name": "Codex", "installed": true, "cliInstalled": true},
                {"id": "cursor", "name": "Cursor", "installed": false, "cliInstalled": false},
            ],
            "policy": {"mode": "open", "plugins": 0},
        })
    }

    #[test]
    fn a_finished_setup_is_ready_and_keeps_typescript_key_order() {
        let reply = checklist(&facts(), json!(5));
        assert_eq!(reply["ready"], json!(true));
        let keys: Vec<_> = reply.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "checkedAt",
                "complete",
                "ready",
                "items",
                "policy",
                "integration"
            ]
        );
        let connect = &reply["items"][3];
        assert_eq!(connect["agent"], json!("codex"));
        assert_eq!(
            connect["detail"],
            json!(
                "Configured · runtime invocation unverified. Run Settings Diagnostics for checks."
            )
        );
        // The planner's own agent has no optional row.
        assert_eq!(reply["items"].as_array().unwrap().len(), 9);
    }

    #[test]
    fn missing_facts_leave_the_rows_pending() {
        let mut input = facts();
        input["planner"] = Value::Null;
        input["connected"] = json!(false);
        input["executors"] =
            json!({"ranked": [], "excluded": [{"id": "codex", "reason": "blocked"}]});
        input["errors"] = json!({"strategy": "bad yaml"});
        let reply = checklist(&input, json!(5));
        assert_eq!(reply["complete"], json!(false));
        assert_eq!(reply["items"][1]["options"], json!(["codex"]));
        assert_eq!(reply["items"][5]["detail"], json!("codex: blocked"));
        assert_eq!(reply["items"][5]["action"], json!("nav:add-executor"));
        assert_eq!(reply["integration"]["configuration"], json!("unverified"));
    }
}
