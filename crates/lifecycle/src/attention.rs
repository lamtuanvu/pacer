//! Attention rules and store transitions, without persistence or retry selection.
use crate::{
    Error, a,
    js::{self, Text},
    n, s, truth,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
pub struct Item {
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
    pub detail: Text,
}
impl Item {
    pub fn from_value(v: &Value) -> Self {
        let mut fields = v.as_object().cloned().unwrap_or_default();
        fields.remove("detail");
        Self {
            fields,
            detail: Text::new(s(&v["detail"])),
        }
    }
    pub fn get(&self, key: &str) -> &Value {
        self.fields.get(key).unwrap_or(&Value::Null)
    }
}
fn open(label: &str, params: Value) -> Value {
    json!({"label":label,"op":"ui.open","params":params})
}
fn action(label: &str, op: &str, params: Value) -> Value {
    json!({"label":label,"op":op,"params":params})
}
fn danger(label: &str, op: &str, id: &str) -> Value {
    let mut v = action(label, op, json!({"id":id}));
    v["style"] = "danger".into();
    v
}
fn display(id: &Value) -> &str {
    let id = s(id);
    let agent = id.split(['#', '@']).next().unwrap_or("");
    let re =
        regex::Regex::new(r"^[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?(?:@[a-z0-9][a-z0-9-]*)?$")
            .ok();
    let valid = re.is_some_and(|r| r.is_match(id))
        && ["agy", "codex", "claude-code", "cursor", "opencode"].contains(&agent);
    name(if valid { agent } else { id })
}
fn name(agent: &str) -> &str {
    match agent {
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
pub fn sort(items: &mut [Item]) {
    let severity = |i: &Item| match s(i.get("severity")) {
        "blocked" => 0,
        "problem" => 1,
        _ => 2,
    };
    items.sort_by(|a, b| {
        severity(a)
            .cmp(&severity(b))
            .then_with(|| {
                n(a.get("since"))
                    .partial_cmp(&n(b.get("since")))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| js::compare(s(a.get("id")), s(b.get("id"))))
    });
}
// Each argument corresponds to a field in the TS rule constructor.
#[allow(clippy::too_many_arguments)]
fn add(
    items: &mut Vec<Item>,
    time: f64,
    kind: &str,
    key: &str,
    title: &str,
    detail: &str,
    actions: Vec<Value>,
    extra: Value,
) {
    let severity = if ["stuck", "stalled"].contains(&kind) {
        "blocked"
    } else if ["review", "update", "discovery", "discovery-network"].contains(&kind) {
        "decide"
    } else {
        "problem"
    };
    let mut v = json!({"id":format!("{kind}:{key}"),"kind":kind,"severity":severity,"repo":null,"title":title,"detail":detail,"raisedAt":time,"since":time,"actions":actions,"notify":if ["setup","update"].contains(&kind){"all"}else{"important"}});
    if let Some(extra) = extra.as_object() {
        for (k, val) in extra {
            v[k] = val.clone();
        }
    }
    let mut item = Item::from_value(&v);
    if kind == "question" || kind == "message" {
        item.detail = item.detail.slice(200);
    }
    items.push(item);
}
fn reason(t: &Value) -> &str {
    if !["done", "partial"].contains(&s(&t["state"]))
        || ["review", "resolved", "dismissed", "retriedBy"]
            .iter()
            .any(|k| truth(&t[k]))
    {
        return "";
    }
    if t["acceptanceState"] == "failed" {
        "checks_failed"
    } else if t["state"] == "partial" {
        "incomplete"
    } else if truth(&t["reviewRequest"]) {
        "review_requested"
    } else {
        ""
    }
}
pub fn derive(input: &Value, time: f64) -> Vec<Item> {
    let mut items = vec![];
    for t in a(&input["tasks"]) {
        let id = s(&t["id"]);
        let goal = s(&t["goal"]);
        let state = s(&t["state"]);
        let mut extra =
            json!({"repo":t["repo"],"taskId":id,"since":t["updatedAt"],"raisedAt":t["updatedAt"]});
        for key in ["executor", "host"] {
            if truth(&t[key]) {
                extra[key] = t[key].clone();
            }
        }
        let question = state == "needs_input"
            && truth(&t["question"])
            && t["question"].get("answer").is_none()
            && !truth(&t["retriedBy"]);
        let why = reason(t);
        if question && !truth(&t["dismissed"]) {
            let mut x = extra.clone();
            x["severity"] = "blocked".into();
            x["since"] = t["question"]["at"].clone();
            x["raisedAt"] = x["since"].clone();
            add(
                &mut items,
                time,
                "question",
                id,
                goal,
                s(&t["question"]["text"]),
                vec![
                    action(
                        "Answer",
                        if truth(&t["work"]) {
                            "dispatch.answer"
                        } else {
                            "task.answer"
                        },
                        if truth(&t["work"]) {
                            json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.answer",id,t["rev"])})
                        } else {
                            json!({"id":id})
                        },
                    ),
                    danger("Stop", "task.stop", id),
                ],
                x,
            );
        } else if ["checks_failed", "incomplete"].contains(&why) {
            add(
                &mut items,
                time,
                "failed",
                id,
                goal,
                if why == "checks_failed" {
                    "Acceptance checks failed"
                } else {
                    "Execution is incomplete"
                },
                vec![open(
                    if why == "checks_failed" {
                        "Inspect failures"
                    } else {
                        "Inspect incomplete work"
                    },
                    json!({"view":"task","id":id}),
                )],
                extra.clone(),
            );
        } else if why == "review_requested" {
            let mut x = extra.clone();
            x["since"] = t["reviewRequest"]["at"].clone();
            x["raisedAt"] = x["since"].clone();
            add(
                &mut items,
                time,
                "review",
                id,
                goal,
                s(&t["reviewRequest"]["note"]),
                vec![open("Review changes", json!({"view":"review","id":id}))],
                x,
            );
        } else if ["failed", "limit"].contains(&state)
            && !["retriedBy", "dismissed", "review", "resolved"]
                .iter()
                .any(|k| truth(&t[k]))
        {
            let target = &input["retryTargets"][id];
            let managed = truth(&t["work"]);
            let has = !managed && truth(target);
            let mut params = if managed {
                json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.retry",id,t["rev"])})
            } else {
                json!({"id":id})
            };
            if has {
                params["executor"] = target.clone();
            }
            let detail = if managed || has {
                format!(
                    "{} {}",
                    display(&t["executor"]),
                    if state == "limit" {
                        "reached its limit"
                    } else {
                        "failed"
                    }
                )
            } else {
                "No other executor available".into()
            };
            add(
                &mut items,
                time,
                state,
                id,
                goal,
                &detail,
                vec![
                    action(
                        &if has {
                            format!("Retry on {}", display(target))
                        } else {
                            "Retry".into()
                        },
                        if managed {
                            "dispatch.retry"
                        } else {
                            "task.retry"
                        },
                        params,
                    ),
                    open("See error", json!({"view":"task","id":id})),
                ],
                extra.clone(),
            );
        } else if state == "running" && t["progress"]["phase"] == "idle" {
            add(
                &mut items,
                time,
                "stuck",
                id,
                goal,
                "Waiting for output",
                vec![
                    open("Open task", json!({"view":"task","id":id})),
                    danger("Stop it", "task.stop", id),
                ],
                extra.clone(),
            );
        }
        if truth(&t["liveness"]["stalled"]) {
            let mut x = extra.clone();
            x["since"] = t["liveness"]["since"].clone();
            x["raisedAt"] = x["since"].clone();
            add(
                &mut items,
                time,
                "stalled",
                id,
                goal,
                &format!("Conversation stalled: {}", s(&t["liveness"]["reason"])),
                vec![open(
                    "Open messages",
                    json!({"view":"task","id":id,"tab":"messages"}),
                )],
                x,
            );
        }
        if truth(&t["messages"]["unreadForHuman"]) && !truth(&t["dismissed"]) && !question {
            let q = &t["messages"]["question"];
            let has = truth(q);
            let mut x = extra.clone();
            x["severity"] = if has { "blocked" } else { "decide" }.into();
            x["since"] = q
                .get("at")
                .filter(|v| !v.is_null())
                .unwrap_or(&t["updatedAt"])
                .clone();
            x["raisedAt"] = x["since"].clone();
            let answerable = has && !truth(&t["review"]) && state != "stopped";
            let mut act = if answerable {
                open("Answer", json!({"view":"task","id":id,"tab":"answer"}))
            } else {
                open("Open task", json!({"view":"task","id":id}))
            };
            act["style"] = "primary".into();
            let count = n(&t["messages"]["unreadForHuman"]);
            let detail = if has {
                s(&q["text"]).into()
            } else {
                format!(
                    "{} unread message{}",
                    js::number(count),
                    if count == 1.0 { "" } else { "s" }
                )
            };
            add(&mut items, time, "message", id, goal, &detail, vec![act], x);
        }
    }
    let executors = a(&input["executors"]);
    let signed_out: HashSet<&str> = a(&input["accounts"])
        .iter()
        .filter(|x| x["signedIn"] == false)
        .map(|x| s(&x["name"]))
        .collect();
    for account in a(&input["accounts"]) {
        let key = s(&account["name"]);
        if account["signedIn"] != false
            || !executors
                .iter()
                .any(|e| s(&e["account"]) == key && truth(&e["enabled"]))
        {
            continue;
        }
        let mut acts = vec![action("Sign in", "account.signin", json!({"name":key}))];
        acts.extend(
            executors
                .iter()
                .filter(|e| {
                    s(&e["account"]) == key && truth(&e["enabled"]) && e["rank"] != "planner"
                })
                .map(|e| {
                    action(
                        "Disable",
                        "runner.set",
                        json!({"id":e["id"],"enabled":false}),
                    )
                }),
        );
        add(
            &mut items,
            time,
            "account_signin",
            key,
            &format!("Sign in to {}", name(s(&account["agent"]))),
            "Account is signed out",
            acts,
            json!({"account":key}),
        );
    }
    for e in executors {
        if truth(&e["enabled"])
            && e["rank"] != "planner"
            && !signed_out.contains(s(&e["account"]))
            && (e["state"] == "down"
                || e["lastCheck"]["passed"] == false && e["state"] != "checking")
        {
            let mut extra = json!({"executor":e["id"]});
            if truth(&e["host"]) {
                extra["host"] = e["host"].clone();
            }
            add(
                &mut items,
                time,
                "executor_down",
                s(&e["id"]),
                &format!("{} needs attention", display(&e["id"])),
                "Executor is not working",
                vec![
                    open(
                        "Open settings",
                        json!({"view":"settings","section":"executors"}),
                    ),
                    action(
                        "Disable",
                        "runner.set",
                        json!({"id":e["id"],"enabled":false}),
                    ),
                ],
                extra,
            );
        }
    }
    for h in a(&input["hosts"]) {
        if h["state"] != "down"
            || !executors
                .iter()
                .any(|e| e["host"] == h["alias"] && truth(&e["enabled"]))
        {
            continue;
        }
        let candidates: Vec<_> = executors
            .iter()
            .filter(|e| {
                truth(&e["enabled"])
                    && e["rank"] != "planner"
                    && e["host"] != h["alias"]
                    && ["ready", "busy"].contains(&s(&e["state"]))
            })
            .collect();
        let next = candidates
            .iter()
            .find(|e| truth(&e["next"]))
            .or(candidates.first());
        add(
            &mut items,
            time,
            "host_down",
            s(&h["alias"]),
            &format!("{} is down", s(&h["alias"])),
            &format!(
                "{} task(s) running there. New work goes to {} until it is back.",
                js::number(n(&h["running"])),
                next.map(|e| display(&e["id"]))
                    .unwrap_or("the next available executor")
            ),
            vec![
                action("Run checks", "host.check", json!({"alias":h["alias"]})),
                action(
                    "Pause host",
                    "host.set",
                    json!({"alias":h["alias"],"paused":true}),
                ),
            ],
            json!({"host":h["alias"]}),
        );
    }
    let p = &input["planner"];
    if truth(p)
        && !(truth(&p["modeHeldUntil"]) && n(&p["modeHeldUntil"]) > time)
        && p["verdict"] == "out"
    {
        add(
            &mut items,
            time,
            "planner_quota",
            s(&p["runner"]),
            &format!("{} is out of quota", display(&p["runner"])),
            s(&p["advice"]),
            vec![
                open(
                    "Open planner settings",
                    json!({"view":"settings","section":"planner"}),
                ),
                action("Keep normal", "mode.hold", json!({"mode":"normal"})),
            ],
            json!({"executor":p["runner"]}),
        );
    }
    for setup in a(&input["setup"]["items"]) {
        if truth(&setup["required"]) && setup["status"] != "done" {
            add(
                &mut items,
                time,
                "setup",
                s(&setup["id"]),
                s(&setup["title"]),
                "Setup required",
                vec![open(
                    "Open settings",
                    json!({"view":"settings","section":setup["id"]}),
                )],
                json!({}),
            );
        }
    }
    let update = &input["update"];
    if truth(&update["available"]) {
        let latest = s(&update["latest"]);
        add(
            &mut items,
            time,
            "update",
            latest,
            &format!("Update to {latest}"),
            "An update is available",
            vec![
                action("Update", "update.apply", json!({})),
                action(
                    "Later",
                    "attention.dismiss",
                    json!({"id":format!("update:{latest}")}),
                ),
            ],
            json!({}),
        );
    }
    discovery(&mut items, &input["discovery"], time);
    sort(&mut items);
    items
}
fn discovery(items: &mut Vec<Item>, d: &Value, time: f64) {
    for p in a(&d["prompted"]) {
        let id = s(&p["discoveryId"]);
        let mut pair = if truth(&d["canPair"]) {
            action(
                "Pair",
                "discovery.respond",
                json!({"discoveryId":id,"action":"pair"}),
            )
        } else {
            open("Pair", json!({"view":"settings","section":"pairing"}))
        };
        pair["style"] = "primary".into();
        add(
            items,
            time,
            "discovery",
            id,
            &format!("Found pacer on {}", s(&p["name"])),
            "Unverified name. Pair only if this is your machine.",
            vec![
                pair,
                action(
                    "Later",
                    "discovery.respond",
                    json!({"discoveryId":id,"action":"later"}),
                ),
            ],
            json!({"since":p["at"],"raisedAt":p["at"]}),
        );
    }
    let net = &d["network"];
    if truth(net) && net["advertise"].is_null() {
        let key = s(&net["key"]);
        let mut allow = action(
            "Allow",
            "discovery.network.set",
            json!({"network":key,"advertise":true,"expect_rev":d["networksRev"]}),
        );
        allow["style"] = "primary".into();
        add(
            items,
            time,
            "discovery-network",
            key,
            &format!(
                "Let your other machines find this one on {}?",
                s(&net["label"])
            ),
            &format!("It will appear as {}.", s(&net["name"])),
            vec![
                allow,
                action(
                    "Not on this network",
                    "discovery.network.set",
                    json!({"network":key,"advertise":false,"expect_rev":d["networksRev"]}),
                ),
            ],
            json!({}),
        );
    }
}
pub fn derive_tasks(input: &Value, time: f64) -> Vec<Item> {
    let tasks = a(&input["tasks"]);
    let active: HashSet<_> = tasks
        .iter()
        .filter(|t| !truth(&t["dismissed"]) && t["state"] != "stopped")
        .map(|t| s(&t["id"]))
        .collect();
    let inactive: HashSet<_> = tasks
        .iter()
        .filter(|t| truth(&t["dismissed"]) || t["state"] == "stopped")
        .map(|t| s(&t["id"]))
        .collect();
    let mut superseded: HashSet<&str> = tasks
        .iter()
        .filter(|t| truth(&t["retriedBy"]) && active.contains(s(&t["retriedBy"])))
        .map(|t| s(&t["id"]))
        .collect();
    for t in tasks {
        if active.contains(s(&t["id"])) && truth(&t["retryOf"]) {
            superseded.insert(s(&t["retryOf"]));
        }
    }
    let filtered: Vec<_> = tasks
        .iter()
        .filter(|t| !superseded.contains(s(&t["id"])))
        .map(|t| {
            let mut t = t.clone();
            if truth(&t["retriedBy"])
                && inactive.contains(s(&t["retriedBy"]))
                && let Some(m) = t.as_object_mut()
            {
                m.remove("retriedBy");
            }
            t
        })
        .collect();
    let titles: HashMap<_, _> = filtered
        .iter()
        .map(|t| (s(&t["id"]), t["title"].clone()))
        .collect();
    let mut input = input.clone();
    input["tasks"] = json!(filtered);
    let mut items = derive(&input, time);
    for item in &mut items {
        if let Some(title) = titles.get(s(item.get("taskId"))) {
            item.fields.insert("title".into(), title.clone());
        }
    }
    items
}
pub fn apply(store: &mut Value, items: Vec<Item>, time: f64) -> Vec<Item> {
    if !store.is_object() {
        *store = json!({});
    }
    if let Some(m) = store.as_object_mut() {
        m.retain(|id, _| items.iter().any(|i| s(i.get("id")) == id));
    }
    let mut out = vec![];
    for mut item in items {
        let id = s(item.get("id")).to_owned();
        if store.get(&id).is_none() {
            store[&id] = json!({"since":time});
        }
        let e = &store[&id];
        if e.get("dismissedSince") == e.get("since") || n(&e["snoozedUntil"]) > time {
            continue;
        }
        item.fields.insert("since".into(), e["since"].clone());
        if !truth(item.get("taskId")) {
            item.fields.insert("raisedAt".into(), e["since"].clone());
        }
        if let Some(until) = e.get("snoozedUntil") {
            item.fields.insert("snoozedUntil".into(), until.clone());
        }
        out.push(item);
    }
    sort(&mut out);
    out
}
pub fn dismiss(store: &mut Value, id: &str, items: &[Item], time: f64) -> Result<Value, Error> {
    raised(store, id, items, time, true)?;
    store[id]["dismissedSince"] = store[id]["since"].clone();
    Ok(json!({"dismissed":true}))
}
pub fn snooze(
    store: &mut Value,
    id: &str,
    duration: &str,
    items: &[Item],
    time: f64,
) -> Result<Value, Error> {
    raised(store, id, items, time, false)?;
    let seconds = match duration {
        "1h" => 3600.0,
        "4h" => 14400.0,
        "1d" => 86400.0,
        _ => f64::NAN,
    };
    let until = time + seconds;
    store[id]["snoozedUntil"] = json!(until);
    Ok(json!({"until":until}))
}
fn raised(
    store: &mut Value,
    id: &str,
    items: &[Item],
    time: f64,
    allow: bool,
) -> Result<(), Error> {
    if !items.iter().any(|i| s(i.get("id")) == id)
        && !(allow
            && store.get(id).is_some()
            && store[id].get("dismissedSince") == store[id].get("since"))
    {
        return Err(Error::new(
            "unknown_task",
            format!("unknown attention item \"{id}\""),
        ));
    }
    if store.get(id).is_none() {
        store[id] = json!({"since":time});
    }
    Ok(())
}
