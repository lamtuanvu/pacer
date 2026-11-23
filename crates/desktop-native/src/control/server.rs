//! Accept loop for the native desktop control socket.
//!
//! Mirrors `LocalNativeServer` (`native-socket.ts`): accepts at most a fixed
//! number of peers, reads length-prefixed compact-JSON frames, completes the
//! hello handshake (challenge → hello → verify → registered) within a hard
//! deadline, then dispatches post-hello requests through [`Dispatch`] after
//! re-verifying the peer on every frame ([`Guard`]). Idle peers are closed
//! after an inactivity deadline.

use super::{
    Dispatch, Guard,
    frames::{Hello, Request, RequestError},
    peer::{INACTIVITY_TIMEOUT, Peer},
    session::{Identity, Session},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{
    net::UnixListener,
    sync::{Mutex, Notify, RwLock, mpsc},
    task::JoinHandle,
};

/// Maximum number of concurrent accepted peers (matches the desktop server).
pub const MAX_CONNECTIONS: usize = 8;
/// Hello must complete within this deadline or the peer is closed.
const HELLO_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Publishable live state an accepting server shares with the process.
pub struct ControlState {
    sessions: RwLock<std::collections::HashMap<String, Arc<SessionState>>>,
}

struct SessionState {
    session: Mutex<Session>,
    role: String,
}

impl ControlState {
    fn new() -> Self {
        Self {
            sessions: RwLock::new(std::collections::HashMap::new()),
        }
    }
    /// Number of live accepted sessions.
    pub async fn live_connections(&self) -> usize {
        self.sessions.read().await.len()
    }
    /// Whether any accepted desktop session is ready.
    pub async fn desktop_ready(&self) -> bool {
        for state in self.sessions.read().await.values() {
            if state.role == "desktop" && state.session.lock().await.ready {
                return true;
            }
        }
        false
    }
}

/// Accepts and serves native control peers.
pub struct ControlServer<D: Dispatch + 'static, G: Guard + 'static> {
    inner: Arc<Inner<D, G>>,
    shutdown: Arc<Notify>,
}

struct Inner<D: Dispatch, G: Guard> {
    listener: Arc<UnixListener>,
    dispatch: Arc<D>,
    guard: Arc<G>,
    service: String,
    version: String,
    port: u16,
    state: Arc<ControlState>,
}

impl<D: Dispatch + 'static, G: Guard + 'static> ControlServer<D, G> {
    /// Build a server over a bound native listener.
    pub fn new(
        listener: UnixListener,
        service: String,
        version: String,
        port: u16,
        dispatch: D,
        guard: G,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                listener: Arc::new(listener),
                dispatch: Arc::new(dispatch),
                guard: Arc::new(guard),
                service,
                version,
                port,
                state: Arc::new(ControlState::new()),
            }),
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// The shared session state (for readiness probes and tests).
    pub fn state(&self) -> Arc<ControlState> {
        self.inner.state.clone()
    }

    /// Accept and serve peers until `shutdown()` is called or the server
    /// handle is dropped.
    pub fn serve(self) -> JoinHandle<()> {
        tokio::spawn(async move {
            self.run_accept().await;
        })
    }

    /// Stop accepting new peers.
    pub fn shutdown(&self) {
        self.shutdown.notify_one();
    }

    async fn run_accept(self) {
        loop {
            tokio::select! {
                _ = self.shutdown.notified() => return,
                accepted = self.inner.listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        tokio::time::sleep(std::time::Duration::from_millis(8)).await;
                        continue;
                    };
                    if self.inner.state.live_connections().await >= MAX_CONNECTIONS {
                        drop(stream);
                        continue;
                    }
                    let inner = self.inner.clone();
                    let shutdown = self.shutdown.clone();
                    tokio::spawn(async move {
                        let _ = serve_peer(stream, inner).await;
                        let _ = shutdown;
                    });
                }
            }
        }
    }
}

async fn serve_peer<D: Dispatch, G: Guard>(
    stream: tokio::net::UnixStream,
    inner: Arc<Inner<D, G>>,
) {
    let peer = match Peer::new(stream) {
        Ok(peer) => peer,
        Err(_) => return,
    };
    // Challenge first, then expect a hello within the deadline.
    let nonce = random_nonce();
    let _ = peer
        .send(json!({
            "schema": 1, "kind": "challenge", "nonce": nonce,
            "service": inner.service, "version": inner.version, "port": inner.port,
        }))
        .await;

    let Some(hello) = hello_handshake(&peer, &nonce).await else {
        return;
    };
    let Ok(identity) = inner.guard.verify_peer(&peer, &hello).await else {
        peer.close().await;
        return;
    };
    let session_id = new_id();
    let client_id = new_id();
    let session = Session::new(peer.clone(), session_id.clone(), identity.clone());
    let session_state = Arc::new(SessionState {
        session: Mutex::new(session),
        role: hello.role.clone(),
    });
    inner
        .state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), session_state.clone());

    let _ = peer
        .send(json!({
            "schema": 1, "kind": "registered",
            "nonce": hello.nonce, "sessionId": session_id, "clientId": client_id,
            "serviceVersion": inner.version, "installation": Value::Null,
        }))
        .await;

    let mut events: Option<JoinHandle<()>> = None;
    let mut idle = InactiveClock::new();
    'peer: loop {
        tokio::select! {
            _ = idle.tick() => {
                peer.close().await;
                break 'peer;
            }
            frames = peer.read_frames() => match frames {
                Ok(None) => break 'peer,
                Err(_) => { peer.close().await; break 'peer; }
                Ok(Some(values)) => {
                    for value in values {
                        if peer.is_dead() { break 'peer; }
                        let outcome = dispatch_frame(
                            &session_state, &peer, &inner, &identity,
                            hello.role.as_str(), &mut events, &value,
                        ).await;
                        match outcome {
                            FrameOutcome::Continue => {}
                            FrameOutcome::Close => { break 'peer; }
                        }
                        idle.touch();
                    }
                }
            }
        }
    }
    if let Some(task) = events {
        task.abort();
    }
    inner.state.sessions.write().await.remove(&session_id);
    peer.close().await;
}

enum FrameOutcome {
    Continue,
    Close,
}

/// A ticker for the inactivity deadline, clamped at the desktop's poll cadence.
struct InactiveClock {
    deadline: std::time::Instant,
}

impl InactiveClock {
    fn new() -> Self {
        Self {
            deadline: std::time::Instant::now() + INACTIVITY_TIMEOUT,
        }
    }
    fn touch(&mut self) {
        self.deadline = std::time::Instant::now() + INACTIVITY_TIMEOUT;
    }
    async fn tick(&mut self) {
        let remaining = self
            .deadline
            .saturating_duration_since(std::time::Instant::now());
        tokio::time::sleep(remaining).await;
    }
}

async fn dispatch_frame<D: Dispatch, G: Guard>(
    session_state: &Arc<SessionState>,
    peer: &Arc<Peer>,
    inner: &Inner<D, G>,
    identity: &Identity,
    role: &str,
    events: &mut Option<JoinHandle<()>>,
    value: &Value,
) -> FrameOutcome {
    let request = match Request::parse(value) {
        Ok(request) => request,
        Err(RequestError) => return FrameOutcome::Close,
    };
    let mut session = session_state.session.lock().await;
    if !session.accepts(&request.session_id, request.sequence) {
        return FrameOutcome::Close;
    }
    // Re-verify the kernel peer on every frame before any authority effect.
    if inner
        .guard
        .verify_peer(peer, &frame_hello(role, identity))
        .await
        .is_err()
    {
        return FrameOutcome::Close;
    }
    // An op requires a ready, desktop session.
    let requires_ready = matches!(
        request.kind,
        super::FrameKind::Op | super::FrameKind::Snapshot | super::FrameKind::SubscribeEvents
    );
    if requires_ready && (role != "desktop" || !session.ready) {
        return FrameOutcome::Close;
    }
    let sequence = request.sequence;
    match request.kind {
        super::FrameKind::Heartbeat => {
            let _ = peer
                .send(json!({"schema": 1, "kind": "alive", "sequence": sequence}))
                .await;
        }
        super::FrameKind::Op => {
            let Some(op) = request.op.as_deref().filter(|o| !o.is_empty()) else {
                return FrameOutcome::Close;
            };
            let params = request.params.unwrap_or(Value::Null);
            let reply = match inner.dispatch.call_op(identity, op, params).await {
                Ok(result) => json!({"kind": "op-result", "result": result}),
                Err(error) => json!({"kind": "op-error", "error": error}),
            };
            let _ = peer
                .send(merge(json!({"schema": 1, "sequence": sequence}), reply))
                .await;
        }
        super::FrameKind::Snapshot => {
            let reply = match inner
                .dispatch
                .call_op(identity, "snapshot.get", json!({}))
                .await
            {
                Ok(snapshot) => json!({"kind": "snapshot", "snapshot": snapshot}),
                Err(error) => json!({"kind": "op-error", "error": error}),
            };
            let _ = peer
                .send(merge(json!({"schema": 1, "sequence": sequence}), reply))
                .await;
        }
        super::FrameKind::SubscribeEvents => {
            let since = request.params.as_ref().and_then(parse_since).unwrap_or(0.0);
            match inner.dispatch.subscribe(identity, since).await {
                Ok(rx) => {
                    let _ = peer
                        .send(json!({"schema": 1, "kind": "subscribed", "sequence": sequence}))
                        .await;
                    *events = Some(spawn_event_forwarder(peer.clone(), rx, sequence));
                }
                Err(error) => {
                    let _ = peer
                        .send(json!({"schema": 1, "kind": "op-error", "sequence": sequence, "error": error}))
                        .await;
                }
            }
        }
        super::FrameKind::DesktopReady => {
            if role != "desktop" {
                return FrameOutcome::Close;
            }
            session.make_ready();
            drop(session);
            let _ = peer
                .send(json!({"schema": 1, "kind": "ready", "sequence": sequence}))
                .await;
        }
        super::FrameKind::QueryReadiness => {
            let _ = peer
                .send(
                    json!({"schema": 1, "kind": "readiness", "sequence": sequence,
                             "hasDesktop": role == "desktop"}),
                )
                .await;
        }
        other => {
            // Helper and adoption kinds are handled in later slices; reject
            // them as unknown to this session rather than mis-dispatching.
            let _ = other;
            return FrameOutcome::Close;
        }
    }
    FrameOutcome::Continue
}

/// Forward subscribed events to the peer as native `event` frames until the
/// receiver closes or the peer dies.
fn spawn_event_forwarder(
    peer: Arc<Peer>,
    mut rx: mpsc::Receiver<Value>,
    sequence: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if peer.is_dead() {
                break;
            }
            let _ = peer
                .send(json!({
                    "schema": 1, "kind": "event", "sequence": sequence, "event": event,
                }))
                .await;
        }
    })
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(map), Some(extra_map)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_map {
            map.insert(key.clone(), value.clone());
        }
    }
    base
}

fn parse_since(params: &Value) -> Option<f64> {
    let value = params.get("since")?;
    let cursor = match value.as_str() {
        Some(text) => text.trim().parse::<f64>().ok()?,
        None => value.as_f64()?,
    };
    if cursor.is_finite() && cursor.fract() == 0.0 && cursor >= 0.0 {
        Some(cursor)
    } else {
        None
    }
}

fn frame_hello(role: &str, identity: &Identity) -> Hello {
    crate::control::frames::Hello {
        role: role.to_owned(),
        version: String::new(),
        nonce: String::new(),
        challenge: String::new(),
        client_id: identity.client_id.clone(),
        value: Value::Null,
    }
}

async fn hello_handshake(peer: &Arc<Peer>, expected_nonce: &str) -> Option<Hello> {
    let deadline = tokio::time::sleep(HELLO_DEADLINE);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                peer.close().await;
                return None;
            }
            frames = peer.read_frames() => match frames {
                Ok(None) => return None,
                Err(_) => { peer.close().await; return None; }
                Ok(Some(values)) => {
                    if let Some(value) = values.first() {
                        let hello = super::frames::parse_hello(value).ok()?;
                        if hello.challenge != expected_nonce {
                            peer.close().await;
                            return None;
                        }
                        return Some(hello);
                    }
                }
            }
        }
    }
}

fn random_nonce() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
#[path = "tests/server.rs"]
mod tests;
