//! A scripted in-process host for exercising a [`Plugin`] inside tests.
//!
//! The [`Harness`] runs a plugin over two in-memory pipes (as the real host
//! would via stderr). Capability requests the plugin makes are answered from the
//! closures registered with [`Harness::on_capability`]; a capability with no
//! registered answer is denied with `capability_denied`, matching what the real
//! host returns for an ungranted capability.

use crate::{Plugin, PluginError, wire};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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

/// Parameters used to script `plugin.hello` when the harness starts a plugin.
pub struct HelloSpec {
    pub config: Value,
    pub grants: Vec<String>,
}

impl Default for HelloSpec {
    fn default() -> Self {
        Self {
            config: json!({}),
            grants: Vec::new(),
        }
    }
}

/// An answer installed for one capability method: params in, (value or error) out.
type Answer = Arc<dyn Fn(Value) -> Result<Value, (String, String)> + Send + Sync + 'static>;

fn unavailable() -> PluginError {
    PluginError::new("plugin_unavailable", "host closed the connection")
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

struct Inner {
    out: mpsc::UnboundedSender<String>,
    answers: RwLock<HashMap<String, Answer>>,
    progress: RwLock<Vec<Value>>,
    capability_calls: RwLock<Vec<(String, Value)>>,
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
            wire::Incoming::Request { id, method, params } => {
                write_lock(&inner.capability_calls).push((method.clone(), params.clone()));
                let answer = read_lock(&inner.answers).get(&method).cloned();
                let reply = match answer {
                    Some(f) => match f(params) {
                        Ok(value) => wire::result(&id, value),
                        Err((code, message)) => {
                            wire::error(&id, -32000, &message, json!({"code": code}))
                        }
                    },
                    None => wire::error(
                        &id,
                        -32000,
                        "capability denied",
                        json!({"code": "capability_denied"}),
                    ),
                };
                let _ = inner.out.send(reply);
            }
            wire::Incoming::Notification { method, params } if method == "$/progress" => {
                if let Some(data) = params.get("data").cloned() {
                    write_lock(&inner.progress).push(data);
                }
            }
            wire::Incoming::Response { id, result } => {
                if let Some(tx) = lock(&inner.pending).remove(&id) {
                    let _ = tx.send(result.map_err(|e| PluginError {
                        code: e.code().to_owned(),
                        hint: e.hint().map(str::to_owned),
                        message: e.message,
                    }));
                }
            }
            _ => {}
        }
    }
}

impl Harness {
    /// Send `plugin.hello` with the given script and assert the plugin accepted
    /// it (protocol version checked).
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
            capability_calls: RwLock::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });

        let plugin_task = tokio::spawn(plugin.serve(BufReader::new(plugin_r), plugin_w));

        let handshake = json!({
            "protocol": pacer_plugin_protocol::VERSION,
            "config": hello.config,
            "grants": hello.grants,
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
                        && value.get("protocol") == Some(&json!(pacer_plugin_protocol::VERSION))
                    {
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
        write_lock(&self.inner.answers).insert(method.to_owned(), Arc::new(f));
    }

    /// Invoke the plugin, answering any capability requests it makes while the
    /// call is in flight.
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, PluginError> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = lock(&self.inner.pending);
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            pending.insert(id.clone(), tx);
        }
        if self
            .inner
            .out
            .send(wire::request(&id, method, params))
            .is_err()
        {
            lock(&self.inner.pending).remove(&id);
            return Err(unavailable());
        }
        rx.await.unwrap_or_else(|_| Err(unavailable()))
    }

    /// The `$/progress` data the plugin has emitted so far.
    pub fn progress(&self) -> Vec<Value> {
        read_lock(&self.inner.progress).clone()
    }

    /// The capability requests the plugin has made so far.
    pub fn capability_calls(&self) -> Vec<(String, Value)> {
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
