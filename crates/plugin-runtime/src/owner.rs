//! Process-owner gate and live child map.
//!
//! Production serve keeps [`Ownership::TypeScript`] unless the P4d-1 flag path
//! constructs [`ProcessOwner::native_for_serve`]. The native test token can hold
//! [`PluginProcess`] children in library form without claiming serve supervision
//! or setting `PACER_HOST_SOCKET`. Flag-on calls answer `capability.*` through an
//! installed [`crate::PluginCapabilitySession`] (P4d-6).
//!
//! A lane whose child exited or lost its transport is dead: lookups skip it,
//! and [`ProcessOwner::ensure`] replaces it only after its crash monitor
//! (`crate::crash`) has recorded and reported the crash, and only once the
//! plugin's restart floor has passed.
//!
//! The owner lock covers lookup, start and replacement, never a plugin's
//! reply: calls run on their lane ([`PluginLane::call`]). Every lane is also
//! enrolled in a [`LaneRoster`] outside the lock, so teardown terminates the
//! children at once even while a caller holds the owner.

use crate::capability::PluginCapabilitySession;
use crate::crash::{self, CrashBook, CrashReport};
use crate::observation::{DoorRequest, DoorSlot, LaneObservation};
use crate::orca_attach::SharedOrcaBridge;
use crate::plugin_log::PluginLog;
use crate::process::PluginProcess;
use pacer_plugin_host::{PluginState, ProcessError, Registry, SpawnSpec};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    sync::{Mutex, RwLock, mpsc, watch},
    task::JoinSet,
    time::{Instant, timeout, timeout_at},
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OwnerError {
    #[error("TypeScript currently owns plugin processes")]
    TypeScriptOwnsHost,
    #[error("native process ownership is not activated in serve")]
    NativeNotActivated,
    #[error("plugin already tracked: {0}")]
    AlreadyTracked(String),
    #[error("unknown tracked plugin: {0}")]
    UnknownPlugin(String),
    #[error("plugin process unavailable: {0}")]
    Process(String),
    /// The plugin crashed recently; this owner starts it again at `at`.
    #[error("plugin {id} is waiting to restart after a crash")]
    Backoff { id: String, at: std::time::Instant },
    /// The plugin's dead child is still being reported.
    #[error("plugin {0} is still stopping after a crash")]
    Retiring(String),
    /// Three crashes within the window: no restart until the plugin is enabled again.
    #[error("plugin {0} is failing: {limit} failures within a minute", limit = crash::CRASH_LIMIT)]
    Failing(String),
    #[error("the plugin owner is shutting down")]
    Closing,
    /// The child was asked to stop: no new request reaches it.
    #[error("the plugin is stopping")]
    Stopping,
}

impl From<ProcessError> for OwnerError {
    fn from(error: ProcessError) -> Self {
        Self::Process(error.to_string())
    }
}

/// Who supervises plugin child processes for a serve generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Production default: TypeScript registry via generation-private IPC.
    TypeScript,
    /// Native owner. `supervision` is true only on the flagged serve path.
    Native {
        /// Serve claimed supervision (`ProcessOwner::native_for_serve`).
        supervision: bool,
    },
}

impl Ownership {
    pub fn typescript() -> Self {
        Self::TypeScript
    }

    /// Test-only native token. Production serve must not call this.
    pub fn native_for_tests() -> Self {
        Self::Native { supervision: false }
    }

    /// Flag-on serve constructor: supervision may be claimed.
    pub fn native_for_serve() -> Self {
        Self::Native { supervision: true }
    }

    pub fn is_native(&self) -> bool {
        matches!(self, Self::Native { .. })
    }

    pub fn supervision_claimed(&self) -> bool {
        matches!(self, Self::Native { supervision: true })
    }
}

/// A plugin's capability broker session, shared by the calls that answer through it.
pub type SharedSession = Arc<Mutex<PluginCapabilitySession>>;

/// One tracked child. The owner lock covers lookup and replacement only; a call
/// holds the child's `gate`, so calls to different plugins run in parallel.
/// Exclusive turns keep one call at a time; a reentrant plugin's calls may share.
pub struct PluginLane {
    process: PluginProcess,
    gate: RwLock<()>,
    hello: Mutex<()>,
    /// `Some` once the child answered `plugin.hello`, with the summary when the
    /// caller recorded one.
    ready: std::sync::Mutex<Option<Option<Value>>>,
    /// True once a door-local call sent `plugin.hello` and reports `ready` to its Core;
    /// cleared when that report fails.
    door_hello: AtomicBool,
    /// True once the child exited and its crash, if any, is on record.
    settled: watch::Sender<bool>,
    /// The child's observation generation and idle session.
    observation: Arc<LaneObservation>,
}

impl Drop for PluginLane {
    fn drop(&mut self) {
        self.observation.retire();
    }
}

impl PluginLane {
    fn new(process: PluginProcess, lane: Weak<PluginLane>, door: Arc<DoorSlot>) -> Self {
        Self {
            process,
            gate: RwLock::new(()),
            hello: Mutex::new(()),
            ready: std::sync::Mutex::new(None),
            door_hello: AtomicBool::new(false),
            settled: watch::Sender::new(false),
            observation: Arc::new(LaneObservation::new(door, lane)),
        }
    }

    pub(crate) fn observation(&self) -> &Arc<LaneObservation> {
        &self.observation
    }

    pub(crate) fn note_door_hello(&self) {
        self.door_hello.store(true, Ordering::SeqCst);
    }

    pub(crate) fn forget_door_hello(&self) {
        self.door_hello.store(false, Ordering::SeqCst);
    }

    pub(crate) fn door_helloed(&self) -> bool {
        self.door_hello.load(Ordering::SeqCst)
    }

    /// Refuse a request once [`PluginProcess::terminate`] began, so a call
    /// queued behind a stop never writes to the child.
    pub(crate) fn admit(&self) -> Result<(), OwnerError> {
        if self.process.is_stopping() {
            return Err(OwnerError::Stopping);
        }
        Ok(())
    }

    pub(crate) fn settle(&self) {
        self.settled.send_replace(true);
    }

    pub fn is_settled(&self) -> bool {
        *self.settled.borrow()
    }

    /// Wait up to `within` for [`Self::is_settled`].
    pub async fn wait_settled(&self, within: Duration) {
        let mut settled = self.settled.subscribe();
        let _ = timeout(within, settled.wait_for(|settled| *settled)).await;
    }

    pub fn process(&self) -> &PluginProcess {
        &self.process
    }

    pub fn gate(&self) -> &RwLock<()> {
        &self.gate
    }

    /// Held while sending `plugin.hello`, so overlapping calls send it once.
    pub fn hello_turn(&self) -> &Mutex<()> {
        &self.hello
    }

    fn ready_slot(&self) -> std::sync::MutexGuard<'_, Option<Option<Value>>> {
        self.ready
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_ready(&self) -> bool {
        self.ready_slot().is_some()
    }

    pub fn ready_hello(&self) -> Option<Value> {
        self.ready_slot().clone().flatten()
    }

    pub fn mark_ready(&self, hello: Option<Value>) {
        *self.ready_slot() = Some(hello);
    }

    /// Wait for an exclusive turn until `expires`.
    pub async fn exclusive(
        &self,
        expires: Instant,
    ) -> Result<tokio::sync::RwLockWriteGuard<'_, ()>, OwnerError> {
        timeout_at(expires, self.gate.write())
            .await
            .map_err(|_| ProcessError::Timeout.into())
    }

    /// One request to this child in an exclusive turn. Its capability requests
    /// are answered through `session`, or denied without one. Call it without
    /// the owner lock, so teardown and other plugins never wait for this reply.
    pub async fn call(
        &self,
        session: Option<SharedSession>,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&watch::Receiver<bool>>,
    ) -> Result<Value, OwnerError> {
        let expires = Instant::now() + deadline;
        let _turn = self.exclusive(expires).await?;
        self.admit()?;
        let left = expires.saturating_duration_since(Instant::now());
        self.request_in_turn(session, method, params, left, cancel)
            .await
    }

    /// [`Self::call`] for a caller already holding this lane's [`Self::gate`].
    pub async fn request_in_turn(
        &self,
        session: Option<SharedSession>,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&watch::Receiver<bool>>,
    ) -> Result<Value, OwnerError> {
        match session {
            Some(session) => Ok(self
                .process
                .request_with_handler(method, params, deadline, cancel, move |cap, body, meta| {
                    let session = session.clone();
                    async move {
                        let mut guard = session.lock().await;
                        guard.answer(&cap, body, meta).await
                    }
                })
                .await?),
            None => Ok(self
                .process
                .request(method, params, deadline, cancel)
                .await?),
        }
    }
}

/// Every lane an owner started, and whether teardown began. It sits outside
/// the owner lock, so [`crate::NativeHostSession`] shutdown never waits for a
/// caller holding the owner.
#[derive(Default)]
pub(crate) struct LaneRoster {
    state: std::sync::Mutex<RosterState>,
    /// Where every lane's observation generation reaches the owning door's Core.
    door: Arc<DoorSlot>,
}

#[derive(Default)]
struct RosterState {
    closing: bool,
    lanes: Vec<Weak<PluginLane>>,
}

impl LaneRoster {
    fn state(&self) -> std::sync::MutexGuard<'_, RosterState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.state().closing
    }

    /// Enrol the child `start` returns, unless teardown began. Both happen
    /// under one lock, so [`Self::close`] never misses a child; a refused
    /// child is dropped, which kills it.
    fn admit(
        &self,
        start: impl FnOnce() -> Result<PluginProcess, OwnerError>,
    ) -> Result<Arc<PluginLane>, OwnerError> {
        let mut state = self.state();
        if state.closing {
            return Err(OwnerError::Closing);
        }
        let process = start()?;
        let lane =
            Arc::new_cyclic(|lane| PluginLane::new(process, lane.clone(), self.door.clone()));
        state.lanes.retain(|lane| lane.strong_count() > 0);
        state.lanes.push(Arc::downgrade(&lane));
        Ok(lane)
    }

    /// Refuse new lanes and hand back every one still held.
    pub(crate) fn close(&self) -> Vec<Arc<PluginLane>> {
        let mut state = self.state();
        state.closing = true;
        let lanes: Vec<_> = state
            .lanes
            .drain(..)
            .filter_map(|lane| lane.upgrade())
            .collect();
        drop(state);
        self.door.set(None);
        for lane in &lanes {
            lane.observation().retire();
        }
        lanes
    }

    /// Send every lane's observation requests to `sink` (the owning door's Core).
    pub(crate) fn set_door(&self, sink: Option<mpsc::UnboundedSender<DoorRequest>>) {
        self.door.set(sink);
    }
}

/// Holds live plugin children. Default serve constructs
/// [`ProcessOwner::typescript`]; the P4d-1 flag path uses
/// [`ProcessOwner::native_for_serve`].
pub struct ProcessOwner {
    ownership: Ownership,
    orca_bridge: Option<SharedOrcaBridge>,
    children: HashMap<String, Arc<PluginLane>>,
    /// Optional mirror of [`Registry`] state ids without owning children.
    shadow: HashMap<String, PluginState>,
    /// Per-plugin capability broker sessions (P4d-6). Absent → deny caps.
    sessions: HashMap<String, SharedSession>,
    crashes: Arc<CrashBook>,
    /// No child starts once teardown began ([`Self::close`]).
    roster: Arc<LaneRoster>,
    /// `$PACER_HOME/logs/plugins`: children started here log stderr there.
    log_dir: Option<PathBuf>,
}

impl ProcessOwner {
    fn with_ownership(ownership: Ownership) -> Self {
        Self {
            ownership,
            orca_bridge: None,
            children: HashMap::new(),
            shadow: HashMap::new(),
            sessions: HashMap::new(),
            crashes: Arc::default(),
            roster: Arc::default(),
            log_dir: None,
        }
    }

    /// Append the stderr of children started from now on to `<dir>/<id>.log`.
    pub fn set_log_dir(&mut self, dir: PathBuf) {
        self.log_dir = Some(dir);
    }

    /// Production serve constructor: TypeScript remains the process owner.
    pub fn typescript() -> Self {
        Self::with_ownership(Ownership::typescript())
    }

    /// Test harness that pretends native ownership without activating serve.
    pub fn native_for_tests() -> Self {
        Self::with_ownership(Ownership::native_for_tests())
    }

    /// Flag-on serve path: native ownership with supervision claimable.
    pub fn native_for_serve() -> Self {
        Self::with_ownership(Ownership::native_for_serve())
    }

    pub(crate) fn crash_book(&self) -> Arc<CrashBook> {
        Arc::clone(&self.crashes)
    }

    pub(crate) fn roster(&self) -> Arc<LaneRoster> {
        Arc::clone(&self.roster)
    }

    /// True once teardown began: no child starts again.
    pub fn is_closing(&self) -> bool {
        self.roster.is_closing()
    }

    /// Send each crash this owner sees to `sink` (the owning door's Core).
    pub fn set_crash_sink(&self, sink: mpsc::UnboundedSender<CrashReport>) {
        self.crashes.set_sink(Some(sink));
    }

    /// Send each lane's observation requests (events, task reads, idle log
    /// lines) to `sink`, the owning door's Core.
    pub fn set_door_sink(&self, sink: mpsc::UnboundedSender<DoorRequest>) {
        self.roster.set_door(Some(sink));
    }

    /// The earliest instant this owner starts `id` again after a crash.
    pub fn restart_floor(&self, id: &str) -> Option<std::time::Instant> {
        self.crashes.floor(id)
    }

    /// Forget `id`'s crashes (enabling the plugin clears its backoff).
    pub fn clear_restart_floor(&self, id: &str) {
        self.crashes.clear(id);
    }

    /// Refuse new children and hand back every lane for termination.
    pub fn close(&mut self) -> Vec<Arc<PluginLane>> {
        // Take the lanes before dropping ours: a dropped lane is killed at once.
        let lanes = self.roster.close();
        self.sessions.clear();
        self.children.clear();
        lanes
    }

    pub fn set_orca_bridge(&mut self, bridge: SharedOrcaBridge) {
        self.orca_bridge = Some(bridge);
    }

    pub(crate) fn orca_bridge(&self) -> Option<&SharedOrcaBridge> {
        self.orca_bridge.as_ref()
    }

    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }

    /// Succeeds only for [`Self::native_for_serve`]. TypeScript and the library
    /// test token still refuse.
    pub fn claim_native_supervision(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { supervision: false } => Err(OwnerError::NativeNotActivated),
            Ownership::Native { supervision: true } => Ok(()),
        }
    }

    /// Copy registry plugin states into the shadow table. Never spawns children
    /// and never sets `PACER_HOST_SOCKET`. Safe under TypeScript ownership.
    pub fn sync_shadow_from(&mut self, registry: &Registry) {
        self.shadow.clear();
        for (id, state) in registry.plugin_states() {
            self.shadow.insert(id, state);
        }
    }

    pub fn shadow_state(&self, id: &str) -> Option<PluginState> {
        self.shadow.get(id).copied()
    }

    pub fn shadow_len(&self) -> usize {
        self.shadow.len()
    }

    pub fn tracked_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.children.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn len(&self) -> usize {
        self.children.len()
    }

    pub fn is_empty(&self) -> bool {
        self.children.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&PluginProcess> {
        self.children.get(id).map(|lane| lane.process())
    }

    /// The tracked child's lane, for calls that run without the owner lock.
    pub fn lane(&self, id: &str) -> Option<Arc<PluginLane>> {
        self.children.get(id).cloned()
    }

    /// Install or replace the capability broker session for a tracked plugin.
    pub fn install_capability_session(
        &mut self,
        id: impl Into<String>,
        session: PluginCapabilitySession,
    ) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        self.sessions.insert(id, Arc::new(Mutex::new(session)));
        Ok(())
    }

    /// Shared handle to a plugin's capability session, if installed.
    pub fn capability_session(&self, id: &str) -> Option<SharedSession> {
        self.sessions.get(id).cloned()
    }

    /// Spawn and track a child. Refused while TypeScript owns the host.
    pub fn spawn(&mut self, id: impl Into<String>, spec: &SpawnSpec) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        let log = self
            .log_dir
            .as_deref()
            .and_then(|dir| PluginLog::new(dir, &id));
        let lane = self
            .roster
            .admit(|| Ok(PluginProcess::spawn_logged(spec, log)?))?;
        self.adopt(id, lane);
        Ok(())
    }

    /// Spawn when absent or dead; no-op while a live child is tracked. A dead
    /// lane is replaced once its crash is on record ([`OwnerError::Retiring`]
    /// until then), and no sooner than the restart floor
    /// ([`OwnerError::Backoff`]); a plugin that crashed three times within the
    /// window is not started until enabled again ([`OwnerError::Failing`]).
    /// Refuses TypeScript ownership and teardown ([`OwnerError::Closing`]).
    pub fn ensure(&mut self, id: impl Into<String>, spec: &SpawnSpec) -> Result<bool, OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.roster.is_closing() {
            return Err(OwnerError::Closing);
        }
        if let Some(lane) = self.children.get(&id) {
            if lane.process().is_alive() {
                return Ok(false);
            }
            if !lane.is_settled() {
                return Err(OwnerError::Retiring(id));
            }
            self.children.remove(&id);
            self.sessions.remove(&id);
        }
        if self.crashes.is_failing(&id) {
            return Err(OwnerError::Failing(id));
        }
        if let Some(at) = self.crashes.floor(&id)
            && at > std::time::Instant::now()
        {
            return Err(OwnerError::Backoff { id, at });
        }
        self.spawn(id, spec)?;
        Ok(true)
    }

    /// Adopt an already-spawned child. Refused while TypeScript owns the host.
    pub fn track(&mut self, id: impl Into<String>, child: PluginProcess) -> Result<(), OwnerError> {
        let id = id.into();
        self.ensure_native_library()?;
        if self.children.contains_key(&id) {
            return Err(OwnerError::AlreadyTracked(id));
        }
        let lane = self.roster.admit(|| Ok(child))?;
        self.adopt(id, lane);
        Ok(())
    }

    fn adopt(&mut self, id: String, lane: Arc<PluginLane>) {
        tokio::spawn(crash::monitor(
            self.crashes.clone(),
            id.clone(),
            Arc::downgrade(&lane),
        ));
        self.sessions.remove(&id);
        self.children.insert(id, lane);
    }

    /// Terminate and drop a tracked child.
    pub async fn terminate(&mut self, id: &str) -> Result<(), OwnerError> {
        self.ensure_native_library()?;
        self.sessions.remove(id);
        let lane = self
            .children
            .remove(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        lane.observation().retire();
        lane.process().terminate().await?;
        Ok(())
    }

    pub fn is_ready(&self, id: &str) -> bool {
        self.children.get(id).is_some_and(|lane| lane.is_ready())
    }

    pub fn mark_ready(&mut self, id: &str) {
        if let Some(lane) = self.children.get(id) {
            lane.mark_ready(None);
        }
    }

    /// Mark ready and keep the hello summary until the child is replaced.
    pub fn mark_ready_with(&mut self, id: &str, hello: Value) {
        if let Some(lane) = self.children.get(id) {
            lane.mark_ready(Some(hello));
        }
    }

    pub fn ready_hello(&self, id: &str) -> Option<Value> {
        self.children.get(id).and_then(|lane| lane.ready_hello())
    }

    pub fn clear_ready(&mut self, id: &str) {
        if let Some(lane) = self.children.get(id) {
            *lane.ready_slot() = None;
        }
    }

    /// Pid of a tracked child that is alive and still reachable.
    pub fn find_plugin(&self, id: &str) -> Option<u32> {
        self.children
            .get(id)
            .filter(|lane| lane.process().is_alive())
            .and_then(|lane| lane.process().pid())
    }

    /// JSON-RPC request against a tracked child (`_host.plugin.call`).
    ///
    /// When a [`PluginCapabilitySession`] is installed, plugin-to-host
    /// `capability.*` requests are answered through that broker; otherwise they
    /// stay denied (pre-P4d-6 behavior).
    pub async fn call_plugin(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, OwnerError> {
        self.call_plugin_cancellable(id, method, params, deadline, None)
            .await
    }

    /// [`Self::call_plugin`] that sends `$/cancel` to the child when `cancel` flips.
    pub async fn call_plugin_cancellable(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&watch::Receiver<bool>>,
    ) -> Result<Value, OwnerError> {
        let (lane, session) = self.lane_for_call(id)?;
        lane.call(session, method, params, deadline, cancel).await
    }

    /// The tracked lane and its installed capability session, for a
    /// [`PluginLane::call`] made after the owner lock is released.
    pub fn lane_for_call(
        &self,
        id: &str,
    ) -> Result<(Arc<PluginLane>, Option<SharedSession>), OwnerError> {
        self.ensure_native_library()?;
        if self.roster.is_closing() {
            return Err(OwnerError::Closing);
        }
        let lane = self
            .lane(id)
            .ok_or_else(|| OwnerError::UnknownPlugin(id.into()))?;
        Ok((lane, self.sessions.get(id).cloned()))
    }

    fn ensure_native_library(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { .. } => Ok(()),
        }
    }
}

/// Terminate `lanes` together: each gets SIGTERM, then SIGKILL after the grace.
pub async fn terminate_lanes(lanes: Vec<Arc<PluginLane>>) {
    let mut stopping = JoinSet::new();
    for lane in lanes {
        stopping.spawn(async move {
            let _ = lane.process().terminate().await;
        });
    }
    while stopping.join_next().await.is_some() {}
}

impl Default for ProcessOwner {
    fn default() -> Self {
        Self::typescript()
    }
}

impl std::fmt::Debug for ProcessOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessOwner")
            .field("ownership", &self.ownership)
            .field("children", &self.tracked_ids())
            .field("shadow", &self.shadow)
            .finish()
    }
}
