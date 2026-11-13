//! A lane's observation generation and idle session (ADR 0027, observation addendum).
//!
//! A plugin that subscribes during a doctor or policy call keeps its read
//! owner and event subscription for as long as its child, not its call: they
//! belong to the lane. The owning door's Core is the event and task source
//! (private `observation_events` and `observation_read`), so the plugin gets
//! the events the TypeScript registry would deliver, filtered by its grants
//! and subscribed types, in outbox order and framed as `JSON.stringify` writes
//! them. Core re-checks on every pump and read that the plugin is enabled,
//! granted and keeps the fingerprint the generation was sealed with. The
//! generation retires when its child exits or is stopped, the owner closes,
//! Core refuses it, or a pump or delivery fails.
//!
//! Requests sent while no call is pending, and every read-owner request, reach
//! the lane's idle session ([`LaneObservation::answer`]), never the next call's
//! session: it answers task reads and subscriptions only under the
//! generation's read owner, `capability.log` and `capability.config.get` from
//! the sealed hello, and refuses everything else.

use crate::{
    bridge_call::log_line,
    capability::{PluginCapabilitySession, session_from_hello},
    owner::PluginLane,
    process::PluginProcess,
};
use pacer_plugin_host::{
    AuthorityError, BrokerError, EventBatch, ObservationCall, ObservationGeneration,
    ParsedManifest, ProcessError, ReadContext, TaskProjection, parse_manifest, read_task,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex as StdMutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify, mpsc, oneshot},
    task::JoinHandle,
    time::{MissedTickBehavior, timeout},
};

/// How often a subscription asks Core for new events (the registry's `eventPumpMs`).
pub const PUMP_EVERY: Duration = Duration::from_millis(100);
/// How long one `$/event` line may wait on the child's stdin (`notifyBounded`).
const DELIVERY_DEADLINE: Duration = Duration::from_secs(2);
/// How long a lane waits for its door to answer one private request.
const CORE_WAIT: Duration = Duration::from_secs(10);
/// The idle session's authority outlives any child.
const IDLE_LIFETIME: Duration = Duration::from_secs(10 * 365 * 24 * 3600);
const PUMP_FAILED: &str = "event generation or projection unavailable";
const DELIVERY_FAILED: &str = "event notification delivery failed";

/// A private `/_internal/plugins` request for the owning door's Core, and
/// where its reply goes.
pub struct DoorRequest {
    pub body: Value,
    pub reply: oneshot::Sender<Result<Value, DoorRefusal>>,
}

/// Core's refusal of a [`DoorRequest`]: its error code and message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoorRefusal {
    pub code: String,
    pub message: String,
}

impl DoorRefusal {
    fn unavailable() -> Self {
        Self {
            code: "unavailable".into(),
            message: "the owning door's Core is unavailable".into(),
        }
    }

    fn rpc(&self) -> Value {
        rpc_error(&self.code, &self.message)
    }
}

fn rpc_error(code: &str, message: &str) -> Value {
    json!({"code": if code == "unknown_op" { -32601 } else { -32000 },
        "message": message, "data": {"code": code}})
}

fn denied(message: impl AsRef<str>) -> Value {
    rpc_error("capability_denied", message.as_ref())
}

fn broker_rpc(error: &BrokerError) -> Value {
    let code = match error {
        BrokerError::Invalid(_) => "invalid_input",
        _ => "capability_denied",
    };
    rpc_error(code, &error.to_string())
}

/// Where an owner's lanes send their Core requests; unset, none reach Core.
#[derive(Default)]
pub(crate) struct DoorSlot(StdMutex<Option<mpsc::UnboundedSender<DoorRequest>>>);

impl DoorSlot {
    pub(crate) fn set(&self, sink: Option<mpsc::UnboundedSender<DoorRequest>>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sink;
    }

    async fn request(&self, body: Value) -> Result<Value, DoorRefusal> {
        let sink = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(DoorRefusal::unavailable)?;
        let (reply, answer) = oneshot::channel();
        sink.send(DoorRequest { body, reply })
            .map_err(|_| DoorRefusal::unavailable())?;
        match timeout(CORE_WAIT, answer).await {
            Ok(Ok(reply)) => reply,
            _ => Err(DoorRefusal::unavailable()),
        }
    }
}

/// A call's Core-sealed observation admission.
pub(crate) struct CallObservation {
    pub(crate) call: ObservationCall,
    pub(crate) context: ReadContext,
    /// Core's digest of the plugin's observation fingerprint.
    pub(crate) generation: Option<String>,
}

/// Core answers task reads under the generation it re-checks.
struct CoreProjection<'a> {
    door: &'a DoorSlot,
    id: &'a str,
    generation: &'a str,
    refusal: Option<DoorRefusal>,
}

impl TaskProjection for CoreProjection<'_> {
    fn authorize(&self, _: &ReadContext, _: &str, _: &Value) -> Result<(), BrokerError> {
        Ok(())
    }

    async fn project(
        &mut self,
        _: ReadContext,
        method: &str,
        params: Value,
    ) -> Result<Value, BrokerError> {
        let body = json!({"kind":"observation_read","id":self.id,"generation":self.generation,
            "method":method,"params":params});
        self.door.request(body).await.map_err(|refusal| {
            let message = refusal.message.clone();
            self.refusal = Some(refusal);
            AuthorityError::Denied(message).into()
        })
    }
}

struct Live {
    generation: ObservationGeneration,
    /// Core's name for it: the digest the bootstrap call was sealed with.
    name: String,
    current: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

impl Live {
    fn retire(mut self) {
        self.current.store(false, Ordering::SeqCst);
        self.generation.retire();
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

fn live_generation<'a>(
    state: &'a mut State,
    name: &str,
) -> Result<&'a mut ObservationGeneration, Value> {
    state
        .live
        .as_mut()
        .filter(|live| live.name == name)
        .map(|live| &mut live.generation)
        .ok_or_else(|| denied("read owner generation changed"))
}

#[derive(Default)]
struct State {
    /// The plugin id, the sealed hello's manifest and grants, and the idle
    /// session, once a call helloed the child.
    id: Option<String>,
    manifest: Option<ParsedManifest>,
    grants: Vec<String>,
    idle: Option<Arc<Mutex<PluginCapabilitySession>>>,
    live: Option<Live>,
    /// The child exited or was stopped: no generation starts again.
    closed: bool,
}

/// One lane's observation generation and idle session.
pub struct LaneObservation {
    door: Arc<DoorSlot>,
    lane: Weak<PluginLane>,
    state: StdMutex<State>,
    wake: Notify,
}

const OBSERVATION_METHODS: [&str; 3] = [
    "capability.tasks.read",
    "capability.tasks.list",
    "capability.events.subscribe",
];

impl LaneObservation {
    pub(crate) fn new(door: Arc<DoorSlot>, lane: Weak<PluginLane>) -> Self {
        Self {
            door,
            lane,
            state: StdMutex::default(),
            wake: Notify::new(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Bind the plugin and its sealed `hello` once the child answered it, and
    /// answer the requests that arrive with no call pending from now on.
    pub(crate) fn install(self: &Arc<Self>, id: &str, hello: &Value, process: &PluginProcess) {
        {
            let mut state = self.state();
            if state.id.is_some() || state.closed {
                return;
            }
            let Ok(idle) = session_from_hello(hello, IDLE_LIFETIME) else {
                return;
            };
            state.id = Some(id.to_owned());
            state.manifest = hello
                .get("manifest")
                .cloned()
                .and_then(|manifest| parse_manifest(manifest).ok());
            state.grants = hello["grants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            state.idle = Some(Arc::new(Mutex::new(idle)));
        }
        let this = Arc::clone(self);
        process.serve_idle(move |method, params, metadata| {
            let this = Arc::clone(&this);
            async move { this.answer(&method, params, metadata, None).await }
        });
    }

    /// The live generation's name, when a call bootstrapped one.
    pub(crate) fn generation(&self) -> Option<String> {
        self.state().live.as_ref().map(|live| live.name.clone())
    }

    /// Retire the generation for good: the child exited or is being stopped,
    /// or its owner is closing.
    pub(crate) fn retire(&self) {
        let live = {
            let mut state = self.state();
            state.closed = true;
            state.live.take()
        };
        if let Some(live) = live {
            live.retire();
        }
        self.wake.notify_one();
    }

    /// Retire `name` if it is still the live generation; its plugin id when it was.
    fn retire_named(&self, name: &str) -> Option<String> {
        let (live, id) = {
            let mut state = self.state();
            if state.live.as_ref().is_none_or(|live| live.name != name) {
                return None;
            }
            state.closed = true;
            (state.live.take(), state.id.clone())
        };
        if let Some(live) = live {
            live.retire();
        }
        self.wake.notify_one();
        id
    }

    /// End `name` and stop the child, as the registry stops a local child
    /// whose generation it retired. `reason` is a failure Core records.
    fn stop(self: &Arc<Self>, name: &str, reason: Option<&'static str>) {
        let Some(id) = self.retire_named(name) else {
            return;
        };
        let this = Arc::clone(self);
        let name = name.to_owned();
        tokio::spawn(async move {
            if let Some(reason) = reason {
                let body =
                    json!({"kind":"observation_retired","id":id,"generation":name,"reason":reason});
                let _ = this.door.request(body).await;
            }
            let lane = this.lane.upgrade();
            if let Some(lane) = lane {
                let _ = lane.process().terminate().await;
            }
        });
    }

    fn negotiated(&self) -> bool {
        self.lane.upgrade().is_some_and(|lane| {
            lane.ready_hello().is_some_and(|hello| {
                hello["features"]
                    .as_array()
                    .is_some_and(|features| features.iter().any(|f| f == "policyObservations"))
            })
        })
    }

    /// The live generation for `call`'s sealed bootstrap, started when none is.
    fn ensure(&self, call: &CallObservation) -> Result<(), Value> {
        let name = call
            .generation
            .as_deref()
            .ok_or_else(|| denied("observation generation was not sealed"))?;
        let mut state = self.state();
        if state.closed {
            return Err(denied("read owner generation changed"));
        }
        if let Some(live) = &state.live {
            return if live.name == name {
                Ok(())
            } else {
                Err(rpc_error(
                    "plugin_unavailable",
                    "observation generation changed before request",
                ))
            };
        }
        let manifest = state
            .manifest
            .clone()
            .ok_or_else(|| denied("observation transport not negotiated"))?;
        let current = Arc::new(AtomicBool::new(true));
        let (lane, live) = (self.lane.clone(), Arc::clone(&current));
        let generation = ObservationGeneration::new(
            call.context.clone(),
            manifest,
            state.grants.clone(),
            true,
            Arc::new(move || {
                live.load(Ordering::SeqCst)
                    && lane.upgrade().is_some_and(|lane| {
                        lane.process().is_alive() && !lane.process().is_stopping()
                    })
            }),
        );
        state.live = Some(Live {
            generation,
            name: name.to_owned(),
            current,
            tasks: Vec::new(),
        });
        Ok(())
    }

    /// Answer one plugin-to-host request: an observation under `call`'s
    /// admission or the generation's read owner, or, with no call, anything
    /// the idle session may answer.
    pub(crate) async fn answer(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        metadata: Option<Value>,
        call: Option<&CallObservation>,
    ) -> Result<Value, Value> {
        if OBSERVATION_METHODS.contains(&method) {
            return self.observe(method, params, metadata, call).await;
        }
        let meta = metadata.as_ref().and_then(Value::as_object);
        if meta.is_some_and(|meta| meta.contains_key("readOwner")) {
            return Err(denied("read owner cannot authorize this method"));
        }
        if meta.is_some_and(|meta| meta.contains_key("capabilityCall")) {
            return Err(denied("capability token has no active pending request"));
        }
        let (idle, id) = {
            let state = self.state();
            (state.idle.clone(), state.id.clone())
        };
        let (Some(idle), Some(id)) = (idle, id) else {
            return Err(denied("scoped capability requires an active owning call"));
        };
        let (result, logs) = {
            let mut session = idle.lock().await;
            let result = session.answer(method, params, None).await;
            (result, session.take_logs())
        };
        for (level, message) in logs {
            let body = json!({"kind":"log","id":id,"level":level,"message":log_line(message)});
            let _ = self.door.request(body).await;
        }
        result
    }

    async fn observe(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        metadata: Option<Value>,
        call: Option<&CallObservation>,
    ) -> Result<Value, Value> {
        if !self.negotiated() {
            return Err(denied("observation transport not negotiated"));
        }
        let subscribe = method == "capability.events.subscribe";
        let capability = if subscribe {
            "events.subscribe"
        } else {
            "tasks.read"
        };
        let id = {
            let state = self.state();
            let declared = state.manifest.as_ref().is_some_and(|manifest| {
                manifest
                    .capabilities
                    .iter()
                    .any(|c| c.name.to_string() == capability)
            });
            let id = state.id.clone().unwrap_or_default();
            if !declared {
                return Err(denied(format!("plugin {id} did not declare {capability}")));
            }
            id
        };
        let read_owner = metadata
            .as_ref()
            .is_some_and(|meta| meta.get("readOwner").is_some());
        let request = json!({"id": 1, "_meta": metadata.unwrap_or_else(|| json!({}))});
        let call = match call {
            Some(call) if !read_owner => {
                self.ensure(call)?;
                Some(call)
            }
            None if !read_owner => {
                return Err(denied(
                    "observations require an active pending call or read owner",
                ));
            }
            _ => None,
        };
        let admitted = call.map(|call| &call.call);
        let name = self
            .generation()
            .ok_or_else(|| denied("unknown or foreign read owner"))?;
        if subscribe {
            live_generation(&mut self.state(), &name)?
                .authorize(method, &request, admitted)
                .map_err(|error| broker_rpc(&error))?;
            let body = json!({"kind":"observation_events","id":id,"generation":name,
                "since":null,"types":["reset"]});
            let start = self
                .door
                .request(body)
                .await
                .map_err(|refusal| refusal.rpc())?;
            let cursor = start["last"]
                .as_u64()
                .ok_or_else(|| rpc_error("plugin_unavailable", PUMP_FAILED))?;
            let reply = live_generation(&mut self.state(), &name)?
                .subscribe(&params, &request, admitted, cursor)
                .map_err(|error| broker_rpc(&error))?;
            self.start_pump(&name);
            return Ok(reply);
        }
        let (owner, context) = {
            let mut state = self.state();
            let generation = live_generation(&mut state, &name)?;
            let owner = generation
                .read_owner(method, &request, admitted)
                .map_err(|error| broker_rpc(&error))?;
            (owner, generation.context().clone())
        };
        let mut projection = CoreProjection {
            door: &self.door,
            id: &id,
            generation: &name,
            refusal: None,
        };
        let result = read_task(
            &owner,
            &context.home,
            &context.pacer_home,
            method,
            params,
            &request,
            &mut projection,
        )
        .await;
        let result = match (result, projection.refusal) {
            (Ok(result), _) => result,
            (Err(_), Some(refusal)) => return Err(refusal.rpc()),
            (Err(error), None) => return Err(broker_rpc(&error)),
        };
        live_generation(&mut self.state(), &name)?
            .authorize(method, &request, admitted)
            .map_err(|error| broker_rpc(&error))?;
        Ok(result)
    }

    fn start_pump(self: &Arc<Self>, name: &str) {
        let mut state = self.state();
        let Some(live) = state.live.as_mut().filter(|live| live.name == name) else {
            return;
        };
        if live.tasks.is_empty() {
            live.tasks = vec![
                tokio::spawn(Arc::clone(self).pump(name.to_owned())),
                tokio::spawn(Arc::clone(self).flush(name.to_owned())),
            ];
        }
    }

    /// `(id, cursor, types)` of `name`'s active subscription.
    fn cursor(&self, name: &str) -> Option<(String, u64, Vec<String>)> {
        let mut state = self.state();
        let id = state.id.clone()?;
        let live = state.live.as_mut().filter(|live| live.name == name)?;
        let subscription = live.generation.subscription().filter(|s| s.active())?;
        Some((id, subscription.cursor(), subscription.types()))
    }

    /// Ask Core for the events after the cursor every [`PUMP_EVERY`] and queue
    /// them, as the registry's pump does for a local child.
    async fn pump(self: Arc<Self>, name: String) {
        let mut tick = tokio::time::interval(PUMP_EVERY);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some((id, cursor, types)) = self.cursor(&name) else {
                return;
            };
            let body = json!({"kind":"observation_events","id":id,"generation":name,
                "since":cursor,"types":types});
            let batch = match self.door.request(body).await {
                Ok(batch) => batch,
                // Core restarting: the cursor holds until it answers again.
                Err(refusal) if refusal.code == "unavailable" => continue,
                // Disabled, refused or reconfigured: the registry stops the child.
                Err(refusal) if refusal.code == "capability_denied" => {
                    return self.stop(&name, None);
                }
                Err(_) => return self.stop(&name, Some(PUMP_FAILED)),
            };
            let (Some(events), Some(last)) = (batch["events"].as_array(), batch["last"].as_u64())
            else {
                return self.stop(&name, Some(PUMP_FAILED));
            };
            let batch = EventBatch {
                events: events.clone(),
                last,
                reset: batch["reset"] == true,
            };
            let queued = {
                let mut state = self.state();
                match state.live.as_mut().filter(|live| live.name == name) {
                    Some(live) => live
                        .generation
                        .subscription()
                        .map(|subscription| subscription.pump(batch).is_ok()),
                    None => return,
                }
            };
            match queued {
                Some(true) => self.wake.notify_one(),
                Some(false) => return self.stop(&name, Some(PUMP_FAILED)),
                None => return,
            }
        }
    }

    /// Write queued events to the child one at a time, each within
    /// [`DELIVERY_DEADLINE`], independent of the pump.
    async fn flush(self: Arc<Self>, name: String) {
        loop {
            self.wake.notified().await;
            loop {
                let event = {
                    let mut state = self.state();
                    let Some(live) = state.live.as_mut().filter(|live| live.name == name) else {
                        return;
                    };
                    match live.generation.subscription().map(|s| s.next_delivery()) {
                        Some(Ok(Some(event))) => event,
                        Some(Ok(None)) => break,
                        _ => return,
                    }
                };
                let Some(lane) = self.lane.upgrade() else {
                    return;
                };
                let guard = || self.delivery_guard(&name);
                let sent = lane
                    .process()
                    .notify_bounded("$/event", event, DELIVERY_DEADLINE, guard)
                    .await;
                drop(lane);
                let mut state = self.state();
                let Some(live) = state.live.as_mut().filter(|live| live.name == name) else {
                    return;
                };
                if let Some(subscription) = live.generation.subscription() {
                    subscription.delivered(sent.is_ok());
                }
                if sent.is_err() {
                    drop(state);
                    return self.stop(&name, Some(DELIVERY_FAILED));
                }
            }
        }
    }

    fn delivery_guard(&self, name: &str) -> Result<(), ProcessError> {
        let mut state = self.state();
        let active = state
            .live
            .as_mut()
            .filter(|live| live.name == name)
            .and_then(|live| live.generation.subscription())
            .is_some_and(|subscription| subscription.guard().is_ok());
        if active {
            Ok(())
        } else {
            Err(ProcessError::OwnerRefused("subscription retired".into()))
        }
    }
}

#[cfg(test)]
#[path = "observation/tests.rs"]
mod tests;
