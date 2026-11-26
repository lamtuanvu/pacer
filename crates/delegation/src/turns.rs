//! Port of `src/messaging/turns.ts`: a message to a settled task starts a new
//! headless turn. The front doors inject runner spawn through [`Runtime`]; all
//! validation, policy admission and store writes are native.
#![allow(clippy::result_large_err)]
use crate::runtime::Runtime;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_messaging_ops::publish::task_message_events;
use pacer_store::{TaskStore, messages};
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use std::path::Path;

#[cfg(test)]
mod tests;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `isClosed` (`src/messaging/closed.ts`).
pub fn is_closed(t: &Value) -> bool {
    truthy(t.get("review")) || truthy(t.get("dismissed")) || truthy(t.get("msgClosed"))
        || text(t, "state") == "stopped"
}

fn session_agent(t: &Value) -> Option<&str> {
    t.pointer("/run/executor")
        .filter(|v| !v.is_null())
        .or_else(|| t.pointer("/result/executor"))
        .filter(|v| truthy(Some(v)))
        .and_then(Value::as_str)
}

/// A local agent that resumes or replays a headless session (`headlessTurnPath`).
fn headless_turn(ctx: &Ctx, executor: &str) -> bool {
    let via_opencode = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .ok()
        .and_then(|s| {
            let runner = s["runners"].get(executor)?;
            let account = runner["account"].as_str()?;
            s["accounts"].get(account)?;
            Some(runner["agent"] == "opencode" || runner["via"] == "opencode")
        })
        .unwrap_or(false);
    if via_opencode {
        return true;
    }
    let (left, host) = executor.split_once('@').unwrap_or((executor, ""));
    if !host.is_empty() && host != "local" {
        return false;
    }
    let agent = left.split_once('#').map_or(left, |(agent, _)| agent);
    matches!(agent, "codex" | "claude-code" | "cursor" | "agy")
}

fn turn_capable(ctx: &Ctx, t: &Value) -> bool {
    let Some(executor) = session_agent(t) else {
        return false;
    };
    let backend = t.pointer("/result/backend");
    !truthy(t.pointer("/run/host"))
        && !(truthy(backend) && backend.and_then(Value::as_str) != Some("direct"))
        && headless_turn(ctx, executor)
}

/// `turnWorktree`: the worktree a turn resumes in.
fn turn_worktree(t: &Value) -> Option<&str> {
    t.get("worktree")
        .filter(|v| !v.is_null())
        .or_else(|| t.pointer("/result/worktree"))
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty())
}

/// Unique per turn: the attempt it will run as, then the task's turn count.
fn turn_key(store: &mut TaskStore, t: &Value, replay: bool) -> String {
    let attempts = t["attempts"].as_array().map_or(0, Vec::len) + 1;
    let id = text(t, "id");
    format!("{id}#{attempts}.{}{}", turns_for_task(store, id).unwrap_or(0) + 1, if replay { "r" } else { "" })
}

fn count(store: &mut TaskStore, sql: &str, param: &str) -> Result<i64, CoreError> {
    let db = store.connection().map_err(store_error)?;
    db.query_row(sql, [param], |row| row.get::<_, i64>(0)).map_err(sql_error)
}

fn turns_for_task(store: &mut TaskStore, id: &str) -> Result<i64, CoreError> {
    count(store, "SELECT COUNT(*) FROM msg_turns WHERE task_id=?", id)
}

fn turns_for_root(store: &mut TaskStore, root: &str) -> Result<i64, CoreError> {
    count(store, "SELECT COUNT(*) FROM msg_turns WHERE root_id=?", root)
}

fn record_turn(store: &mut TaskStore, id: &str, task_id: &str, root: &str, at: f64) -> Result<(), CoreError> {
    let db = store.connection().map_err(store_error)?;
    db.execute(
        "INSERT INTO msg_turns(id,task_id,root_id,started_at) VALUES(?,?,?,?)",
        rusqlite::params![id, task_id, root, at],
    )
    .map_err(sql_error)?;
    Ok(())
}

/// One pending message per recipient row, reduced to the fields a turn needs.
fn pending_senders(store: &mut TaskStore, to: &str) -> Result<Vec<String>, CoreError> {
    let db = store.connection().map_err(store_error)?;
    let mut statement = db
        .prepare("SELECT sender FROM messages WHERE recipient=? AND status='pending' ORDER BY id")
        .map_err(sql_error)?;
    let rows = statement
        .query_map([to], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)
}

fn pending_last_id(store: &mut TaskStore, to: &str) -> Result<Option<String>, CoreError> {
    let db = store.connection().map_err(store_error)?;
    db.query_row(
        "SELECT id FROM messages WHERE recipient=? AND status='pending' ORDER BY id DESC LIMIT 1",
        [to],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(sql_error)
}

/// `getWork`: a managed task's options, or `None` for a legacy task.
fn work_options(store: &mut TaskStore, id: &str) -> Result<Option<Value>, CoreError> {
    let db = store.connection().map_err(store_error)?;
    // No work table (a minimal store) means an ordinary, unmanaged task.
    let options: Option<String> = db
        .query_row(
            "SELECT options FROM work_nodes WHERE task_id=?",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .unwrap_or(None);
    Ok(options.and_then(|text| serde_json::from_str(&text).ok()))
}

fn max_turns(ctx: &Ctx, t: &Value) -> i64 {
    let from_strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .ok()
        .and_then(|s| s["messaging"]["tree"]["max_turns"].as_i64())
        .unwrap_or(50);
    t["messaging"]["max_turns"]
        .as_i64()
        .unwrap_or(from_strategy)
}

/// Why no turn can start for this task now, or `None` when one can.
pub fn turn_blocked(
    ctx: &Ctx,
    store: &mut TaskStore,
    t: Option<&Value>,
) -> Result<Option<&'static str>, CoreError> {
    let Some(t) = t else {
        return Ok(Some("closed"));
    };
    let id = text(t, "id");
    if is_closed(t) {
        return Ok(Some("closed"));
    }
    let state = text(t, "state");
    if state == "running" && t.pointer("/run/interactive").is_some() {
        return Ok(Some("live"));
    }
    if text(t, "interactionMode") == "conversation" {
        return Ok(Some(if state == "running" && t.get("run").is_some() {
            "live"
        } else {
            "live_unavailable"
        }));
    }
    let work = work_options(store, id)?;
    if work.is_some() && matches!(state, "queued" | "running") {
        return Ok(Some("pull"));
    }
    if matches!(state, "queued" | "running") {
        return Ok(Some("queued"));
    }
    if pending_senders(store, &format!("task:{id}"))?.is_empty() {
        return Ok(Some("queued"));
    }
    if session_agent(t).is_none() || !turn_capable(ctx, t) {
        return Ok(Some("no_session"));
    }
    if let Some(options) = work
        && t["attempts"].as_array().map_or(0, Vec::len) as i64
            >= options["maxAttempts"].as_i64().unwrap_or(3)
    {
        return Ok(Some("cap"));
    }
    let root = messages::root_of(store, &format!("task:{id}")).map_err(store_error)?;
    if turns_for_root(store, &root)? >= max_turns(ctx, t) {
        return Ok(Some("cap"));
    }
    Ok(None)
}

/// Why project policy holds a turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnHold {
    pub reason: String,
}

#[derive(Debug, PartialEq, Eq)]
enum TurnAdmission {
    Admitted(String),
    Hold(TurnHold),
}

/// The repository's project executor selection, as the runner resolves it. `None`
/// means an unrestricted repository; `Some([])` means a project with no executors.
fn selection(ctx: &Ctx, repo_key: &str) -> Option<Vec<String>> {
    let path = Path::new(&ctx.pacer_home).join("project-strategies.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    let executors = value["projects"][repo_key]["executors"].as_array()?;
    Some(executors.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}

/// The task's verified repository key, or `None` when project routing cannot be established.
fn repo_key(t: &Value) -> Option<String> {
    let repo = t.get("repo")?;
    if truthy(repo.get("identityUnverified")) {
        return None;
    }
    repo.get("key").and_then(Value::as_str).map(str::to_owned)
}

/// The prior executor first, then the strategy's local headless executors admits project policy allows.
fn turn_candidates(ctx: &Ctx, _t: &Value, prior: &str, project: Option<&[String]>) -> Vec<String> {
    let allowed = |id: &str| project.is_none_or(|ids| ids.iter().any(|candidate| candidate == id));
    let mut out = Vec::new();
    if allowed(prior) {
        out.push(prior.to_owned());
    }
    if let Ok(strategy) = pacer_config::strategy::load_strategy(&ctx.pacer_home) {
        let planner_agent = strategy["planner"]["agent"].as_str().unwrap_or_default();
        let planner_account = strategy["planner"]["account"].as_str().unwrap_or_default();
        if let Some(runners) = strategy["runners"].as_object() {
            for (id, runner) in runners {
                if id == prior
                    || runner["enabled"] == json!(false)
                    || (runner["agent"].as_str() == Some(planner_agent)
                        && runner["account"].as_str() == Some(planner_account))
                    || !headless_turn(ctx, id)
                {
                    continue;
                }
                if allowed(id) && !out.contains(id) {
                    out.push(id.clone());
                }
            }
        }
    }
    out
}

/// A continuation turn passes the same project policy as a new attempt. Plugin
/// policy (B0b) is not in this slice; the repository's executor selection is.
fn admit_turn(ctx: &Ctx, _store: &mut TaskStore, t: &Value) -> Result<TurnAdmission, CoreError> {
    let Some(prior) = session_agent(t) else {
        return Ok(TurnAdmission::Hold(TurnHold {
            reason: "No executor can run this task's next turn".into(),
        }));
    };
    let key = repo_key(t);
    let project = key.as_deref().and_then(|k| selection(ctx, k));
    let candidates = turn_candidates(ctx, t, prior, project.as_deref());
    if candidates.is_empty() {
        let where_ = key.as_deref().unwrap_or("this repository");
        return Ok(TurnAdmission::Hold(TurnHold {
            reason: format!("No executor that project policy allows for {where_} can run this task's next turn"),
        }));
    }
    Ok(TurnAdmission::Admitted(candidates[0].clone()))
}

/// `notifyMessage`: publish the message entity, or the human's tasks on a human message.
pub fn notify_message(ctx: &Ctx, _rt: &Runtime, message_id: &str) -> Result<(), CoreError> {
    let mut store = open(ctx)?;
    notify_message_inner(ctx, message_id, &mut store)
}

fn notify_message_inner(
    ctx: &Ctx,
    message_id: &str,
    store: &mut TaskStore,
) -> Result<(), CoreError> {
    let Some(message) = messages::get(store, message_id).map_err(store_error)? else {
        return Ok(());
    };
    let human = text(&message, "to") == "human" || text(&message, "from") == "human";
    let task_id = text(&message, "taskId").to_owned();
    let event = json!({"type": "entity", "data": {"kind": "message", "id": message_id, "value": message}});
    if human {
        // `publishTaskMessages(ctx, [taskId], [event])`: the message entity is
        // published first, then the human's task and attention items.
        let mut events = vec![event];
        if !task_id.is_empty() {
            events.extend(task_message_events(ctx, store, &task_id));
        }
        pacer_store::publish(ctx, &events);
    } else {
        pacer_store::publish(ctx, &[event]);
    }
    Ok(())
}

/// Begin a resume turn when the task is settled and has pending messages.
fn start_turn_if_idle(
    ctx: &Ctx,
    rt: &Runtime,
    store: &mut TaskStore,
    id: &str,
    executor: &str,
    replay: bool,
) -> Result<&'static str, CoreError> {
    let Some(t) = store.read(id).map_err(store_error)? else {
        return Ok("closed");
    };
    if let Some(blocked) = turn_blocked(ctx, store, Some(&t))? {
        return Ok(blocked);
    }
    let key = turn_key(store, &t, replay);
    let session = if !replay && t.pointer("/run/executor").and_then(Value::as_str) == Some(executor) {
        t.pointer("/run/agentSession").cloned().filter(|v| !v.is_null())
    } else {
        None
    };
    let mut pending = Map::new();
    pending.insert("id".into(), json!(key));
    pending.insert("executor".into(), json!(executor));
    pending.insert("at".into(), json!(ctx.now));
    if let Some(session) = session {
        pending.insert("session".into(), session);
    }
    if replay {
        pending.insert("replay".into(), json!(true));
    }
    if work_options(store, id)?.is_some() {
        restart_work_for_turn(ctx, rt, store, id, Value::Object(pending), &t)?;
        return Ok("turn_started");
    }
    let root = messages::root_of(store, &format!("task:{id}")).map_err(store_error)?;
    store
        .update_current(id, ctx.now, |task| {
            task["pendingTurn"] = Value::Object(pending);
            task["requestedExecutor"] = json!(executor);
            task["state"] = json!("queued");
            let fallback = turn_worktree(&*task).map(str::to_owned);
            if task.get("worktree").is_none_or(Value::is_null)
                && let Some(worktree) = fallback
            {
                task["worktree"] = json!(worktree);
            }
            for key in ["result", "settledAt", "queue", "reviewRequest", "progress", "runnerPid"] {
                if let Some(object) = task.as_object_mut() {
                    object.remove(key);
                }
            }
            if task["question"].get("answer").is_none() {
                if let Some(object) = task.as_object_mut() {
                    object.remove("question");
                }
            }
            Ok(())
        })
        .map_err(store_error)?;
    record_turn(store, &key, id, &root, ctx.now)?;
    launch(ctx, rt, id);
    Ok("turn_started")
}

/// `restartWorkForTurn` (`src/core/work.ts:273-295`) for a managed task.
fn restart_work_for_turn(
    ctx: &Ctx,
    rt: &Runtime,
    store: &mut TaskStore,
    id: &str,
    turn: Value,
    current: &Value,
) -> Result<(), CoreError> {
    let expected_rev = current["rev"].as_i64().unwrap_or(0);
    let options = work_options(store, id)?.unwrap_or_default();
    let attempts = current["attempts"].as_array().map_or(0, Vec::len) as i64;
    if attempts >= options["maxAttempts"].as_i64().unwrap_or(3) {
        return Err(CoreError::new(Code::NotAllowed, "Managed work attempt limit reached"));
    }
    if !matches!(text(current, "state"), "done" | "failed" | "partial" | "limit" | "needs_input") {
        return Err(CoreError::new(Code::Conflict, "Work is not eligible for a message turn"));
    }
    store
        .update_current(id, ctx.now, |task| {
            if task["rev"].as_i64().unwrap_or(0) != expected_rev {
                return Err(pacer_store::StoreError::Conflict);
            }
            task["requestedExecutor"] = json!(text(&turn, "executor"));
            task["pendingTurn"] = turn;
            task["state"] = json!("queued");
            task["queue"] = json!({"reason":"waiting_retry","detail":"Message turn requested","since":ctx.now,"position":1,"nextAt":ctx.now});
            for key in ["settledAt", "result", "review", "resolved", "resolutionCheckedAt", "reviewRequest",
                "run", "runnerPid", "childPid", "pendingAttempt", "attemptStartedAt", "progress", "executor", "backend"] {
                if let Some(object) = task.as_object_mut() {
                    object.remove(key);
                }
            }
            Ok(())
        })
        .map_err(store_error)?;
    let db = store.connection().map_err(store_error)?;
    let _ = db.execute("UPDATE work_grants SET revoked=1 WHERE task_id=?", [id]);
    let _ = db.execute("DELETE FROM work_reservations WHERE task_id=?", [id]);
    launch(ctx, rt, id);
    Ok(())
}

/// Launch after the turn is committed; a failed spawn leaves the committed state standing.
fn launch(ctx: &Ctx, rt: &Runtime, id: &str) {
    if let Err(error) = rt.spawn.launch(ctx, id, None) {
        eprintln!("pacer: message turn launch failed: {}", error.message);
    }
}

/// `report`: write a report message to the sender and deliver it to its recipient.
fn report(
    ctx: &Ctx,
    rt: &Runtime,
    store: &mut TaskStore,
    id: &str,
    parent: &str,
    head: &str,
    body: &str,
    request_id: &str,
) -> Result<(), CoreError> {
    let root = messages::root_of(store, &format!("task:{id}")).map_err(store_error)?;
    let body = format!("{head} {}", body.chars().rev().take(64 * 1024).collect::<String>().chars().rev().collect::<String>()).trim().to_owned();
    let new = messages::NewMessage {
        task_id: Some(id),
        root_id: &root,
        from: &format!("task:{id}"),
        to: parent,
        kind: "report",
        body: &body,
        reply_to: None,
        request_id: Some(request_id),
        held: false,
    };
    let (message, duplicate) = messages::insert(store, &new, ctx.now).map_err(store_error)?;
    if !duplicate {
        let message_id = text(&message, "id").to_owned();
        notify_message_inner(ctx, &message_id, store)?;
        deliver_inner(ctx, rt, parent, store)?;
    }
    Ok(())
}

/// Tell each sender of a held turn's messages why they wait, once per pending set.
fn report_hold(
    ctx: &Ctx,
    rt: &Runtime,
    store: &mut TaskStore,
    id: &str,
    hold: &TurnHold,
    quiet: bool,
) -> Result<(), CoreError> {
    if quiet {
        return Ok(());
    }
    let Some(last) = pending_last_id(store, &format!("task:{id}"))? else {
        return Ok(());
    };
    let senders = pending_senders(store, &format!("task:{id}"))?;
    let mut unique: Vec<String> = Vec::new();
    for sender in senders {
        if sender != format!("task:{id}") && !unique.contains(&sender) {
            unique.push(sender);
        }
    }
    let unseen = unique.iter().any(|from| {
        messages::by_request(store, &format!("task:{id}"), &format!("held:{last}:{from}"))
            .map(|found| found.is_none())
            .unwrap_or(true)
    });
    if unseen {
        let _ = pacer_store::activity::append_activity(ctx, json!({
            "kind": "message", "level": "warn",
            "text": format!("Messages to task {id} are held: {}", hold.reason),
            "taskId": id,
        }));
    }
    let body = format!(
        "Messages to task {id} are held by project policy and stay pending: {}. They are delivered with the next message once policy admits a turn.",
        hold.reason
    );
    for from in unique {
        report(ctx, rt, store, id, &from, "[held]", &body, &format!("held:{last}:{from}"))?;
    }
    Ok(())
}

/// Options for a turn started through the public interface.
#[derive(Default)]
pub struct PendingTurn {
    pub replay: bool,
    pub quiet: bool,
}

/// Start the next message turn after fresh policy admission, retrying when the context changed.
pub fn begin_turn(
    ctx: &Ctx,
    rt: &Runtime,
    task_id: &str,
    turn: PendingTurn,
) -> Result<Value, CoreError> {
    let mut store = open(ctx)?;
    begin_turn_inner(ctx, rt, task_id, turn, &mut store)
}

fn begin_turn_inner(
    ctx: &Ctx,
    rt: &Runtime,
    task_id: &str,
    turn: PendingTurn,
    store: &mut TaskStore,
) -> Result<Value, CoreError> {
    for attempt in 0..3 {
        let t = store.read(task_id).map_err(store_error)?;
        let blocked = turn_blocked(ctx, store, t.as_ref())?;
        if (blocked.is_some() && blocked != Some("live")) || t.is_none() {
            return Ok(json!({"delivery": blocked.unwrap_or("closed")}));
        }
        let t = t.ok_or_else(|| CoreError::new(Code::NotFound, format!("Unknown task {task_id}")))?;
        if blocked == Some("live") && session_agent(&t).is_none() {
            return Ok(json!({"delivery": "live_unavailable"}));
        }
        let admitted = admit_turn(ctx, store, &t)?;
        let (executor, replay) = match admitted {
            TurnAdmission::Hold(hold) => {
                report_hold(ctx, rt, store, task_id, &hold, turn.quiet)?;
                return Ok(json!({"delivery": "held", "hold": {"reason": hold.reason}}));
            }
            TurnAdmission::Admitted(executor) => (executor, turn.replay),
        };
        if blocked == Some("live") {
            return Ok(json!({"delivery": "live"}));
        }
        match start_turn_if_idle(ctx, rt, store, task_id, &executor, replay) {
            Ok(delivery) => {
                let mut out = Map::new();
                out.insert("delivery".into(), json!(delivery));
                return Ok(Value::Object(out));
            }
            Err(error) if error.code == Code::Conflict && attempt < 2 => continue,
            Err(error) if error.code == Code::Conflict => {
                let hold = TurnHold {
                    reason: format!("Project policy changed while this task's next turn was admitted ({})", error.message),
                };
                report_hold(ctx, rt, store, task_id, &hold, turn.quiet)?;
                return Ok(json!({"delivery": "held", "hold": {"reason": hold.reason}}));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(json!({"delivery": "held"}))
}

/// `deliver`: only a task recipient takes a turn.
pub fn deliver(ctx: &Ctx, rt: &Runtime, to: &str) -> Result<Value, CoreError> {
    let mut store = open(ctx)?;
    deliver_inner(ctx, rt, to, &mut store)
}

fn deliver_inner(
    ctx: &Ctx,
    rt: &Runtime,
    to: &str,
    store: &mut TaskStore,
) -> Result<Value, CoreError> {
    let Some(id) = messages::task_of(to) else {
        return Ok(json!({"delivery": "pull"}));
    };
    let t = store.read(id).map_err(store_error)?;
    let blocked = turn_blocked(ctx, store, t.as_ref())?;
    if let Some(blocked) = blocked
        && blocked != "live"
    {
        return Ok(json!({"delivery": blocked}));
    }
    begin_turn_inner(ctx, rt, id, PendingTurn::default(), store)
}

fn open(ctx: &Ctx) -> Result<TaskStore, CoreError> {
    TaskStore::open(&ctx.pacer_home).map_err(store_error)
}

/// The HTTP read model creates `msg_liveness` on first use (`liveness-store.ts`).
/// The native HTTP path publishes without loading that module, so create the
/// shared schema here to keep SQLite's `sqlite_master` identical to Core's.
pub fn ensure_read_model_schema(ctx: &Ctx) -> Result<(), CoreError> {
    let mut store = open(ctx)?;
    let db = store.connection().map_err(store_error)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS msg_liveness(\n    node TEXT PRIMARY KEY, reason TEXT NOT NULL, since REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL,\n    progress_mark TEXT NULL, stalled_at REAL NULL, escalated_at REAL NULL, hook_set TEXT NULL, hook_blocks INTEGER NOT NULL DEFAULT 0);",
    )
    .map_err(sql_error)?;
    Ok(())
}

fn store_error(error: pacer_store::StoreError) -> CoreError {
    CoreError::new(Code::Internal, format!("message store: {error}"))
}

fn sql_error(error: rusqlite::Error) -> CoreError {
    CoreError::new(Code::Internal, format!("message store: {error}"))
}
