use crate::{js::*, read};
use chrono::{Datelike, TimeZone, Timelike};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
pub fn planner(st: &Value, zone: chrono_tz::Tz) -> Value {
    let id = text(&st["planner"]);
    if id.is_empty() {
        return Value::Null;
    }
    let p = array(&st["providers"])
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or(&Value::Null);
    let b = &p["binding"];
    let known = truth(b) && p["verdict"] != "UNKNOWN";
    let verdict = if !known {
        "unknown"
    } else {
        match text(&p["verdict"]) {
            "BEHIND" | "EXPIRING" => "behind",
            "ON_PACE" | "OK" => "on_pace",
            "AHEAD" | "NEAR_LIMIT" => "ahead",
            "EXHAUSTED" => "out",
            _ => "unknown",
        }
    };
    let used = if known {
        b["usedPct"].clone()
    } else {
        Value::Null
    };
    let pace = if known {
        b["pace"].clone()
    } else {
        Value::Null
    };
    let delta = if !used.is_null() && !pace.is_null() {
        number((num(&used) - num(&pace) + 0.5).floor())
    } else {
        Value::Null
    };
    let mut advice = "No usage reading for the planner yet.".to_owned();
    match verdict {
        "behind" if !delta.is_null() => {
            advice = format!(
                "{} pts under pace — spend it.",
                stringify(&number(-num(&delta)))
            )
        }
        "on_pace" => advice = "On pace.".into(),
        "ahead" if !delta.is_null() => {
            advice = format!("{} pts ahead of pace — delegate more.", stringify(&delta))
        }
        "out" if !b["resetsAt"].is_null() => {
            if let Some(d) = zone
                .timestamp_opt(num(&b["resetsAt"]).floor() as i64, 0)
                .single()
            {
                advice = format!(
                    "Out of quota — back {} {:02}:{:02}.",
                    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                        [d.weekday().num_days_from_sunday() as usize],
                    d.hour(),
                    d.minute()
                );
            }
        }
        _ => {}
    }
    let mut row = object();
    if truth(&p["eligibility"]) {
        row["eligibility"] = p["eligibility"].clone();
    }
    let agent = p["agent"]
        .as_str()
        .unwrap_or(id.split(['#', '@']).next().unwrap_or(id));
    row = merge(
        &row,
        &json!({
        "runner":id,"agent":agent,"usedPct":used,"pacePct":pace,"deltaPts":delta,"verdict":verdict,"activeHoursLeft":if known{
        b["activeHoursLeft"].clone()}
        else{
        Value::Null}
        ,"resetsAt":if known{
        b["resetsAt"].clone()}
        else{
        Value::Null}
        ,"window":if known{
        b["name"].clone()}
        else{
        Value::Null}
        ,"stale":p.get("stale").cloned().unwrap_or(json!(false)),"advice":advice,"mode":st["mode"]}
        ),
    );
    if truth(&st["modeHold"]) {
        row["modeHeldUntil"] = st["modeHold"]["until"].clone();
    }
    row
}
pub fn budget(st: &Value) -> Value {
    let providers: Vec<_> = array(&st["providers"])
        .iter()
        .take(32)
        .map(|p| {
            let b = &p["binding"];
            let mut row = json!({
            "id":p["id"]}
            );
            if truth(&p["agent"]) {
                row["agent"] = p["agent"].clone();
                if let Some(v) = p.get("account") {
                    row["account"] = v.clone();
                }
                if truth(&p["unavailableReason"]) {
                    row["unavailableReason"] = p["unavailableReason"].clone();
                }
            }
            row = merge(
                &row,
                &json!({
                "verdict":p["verdict"],"usedPct":b["usedPct"],"pacePct":if b["pace"].is_null(){
                Value::Null}
                else{
                number((num(&b["pace"])*10.0+0.5).floor()/10.0)}
                ,"resetsAt":b["resetsAt"],"window":b["name"]}
                ),
            );
            if let Some(v) = p.get("stale") {
                row["stale"] = v.clone();
            }
            for key in ["brokenReason", "blockedReason"] {
                if truth(&p[key]) {
                    row[key] = p[key].clone();
                }
            }
            if truth(&p["blockedReason"])
                && let Some(v) = p.get("blockedUntil")
            {
                row["blockedUntil"] = v.clone();
            }
            row
        })
        .collect();
    json!({
    "generatedAt":st["generatedAt"],"strategy":st["strategy"],"planner":st["planner"],"mode":st["mode"],"providers":providers,"ranked":array(&st["executors"]["ranked"]).iter().take(32).map(|r|json!({
    "id":r["id"],"verdict":r["verdict"]}
    )).collect::<Vec<_>>()}
    )
}
fn runner<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["runners"]
        .get(id)
        .or_else(|| {
            s["runnerAliases"][id]
                .as_str()
                .and_then(|alias| s["runners"].get(alias))
        })
        .unwrap_or(&Value::Null)
}
pub fn display(id: &str) -> String {
    match id.split(['#', '@']).next().unwrap_or(id) {
        "codex" => "Codex".into(),
        "claude-code" => "Claude Code".into(),
        "cursor" => "Cursor".into(),
        "opencode" => "OpenCode".into(),
        _ => id.into(),
    }
}
pub(crate) fn redact(s: &str) -> String {
    let mut out = s.to_owned();
    for (pat, to) in [
        (
            r"(?i)authorization\s*[:=]\s*[^\r\n]*",
            "Authorization: [redacted]",
        ),
        (r"(?i)\bBearer\s+\S+", "Bearer [redacted]"),
        (
            r"(?i)\b(?:sk|pk|api[_-]?key|token)[_-][A-Za-z0-9_-]+",
            "[redacted]",
        ),
        (
            r"(?i)((?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+",
            "${1}[redacted]",
        ),
    ] {
        if let Ok(re) = regex::Regex::new(pat) {
            out = re.replace_all(&out, to).into_owned();
        }
    }
    let line = out.split_once('\n').map_or(out.as_str(), |(line, _)| {
        line.strip_suffix('\r').unwrap_or(line)
    });
    let out = slice(line, 500);
    regex::Regex::new(r"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}").map_or_else(
        |_| out.clone(),
        |r| r.replace_all(&out, "[redacted]").into_owned(),
    )
}
fn eligibility(decision: &Value, now: f64) -> (String, String, Option<String>) {
    let detail = array(&decision["reasons"])
        .iter()
        .map(|r| match text(&r["code"]) {
            "budget_exhausted" => "Budget exhausted; paid execution is not allowed",
            "budget_missing" => "No budget observation is available",
            "budget_expired_or_unknown" => "Budget evidence has expired or is incomplete",
            "evidence_conflicting" => "Current observations disagree",
            "evidence_missing" => "Execution evidence is missing",
            "availability_unknown" => "Executor availability is not confirmed",
            "subscription_missing" => "No active subscription",
            "subscription_failed" => "Subscription is unavailable",
            "subscription_response_invalid" => "Subscription status could not be read",
            "authentication_failed" | "signed_out" => "Sign-in is required",
            "refresh_failed" => "Could not refresh execution evidence",
            "disabled" => "Disabled",
            "not_installed" => "Not installed",
            "blocked" => "Blocked by you",
            "broken" => "Executor is not working",
            "unavailable" => "Executor is unavailable",
            "planner" => "Reserved for planning",
            "not_configured" => "Not configured",
            "quota_failure" => "The executor reported a quota limit",
            _ => "Execution evidence needs attention",
        })
        .collect::<Vec<_>>()
        .join("; ");
    let age = decision["evidenceAgeS"].as_f64().map(|age| {
        let age = (age + now - num(&decision["evaluatedAt"])).max(0.0);
        let (n, unit) = if age < 60.0 {
            (age, "s")
        } else if age < 3600.0 {
            (age / 60.0, "m")
        } else {
            (age / 3600.0, "h")
        };
        format!("observed {}{unit} ago", stringify(&number(n.floor())))
    });
    let (label, detail) = match text(&decision["state"]) {
        "ineligible" => ("Unavailable", detail),
        "uncertain" => ("Uncertain fallback", detail),
        _ => (
            "Eligible",
            if decision["budget"] == "exhausted" {
                "Paid execution allowed".into()
            } else {
                "Execution permitted".into()
            },
        ),
    };
    (label.into(), detail, age)
}
fn local_cap(s: &Value) -> Option<f64> {
    s["execution"]["local_max_tasks"]
        .as_f64()
        .or(s["execution"]["localMaxTasks"].as_f64())
}
pub(crate) fn jobs(ctx: &Ctx) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(ctx.pacer_home.join("state/jobs")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.strip_suffix(".json").is_some_and(|id| {
                !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            }) && let Some(job) = pacer_foundation::fsutil::read_json::<Value>(&entry.path())
                && (job["state"] == "running"
                    || ctx.now - job["endedAt"].as_f64().unwrap_or(num(&job["startedAt"]))
                        <= 86400.0)
            {
                out.push(job);
            }
        }
    }
    out
}
pub fn executors(ctx: &Ctx, st: &Value, s: &Value, tasks: &[Value]) -> Vec<Value> {
    let planner_id = text(&st["planner"]);
    let planner_id = runner(s, planner_id)["id"].as_str().unwrap_or(planner_id);
    let ids: Vec<String> = values(&s["runners"])
        .iter()
        .filter(|r| {
            !(r["agent"] == s["planner"]["agent"] && r["account"] == s["planner"]["account"])
        })
        .map(|r| text(&r["id"]).into())
        .collect();
    let mut order = vec![planner_id.to_owned()];
    for id in array(&s["pacing"]["order"]) {
        let id = text(id);
        let selected: Vec<_> = if id == "opencode" {
            ids.iter()
                .filter(|id| runner(s, id)["agent"] == "opencode")
                .cloned()
                .collect()
        } else {
            vec![runner(s, id)["id"].as_str().unwrap_or(id).to_owned()]
        };
        for id in selected {
            if ids.contains(&id) && !order.contains(&id) {
                order.push(id);
            }
        }
    }
    for id in ids {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    let jobs = jobs(ctx);
    let mut rows: Vec<_> = order
        .iter()
        .filter(|id| !id.is_empty())
        .enumerate()
        .map(|(index, id)| executor(ctx, st, s, tasks, &jobs, planner_id, id, index))
        .collect();
    if let Some(id) = array(&st["executors"]["ranked"])
        .iter()
        .map(|r| &r["id"])
        .find(|id| {
            rows.iter().any(|r| {
                r["id"] == **id
                    && r["eligibility"]["state"] != "ineligible"
                    && ["ready", "busy", "failing"].contains(&text(&r["state"]))
            })
        })
        && let Some(r) = rows.iter_mut().find(|r| r["id"] == *id)
    {
        r["next"] = json!(true);
    }
    rows
}
#[allow(clippy::too_many_arguments)]
fn executor(
    ctx: &Ctx,
    st: &Value,
    s: &Value,
    tasks: &[Value],
    jobs: &[Value],
    planner_id: &str,
    id: &str,
    index: usize,
) -> Value {
    let r = runner(s, id);
    let p = array(&st["providers"])
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or(&Value::Null);
    let account = r["account"]
        .as_str()
        .or(p["account"].as_str())
        .unwrap_or("");
    let host = &r["host"];
    let used = tasks
        .iter()
        .filter(|t| t["state"] == "running" && t["executor"] == id)
        .count();
    let host_max = s["hosts"][text(host)]["maxTasks"].as_f64();
    let max = r["maxTasks"].as_f64().or(host_max).unwrap_or(1.0);
    let shared = host_max.or_else(|| local_cap(s));
    let enabled = r["enabled"] != false;
    let mut check = read(ctx, "state/runner-checks.json")[id].clone();
    let failures = tasks
        .iter()
        .filter(|t| {
            t["executor"] == id
                && t["state"] == "failed"
                && num(&t["updatedAt"]) >= ctx.now - 86400.0
        })
        .count();
    let assessment = eligibility(&p["eligibility"], ctx.now);
    let block = if used as f64 >= max {
        Some(format!(
            "{} busy ({used}/{})",
            slot_display(id),
            stringify(&number(max))
        ))
    } else if let Some(cap) = shared {
        let n = tasks
            .iter()
            .filter(|t| {
                t["state"] == "running"
                    && if host.is_null() {
                        t["host"].is_null() && runner(s, text(&t["executor"]))["host"].is_null()
                    } else {
                        t["host"] == *host || runner(s, text(&t["executor"]))["host"] == *host
                    }
            })
            .count();
        (n as f64 >= cap).then(|| {
            format!(
                "{} busy ({n}/{})",
                host.as_str().unwrap_or("this machine"),
                stringify(&number(cap))
            )
        })
    } else {
        None
    };
    let (state, mut reason) = if !enabled {
        ("disabled", Some("disabled".into()))
    } else if jobs
        .iter()
        .any(|j| j["kind"] == "runner.check" && j["target"] == id && j["state"] == "running")
    {
        ("checking", None)
    } else if truth(&p["blockedReason"]) {
        ("blocked", Some(text(&p["blockedReason"]).into()))
    } else if truth(&p["brokenReason"]) || truth(&p["unavailableReason"]) || p["installed"] == false
    {
        (
            "down",
            Some(
                p["brokenReason"]
                    .as_str()
                    .or(p["unavailableReason"].as_str())
                    .unwrap_or("not installed")
                    .into(),
            ),
        )
    } else if truth(&p["signedOutReason"]) {
        ("down", Some(text(&p["signedOutReason"]).into()))
    } else if p["eligibility"]["state"] == "ineligible" {
        (
            if p["eligibility"]["budget"] == "exhausted" {
                "exhausted"
            } else {
                "down"
            },
            Some(assessment.1.clone()),
        )
    } else if !truth(&p["eligibility"]) && p["verdict"] == "EXHAUSTED" {
        ("exhausted", None)
    } else if check["passed"] == false {
        ("failing", Some(text(&check["detail"]).into()))
    } else if failures >= 2 {
        ("failing", Some(format!("{failures} recent failures")))
    } else if block.is_some() {
        ("full", block)
    } else if used > 0 {
        ("busy", None)
    } else {
        ("ready", None)
    };
    let untested = state == "ready" && p["endpointNotTested"] == true;
    if untested {
        reason = Some("not tested — run a check".into());
    }
    let reason = reason.map(|r| redact(&r));
    let mut places: Vec<_> = values(&s["runners"])
        .iter()
        .filter(|r| r["account"] == account)
        .map(|r| r["host"].as_str().unwrap_or("this Mac").to_owned())
        .collect();
    places.sort();
    places.dedup();
    places.sort_by_key(|p| p != "this Mac");
    let places = if places.is_empty() {
        "this Mac".into()
    } else {
        places.join(" + ")
    };
    let verdict = match text(&p["verdict"]) {
        "BEHIND" | "EXPIRING" => "Behind pace",
        "AHEAD" => "Ahead of pace",
        "EXHAUSTED" => "Out of quota",
        "ON_PACE" => "On pace",
        "OK" => "Available",
        "NEAR_LIMIT" => "Near limit",
        _ => "Unknown",
    };
    let sub = if truth(&p["eligibility"]) {
        format!(
            "{} · {}{} · {places}",
            assessment.0,
            assessment.1,
            assessment.2.map_or(String::new(), |a| format!(" · {a}"))
        )
    } else {
        format!("{verdict} · {places}")
    };
    let tone = if p["eligibility"]["state"] == "uncertain" {
        "warn"
    } else {
        match state {
            "ready" => "good",
            "busy" | "full" | "checking" => "info",
            "failing" => "warn",
            "down" | "exhausted" => "bad",
            _ => "muted",
        }
    };
    let mut row = object();
    if truth(&p["eligibility"]) {
        row["eligibility"] = p["eligibility"].clone();
        if let Some(v) = p.get("stale") {
            row["stale"] = v.clone();
        }
    }
    row = merge(
        &row,
        &json!({"id":id,"agent":r["agent"].as_str().or(p["agent"].as_str()).unwrap_or(id.split(['#','@']).next().unwrap_or(id)),"account":account,"host":host,"model":r["model"],"rank":if id==planner_id{json!("planner")}else{json!(index)},"enabled":enabled,"state":state,"tone":tone,"sub":reason.clone().unwrap_or(sub)}),
    );
    if let Some(reason) = reason {
        row["reason"] = json!(reason);
    }
    row["usedPct"] = p["binding"]["usedPct"].clone();
    row["pacePct"] = p["binding"]["pace"].clone();
    if p["usage"] == "unmetered" {
        row["paceReason"] = json!("unmetered");
    } else if !truth(&p["binding"]) {
        row["paceReason"] = json!("no limit reported");
    }
    row["slots"] = json!({"used":used,"max":number(max)});
    if shared.is_some_and(|s| max > s) {
        row["limitedBy"] = json!(if host.is_null() { "machine" } else { "host" });
    }
    if untested {
        row["untested"] = json!(true);
    }
    if check.is_object() {
        check["detail"] = json!(redact(text(&check["detail"])));
    }
    row["lastCheck"] = check;
    row["recentFailures"] = json!(failures);
    row["next"] = json!(false);
    row
}
fn slot_display(id: &str) -> String {
    let without_host = id.split('@').next().unwrap_or(id);
    let (agent, account) = without_host.split_once('#').unwrap_or((without_host, ""));
    let name = match agent {
        "claude-code" => "Claude",
        "agy" => "Antigravity",
        "byteplus" => "BytePlus",
        "local" => "Local",
        _ => "",
    };
    let provider = |s: &str| {
        let mut chars = s.chars();
        chars.next().map_or(String::new(), |c| {
            format!("{}{}", c.to_uppercase(), chars.as_str())
        })
    };
    if agent == "opencode" && !account.is_empty() {
        provider(account)
    } else if !account.is_empty() {
        format!(
            "{} ({account})",
            if agent == "claude-code" {
                "Claude Code".into()
            } else {
                provider(agent)
            }
        )
    } else if name.is_empty() {
        provider(agent)
    } else {
        name.into()
    }
}

pub fn accounts(st: &Value, s: &Value) -> Vec<Value> {
    values(&s["accounts"]).iter().map(|a|{
let name=&a["name"];
let runners:Vec<_>=values(&s["runners"]).into_iter().filter(|r|r["account"]==*name).collect();
let p=array(&st["providers"]).iter().find(|p|p["account"]==*name||runners.iter().any(|r|r["id"]==p["id"])).unwrap_or(&Value::Null);
let status=array(&st["accounts"]).iter().find(|a|a["name"]==*name).unwrap_or(&Value::Null);
let pick=|k:&str,f:&Value|status.get(k).filter(|v|!v.is_null()).unwrap_or(f).clone();
let mut row=object();
if truth(&status["eligibility"]){
row["eligibility"]=status["eligibility"].clone();
}
 let checked:Vec<_>=runners.iter().filter(|r|r["host"].is_null()&&!(r["agent"]==s["planner"]["agent"]&&r["account"]==s["planner"]["account"])).filter_map(|r|array(&st["providers"]).iter().find(|p|p["id"]==r["id"]||p["id"]==r["name"])).collect();
let signed=if a["kind"]=="endpoint"{
Value::Null}
else if checked.iter().any(|p|truth(&p["signedOutReason"])){
json!(false)}
else if !checked.is_empty(){
json!(true)}
else{
Value::Null}
;
 row=merge(&row,&json!({
"stale":status.get("stale").or(p.get("stale")).cloned().unwrap_or(json!(true)),"capturedAt":status["capturedAt"],"name":name,"agent":runners.first().map_or(&a["kind"],|r|&r["agent"]),"source":a["source"],"usedPct":pick("usedPct",&p["binding"]["usedPct"]),"pacePct":pick("pacePct",&p["binding"]["pace"]),"window":pick("window",&p["binding"]["name"]),"resetsAt":pick("resetsAt",&p["binding"]["resetsAt"]),"verdict":pick("verdict",p.get("verdict").unwrap_or(&json!("UNKNOWN"))),"signedIn":signed,"executors":runners.iter().map(|r|r["id"].clone()).collect::<Vec<_>>(),"spendUsdWeek":status["spendUsd"],"capUsdWeek":a["weeklyUsd"]}
));
row}
).collect()
}
/// Stored authentication observations are scoped to account configuration, never
/// inferred by opening an agent's native credentials.
pub fn accounts_in_home(ctx: &Ctx, st: &Value, s: &Value) -> Vec<Value> {
    use sha2::{Digest, Sha256};
    let mut rows = accounts(st, s);
    let marks = read(ctx, "state/auth-failed.json");
    let evidence = read(ctx, "state/auth-evidence.json");
    for row in &mut rows {
        if !row["signedIn"].is_null() {
            continue;
        }
        let name = text(&row["name"]);
        let account = &s["accounts"][name];
        if account["kind"] == "endpoint" {
            continue;
        }
        let mut hosts: Vec<_> = s["hosts"]
            .as_object()
            .into_iter()
            .flat_map(|h| h.iter())
            .collect();
        hosts.sort_by(|a, b| a.0.cmp(b.0));
        let hosts: Vec<_> = hosts
            .iter()
            .map(|(alias, h)| json!([alias, h["ssh"], h["accounts"][name]["home"]]))
            .collect();
        let mut signature = vec![
            account["name"].clone(),
            account["kind"].clone(),
            account["source"].clone(),
            account["home"].clone(),
            account["orcaAccount"].clone(),
            account["usageSource"].clone(),
            account["quotaSource"].clone(),
            account["connection"]["base_url"].clone(),
            account["connection"]["key"].clone(),
            json!(hosts),
        ];
        if truth(&account["provider"]) {
            signature.push(account["provider"].clone());
        }
        let identity = format!(
            "{:x}",
            Sha256::digest(stringify(&json!(signature)).as_bytes())
        );
        let observation = &evidence[name];
        let at = observation["at"].as_f64();
        let scope = &observation["scope"];
        let saved = read(ctx, &format!("state/evidence/{identity}.json"));
        let retired = if saved["version"] == 1 && saved["identity"] == identity {
            saved["retiredAt"].as_f64().unwrap_or(-1.0)
        } else {
            -1.0
        };
        if scope["identity"] == identity
            && observation["at"] == marks[name]
            && at.is_some_and(|at| at <= ctx.now && at > retired && at + 7200.0 > ctx.now)
            && ["runner", "model", "host"]
                .iter()
                .all(|key| !truth(&scope[key]))
        {
            row["signedIn"] = json!(false);
        }
    }
    rows
}
