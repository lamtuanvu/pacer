//! Ephemeral state for one live assistant turn: the answer stream, the single
//! in-flight slot, request de-duplication and the turn's tool/grant context.
//!
//! Port of `live`, `inflight`, `requests`, `emit`, `subscribeTurn` and `cancel`
//! in `src/assistant/service.ts`. Nothing here is persisted: history is written
//! by `pacer_store::assistant` and the outbox carries only the turn's state.

use super::{
    cards::{CardDeps, CardTask},
    redact::Redactor,
    tools::{ReadOps, ToolState, run_assistant_tool_with_cards},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_read_model::tasks::full_title;
use pacer_store::{TaskStore, assistant, work_grants};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{mpsc, watch};

/// One stream frame, in wire order: `{"delta"}`, `{"status"}` or `{"done"}`.
pub type Frame = Value;

/// Read access to the task a proposed action names. The card is built while the
/// turn is live, so its revision is the task's current one.
pub struct StoreCards;

impl CardDeps for StoreCards {
    fn task(&self, ctx: &Ctx, id: &str) -> Option<CardTask> {
        let mut store = TaskStore::open(&ctx.pacer_home).ok()?;
        let task = store.read(id).ok()??;
        Some(CardTask {
            rev: task["rev"].as_i64()?,
            title: full_title(&task),
            state: task["state"].as_str()?.to_owned(),
        })
    }
}

/// The one tool state a turn shares between `capability.assistant.tool` (the
/// plugin call) and the `assistant.tool` client op. Both charge one round budget.
pub struct TurnTools {
    pub state: tokio::sync::Mutex<ToolState>,
    pub scope: Value,
    pub redactor: Arc<Redactor>,
    /// The single endpoint account whose key `capability.secrets.resolve` may
    /// answer. No other credential is reachable from a live turn.
    pub account: String,
    /// The account's key source (`none`, `file`, `env:NAME`, `keychain`).
    pub key_source: String,
}

impl TurnTools {
    /// Run one tool call through the ported pipeline, charging the shared budget.
    pub async fn call(
        &self,
        ctx: &Ctx,
        call: &Value,
        reads: &mut dyn ReadOps,
    ) -> (String, bool) {
        let mut state = self.state.lock().await;
        run_assistant_tool_with_cards(
            ctx,
            call,
            &self.scope,
            &self.redactor,
            &mut state,
            reads,
            &StoreCards,
        )
        .await
    }

    /// Answer `capability.secrets.resolve` for exactly the chosen account.
    pub fn secret(&self, ctx: &Ctx, plugin_id: &str, key_ref: &str) -> Result<Value, CoreError> {
        // Only the plugin serving this turn may resolve its account's key.
        if plugin_id.is_empty()
            || ![format!("endpoint:{}", self.account), format!("endpoint/{}", self.account)]
                .iter()
                .any(|expected| expected == key_ref)
        {
            return Err(CoreError::new(
                Code::CapabilityDenied,
                "That secret is not the assistant's account key.",
            ));
        }
        let value = crate::assistant_ops::run_turn::read_endpoint_key(
            ctx,
            &self.account,
            &self.key_source,
        )?;
        Ok(json!({"value": value}))
    }
}

struct LiveTurn {
    redactor: Option<Arc<Redactor>>,
    tools: Option<Arc<TurnTools>>,
    frames: Vec<Frame>,
    listeners: Vec<mpsc::UnboundedSender<Frame>>,
    closed: bool,
    cancelled: bool,
    streamed: bool,
    grant: Option<String>,
    cancel: watch::Sender<bool>,
}

impl LiveTurn {
    fn new(cancel: watch::Sender<bool>) -> Self {
        Self {
            redactor: None,
            tools: None,
            frames: Vec::new(),
            listeners: Vec::new(),
            closed: false,
            cancelled: false,
            streamed: false,
            grant: None,
            cancel,
        }
    }
}

#[derive(Default)]
struct State {
    live: HashMap<String, LiveTurn>,
    /// One turn per pacer home; the value is its turn id.
    inflight: HashMap<String, String>,
    /// Same `requestId` gets the same answer while the first ask is in flight.
    requests: HashMap<String, watch::Sender<Option<Result<Value, CoreError>>>>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// The cancellation receiver a turn watches while it waits for its plugin call.
pub fn open(turn_id: &str) -> watch::Receiver<bool> {
    let (send, receive) = watch::channel(false);
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    state.live.insert(turn_id.to_owned(), LiveTurn::new(send));
    receive
}

/// Attach the turn's redactor and tool context once they exist. Nothing can be
/// streamed before the redactor is set, so unredacted text never reaches a client.
pub fn attach(turn_id: &str, tools: Arc<TurnTools>) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(turn) = state.live.get_mut(turn_id) {
        turn.redactor = Some(Arc::clone(&tools.redactor));
        turn.tools = Some(tools);
    }
}

/// The live turn's tool context, or `None` when the turn has ended.
pub fn tools(turn_id: &str) -> Option<Arc<TurnTools>> {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .get(turn_id)
        .filter(|turn| !turn.closed)
        .and_then(|turn| turn.tools.clone())
}

/// The `pag_` grant issued for this turn, used by the door's grant auth.
pub fn grant(turn_id: &str) -> Option<String> {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .get(turn_id)
        .filter(|turn| !turn.closed)
        .and_then(|turn| turn.grant.clone())
}

pub fn set_grant(turn_id: &str, grant: String) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(turn) = state.live.get_mut(turn_id) {
        turn.grant = Some(grant);
    }
}

/// Close a turn's tool context while its stream is still open. Called before
/// the terminal frame so no tool call can slip in after the answer lands.
pub fn close_tools(turn_id: &str) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .get_mut(turn_id)
        .map(|turn| turn.tools = None);
}

/// Deliver a stream frame to every subscriber, keeping frames for replay.
pub fn emit(turn_id: &str, frame: Frame) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let Some(turn) = state.live.get_mut(turn_id) else {
        return;
    };
    if turn.closed {
        return;
    }
    if frame.get("delta").is_some() {
        turn.streamed = true;
    }
    turn.frames.push(frame.clone());
    turn.listeners.retain(|listener| listener.send(frame.clone()).is_ok());
    if frame.get("done").is_some() {
        turn.closed = true;
        turn.listeners.clear();
        turn.tools = None;
    }
}

/// Subscribe to a turn's frames. Replays the frames already emitted, then
/// streams the rest. `None` means the turn is unknown (never started).
pub fn subscribe(turn_id: &str) -> Option<mpsc::UnboundedReceiver<Frame>> {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    let turn = state.live.get_mut(turn_id)?;
    let (send, receive) = mpsc::unbounded_channel();
    for frame in &turn.frames {
        let _ = send.send(frame.clone());
    }
    if !turn.closed {
        turn.listeners.push(send);
    }
    Some(receive)
}

/// Whether the backend already streamed answer text (so the final answer is not
/// replayed as one more delta).
pub fn streamed(turn_id: &str) -> bool {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .get(turn_id)
        .is_some_and(|turn| turn.streamed)
}

pub fn cancelled(turn_id: &str) -> bool {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .live
        .get(turn_id)
        .is_some_and(|turn| turn.cancelled)
}

/// Reserve the one in-flight slot for a pacer home. Mirrors `startAsk`: the
/// slot is set before the first await so two concurrent asks cannot both pass.
pub fn reserve(home: &str) -> Result<(), CoreError> {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if state.inflight.contains_key(home) {
        return Err(CoreError::new(
            Code::Conflict,
            "The assistant is still answering. Wait for it, or cancel the answer.",
        ));
    }
    state.inflight.insert(home.to_owned(), String::new());
    Ok(())
}

pub fn mark_inflight(home: &str, turn_id: &str) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(slot) = state.inflight.get_mut(home) {
        *slot = turn_id.to_owned();
    }
}

pub fn release(home: &str) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .inflight
        .remove(home);
}

/// Cancel a live turn. Revokes its grant and closes its tools immediately; the
/// turn's runner sees the watch signal and settles as `cancelled`.
pub fn cancel(ctx: &Ctx, turn_id: &str) -> bool {
    let (home, grant) = {
        let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
        let home = state
            .inflight
            .iter()
            .find(|(_, id)| id.as_str() == turn_id)
            .map(|(home, _)| home.clone());
        let Some(turn) = state.live.get_mut(turn_id) else {
            return false;
        };
        if turn.closed || turn.cancelled {
            return false;
        }
        turn.cancelled = true;
        turn.tools = None;
        let grant = turn.grant.take();
        let _ = turn.cancel.send(true);
        (home, grant)
    };
    if let Some(grant) = grant
        && let Ok(mut store) = TaskStore::open(&ctx.pacer_home)
        && let Ok(db) = assistant::database(&mut store)
    {
        let _ = work_grants::revoke_assistant(db, &grant);
    }
    if let Some(home) = home {
        release(&home);
    }
    true
}

/// The watch channel for a request's first answer. A repeat gets the same
/// receiver; the first caller settles it with `finish_request`.
pub fn request(key: &str) -> (bool, watch::Receiver<Option<Result<Value, CoreError>>>) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    match state.requests.get(key) {
        Some(sender) => (false, sender.subscribe()),
        None => {
            let (sender, receiver) = watch::channel(None);
            state.requests.insert(key.to_owned(), sender);
            // Only recent requests are remembered, so a long-lived service does
            // not grow without bound.
            if state.requests.len() > 200 {
                let oldest = state.requests.keys().next().cloned();
                if let Some(oldest) = oldest {
                    state.requests.remove(&oldest);
                }
            }
            (true, receiver)
        }
    }
}

/// Store a request's answer so concurrent and later repeats get the same reply.
pub fn finish_request(key: &str, result: Result<Value, CoreError>) {
    let state = state().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sender) = state.requests.get(key).cloned() {
        let _ = sender.send(Some(result));
    }
}

/// Forget a refused ask: like TypeScript, a request that never started a turn
/// is not remembered.
pub fn forget_request(key: &str) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .requests
        .remove(key);
}

/// Clear all in-memory state between test cases. Not used by runtime code.
pub fn reset() {
    *state().lock().unwrap_or_else(|e| e.into_inner()) = State::default();
}
