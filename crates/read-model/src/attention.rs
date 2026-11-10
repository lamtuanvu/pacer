use crate::{capacity, js::*, read, tasks};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
fn action(label: &str, op: &str, params: Value) -> Value {
    json!({
    "label":label,"op":op,"params":params}
    )
}
fn open(label: &str, params: Value) -> Value {
    action(label, "ui.open", params)
}
#[allow(clippy::too_many_arguments)]
fn item(
    kind: &str,
    key: &str,
    title: &str,
    detail: &str,
    actions: Vec<Value>,
    now: f64,
    extra: Value,
) -> Value {
    merge(
        &json!({
        "id":format!("{kind}:{key}"),"kind":kind,"severity":if ["stuck","stalled"].contains(&kind){
        "blocked"}
        else if ["review","discovery","discovery-network","update"].contains(&kind){
        "decide"}
        else{
        "problem"}
        ,"repo":null,"title":title,"detail":detail,"raisedAt":number(now),"since":number(now),"actions":actions,"notify":if ["setup","update"].contains(&kind){
        "all"}
        else{
        "important"}
        }
        ),
        &extra,
    )
}
pub fn sort(items: &mut [Value]) {
    let rank = |v: &Value| match text(&v["severity"]) {
        "blocked" => 0,
        "problem" => 1,
        _ => 2,
    };
    items.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(num(&a["since"]).total_cmp(&num(&b["since"])))
            .then(text(&a["id"]).cmp(text(&b["id"])))
    });
}
pub fn derive(
    ctx: &Ctx,
    tasks: &[Value],
    executors: &[Value],
    accounts: &[Value],
    setup: &Value,
    planner: &Value,
    can_pair: bool,
) -> Vec<Value> {
    let items = raised(ctx, tasks, executors, accounts, setup, planner, can_pair);
    let store = read(ctx, "state/attention.json");
    let mut items: Vec<Value> = items
        .into_iter()
        .filter_map(|mut a| {
            let entry = &store[text(&a["id"])];
            let since = entry.get("since").cloned().unwrap_or(number(ctx.now));
            if entry.get("dismissedSince") == Some(&since) || num(&entry["snoozedUntil"]) > ctx.now
            {
                return None;
            }
            a["since"] = since.clone();
            if !truth(&a["taskId"]) {
                a["raisedAt"] = since;
            }
            if let Some(v) = entry.get("snoozedUntil") {
                a["snoozedUntil"] = v.clone();
            }
            Some(a)
        })
        .collect();
    sort(&mut items);
    items
}
/// The items the rules raise before `state/attention.json` hides dismissed and snoozed ones.
pub fn raised(
    ctx: &Ctx,
    tasks: &[Value],
    executors: &[Value],
    accounts: &[Value],
    setup: &Value,
    planner: &Value,
    can_pair: bool,
) -> Vec<Value> {
    let mut items = Vec::new();
    let superseded = tasks::superseded(tasks);
    for source in tasks {
        if superseded.contains(&source["id"]) {
            continue;
        }
        let mut t = source.clone();
        if tasks.iter().any(|a| {
            a["id"] == t["retriedBy"] && (truth(&a["dismissed"]) || a["state"] == "stopped")
        }) {
            remove(&mut t, "retriedBy");
        }
        let id = text(&t["id"]);
        let title = t["fullTitle"].as_str().unwrap_or(text(&t["title"]));
        let mut extra = json!({
        "repo":t["repo"],"taskId":id}
        );
        for key in ["executor", "host"] {
            if truth(&t[key]) {
                extra[key] = t[key].clone();
            }
        }
        extra["since"] = t["updatedAt"].clone();
        extra["raisedAt"] = t["updatedAt"].clone();
        let params = json!({
        "view":"task","id":id}
        );
        let reason = tasks::attention_reason(&t);
        let legacy = t["state"] == "needs_input"
            && truth(&t["question"])
            && t["question"].get("answer").is_none()
            && !truth(&t["retriedBy"]);
        if legacy && !truth(&t["dismissed"]) {
            let mut e = extra.clone();
            e["severity"] = json!("blocked");
            e["since"] = t["question"]["at"].clone();
            e["raisedAt"] = t["question"]["at"].clone();
            let mut stop = action(
                "Stop",
                "task.stop",
                json!({
                "id":id}
                ),
            );
            stop["style"] = json!("danger");
            items.push(item(
                "question",
                id,
                title,
                &slice(text(&t["question"]["text"]), 200),
                vec![
                    action(
                        "Answer",
                        if truth(&t["work"]) { "dispatch.answer" } else { "task.answer" },
                        if truth(&t["work"]) { json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.answer",id,t["rev"])}) } else { json!({"id":id}) },
                    ),
                    stop,
                ],
                ctx.now,
                e,
            ));
        } else if let Some(reason) = reason {
            let (detail, label, view) = match reason {
                "checks_failed" => ("Acceptance checks failed", "Inspect failures", "task"),
                "incomplete" => ("Execution is incomplete", "Inspect incomplete work", "task"),
                _ => (
                    text(&t["reviewRequest"]["note"]),
                    "Review changes",
                    "review",
                ),
            };
            let kind = if reason == "review_requested" {
                "review"
            } else {
                "failed"
            };
            let mut e = extra.clone();
            if kind == "review" {
                e["since"] = t["reviewRequest"]["at"].clone();
                e["raisedAt"] = t["reviewRequest"]["at"].clone();
            }
            items.push(item(
                kind,
                id,
                title,
                detail,
                vec![open(
                    label,
                    json!({
                    "view":view,"id":id}
                    ),
                )],
                ctx.now,
                e,
            ));
        } else if ["failed", "limit"].contains(&text(&t["state"]))
            && !["retriedBy", "dismissed", "review", "resolved"]
                .iter()
                .any(|key| truth(&t[key]))
        {
            let managed = truth(&t["work"]);
            let target = executors.iter().find(|e| {
                e["id"] != t["executor"]
                    && e["enabled"] == true
                    && e["rank"] != "planner"
                    && e["state"] == "ready"
                    && num(&e["slots"]["used"]) < num(&e["slots"]["max"])
            });
            let target = if managed { None } else { target };
            let mut params = if managed {
                json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.retry",id,t["rev"])})
            } else {
                json!({"id":id})
            };
            let label = target.map_or("Retry".into(), |e| {
                format!("Retry on {}", capacity::display(text(&e["id"])))
            });
            if let Some(e) = target {
                params["executor"] = e["id"].clone();
            }
            let detail = if managed || target.is_some() {
                format!(
                    "{} {}",
                    capacity::display(text(&t["executor"])),
                    if t["state"] == "limit" {
                        "reached its limit"
                    } else {
                        "failed"
                    }
                )
            } else {
                "No other executor available".into()
            };
            items.push(item(
                text(&t["state"]),
                id,
                title,
                &detail,
                vec![
                    action(
                        &label,
                        if managed {
                            "dispatch.retry"
                        } else {
                            "task.retry"
                        },
                        params,
                    ),
                    open(
                        "See error",
                        json!({
                        "view":"task","id":id}
                        ),
                    ),
                ],
                ctx.now,
                extra.clone(),
            ));
        } else if t["state"] == "running" && t["progress"]["phase"] == "idle" {
            let mut stop = action(
                "Stop it",
                "task.stop",
                json!({
                "id":id}
                ),
            );
            stop["style"] = json!("danger");
            items.push(item(
                "stuck",
                id,
                title,
                "Waiting for output",
                vec![open("Open task", params.clone()), stop],
                ctx.now,
                extra.clone(),
            ));
        }
        if t["liveness"]["stalled"] == true {
            let mut e = extra.clone();
            e["since"] = t["liveness"]["since"].clone();
            e["raisedAt"] = t["liveness"]["since"].clone();
            items.push(item(
                "stalled",
                id,
                title,
                &format!("Conversation stalled: {}", text(&t["liveness"]["reason"])),
                vec![open(
                    "Open messages",
                    json!({
                    "view":"task","id":id,"tab":"messages"}
                    ),
                )],
                ctx.now,
                e,
            ));
        }
        if truth(&t["messages"]["unreadForHuman"]) && !truth(&t["dismissed"]) && !legacy {
            let q = &t["messages"]["question"];
            let n = num(&t["messages"]["unreadForHuman"]);
            let answerable = truth(q) && !truth(&t["review"]) && t["state"] != "stopped";
            let mut a = if answerable {
                open(
                    "Answer",
                    json!({
                    "view":"task","id":id,"tab":"answer"}
                    ),
                )
            } else {
                open("Open task", params)
            };
            a["style"] = json!("primary");
            let mut e = extra;
            e["severity"] = json!(if truth(q) { "blocked" } else { "decide" });
            if truth(q) {
                e["since"] = q["at"].clone();
                e["raisedAt"] = q["at"].clone();
            }
            let detail = if truth(q) {
                slice(text(&q["text"]), 200)
            } else {
                format!(
                    "{} unread message{}",
                    stringify(&number(n)),
                    if n == 1.0 { "" } else { "s" }
                )
            };
            items.push(item("message", id, title, &detail, vec![a], ctx.now, e));
        }
    }
    for a in accounts {
        if a["signedIn"] == false
            && executors
                .iter()
                .any(|e| e["account"] == a["name"] && truth(&e["enabled"]))
        {
            let mut actions = vec![action(
                "Sign in",
                "account.signin",
                json!({
                "name":a["name"]}
                ),
            )];
            actions.extend(
                executors
                    .iter()
                    .filter(|e| {
                        e["account"] == a["name"] && truth(&e["enabled"]) && e["rank"] != "planner"
                    })
                    .map(|e| {
                        action(
                            "Disable",
                            "runner.set",
                            json!({
                            "id":e["id"],"enabled":false}
                            ),
                        )
                    }),
            );
            items.push(item(
                "account_signin",
                text(&a["name"]),
                &format!("Sign in to {}", capacity::display(text(&a["agent"]))),
                "Account is signed out",
                actions,
                ctx.now,
                json!({
                "account":a["name"]}
                ),
            ));
        }
    }
    for e in executors {
        if e["enabled"] == true
            && e["rank"] != "planner"
            && !accounts
                .iter()
                .any(|a| a["name"] == e["account"] && a["signedIn"] == false)
            && (e["state"] == "down"
                || e["lastCheck"]["passed"] == false && e["state"] != "checking")
        {
            let mut extra = json!({
            "executor":e["id"]}
            );
            if truth(&e["host"]) {
                extra["host"] = e["host"].clone();
            }
            items.push(item(
                "executor_down",
                text(&e["id"]),
                &format!("{} needs attention", capacity::display(text(&e["id"]))),
                "Executor is not working",
                vec![
                    open(
                        "Open settings",
                        json!({
                        "view":"settings","section":"executors"}
                        ),
                    ),
                    action(
                        "Disable",
                        "runner.set",
                        json!({
                        "id":e["id"],"enabled":false}
                        ),
                    ),
                ],
                ctx.now,
                extra,
            ));
        }
    }
    if planner["verdict"] == "out" && num(&planner["modeHeldUntil"]) <= ctx.now {
        items.push(item(
            "planner_quota",
            text(&planner["runner"]),
            &format!(
                "{} is out of quota",
                capacity::display(text(&planner["runner"]))
            ),
            text(&planner["advice"]),
            vec![
                open(
                    "Open planner settings",
                    json!({
                    "view":"settings","section":"planner"}
                    ),
                ),
                action(
                    "Keep normal",
                    "mode.hold",
                    json!({
                    "mode":"normal"}
                    ),
                ),
            ],
            ctx.now,
            json!({
            "executor":planner["runner"]}
            ),
        ));
    }
    for s in array(&setup["items"]) {
        if s["required"] == true && s["status"] != "done" {
            items.push(item(
                "setup",
                text(&s["id"]),
                text(&s["title"]),
                "Setup required",
                vec![open(
                    "Open settings",
                    json!({
                    "view":"settings","section":s["id"]}
                    ),
                )],
                ctx.now,
                object(),
            ));
        }
    }
    let state = read(ctx, "discovery/state.json");
    if state.is_null() || state["enabled"] != false {
        let mut seen = values(&state["seen"]);
        seen.sort_by(|a, b| num(&a["promptedAt"]).total_cmp(&num(&b["promptedAt"])));
        for p in seen {
            let id = text(&p["discoveryId"]);
            let at = num(&p["promptedAt"]);
            let silence = &state["silenced"][id];
            if at <= ctx.now - 604800.0
                || p.get("promptedAt").is_none()
                || p.get("handedOverAt").is_some_and(|v| num(v) >= at)
                || *silence == "forever"
                || num(silence) > ctx.now
                || state["networks"][text(&p["network"])]["muted"] == true
            {
                continue;
            }
            let mut pair = if can_pair {
                action(
                    "Pair",
                    "discovery.respond",
                    json!({
                    "discoveryId":id,"action":"pair"}
                    ),
                )
            } else {
                open(
                    "Pair",
                    json!({
                    "view":"settings","section":"pairing"}
                    ),
                )
            };
            pair["style"] = json!("primary");
            items.push(item(
                "discovery",
                id,
                &format!("Found pacer on {}", text(&p["name"])),
                "Unverified name. Pair only if this is your machine.",
                vec![
                    pair,
                    action(
                        "Later",
                        "discovery.respond",
                        json!({
                        "discoveryId":id,"action":"later"}
                        ),
                    ),
                ],
                ctx.now,
                json!({
                "since":number(at),"raisedAt":number(at)}
                ),
            ));
        }
    }
    items
}

#[cfg(test)]
mod managed_action_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn managed_and_ordinary_attention_actions_preserve_protocol() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().join("home"),
            HashMap::new(),
            100.0,
        );
        for state in ["failed", "limit", "needs_input"] {
            for managed in [false, true] {
                let mut task = json!({"id":"t-1","title":"Task","state":state,"rev":7,"updatedAt":10,"executor":"codex","question":{"text":"Which?","at":5}});
                if managed {
                    task["work"] = json!({"rootId":"t-1","depth":0});
                }
                let items = raised(
                    &ctx,
                    &[task],
                    &[],
                    &[],
                    &json!({"items":[]}),
                    &Value::Null,
                    false,
                );
                let action = &items[0]["actions"][0];
                let kind = if state == "needs_input" {
                    "answer"
                } else {
                    "retry"
                };
                assert_eq!(
                    action["op"],
                    format!("{}.{}", if managed { "dispatch" } else { "task" }, kind)
                );
                if managed {
                    assert_eq!(
                        action["params"],
                        json!({"id":"t-1","expect_rev":7,"requestId":format!("t-1.7.{kind}")})
                    );
                } else {
                    assert_eq!(action["params"], json!({"id":"t-1"}));
                }
            }
        }
    }
}
