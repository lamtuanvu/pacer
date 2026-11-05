use crate::{js::*, tasks};
use chrono::{TimeZone, Timelike};
use serde_json::{Value, json};
pub fn setup(
    checklist: &Value,
    st: &Value,
    reviewed: bool,
    skipped: bool,
    policy: &Value,
) -> Value {
    let p = array(&st["providers"])
        .iter()
        .find(|p| p["id"] == st["planner"])
        .unwrap_or(&Value::Null);
    let ranked = array(&st["executors"]["ranked"]);
    let excluded = array(&st["executors"]["excluded"]);
    let items: Vec<_> = array(&checklist["items"])
        .iter()
        .map(|i| {
            let mut i = i.clone();
            match text(&i["id"]) {
                "executor" => {
                    i["status"] = json!(if ranked.is_empty() { "pending" } else { "done" });
                    i["detail"] = json!(if !ranked.is_empty() {
                        ranked
                            .iter()
                            .map(|r| text(&r["id"]))
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else if !excluded.is_empty() {
                        excluded
                            .iter()
                            .map(|r| format!("{}: {}", text(&r["id"]), text(&r["reason"])))
                            .collect::<Vec<_>>()
                            .join("; ")
                    } else {
                        "no executor configured".into()
                    });
                    if ranked.is_empty() {
                        i["command"] = json!("pacer runner add");
                        i["action"] = json!("nav:add-executor");
                    } else {
                        remove(&mut i, "command");
                        remove(&mut i, "action");
                    }
                }
                "usage" => {
                    i["status"] = json!(if truth(&p["verdict"]) && p["verdict"] != "UNKNOWN" {
                        "done"
                    } else {
                        "pending"
                    })
                }
                "first" if reviewed || skipped => {
                    i["status"] = json!("done");
                    remove(&mut i, "action");
                    if skipped {
                        i["detail"] = json!("Skipped");
                    }
                }
                _ => {}
            }
            i
        })
        .collect();
    let open = items
        .iter()
        .filter(|i| truth(&i["required"]) && i["status"] != "done")
        .count();
    let complete = open == 0;
    let ready = complete
        && ["executor", "first"].iter().all(|id| {
            items
                .iter()
                .any(|i| i["id"] == *id && i["status"] == "done")
        });
    json!({
    "policy":policy,"complete":complete,"ready":ready,"open":open,"items":items}
    )
}
pub fn counts(
    tasks: &[Value],
    executors: &[Value],
    setup: &Value,
    hosts: &[Value],
    attention: &[Value],
) -> Value {
    let superseded = tasks::superseded(tasks);
    let review = |t: &&Value| {
        let mut t = (*t).clone();
        remove(&mut t, "retriedBy");
        !superseded.contains(&t["id"]) && tasks::attention_reason(&t) == Some("review_requested")
    };
    let mut by_repo = object();
    for t in tasks {
        let key = text(&t["repo"]["key"]);
        if by_repo.get(key).is_none() {
            by_repo[key] = json!({
            "review":0,"running":0,"attention":0}
            );
        }
        if review(&t) {
            by_repo[key]["review"] = number(num(&by_repo[key]["review"]) + 1.0);
        }
        if t["state"] == "running" || truth(&t["activeAgentSessions"]) {
            by_repo[key]["running"] = number(num(&by_repo[key]["running"]) + 1.0);
        }
    }
    for a in attention {
        if truth(&a["repo"]) {
            let key = text(&a["repo"]["key"]);
            if by_repo.get(key).is_none() {
                by_repo[key] = json!({
                "review":0,"running":0,"attention":0}
                );
            }
            by_repo[key]["attention"] = number(num(&by_repo[key]["attention"]) + 1.0);
        }
    }
    json!({
    "attention":attention.len(),"problems":attention.iter().filter(|a|a["severity"]!="decide").count(),"review":tasks.iter().filter(review).count(),"running":tasks.iter().filter(|t|t["state"]=="running"||truth(&t["activeAgentSessions"])).count(),"queued":tasks.iter().filter(|t|t["state"]=="queued").count(),"ready":executors.iter().filter(|e|e["rank"]!="planner"&&(e["eligibility"].is_null()||e["eligibility"]["state"]=="eligible")&&["ready","busy"].contains(&text(&e["state"]))).count(),"executors":executors.iter().filter(|e|e["rank"]!="planner").count(),"setupOpen":setup["open"],"hostsWithProblems":hosts.iter().filter(|h|["down","needs_setup"].contains(&text(&h["state"]))).count(),"byRepo":by_repo}
    )
}
pub fn today(now: f64, tasks: &[Value], zone: chrono_tz::Tz) -> Value {
    let since = zone
        .timestamp_opt(now.floor() as i64, 0)
        .single()
        .and_then(|d| d.with_hour(0)?.with_minute(0)?.with_second(0))
        .map_or(0.0, |d| d.timestamp() as f64);
    let rows: Vec<_> = tasks
        .iter()
        .filter(|t| {
            t["source"] != "onboarding"
                && !["running", "queued"].contains(&text(&t["state"]))
                && !truth(&t["activeAgentSessions"])
                && num(&t["updatedAt"]) >= since
        })
        .collect();
    let mut by_repo = object();
    for t in &rows {
        let key = text(&t["repo"]["key"]);
        by_repo[key] = number(num(&by_repo[key]) + 1.0);
    }
    json!({
    "since":number(since),"done":rows.len(),"accepted":rows.iter().filter(|t|t["review"]["accepted"]==true).count(),"rejected":rows.iter().filter(|t|t["review"]["accepted"]==false).count(),"failed":rows.iter().filter(|t|["failed","limit"].contains(&text(&t["state"]))).count(),"byRepo":by_repo}
    )
}
pub fn hosts(
    ctx: &pacer_foundation::Ctx,
    s: &Value,
    executors: &[Value],
    tasks: &[Value],
) -> Vec<Value> {
    use sha2::{Digest, Sha256};
    let jobs = crate::capacity::jobs(ctx);
    let checks = crate::read(ctx, "state/host-checks.json");
    let reachability = crate::read(ctx, "cache/hosts.json");
    let repos = crate::tasks::registered_repos(ctx)
        .into_iter()
        .chain(tasks.iter().map(|t| t["repo"].clone()))
        .collect::<Vec<_>>();
    values(&s["hosts"]).iter().map(|h|{
 let alias=&h["alias"];let ssh=text(&h["ssh"]).split_once('@').map_or(text(&h["ssh"]),|(_,s)|s);
 let target=format!("{:x}",Sha256::digest(stringify(&json!([h["alias"],h["ssh"]])).as_bytes()));let reading=&reachability[text(alias)];
 let state=if truth(&h["paused"]){"paused"}else if reading["target"]==target&&reading["at"].is_number()&&num(&reading["failures"])>=2.0{"down"}else if jobs.iter().any(|j|j["kind"]=="host.check"&&j["target"]==*alias&&j["state"]=="running"){"checking"}else if array(&checks[text(alias)]["checks"]).iter().any(|c|!truth(&c["ok"]))||repos.iter().any(|r|!text(&r["key"]).starts_with("local:")&&!truth(&h["repos"][text(&r["key"])])&&executors.iter().any(|e|e["host"]==*alias&&truth(&e["enabled"]))){"needs_setup"}else{"ready"};
 json!({"alias":alias,"ssh":ssh,"state":state,"running":tasks.iter().filter(|t|t["state"]=="running"&&t["host"]==*alias).count(),"maxTasks":h["maxTasks"],"executors":executors.iter().filter(|e|e["host"]==*alias).map(|e|e["id"].clone()).collect::<Vec<_>>(),"repos":h["repos"].as_object().map_or(0,|r|r.len())})
 }).collect()
}

pub fn legacy_setup(setup: &Value) -> Value {
    let find = |id: &str| {
        array(&setup["items"])
            .iter()
            .find(|i| i["id"] == id)
            .unwrap_or(&Value::Null)
    };
    let planner = find("planner");
    let connect = find("connect");
    let mut items = Vec::new();
    for (id, title, required) in [
        ("binary", "Binary", true),
        ("strategy", "Strategy", true),
        ("service", "Login service", true),
        ("link", "Link", true),
        ("live", "Live plugin", false),
        ("agent:claude-code", "Claude Code", false),
        ("agent:codex", "Codex", false),
        ("agent:cursor", "Cursor", false),
        ("agent:opencode", "OpenCode", false),
    ] {
        let status = if id == "strategy" {
            if planner["status"] == "failed" {
                "failed"
            } else if truth(&planner["detail"]) && planner["detail"] != "Choose a planner" {
                "done"
            } else {
                "pending"
            }
        } else {
            find(id)["status"]
                .as_str()
                .or_else(|| {
                    id.strip_prefix("agent:")
                        .filter(|agent| connect["agent"] == *agent)
                        .and_then(|_| connect["status"].as_str())
                })
                .unwrap_or("pending")
        };
        items.push(json!({
        "id":id,"title":title,"status":status,"required":required}
        ));
    }
    let open = items
        .iter()
        .filter(|i| i["required"] == true && i["status"] != "done")
        .count();
    json!({
    "complete":open==0,"open":open,"items":items}
    )
}
