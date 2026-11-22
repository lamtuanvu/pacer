//! A scripted in-process host for exercising a [`Plugin`] inside tests.
//!
//! The [`Harness`] runs a plugin over two in-memory pipes (as the real host
//! would via stderr). Capability requests the plugin makes are answered from the
//! closures registered with [`Harness::on_capability`]; a capability with no
//! registered answer is denied with `capability_denied`, matching what the real
//! host returns for an ungranted capability.
//!
//! Scoped capabilities (matching the TypeScript host) require the plugin to echo
//! the owning call's `_meta.capabilityCall` token. `$/resultChunk` requests are
//! acknowledged with `{ bytes: offset + len }` by default (so a plugin using
//! negotiated chunked results can assemble a large reply); register an answer
//! for `$/resultChunk` to script a failure path.

use crate::{Plugin, PluginError, js, wire};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

/// An error the scripted host can return to the plugin, mirroring [`PluginError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub reason: Option<String>,
}

impl HostError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
            reason: None,
        }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

impl From<(String, String)> for HostError {
    fn from((code, message): (String, String)) -> Self {
        HostError::new(code, message)
    }
}

/// Parameters used to script `plugin.hello` when the harness starts a plugin.
pub struct HelloSpec {
    pub config: Value,
    pub grants: Vec<String>,
    /// Features the host offers at hello; the plugin filters by protocol gate.
    pub features: Vec<String>,
    /// The protocol version the host advertises at hello.
    pub protocol: String,
}

impl Default for HelloSpec {
    fn default() -> Self {
        Self {
            config: json!({}),
            grants: Vec::new(),
            features: Vec::new(),
            protocol: pacer_plugin_protocol::VERSION.to_string(),
        }
    }
}

/// An answer installed for one capability method: params in, (value or error) out.
type Answer = Arc<
    dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send>>
        + Send
        + Sync
        + 'static,
>;

fn unavailable() -> PluginError {
    PluginError::new("plugin_unavailable", "host closed the connection")
}

fn host_error_data(e: &HostError) -> Value {
    let mut d = json!({ "code": e.code.clone() });
    if let Some(h) = &e.hint {
        d["hint"] = json!(h);
    }
    if let Some(r) = &e.reason
        && e.code == "capability_denied"
        && r == "credential_reflection"
    {
        d["reason"] = json!(r);
    }
    d
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn read_lock<T>(r: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    match r.read() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn write_lock<T>(r: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    match r.write() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Capability methods that require an owning-call token on the real host
/// (`src/plugins/host.ts`), excluding `capability.secrets.resolve`.
fn requires_capability_call(method: &str) -> bool {
    matches!(
        method,
        "capability.fs.read"
            | "capability.fs.write"
            | "capability.process.spawn"
            | "capability.usage.state"
            | "capability.net.http"
            | "capability.secrets.check"
            | "capability.hosts"
            | "capability.worktree"
            | "capability.orca"
            | "capability.assistant.tool"
    ) || method.starts_with("capability.fs.")
        || method.starts_with("capability.process.")
        || method.starts_with("capability.hosts.")
        || method.starts_with("capability.worktree.")
        || method.starts_with("capability.orca.")
}

struct Inner {
    out: mpsc::UnboundedSender<String>,
    answers: RwLock<HashMap<String, Answer>>,
    progress: RwLock<Vec<Value>>,
    notifications: RwLock<Vec<(String, Value)>>,
    capability_calls: RwLock<Vec<(String, Value, Option<Value>)>>,
    /// `$/resultChunk` requests the plugin made (offset / base64), in order.
    chunks: RwLock<Vec<Value>>,
    /// The plugin's acknowledgement to `plugin.hello`.
    hello: RwLock<Option<Value>>,
    /// Token of the in-flight host→plugin call; scoped capabilities must echo it.
    active_token: RwLock<Option<String>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, PluginError>>>>,
    next: AtomicU64,
    closed: AtomicBool,
}

/// A scripted host harness that runs a [`Plugin`] and answers its capability
/// requests.
pub struct Harness {
    inner: Arc<Inner>,
    rx_task: JoinHandle<()>,
    writer: JoinHandle<()>,
    plugin_task: JoinHandle<std::io::Result<()>>,
    stop: CancellationToken,
}

/// Background reader of the plugin's output: answers capability requests from the
/// registered closures, records `$/progress` notifications, and routes
/// responses back to in-flight [`Harness::call`] subscribers.
async fn listen(inner: Arc<Inner>, mut lines: Lines<BufReader<tokio::io::DuplexStream>>) {
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(msg) = wire::parse(&line) else {
            continue;
        };
        match msg {
            wire::Incoming::Request {
                id,
                method,
                params,
                meta,
            } => {
                if method == "$/resultChunk" {
                    write_lock(&inner.chunks).push(params.clone());
                    let reply = answer_result_chunk(&inner, &id, params).await;
                    let _ = inner.out.send(reply);
                    continue;
                }
                write_lock(&inner.capability_calls).push((
                    method.clone(),
                    params.clone(),
                    meta.clone(),
                ));
                let reply = if requires_capability_call(&method) {
                    let expected = read_lock(&inner.active_token).clone();
                    let got = wire::capability_call_token(meta.as_ref());
                    if expected.is_none() || got.as_ref() != expected.as_ref() {
                        wire::error(
                            &id,
                            -32000,
                            "scoped capability requires an active owning call",
                            json!({"code": "capability_denied"}),
                        )
                    } else {
                        answer_capability(&inner, &id, &method, params).await
                    }
                } else {
                    answer_capability(&inner, &id, &method, params).await
                };
                let _ = inner.out.send(reply);
            }
            wire::Incoming::Notification { method, params } if method == "$/progress" => {
                if let Some(data) = params.get("data").cloned() {
                    write_lock(&inner.progress).push(data);
                }
            }
            wire::Incoming::Notification { method, params } => {
                write_lock(&inner.notifications).push((method, params));
            }
            wire::Incoming::Response { id, result } => {
                if let Some(tx) = lock(&inner.pending).remove(&id) {
                    let _ = tx.send(result.map_err(|e| PluginError {
                        code: e.code().to_owned(),
                        hint: e.hint().map(str::to_owned),
                        reason: e.reason().map(str::to_owned),
                        message: e.message,
                    }));
                }
            }
        }
    }
}

async fn answer_capability(inner: &Inner, id: &Value, method: &str, params: Value) -> String {
    let answer = read_lock(&inner.answers).get(method).cloned();
    match answer {
        Some(f) => match f(params).await {
            Ok(value) => wire::result(id, value),
            Err(e) => wire::error(id, -32000, &e.message, host_error_data(&e)),
        },
        None => wire::error(
            id,
            -32000,
            "capability denied",
            json!({"code": "capability_denied"}),
        ),
    }
}

async fn answer_result_chunk(inner: &Inner, id: &Value, params: Value) -> String {
    let answer = read_lock(&inner.answers).get("$/resultChunk").cloned();
    match answer {
        Some(f) => match f(params).await {
            Ok(v) => wire::result(id, v),
            Err(e) => wire::error(id, -32000, &e.message, host_error_data(&e)),
        },
        None => {
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let decoded = params
                .get("base64")
                .and_then(Value::as_str)
                .map(|b| js::base64::decode_lenient(b).len() as u64)
                .unwrap_or(0);
            wire::result(id, json!({"bytes": offset + decoded}))
        }
    }
}

impl Harness {
    /// Send `plugin.hello` with the given script and assert the plugin accepted
    /// it.
    pub async fn start(plugin: Plugin, hello: HelloSpec) -> Self {
        let (host_w, plugin_r) = tokio::io::duplex(1 << 16);
        let (plugin_w, host_r) = tokio::io::duplex(1 << 16);

        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let stop = CancellationToken::new();
        let writer_stop = stop.clone();
        let writer = tokio::spawn(async move {
            let mut w = host_w;
            loop {
                tokio::select! {
                    line = out_rx.recv() => match line {
                        Some(line) => {
                            if w.write_all(line.as_bytes()).await.is_err() {
                                break;
                            }
                            if w.flush().await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                    _ = writer_stop.cancelled() => break,
                }
            }
        });

        let inner = Arc::new(Inner {
            out,
            answers: RwLock::new(HashMap::new()),
            progress: RwLock::new(Vec::new()),
            notifications: RwLock::new(Vec::new()),
            capability_calls: RwLock::new(Vec::new()),
            chunks: RwLock::new(Vec::new()),
            hello: RwLock::new(None),
            active_token: RwLock::new(None),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });

        let plugin_task = tokio::spawn(plugin.serve(BufReader::new(plugin_r), plugin_w));

        let handshake = json!({
            "protocol": hello.protocol,
            "config": hello.config,
            "grants": hello.grants,
            "features": hello.features,
        });
        let _ = inner
            .out
            .send(wire::request("start", "plugin.hello", handshake));

        let mut lines = BufReader::new(host_r).lines();
        let mut acked = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await {
                Ok(Ok(Some(line))) => {
                    if let Some(wire::Incoming::Response {
                        result: Ok(value), ..
                    }) = wire::parse(&line)
                        && value.get("id").is_some()
                        && value.get("protocol").is_some()
                    {
                        *write_lock(&inner.hello) = Some(value);
                        acked = true;
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }
        assert!(acked, "plugin did not acknowledge plugin.hello");

        let rx_inner = inner.clone();
        let rx_task = tokio::spawn(listen(rx_inner, lines));

        Self {
            inner,
            rx_task,
            writer,
            plugin_task,
            stop,
        }
    }

    /// Register an answer for a capability method. A capability method with no
    /// registered answer is denied with `capability_denied`.
    pub fn on_capability<F>(&mut self, method: &str, f: F)
    where
        F: Fn(Value) -> Result<Value, (String, String)> + Send + Sync + 'static,
    {
        let f = Arc::new(f);
        write_lock(&self.inner.answers).insert(
            method.to_owned(),
            Arc::new(move |params| {
                let f = f.clone();
                Box::pin(async move { f(params).map_err(Into::into) })
            }),
        );
    }

    /// Register an asynchronous answer for a capability method, yielding a
    /// richer [`HostError`] (code / hint / reason).
    pub fn on_capability_async<F, Fut>(&mut self, method: &str, f: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, HostError>> + Send + 'static,
    {
        write_lock(&self.inner.answers)
            .insert(method.to_owned(), Arc::new(move |p| Box::pin(f(p))));
    }

    fn issue_token(&self) -> String {
        let token = format!(
            "harness-{}",
            self.inner.next.fetch_add(1, Ordering::Relaxed)
        );
        *write_lock(&self.inner.active_token) = Some(token.clone());
        token
    }

    fn send_request(
        &self,
        id: u64,
        method: &str,
        params: Value,
        meta: Option<&Value>,
        tx: oneshot::Sender<Result<Value, PluginError>>,
    ) -> Result<(), PluginError> {
        {
            let mut pending = lock(&self.inner.pending);
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            pending.insert(id.to_string(), tx);
        }
        let frame = wire::request_value_with_meta(&json!(id), method, params, meta);
        if self.inner.out.send(frame).is_err() {
            lock(&self.inner.pending).remove(&id.to_string());
            return Err(unavailable());
        }
        Ok(())
    }

    /// Invoke the plugin, answering any capability requests it makes while the
    /// call is in flight. Sends `_meta.capabilityCall` so scoped capabilities can succeed.
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, PluginError> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let token = self.issue_token();
        let meta = json!({ "capabilityCall": token });
        let (tx, rx) = oneshot::channel();
        self.send_request(id, method, params, Some(&meta), tx)?;
        let result = rx.await.unwrap_or_else(|_| Err(unavailable()));
        *write_lock(&self.inner.active_token) = None;
        result
    }

    /// Invoke the plugin without an owning-call `_meta` (no `capabilityCall`,
    /// matching a host that serves ambient requests).
    pub async fn call_unowned(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, PluginError> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.send_request(id, method, params, None, tx)?;
        rx.await.unwrap_or_else(|_| Err(unavailable()))
    }

    /// Start an owned call without waiting; returns the request id for [`Self::cancel`].
    pub fn start_call(&mut self, method: &str, params: Value) -> Result<String, PluginError> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let token = self.issue_token();
        let meta = json!({ "capabilityCall": token });
        let (tx, rx) = oneshot::channel();
        self.send_request(id, method, params, Some(&meta), tx)?;
        // Keep the receiver alive by parking it on a background task that drops
        // the result; cancellation tests only need the id.
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let _ = rx.await;
            *write_lock(&inner.active_token) = None;
        });
        Ok(id.to_string())
    }

    /// Send `$/cancel` for an in-flight call started with [`Self::call`] or [`Self::start_call`].
    pub fn cancel(&self, id: &str) {
        let _ = self
            .inner
            .out
            .send(wire::notification("$/cancel", json!({"id": id})));
    }

    /// The plugin's acknowledgement to `plugin.hello`.
    pub fn hello_result(&self) -> Option<Value> {
        read_lock(&self.inner.hello).clone()
    }

    /// The raw `$/resultChunk` requests the plugin made (offset / base64),
    /// in order, before any default reassembly.
    pub fn raw_results(&self) -> Vec<Value> {
        read_lock(&self.inner.chunks).clone()
    }

    /// The `$/progress` data the plugin has emitted so far.
    pub fn progress(&self) -> Vec<Value> {
        read_lock(&self.inner.progress).clone()
    }

    /// Plugin → host notifications other than `$/progress` (for example `assistant.delta`).
    pub fn notifications(&self) -> Vec<(String, Value)> {
        read_lock(&self.inner.notifications).clone()
    }

    /// The capability requests the plugin has made so far (method, params).
    pub fn capability_calls(&self) -> Vec<(String, Value)> {
        read_lock(&self.inner.capability_calls)
            .iter()
            .map(|(m, p, _)| (m.clone(), p.clone()))
            .collect()
    }

    /// Capability requests with their `_meta` (for asserting token echo).
    pub fn capability_calls_with_meta(&self) -> Vec<(String, Value, Option<Value>)> {
        read_lock(&self.inner.capability_calls).clone()
    }

    /// Stop the plugin: fail any in-flight calls, close the pipe to the plugin,
    /// and wait for it to shut down.
    pub async fn close(self) {
        self.inner.closed.store(true, Ordering::Release);
        {
            let mut pending = lock(&self.inner.pending);
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(unavailable()));
            }
        }
        let Harness {
            inner,
            rx_task,
            writer,
            plugin_task,
            stop,
        } = self;
        drop(inner);
        stop.cancel();
        let _ = writer.await;
        let _ = plugin_task.await;
        let _ = rx_task.await;
    }
}
