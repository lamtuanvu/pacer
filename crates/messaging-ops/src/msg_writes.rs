//! `msg.send`, `msg.confirm`, `msg.close` and `msg.wait` from `src/api/ops-msg.ts` and
//! `src/messaging/send.ts`. Rust owns validation, the caller, the guardrail and every store
//! write. The Core [`Bridge`] runs only what needs the live TypeScript service: a task
//! recipient's turn (`deliver`: project-policy admission and runner spawn), the human's task
//! and attention republication, and worktree auto-clean.
#![allow(clippy::result_large_err)] // CoreError is part of the public handler API by value.
use crate::msg_ops::{
    MSG_KINDS, PARTICIPANT, Params, forbidden, is_closed, open, participant, participant_id,
    store_error, truthy,
};
use crate::policy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{TaskStore, messages};
use serde_json::{Map, Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Core effects a message write cannot own. Requests are `{"kind":"deliver","to"}`,
/// `{"kind":"notify","id"}`, `{"kind":"publish","taskIds"}` and `{"kind":"clean","id"}`.
pub trait Bridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// A transport without the Core bridge (stdio `msg.wait`, which never has a human caller).
pub struct NoBridge;

impl Bridge for NoBridge {
    fn call(&mut self, _: Value) -> OpFuture<'_> {
        Box::pin(async { Err(unavailable()) })
    }
}

fn unavailable() -> CoreError {
    CoreError::new(Code::Unavailable, "message bridge unavailable")
}

pub fn uses_bridge(name: &str) -> bool {
    matches!(name, "msg.send" | "msg.confirm" | "msg.close" | "msg.wait")
}

/// The registry entry; the front doors call [`call`] with their Core bridge instead.
pub fn bridge_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async { Err(unavailable()) })
}

/// Runs one message write. TypeScript clocks read `Date.now() / 1000`, so `now` is in milliseconds.
pub async fn call(
    ctx: &Ctx,
    name: &str,
    params: Value,
    bridge: &mut dyn Bridge,
) -> Result<Value, CoreError> {
    let ctx = &Ctx {
        now: (ctx.now * 1000.0).floor() / 1000.0,
        ..ctx.clone()
    };
    match name {
        "msg.send" => send(ctx, params, bridge).await,
        "msg.confirm" => confirm(ctx, params, bridge).await,
        "msg.close" => close(ctx, params, bridge).await,
        "msg.wait" => wait(ctx, params, bridge).await,
        _ => Err(unavailable()),
    }
}

/// An effect whose failure leaves the committed write standing; the failure is only logged.
async fn best_effort(bridge: &mut dyn Bridge, request: Value) {
    let kind = request["kind"].as_str().unwrap_or_default().to_owned();
    if let Err(error) = bridge.call(request).await {
        eprintln!("pacer: message {kind} effect failed: {}", error.message);
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn reason(error: CoreError, reason: &str) -> CoreError {
    let mut data = Map::new();
    data.insert("reason".into(), json!(reason));
    error.data(data)
}

/// `String.prototype.trim`: ECMAScript white space and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

fn wall_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

impl<'a> Params<'a> {
    /// `z.string().min(min).max(max)`; `None` for an optional field that is absent.
    fn bounded(&mut self, key: &str, min: usize, max: usize, required: bool) -> Option<&'a str> {
        let Some(value) = self.map.get(key) else {
            if required {
                self.issues.push(format!(
                    "{key}: Invalid input: expected string, received undefined"
                ));
            }
            return None;
        };
        let text = self.string(key, value, Some(max))?;
        if text.chars().count() < min {
            self.issues.push(format!(
                "{key}: Too small: expected string to have >={min} characters"
            ));
            return None;
        }
        Some(text)
    }

    /// An optional `z.enum(MSG_KINDS)`.
    fn kind(&mut self, key: &str) -> Option<&'a str> {
        let value = self.map.get(key)?;
        let kind = value.as_str().filter(|k| MSG_KINDS.contains(k));
        if kind.is_none() {
            let options: Vec<String> = MSG_KINDS.iter().map(|k| format!("\"{k}\"")).collect();
            self.issues.push(format!(
                "{key}: Invalid option: expected one of {}",
                options.join("|")
            ));
        }
        kind
    }
}

fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

/// The human's messages changed: TypeScript republishes their tasks and attention items.
async fn publish_for_human(store: &mut TaskStore, ids: &[&str], bridge: &mut dyn Bridge) {
    let mut tasks = Vec::new();
    for id in ids {
        let task = messages::get(store, id)
            .ok()
            .flatten()
            .and_then(|m| m.get("taskId").cloned())
            .unwrap_or(Value::Null);
        tasks.push(task);
    }
    // `void publishTaskMessages(...)`: the receipts stand when publication fails.
    best_effort(bridge, json!({"kind": "publish", "taskIds": tasks})).await;
}

/// `readMessages`: marks the recipient's messages read; the human's update their tasks at once.
async fn read_messages(
    store: &mut TaskStore,
    to: &str,
    ids: &[&str],
    at: f64,
    bridge: &mut dyn Bridge,
) -> Result<usize, CoreError> {
    let read = messages::mark_read(store, to, ids, at).map_err(store_error)?;
    if read > 0 && to == "human" {
        publish_for_human(store, ids, bridge).await;
    }
    Ok(read)
}

/// `notifyMessage`: a message to or from the human changes what its task shows them.
async fn notify(ctx: &Ctx, message: &Value, bridge: &mut dyn Bridge) {
    if text(message, "to") == Some("human") || text(message, "from") == Some("human") {
        best_effort(bridge, json!({"kind": "notify", "id": message["id"]})).await;
    } else {
        let event = json!({"type": "entity", "data": {"kind": "message", "id": message["id"], "value": message}});
        pacer_store::publish(ctx, &[event]);
    }
}

/// `deliver`: only a task recipient takes a turn, which TypeScript admits and launches.
async fn deliver(to: &str, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
    if messages::task_of(to).is_none() {
        return Ok(json!({"delivery": "pull"}));
    }
    let result = bridge.call(json!({"kind": "deliver", "to": to})).await?;
    if text(&result, "delivery").is_none() {
        return Err(CoreError::new(
            Code::Unavailable,
            "invalid message bridge response",
        ));
    }
    Ok(result)
}

/// `answeredQuestion`: the question from task `to` that the caller's reply answers.
fn answered_question(
    store: &mut TaskStore,
    caller: &str,
    to: &str,
    reply_to: &str,
) -> Result<Option<Value>, CoreError> {
    let Some(question) = messages::get(store, reply_to).map_err(store_error)? else {
        return Ok(None);
    };
    let ok = text(&question, "kind") == Some("question")
        && messages::task_of(to).is_some()
        && text(&question, "from") == Some(to)
        && (text(&question, "to") == Some(caller) || caller == "human");
    Ok(ok.then_some(question))
}

/// `recordAnswer`: the question, and whether the task's open question took this answer.
fn record_answer(
    ctx: &Ctx,
    store: &mut TaskStore,
    m: &Value,
) -> Result<Option<(Value, bool)>, CoreError> {
    let (Some("answer"), Some(reply_to)) = (text(m, "kind"), text(m, "replyTo")) else {
        return Ok(None);
    };
    let (from, to, body) = (
        text(m, "from").unwrap_or_default(),
        text(m, "to").unwrap_or_default(),
        text(m, "body").unwrap_or_default(),
    );
    let Some(question) = answered_question(store, from, to, reply_to)? else {
        return Ok(None);
    };
    let Some(id) = messages::task_of(to) else {
        return Ok(None);
    };
    // `isTaskQuestion`: a stale reply to an earlier question never answers the one the task waits on now.
    let open = |t: &Value| {
        t.get("question").is_some_and(|q| {
            truthy(Some(q))
                && q.get("answer").is_none()
                && q.get("text") == question.get("body")
                && q.get("at").and_then(Value::as_f64)
                    == question.get("createdAt").and_then(Value::as_f64)
        })
    };
    if !store
        .read(id)
        .map_err(store_error)?
        .is_some_and(|t| open(&t))
    {
        return Ok(Some((question, false)));
    }
    store
        .update_current(id, ctx.now, |t| {
            if open(t) {
                t["question"]["answer"] = json!(body);
                t["question"]["answeredAt"] = json!(ctx.now);
            }
            Ok(())
        })
        .map_err(store_error)?;
    Ok(Some((question, true)))
}

/// Reopens the task's question when the turn that would carry the answer did not start.
fn undo_answer(ctx: &Ctx, store: &mut TaskStore, m: &Value) -> Result<(), CoreError> {
    let (Some(id), Some(body)) = (text(m, "to").and_then(messages::task_of), text(m, "body"))
    else {
        return Ok(());
    };
    store
        .update_current(id, ctx.now, |t| {
            if let Some(q) = t.get_mut("question").and_then(Value::as_object_mut)
                && q.get("answer").and_then(Value::as_str) == Some(body)
            {
                q.remove("answer");
                q.remove("answeredAt");
            }
            Ok(())
        })
        .map_err(store_error)?;
    Ok(())
}

/// `deliverMessage`: an answer is recorded on the task's question before its turn starts.
async fn deliver_message(
    ctx: &Ctx,
    store: &mut TaskStore,
    m: &Value,
    bridge: &mut dyn Bridge,
) -> Result<Value, CoreError> {
    let answered = record_answer(ctx, store, m)?;
    let result = match deliver(text(m, "to").unwrap_or_default(), bridge).await {
        Ok(result) => result,
        Err(error) => {
            // A lost bridge reply may follow a turn TypeScript already started or queued,
            // the two outcomes that keep the answer.
            let id = text(m, "to")
                .and_then(messages::task_of)
                .unwrap_or_default();
            let taken = store.read(id).map_err(store_error)?.is_some_and(|t| {
                truthy(t.get("pendingTurn"))
                    || matches!(text(&t, "state"), Some("queued" | "running"))
            });
            if !taken && answered.as_ref().is_some_and(|(_, undo)| *undo) {
                undo_answer(ctx, store, m)?;
            }
            return Err(error);
        }
    };
    let delivery = text(&result, "delivery").unwrap_or_default();
    if let Some((question, undo)) = answered {
        if undo && !matches!(delivery, "turn_started" | "queued") {
            undo_answer(ctx, store, m)?;
        }
        if delivery != "held" {
            let to = text(&question, "to").unwrap_or_default();
            let id = text(&question, "id").unwrap_or_default();
            read_messages(store, to, &[id], ctx.now, bridge).await?;
        }
    }
    Ok(result)
}

fn merged(mut out: Map<String, Value>, delivery: Value) -> Value {
    if let Value::Object(fields) = delivery {
        for (key, value) in fields {
            if key == "delivery" || key == "hold" {
                out.insert(key, value);
            }
        }
    }
    Value::Object(out)
}

/// `duplicate`: a retried request id returns what it stored before any check can refuse it.
async fn duplicate(
    ctx: &Ctx,
    store: &mut TaskStore,
    (message, stored): (Value, Option<String>),
    fingerprint: &str,
    bridge: &mut dyn Bridge,
) -> Result<Value, CoreError> {
    if stored.is_some_and(|stored| stored != fingerprint) {
        return Err(reason(
            CoreError::new(
                Code::Conflict,
                "That request id was already used for a different message",
            ),
            "msg_request_mismatch",
        ));
    }
    let mut out = Map::new();
    out.insert("message".into(), message.clone());
    out.insert("duplicate".into(), json!(true));
    match text(&message, "status") {
        Some("held") => return Ok(merged(out, json!({"delivery": "held"}))),
        Some("pending") => {
            let delivery = deliver_message(ctx, store, &message, bridge).await?;
            return Ok(merged(out, delivery));
        }
        _ => {}
    }
    if let (Some("answer"), Some(reply_to)) = (text(&message, "kind"), text(&message, "replyTo")) {
        let (from, to) = (
            text(&message, "from").unwrap_or_default(),
            text(&message, "to").unwrap_or_default(),
        );
        if let Some(q) = answered_question(store, from, to, reply_to)? {
            let id = text(&q, "id").unwrap_or_default();
            read_messages(
                store,
                text(&q, "to").unwrap_or_default(),
                &[id],
                ctx.now,
                bridge,
            )
            .await?;
        }
    }
    Ok(merged(out, json!({"delivery": "queued"})))
}

/// `headlessTurnPath(turnRunner(ctx, executor))` is not null.
fn headless_turn(ctx: &Ctx, executor: &str) -> bool {
    const AGENTS: [&str; 5] = ["claude-code", "codex", "cursor", "agy", "opencode"];
    let opencode = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .ok()
        .and_then(|s| {
            let runner = s["runners"].get(executor)?;
            let account = runner["account"].as_str()?;
            s["accounts"].get(account)?;
            Some(runner["agent"] == "opencode")
        })
        .unwrap_or(false);
    let segment = |s: &str| {
        s.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let (left, host) = executor.split_once('@').unwrap_or((executor, ""));
    let (agent, account) = left.split_once('#').unwrap_or((left, ""));
    let parsed = AGENTS.contains(&agent)
        && segment(agent)
        && (account.is_empty() && !left.contains('#') || segment(account))
        && (host.is_empty() && !executor.contains('@') || segment(host));
    if parsed && !host.is_empty() && host != "local" {
        return false;
    }
    if opencode {
        return true;
    }
    let agent = if parsed { agent } else { executor };
    matches!(agent, "codex" | "claude-code" | "cursor" | "agy")
}

/// `turnCapable`: a local direct run whose executor resumes or replays headless.
fn turn_capable(ctx: &Ctx, t: &Value) -> bool {
    let executor = t
        .pointer("/run/executor")
        .filter(|v| !v.is_null())
        .or_else(|| t.pointer("/result/executor"))
        .filter(|v| truthy(Some(v)));
    let backend = t.pointer("/result/backend");
    executor.is_some()
        && !truthy(t.pointer("/run/host"))
        && !(truthy(backend) && backend.and_then(Value::as_str) != Some("direct"))
        && executor
            .and_then(Value::as_str)
            .is_some_and(|e| headless_turn(ctx, e))
}

/// `assertOpen`: a task recipient exists, is open and can still take a turn in its worktree.
fn assert_open(ctx: &Ctx, store: &mut TaskStore, to: &str) -> Result<(), CoreError> {
    let Some(id) = messages::task_of(to) else {
        return Ok(());
    };
    let Some(t) = store.read(id).map_err(store_error)? else {
        return Err(CoreError::new(Code::NotFound, format!("Unknown task {id}")));
    };
    if is_closed(&t) {
        return Err(reason(
            CoreError::new(Code::Conflict, format!("Task {id} is closed for messages")),
            "msg_node_closed",
        ));
    }
    let worktree = t
        .get("worktree")
        .filter(|v| !v.is_null())
        .or_else(|| t.pointer("/result/worktree"))
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty());
    let settled = !matches!(text(&t, "state"), Some("queued" | "running"));
    if let Some(worktree) = worktree
        && settled
        && text(&t, "interactionMode") != Some("conversation")
        && !messages::is_work(store, id).map_err(store_error)?
        && turn_capable(ctx, &t)
        && !std::path::Path::new(worktree).exists()
    {
        return Err(reason(
            CoreError::new(
                Code::Conflict,
                format!(
                    "Task {id}'s worktree was cleaned up, so it cannot take another message turn"
                ),
            )
            .hint("Start a new task, or retry this one to restore its worktree from its branch."),
            "msg_worktree_unavailable",
        ));
    }
    Ok(())
}

async fn send(ctx: &Ctx, params: Value, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
    let mut p = Params::new(&params)?;
    let map = p.map;
    let to = p.pattern("to", map.get("to"), participant_id, PARTICIPANT);
    let body = p.bounded("body", 1, 1 << 20, true);
    let kind = p.kind("kind");
    let reply_to = p.optional_string("reply_to", 64);
    let request_id = p.bounded("request_id", 1, 128, false);
    p.finish(&["to", "body", "kind", "reply_to", "request_id"])?;
    let (to, body, kind) = (
        to.unwrap_or_default(),
        body.unwrap_or_default(),
        kind.unwrap_or("message"),
    );
    if kind == "nudge" {
        return Err(forbidden("Only the broker sends nudges", "protocol"));
    }
    if kind == "answer" && reply_to.is_none() {
        return Err(invalid("An answer needs reply_to"));
    }
    let body = js_trim(body);
    if body.is_empty() {
        return Err(invalid("Message body is empty"));
    }
    let me = participant(ctx)?;
    let mut store = open(ctx)?;
    let fingerprint = messages::fingerprint(to, kind, body);
    if let Some(request_id) = request_id
        && let Some(prior) =
            messages::by_request(&mut store, &me, request_id).map_err(store_error)?
    {
        return duplicate(ctx, &mut store, prior, &fingerprint, bridge).await;
    }
    assert_open(ctx, &mut store, to)?;
    let mut policy_store = policy::Store::new(&ctx.pacer_home);
    let check = policy::Send {
        from: &me,
        to,
        kind,
        grant: false,
    };
    let (hold, _, _) =
        policy::verdict(&mut policy_store, ctx.now, &check, body.len()).map_err(store_error)??;
    let (task_id, anchor) = match messages::task_of(to) {
        Some(id) => (Some(id), to),
        None => (messages::task_of(&me), me.as_str()),
    };
    let root = messages::root_of(&mut store, anchor).map_err(store_error)?;
    let new = messages::NewMessage {
        task_id,
        root_id: &root,
        from: &me,
        to,
        kind,
        body,
        reply_to,
        request_id,
        held: hold,
    };
    let (message, raced) = messages::insert(&mut store, &new, ctx.now).map_err(store_error)?;
    if raced {
        let stored = request_id
            .and_then(|r| messages::by_request(&mut store, &me, r).ok().flatten())
            .and_then(|(_, fingerprint)| fingerprint);
        return duplicate(ctx, &mut store, (message, stored), &fingerprint, bridge).await;
    }
    notify(ctx, &message, bridge).await;
    let mut out = Map::new();
    out.insert("message".into(), message.clone());
    out.insert("duplicate".into(), json!(false));
    // A turn the guardrail allowed still passes project policy; a policy hold says why (ADR 0015).
    let delivery = if hold {
        json!({"delivery": "held"})
    } else {
        deliver_message(ctx, &mut store, &message, bridge).await?
    };
    Ok(merged(out, delivery))
}

async fn confirm(ctx: &Ctx, params: Value, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
    let mut p = Params::new(&params)?;
    let id = p.bounded("id", 0, 64, true);
    p.finish(&["id"])?;
    if participant(ctx)? != "human" {
        return Err(forbidden(
            "Only the human confirms held messages",
            "protocol",
        ));
    }
    let mut store = open(ctx)?;
    let Some(message) =
        messages::confirm_held(&mut store, id.unwrap_or_default()).map_err(store_error)?
    else {
        return Err(CoreError::new(
            Code::Conflict,
            "Message is not waiting for confirmation",
        ));
    };
    let delivery = deliver(text(&message, "to").unwrap_or_default(), bridge).await?;
    let mut out = Map::new();
    out.insert("message".into(), message);
    Ok(merged(out, delivery))
}

async fn close(ctx: &Ctx, params: Value, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
    let mut p = Params::new(&params)?;
    let task = p.task_id("task");
    p.finish(&["task"])?;
    let task = task.unwrap_or_default();
    // Closing is not a send: only the node's parent, the tree's origin or the human may close it.
    let me = participant(ctx)?;
    let node = format!("task:{task}");
    let mut store = open(ctx)?;
    if store.read(task).map_err(store_error)?.is_none() {
        return Err(CoreError::new(
            Code::NotFound,
            format!("Unknown participant {node}"),
        ));
    }
    let parent = messages::parent_of(&mut store, &node).map_err(store_error)?;
    let root = messages::root_of(&mut store, &node).map_err(store_error)?;
    let origin = messages::parent_of(&mut store, &root).map_err(store_error)?;
    if me != "human" && Some(&me) != parent.as_ref() && Some(&me) != origin.as_ref() {
        return Err(forbidden(
            &format!("Only the parent of {node}, its tree's origin or the human may close it"),
            "protocol",
        ));
    }
    store
        .update_current(task, ctx.now, |t| {
            t["msgClosed"] = json!(true);
            Ok(())
        })
        .map_err(store_error)?;
    // A resolved task kept its worktree only for messages: release it now, as a verdict does.
    // Best effort, as `autoCleanTask` is; the periodic sweep retries.
    best_effort(bridge, json!({"kind": "clean", "id": task})).await;
    Ok(json!({"task": task, "closed": true}))
}

/// A reply names the message, or is the recipient's later report, answer or question back.
fn replies(m: &Value, reply_to: &str, original: Option<&Value>) -> bool {
    if text(m, "replyTo") == Some(reply_to) {
        return true;
    }
    let Some(original) = original else {
        return false;
    };
    let at = |v: &Value| v["createdAt"].as_f64().unwrap_or(f64::NAN);
    text(m, "from") == text(original, "to")
        && matches!(text(m, "kind"), Some("report" | "answer" | "question"))
        && (at(m) > at(original)
            || (at(m) == at(original)
                && text(m, "id").unwrap_or_default() > text(original, "id").unwrap_or_default()))
}

struct WaitFor {
    me: String,
    reply_to: Option<String>,
    original: Option<Value>,
    timeout_s: u32,
}

fn wait_for(ctx: &Ctx, store: &mut TaskStore, params: &Value) -> Result<WaitFor, CoreError> {
    let mut p = Params::new(params)?;
    let reply_to = p.optional_string("reply_to", 64);
    let timeout_s = p.optional_int("timeout_s", 3000);
    p.finish(&["reply_to", "timeout_s"])?;
    let me = participant(ctx)?;
    messages::ensure_schema(store).map_err(store_error)?;
    let original = match reply_to {
        Some(id) => messages::get(store, id).map_err(store_error)?,
        None => None,
    };
    Ok(WaitFor {
        me,
        reply_to: reply_to.map(str::to_owned),
        original,
        timeout_s: timeout_s.unwrap_or(600),
    })
}

/// The caller's unread messages that end the wait.
fn hits(store: &mut TaskStore, w: &WaitFor) -> Result<Vec<Value>, CoreError> {
    let unread = messages::inbox(store, &w.me, true, None).map_err(store_error)?;
    Ok(match &w.reply_to {
        Some(reply_to) => unread
            .into_iter()
            .filter(|m| replies(m, reply_to, w.original.as_ref()))
            .collect(),
        None => unread,
    })
}

fn waited(store: &mut TaskStore, me: &str, hits: &[Value]) -> Result<Value, CoreError> {
    let mut messages = Vec::with_capacity(hits.len());
    for hit in hits {
        let current =
            messages::get(store, text(hit, "id").unwrap_or_default()).map_err(store_error)?;
        messages.push(current.unwrap_or_else(|| hit.clone()));
    }
    Ok(json!({"participant": me, "messages": messages, "timedOut": false}))
}

fn ids(hits: &[Value]) -> Vec<&str> {
    hits.iter().filter_map(|m| text(m, "id")).collect()
}

async fn wait(ctx: &Ctx, params: Value, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
    let mut store = open(ctx)?;
    let w = wait_for(ctx, &mut store, &params)?;
    let until = wall_ms() + u128::from(w.timeout_s) * 1000;
    loop {
        let hits = hits(&mut store, &w)?;
        if !hits.is_empty() {
            // Waiting consumes what it returns; msg.inbox does not.
            let at = wall_ms() as f64 / 1000.0;
            read_messages(&mut store, &w.me, &ids(&hits), at, bridge).await?;
            return waited(&mut store, &w.me, &hits);
        }
        if wall_ms() >= until {
            return Ok(json!({"participant": w.me, "messages": [], "timedOut": true}));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// `msg.wait`'s first check, which TypeScript makes as the request arrives: the answer, or
/// `None` while the caller must wait. The human's receipts need the Core, so they always wait.
pub fn wait_now(ctx: &Ctx, params: &Value) -> Option<Result<Value, CoreError>> {
    let check = || {
        let mut store = open(ctx)?;
        let w = wait_for(ctx, &mut store, params)?;
        let hits = hits(&mut store, &w)?;
        if hits.is_empty() || w.me == "human" {
            return Ok(None);
        }
        let at = wall_ms() as f64 / 1000.0;
        messages::mark_read(&mut store, &w.me, &ids(&hits), at).map_err(store_error)?;
        waited(&mut store, &w.me, &hits).map(Some)
    };
    check().transpose()
}

#[cfg(test)]
mod tests;
