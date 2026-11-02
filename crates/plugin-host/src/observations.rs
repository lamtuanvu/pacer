//! Generation-owned read authority. Public projections are injected by the host;
//! neither a retained owner nor an event subscription can authorize an effect.
use crate::{AuthorityError, BrokerError, ParsedManifest};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
pub const EVENT_QUEUE_COUNT: usize = 128;
pub const EVENT_QUEUE_BYTES: usize = 256 * 1024;
pub const POLICY_EVENT_TYPES: &[&str] = &[
    "desktop.update",
    "plugin",
    "pause",
    "task",
    "mode",
    "config",
    "reset",
    "planner",
    "executor",
    "account",
    "host",
    "repo",
    "counts",
    "attention",
    "activity",
    "job",
    "notify",
    "message",
    "liveness",
    "machine",
    "assistant",
    "discovery.found",
];
pub(crate) const TASK_STATES: &[&str] = &[
    "queued",
    "running",
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];
fn deny() -> BrokerError {
    AuthorityError::Denied("read owner retired, foreign, or not granted".into()).into()
}
#[derive(Clone)]
pub struct ReadContext {
    pub home: PathBuf,
    pub pacer_home: PathBuf,
    pub env: std::collections::HashMap<String, String>,
    pub now: f64,
}
#[derive(Clone)]
pub struct ReadOwner {
    token: String,
    context: ReadContext,
    issued: Instant,
    retired: Arc<AtomicBool>,
    allowed: HashSet<String>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl ReadOwner {
    pub fn new(
        context: ReadContext,
        manifest: &ParsedManifest,
        grants: &[String],
        current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, BrokerError> {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| deny())?;
        Ok(Self {
            token: format!(
                "pro_{}",
                bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
            ),
            context,
            issued: Instant::now(),
            retired: Arc::new(AtomicBool::new(false)),
            allowed: manifest
                .capabilities
                .iter()
                .map(|c| c.name.to_string())
                .filter(|c| {
                    ["tasks.read", "events.subscribe"].contains(&c.as_str()) && grants.contains(c)
                })
                .collect(),
            current,
        })
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn revoke(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }
    pub fn granted(&self, capability: &str) -> Result<(), BrokerError> {
        if self.retired.load(Ordering::SeqCst) {
            return Err(deny());
        }
        if !(self.current)() {
            self.revoke();
            return Err(deny());
        }
        if !self.allowed.contains(capability) {
            return Err(deny());
        }
        Ok(())
    }
    pub fn context(&self) -> ReadContext {
        let mut context = self.context.clone();
        context.now += self.issued.elapsed().as_millis() as f64 / 1000.0;
        context
    }
    /// Presence of both reserved fields is forbidden even if one has an invalid token.
    pub fn admit(&self, method: &str, metadata: &Value) -> Result<(), BrokerError> {
        let m = metadata.as_object().ok_or_else(deny)?;
        if m.contains_key("capabilityCall")
            || m.get("readOwner").and_then(Value::as_str) != Some(self.token())
        {
            return Err(deny());
        }
        self.granted(match method {
            "capability.tasks.read" | "capability.tasks.list" => "tasks.read",
            "capability.events.subscribe" => "events.subscribe",
            _ => return Err(deny()),
        })
    }
}
/// Implemented by the API owner, using the same read-only principal, work-grant
/// policy and task projections as the authoritative host. No raw task-store API.
pub trait TaskProjection {
    fn authorize(
        &self,
        context: &ReadContext,
        method: &str,
        params: &Value,
    ) -> Result<(), BrokerError>;
    fn project(
        &mut self,
        context: ReadContext,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
}
pub async fn read_task<P: TaskProjection>(
    owner: &ReadOwner,
    home: &std::path::Path,
    pacer_home: &std::path::Path,
    method: &str,
    params: Value,
    request: &Value,
    projection: &mut P,
) -> Result<Value, BrokerError> {
    owner.granted("tasks.read")?;
    let context = owner.context();
    if context.home != home || context.pacer_home != pacer_home || request.get("id").is_none() {
        return Err(deny());
    }
    validate_task_params(method, &params)?;
    projection.authorize(&context, method, &params)?;
    let result = projection.project(context, method, params.clone()).await?;
    owner.granted("tasks.read")?;
    projection.authorize(&owner.context(), method, &params)?;
    let envelope = json!({"jsonrpc":"2.0","id":request["id"],"result":result});
    if crate::process::frame(envelope).is_err() {
        return Err(BrokerError::Invalid(
            "task result exceeds transport envelope",
        ));
    }
    Ok(result)
}
fn validate_task_params(method: &str, p: &Value) -> Result<(), BrokerError> {
    let invalid = || BrokerError::Invalid("task read parameters");
    let object = p.as_object().ok_or_else(invalid)?;
    match method {
        "capability.tasks.read"
            if object.len() == 1
                && p["id"].as_str().is_some_and(|s| {
                    !s.is_empty() && crate::js_semantics::codepoint_len(s) <= 128
                }) =>
        {
            Ok(())
        }
        "capability.tasks.list"
            if object
                .keys()
                .all(|k| ["states", "limit"].contains(&k.as_str()))
                && p.get("limit").is_none_or(|v| {
                    crate::js_semantics::safe_u64(v).is_some_and(|n| (1..=500).contains(&n))
                })
                && p.get("states").is_none_or(|v| {
                    v.as_array().is_some_and(|a| {
                        a.len() <= 8
                            && a.iter()
                                .all(|s| s.as_str().is_some_and(|s| TASK_STATES.contains(&s)))
                    })
                }) =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}
pub struct EventBatch {
    pub events: Vec<Value>,
    pub last: u64,
    pub reset: bool,
}
struct Queued {
    event: Value,
    bytes: usize,
}
pub struct EventSubscription {
    owner: ReadOwner,
    types: HashSet<String>,
    queue: VecDeque<Queued>,
    inflight: Option<Queued>,
    position: u64,
    retired: bool,
}
fn event_size(event: &Value) -> usize {
    crate::js_canonical_json(&json!({"jsonrpc":"2.0","method":"$/event","params":event}))
        .map_or(usize::MAX, |s| s.len() + 1)
}
fn valid_event(e: &Value) -> bool {
    e.as_object().is_some_and(|o| o.len() == 4)
        && e.get("seq")
            .and_then(crate::js_semantics::safe_u64)
            .is_some()
        && e.get("at")
            .and_then(crate::js_semantics::finite_f64)
            .is_some()
        && e["type"]
            .as_str()
            .is_some_and(|s| POLICY_EVENT_TYPES.contains(&s))
        && e.get("data").is_some()
}
impl EventSubscription {
    pub fn new(
        owner: ReadOwner,
        types: &[String],
        current_cursor: u64,
    ) -> Result<Self, BrokerError> {
        owner.granted("events.subscribe")?;
        if owner
            .context
            .env
            .get("PACER_WORK_GRANT")
            .is_some_and(|v| !v.is_empty())
        {
            return Err(deny());
        }
        let unique: HashSet<_> = types.iter().cloned().collect();
        if types.is_empty()
            || types.len() > 32
            || unique.len() != types.len()
            || types
                .iter()
                .any(|s| !POLICY_EVENT_TYPES.contains(&s.as_str()))
        {
            return Err(BrokerError::Invalid("unique event types"));
        }
        Ok(Self {
            owner,
            types: unique,
            queue: VecDeque::new(),
            inflight: None,
            position: current_cursor,
            retired: false,
        })
    }
    pub fn cursor(&self) -> u64 {
        self.position
    }
    pub fn active(&self) -> bool {
        !self.retired
    }
    pub fn pending(&self) -> (usize, usize) {
        (
            self.queue.len() + usize::from(self.inflight.is_some()),
            self.queue
                .iter()
                .chain(self.inflight.iter())
                .map(|q| q.bytes)
                .sum(),
        )
    }
    pub fn retire(&mut self, revoke: bool) {
        self.retired = true;
        self.queue.clear();
        self.inflight = None;
        if revoke {
            self.owner.revoke();
        }
    }
    pub fn guard(&self) -> Result<(), BrokerError> {
        if self.retired {
            return Err(deny());
        }
        self.owner.granted("events.subscribe")
    }
    pub fn pump(&mut self, batch: EventBatch) -> Result<(), BrokerError> {
        if self.retired {
            return Ok(());
        }
        if let Err(e) = self.guard() {
            self.retire(true);
            return Err(e);
        }
        let mut reset = batch.reset && !batch.events.iter().any(|e| e["type"] == "reset");
        let mut selected = vec![];
        for event in batch.events {
            if event["type"] != "reset"
                && !event["type"]
                    .as_str()
                    .is_some_and(|s| self.types.contains(s))
            {
                continue;
            }
            let bytes = event_size(&event);
            if !valid_event(&event) || bytes > EVENT_QUEUE_BYTES - 1024 {
                reset = true;
                break;
            }
            selected.push(Queued { event, bytes });
        }
        let (count, bytes) = self.pending();
        if reset
            || count + selected.len() > EVENT_QUEUE_COUNT - 1
            || bytes + selected.iter().map(|q| q.bytes).sum::<usize>() > EVENT_QUEUE_BYTES - 1024
        {
            let event = json!({"seq":batch.last,"at":self.owner.context().now,"type":"reset","data":{"reason":"event delivery requires resnapshot","cursor":batch.last}});
            self.queue = VecDeque::from([Queued {
                bytes: event_size(&event),
                event,
            }]);
        } else {
            self.queue.extend(selected);
        }
        self.position = batch.last;
        Ok(())
    }
    /// Only one delivery may be in flight. Its bytes remain reserved until ack.
    pub fn next_delivery(&mut self) -> Result<Option<Value>, BrokerError> {
        self.guard()?;
        if self.inflight.is_some() {
            return Ok(None);
        }
        self.inflight = self.queue.pop_front();
        Ok(self.inflight.as_ref().map(|q| q.event.clone()))
    }
    pub fn delivered(&mut self, success: bool) {
        if success {
            self.inflight = None;
        } else {
            self.retire(true);
        }
    }
}
