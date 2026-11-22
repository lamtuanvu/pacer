use crate::{capacity, js::*, read, tasks};
use pacer_foundation::Ctx;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value, json};
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
fn unblocks_rank(v: &Value) -> i32 {
    match text(&v["unblocks"]) {
        "run" => 0,
        "branch" => 1,
        "nothing" => 2,
        // Ordinary items omit unblocks — same sentinel as TS (`nothing`).
        _ => 2,
    }
}
fn priority_rank(v: &Value) -> i32 {
    match text(&v["run"]["priority"]) {
        "urgent" => 0,
        "normal" => 1,
        "background" => 2,
        _ => 1,
    }
}
pub fn sort(items: &mut [Value]) {
    let rank = |v: &Value| match text(&v["severity"]) {
        "blocked" => 0,
        "problem" => 1,
        _ => 2,
    };
    // Total order: missing unblocks/run use the same sentinels as TS (nothing / normal).
    items.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(unblocks_rank(a).cmp(&unblocks_rank(b)))
            .then(priority_rank(a).cmp(&priority_rank(b)))
            .then(num(&a["since"]).total_cmp(&num(&b["since"])))
            .then(text(&a["id"]).cmp(text(&b["id"])))
    });
}
/// Stable A–Z letter from a run id (matches TS `runAttentionLetter` until Phase 6).
pub fn run_attention_letter(run_id: &str) -> String {
    let mut h: u32 = 0;
    for b in run_id.bytes() {
        h = h.wrapping_mul(31).wrapping_add(u32::from(b));
    }
    char::from(b'A' + (h % 26) as u8).to_string()
}
fn has_table(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        [name],
        |_| Ok(true),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}
/// Open person-answerer run questions for live runs. Missing tables → no items.
pub fn run_question_items(ctx: &Ctx) -> Vec<Value> {
    let path = ctx.pacer_home.join("state/tasks.db");
    let db = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(db) => db,
        Err(_) => return Vec::new(),
    };
    if !has_table(&db, "workflow_questions") || !has_table(&db, "workflow_runs") {
        return Vec::new();
    }
    let mut stmt = match db.prepare(
        "SELECT q.id, q.run_id, q.step_id, q.attempt, q.branch, q.asker_task_id, q.asker_kind,
                q.text, q.answer_type, q.options, q.recommended, q.blocks, q.artifact,
                q.suggested, q.rev, q.created_at, r.title, r.workflow, r.status
         FROM workflow_questions q
         JOIN workflow_runs r ON r.id = q.run_id
         WHERE q.status = 'open' AND q.answerer = 'person'
           AND r.status IN ('running', 'waiting')
         ORDER BY q.created_at, q.id",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
            row.get::<_, i64>(14)?,
            row.get::<_, f64>(15)?,
            row.get::<_, String>(16)?,
            row.get::<_, String>(17)?,
            row.get::<_, String>(18)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = Vec::new();
    for row in rows.flatten() {
        let (
            id,
            run_id,
            _step_id,
            _attempt,
            branch,
            asker_task_id,
            asker_kind,
            text_body,
            answer_type,
            options,
            recommended,
            blocks,
            artifact,
            suggested,
            rev,
            created_at,
            title,
            workflow,
            _status,
        ) = row;
        let unblocks = match blocks.as_str() {
            "branch" => "branch",
            "nothing" => "nothing",
            _ => "run",
        };
        let severity = if unblocks == "nothing" {
            "decide"
        } else {
            "blocked"
        };
        let notify = if unblocks == "nothing" {
            "all"
        } else {
            "important"
        };
        let run_title = if title.is_empty() { workflow } else { title };
        let at = if created_at > 0.0 {
            created_at
        } else {
            ctx.now
        };
        let mut question = Map::new();
        question.insert("id".into(), json!(id));
        question.insert("text".into(), json!(text_body));
        question.insert("answerType".into(), json!(answer_type));
        question.insert("blocks".into(), json!(blocks));
        question.insert("rev".into(), number(rev as f64));
        question.insert("askerKind".into(), json!(asker_kind));
        if let Some(raw) = options.filter(|s| !s.is_empty())
            && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
        {
            question.insert("options".into(), parsed);
        }
        if let Some(v) = recommended.filter(|s| !s.is_empty()) {
            question.insert("recommended".into(), json!(v));
        }
        if let Some(v) = artifact.filter(|s| !s.is_empty()) {
            question.insert("artifact".into(), json!(v));
        }
        if let Some(v) = suggested.filter(|s| !s.is_empty()) {
            question.insert("suggested".into(), json!(v));
        }
        if let Some(v) = asker_task_id.filter(|s| !s.is_empty()) {
            question.insert("askerTaskId".into(), json!(v));
        }
        if let Some(v) = branch.filter(|s| !s.is_empty()) {
            question.insert("branch".into(), json!(v));
        }
        // Key order matches TS `runQuestionItem` for byte-identical stringify.
        let mut obj = Map::new();
        obj.insert("id".into(), json!(format!("question:{id}")));
        obj.insert("kind".into(), json!("question"));
        obj.insert("severity".into(), json!(severity));
        obj.insert("repo".into(), Value::Null);
        obj.insert("title".into(), json!(run_title.clone()));
        obj.insert("detail".into(), json!(slice(&text_body, 200)));
        obj.insert("raisedAt".into(), number(at));
        obj.insert("since".into(), number(at));
        obj.insert("notify".into(), json!(notify));
        obj.insert(
            "actions".into(),
            json!([{
                "label":"Answer",
                "op":"question.answer",
                "params":{"id":id,"expect_rev":number(rev as f64)},
                "style":"primary"
            }]),
        );
        obj.insert("unblocks".into(), json!(unblocks));
        obj.insert(
            "run".into(),
            json!({
                "id":run_id,
                "letter":run_attention_letter(&run_id),
                "title":run_title,
                "priority":"normal"
            }),
        );
        obj.insert("question".into(), Value::Object(question));
        items.push(Value::Object(obj));
    }
    sort(&mut items);
    items
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
                &stalled_detail(&t["liveness"], ctx.now),
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
    items.extend(run_question_items(ctx));
    items
}

/// The stalled item's detail; a no-progress stall counts minutes from its last progress, as the TypeScript rules do.
fn stalled_detail(liveness: &Value, now: f64) -> String {
    let reason = liveness["reason"].as_str().unwrap_or("");
    if reason == "no_progress" {
        let since = liveness["since"].as_f64().unwrap_or(now);
        return format!(
            "No progress for {} min",
            (((now - since) / 60.0).floor() as i64).max(1)
        );
    }
    if reason == "caller_decision" {
        let who = liveness["waitingOn"]
            .as_str()
            .and_then(|p| p.strip_prefix("external:"))
            .and_then(|p| p.split(':').next())
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
            .unwrap_or("the caller");
        return format!("Waiting for {who} to review and decide");
    }
    format!("Conversation stalled: {reason}")
}

#[cfg(test)]
mod managed_action_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn managed_and_ordinary_attention_actions_preserve_protocol() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
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
        Ok(())
    }
}

#[cfg(test)]
mod stalled_detail_tests {
    use super::stalled_detail;
    use serde_json::json;

    #[test]
    fn caller_decision_names_the_planner_kind() {
        let now = 1_000_000.0;
        assert_eq!(
            stalled_detail(
                &json!({"reason":"caller_decision","since":now,"waitingOn":"external:claude-code:s1"}),
                now
            ),
            "Waiting for claude-code to review and decide"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"caller_decision","since":now}), now),
            "Waiting for the caller to review and decide"
        );
    }

    #[test]
    fn no_progress_counts_minutes_from_the_last_progress() {
        let now = 1_000_000.0;
        assert_eq!(
            stalled_detail(&json!({"reason":"no_progress","since":now - 4500.0}), now),
            "No progress for 75 min"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"no_progress","since":now}), now),
            "No progress for 1 min"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"cycle","since":now}), now),
            "Conversation stalled: cycle"
        );
    }
}
