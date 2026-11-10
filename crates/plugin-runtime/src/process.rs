//! Owned plugin child transport. Calls may overlap: a reader task routes
//! responses by request id and plugin-to-host requests by `_meta.capabilityCall`,
//! and a writer task keeps every frame whole.

use pacer_plugin_host::{
    MAX_LINE_BYTES, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, Notify, mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

async fn read_line_bounded(
    stream: &mut (impl AsyncRead + Unpin),
    line: &mut Vec<u8>,
    dropping: &mut bool,
) -> Result<Vec<u8>, ProcessError> {
    let mut byte = [0];
    loop {
        match stream.read(&mut byte).await {
            Ok(0) if line.is_empty() && !*dropping => {
                return Err(ProcessError::Unavailable("stdout closed".into()));
            }
            Ok(0) if *dropping => {
                *dropping = false;
                return Err(ProcessError::TooLarge);
            }
            Ok(0) => return Ok(std::mem::take(line)),
            Ok(_) if byte[0] == b'\n' => {
                if *dropping {
                    *dropping = false;
                    return Err(ProcessError::TooLarge);
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(std::mem::take(line));
            }
            Ok(_) if !*dropping => {
                line.push(byte[0]);
                if line.len() > MAX_LINE_BYTES {
                    line.clear();
                    *dropping = true;
                }
            }
            Ok(_) => {}
            Err(error) => return Err(ProcessError::Unavailable(error.to_string())),
        }
    }
}

/// Frames waiting for the child's stdin. A full queue holds callers back the way
/// a full pipe did; the reader drops a refusal it cannot queue.
const QUEUED_WRITES: usize = 64;
/// Plugin-to-host requests one call has not answered yet; more are refused.
const QUEUED_REQUESTS: usize = 16;
/// Requests that arrived with no call pending; more are refused.
const QUEUED_IDLE: usize = 16;

/// A plugin-to-host request waiting for the call that owns it.
struct Incoming {
    id: Value,
    method: String,
    params: Value,
    metadata: Option<Value>,
}

struct Route {
    token: Option<String>,
    reply: Option<oneshot::Sender<Result<Value, Value>>>,
    requests: mpsc::Sender<Incoming>,
}

#[derive(Default)]
struct Routes {
    calls: HashMap<u64, Route>,
    /// Requests that arrived while no call was pending. The next call, or
    /// [`PluginProcess::handle_idle_request`], answers them in order.
    idle: VecDeque<Incoming>,
    closed: Option<String>,
}

#[derive(Default)]
struct Shared {
    routes: StdMutex<Routes>,
    idle: Notify,
}

impl Shared {
    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        self.routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn close(&self, reason: &str) {
        let mut routes = self.routes();
        routes.closed.get_or_insert_with(|| reason.to_owned());
        routes.calls.clear();
        routes.idle.clear();
        drop(routes);
        self.idle.notify_one();
    }

    fn closed(&self) -> ProcessError {
        let reason = self.routes().closed.clone();
        ProcessError::Unavailable(reason.unwrap_or_else(|| "stdout closed".into()))
    }

    fn reply(&self, id: u64, reply: Result<Value, Value>) {
        let sender = self
            .routes()
            .calls
            .get_mut(&id)
            .and_then(|route| route.reply.take());
        if let Some(sender) = sender {
            let _ = sender.send(reply);
        }
    }

    /// A request echoing a call's `_meta.capabilityCall` goes to that call. A
    /// call sent without a token owns every request while it is the only call;
    /// its handler judges the request's metadata. An untokened request goes to
    /// the only pending call, or to the only untokened one when calls overlap;
    /// with no call pending it waits for the next one.
    fn route(&self, request: Incoming) -> Result<(), (Value, &'static str)> {
        let token = request
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("capabilityCall"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut routes = self.routes();
        let alone = (routes.calls.len() == 1)
            .then(|| routes.calls.values().next())
            .flatten();
        let owner = match token {
            Some(token) => routes
                .calls
                .values()
                .find(|route| route.token.as_deref() == Some(token.as_str()))
                .or(alone.filter(|route| route.token.is_none())),
            None if routes.calls.is_empty() => {
                if routes.idle.len() >= QUEUED_IDLE {
                    return Err((request.id, "too many capability requests without a call"));
                }
                routes.idle.push_back(request);
                drop(routes);
                self.idle.notify_one();
                return Ok(());
            }
            None if routes.calls.len() == 1 => routes.calls.values().next(),
            None => {
                let mut untokened = routes.calls.values().filter(|route| route.token.is_none());
                untokened.next().filter(|_| untokened.next().is_none())
            }
        };
        let Some(owner) = owner else {
            return Err((request.id, "capability request has no active owning call"));
        };
        owner
            .requests
            .try_send(request)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(request) => (
                    request.id,
                    "too many pending capability requests for this call",
                ),
                mpsc::error::TrySendError::Closed(request) => {
                    (request.id, "owning plugin call ended")
                }
            })
    }
}

/// Removes a call's route however the call ends.
struct RouteGuard<'a> {
    shared: &'a Shared,
    id: u64,
}

impl Drop for RouteGuard<'_> {
    fn drop(&mut self) {
        self.shared.routes().calls.remove(&self.id);
    }
}

type Write = (Vec<u8>, Option<oneshot::Sender<Result<(), ProcessError>>>);

/// One owned child. Calls may overlap: a reader task routes responses by request
/// id and plugin-to-host requests by `_meta.capabilityCall`, and a writer task
/// keeps every frame whole, so a call that gives up never cuts another's frame.
pub struct PluginProcess {
    child: AsyncMutex<Child>,
    pid: Option<u32>,
    writes: mpsc::Sender<Write>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    tasks: [JoinHandle<()>; 2],
}

impl Drop for PluginProcess {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn write_frames(
    mut stdin: ChildStdin,
    mut writes: mpsc::Receiver<Write>,
    shared: Arc<Shared>,
) {
    while let Some((bytes, ack)) = writes.recv().await {
        let written = stdin
            .write_all(&bytes)
            .await
            .map_err(|error| ProcessError::Unavailable(error.to_string()));
        let failed = written.as_ref().err().map(ToString::to_string);
        if let Some(ack) = ack {
            let _ = ack.send(written);
        }
        if let Some(reason) = failed {
            shared.close(&reason);
            return;
        }
    }
}

async fn read_frames(stdout: ChildStdout, shared: Arc<Shared>, writes: mpsc::Sender<Write>) {
    let mut stdout = BufReader::new(stdout);
    let (mut line, mut dropping) = (Vec::new(), false);
    loop {
        let bytes = match read_line_bounded(&mut stdout, &mut line, &mut dropping).await {
            Ok(bytes) => bytes,
            Err(ProcessError::TooLarge) => continue,
            Err(ProcessError::Unavailable(reason)) => return shared.close(&reason),
            Err(error) => return shared.close(&error.to_string()),
        };
        match parse_frame(&bytes) {
            Ok(ProcessFrame::Response { id, result }) => shared.reply(id, Ok(result)),
            Ok(ProcessFrame::Error { id, error }) => shared.reply(id, Err(error)),
            Ok(ProcessFrame::Request {
                id,
                method,
                params,
                metadata,
            }) => {
                let request = Incoming {
                    id,
                    method,
                    params,
                    metadata,
                };
                if let Err((id, message)) = shared.route(request)
                    && let Ok(bytes) = frame(json!({"jsonrpc":"2.0","id":id,
                        "error":rpc_error("capability_denied", message.into())}))
                {
                    let _ = writes.try_send((bytes, None));
                }
            }
            Ok(ProcessFrame::Notification { .. }) | Err(_) => {}
        }
    }
}

impl PluginProcess {
    pub fn spawn(spec: &SpawnSpec) -> Result<Self, ProcessError> {
        let (program, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| ProcessError::Unavailable("empty argv".into()))?;
        let mut child = Command::new(program);
        child
            .args(args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = child
            .spawn()
            .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProcessError::Unavailable("stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProcessError::Unavailable("stdout unavailable".into()))?;
        let shared = Arc::new(Shared::default());
        let (writes, queued) = mpsc::channel(QUEUED_WRITES);
        let tasks = [
            tokio::spawn(write_frames(stdin, queued, shared.clone())),
            tokio::spawn(read_frames(stdout, shared.clone(), writes.clone())),
        ];
        Ok(Self {
            pid: child.id(),
            child: AsyncMutex::new(child),
            writes,
            shared,
            next_id: AtomicU64::new(1),
            tasks,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        match self.child.try_lock() {
            Ok(child) => child.id(),
            Err(_) => self.pid,
        }
    }

    async fn send(&self, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.writes
            .send((bytes, None))
            .await
            .map_err(|_| self.shared.closed())
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> Result<Value, ProcessError> {
        self.request_with_handler(
            method,
            params,
            deadline,
            cancel,
            |method, _, _| async move {
                let (code, message) = if known_capability(&method) {
                    ("capability_denied", "capability is not granted")
                } else {
                    ("unknown_op", "unknown host method")
                };
                Err(rpc_error(code, format!("{message}: {method}")))
            },
        )
        .await
    }

    /// The handler runs for plugin-to-host requests while the parent call is pending.
    /// It must return a JSON-RPC error object for refused capabilities.
    pub async fn request_with_handler<F, Fut>(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
        cancel: Option<&tokio::sync::watch::Receiver<bool>>,
        handler: F,
    ) -> Result<Value, ProcessError>
    where
        F: FnMut(String, Value, Option<Value>) -> Fut,
        Fut: Future<Output = Result<Value, Value>>,
    {
        self.request_with_metadata(method, params, None, deadline, cancel, handler)
            .await
    }

    /// `metadata.capabilityCall`, when present, is the token the child echoes on
    /// the capability requests that belong to this call.
    pub async fn request_with_metadata<F, Fut>(
        &self,
        method: &str,
        params: Value,
        metadata: Option<Value>,
        deadline: Duration,
        cancel: Option<&tokio::sync::watch::Receiver<bool>>,
        mut handler: F,
    ) -> Result<Value, ProcessError>
    where
        F: FnMut(String, Value, Option<Value>) -> Fut,
        Fut: Future<Output = Result<Value, Value>>,
    {
        if cancel.is_some_and(|signal| *signal.borrow()) {
            return Err(ProcessError::Cancelled);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let token = metadata
            .as_ref()
            .and_then(|meta| meta.get("capabilityCall"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut envelope = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        if let Some(metadata) = metadata {
            envelope["_meta"] = metadata;
        }
        let request = frame(envelope)?;
        let (reply, mut replied) = oneshot::channel();
        let (requests, mut received) = mpsc::channel(QUEUED_REQUESTS);
        {
            let mut routes = self.shared.routes();
            if let Some(reason) = &routes.closed {
                return Err(ProcessError::Unavailable(reason.clone()));
            }
            if routes.calls.is_empty() {
                for waiting in routes.idle.drain(..) {
                    let _ = requests.try_send(waiting);
                }
            }
            let route = Route {
                token: token.clone(),
                reply: Some(reply),
                requests,
            };
            routes.calls.insert(id, route);
        }
        let _route = RouteGuard {
            shared: &self.shared,
            id,
        };
        let expires = Instant::now() + deadline;
        let exchange = async {
            self.send(request).await?;
            let mut open = true;
            let mut transfer_started = false;
            loop {
                // Requests the child sent before its reply are answered first.
                let request = tokio::select! {
                    biased;
                    request = received.recv(), if open => match request {
                        Some(request) => request,
                        None => {
                            open = false;
                            continue;
                        }
                    },
                    reply = &mut replied => return match reply {
                        Ok(Ok(result)) if transfer_started && result.get("_chunkedResult").is_none() =>
                            Err(ProcessError::OwnerRefused(rpc_error("plugin_refused", "incomplete or unnegotiated chunked result".into()).to_string())),
                        Ok(Ok(result)) => Ok(result),
                        Ok(Err(error)) => Err(ProcessError::Unavailable(error.to_string())),
                        Err(_) => Err(self.shared.closed()),
                    },
                };
                let chunk = request.method == "$/resultChunk";
                // Stale/unsolicited chunks do not start or fail the current transfer.
                if chunk
                    && (request
                        .params
                        .get("request")
                        .filter(|owner| owner.is_number())
                        .is_some_and(|owner| owner != &json!(id))
                        || token.as_deref()
                            != request
                                .metadata
                                .as_ref()
                                .and_then(|meta| meta.get("capabilityCall"))
                                .and_then(Value::as_str))
                {
                    self.send(frame(json!({"jsonrpc":"2.0","id":request.id,"error":rpc_error("capability_denied", "result chunk does not belong to an active negotiated request".into())}))?).await?;
                    continue;
                }
                // Admission is visible before the handler can await staging in Core.
                transfer_started |= chunk;
                let result = handler(request.method, request.params, request.metadata).await;
                let failure = if chunk {
                    result.as_ref().err().cloned()
                } else {
                    None
                };
                let reply = match result {
                    Ok(result) => json!({"jsonrpc":"2.0","id":request.id,"result":result}),
                    Err(error) => json!({"jsonrpc":"2.0","id":request.id,"error":error}),
                };
                self.send(frame(reply)?).await?;
                if let Some(error) = failure {
                    return Err(ProcessError::OwnerRefused(error.to_string()));
                }
            }
        };
        let outcome = if let Some(cancel) = cancel {
            let mut cancel = cancel.clone();
            tokio::select! {
                result = timeout_at(expires, exchange) => result.unwrap_or(Err(ProcessError::Timeout)),
                _ = cancel.changed() => Err(ProcessError::Cancelled),
            }
        } else {
            timeout_at(expires, exchange)
                .await
                .unwrap_or(Err(ProcessError::Timeout))
        };
        if matches!(
            outcome,
            Err(ProcessError::Timeout | ProcessError::Cancelled)
        ) {
            let cancel = frame(json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":id}}))?;
            let _ = timeout(Duration::from_millis(100), self.send(cancel)).await;
        }
        outcome
    }

    /// Answer one plugin-to-host request that arrived while no call was pending.
    /// The generation owner must reject effect RPCs.
    pub async fn handle_idle_request<F, Fut>(
        &self,
        deadline: Duration,
        mut handler: F,
    ) -> Result<bool, ProcessError>
    where
        F: FnMut(String, Value, Option<Value>) -> Fut,
        Fut: Future<Output = Result<Value, Value>>,
    {
        timeout(deadline, async {
            let request = loop {
                {
                    let mut routes = self.shared.routes();
                    if let Some(request) = routes.idle.pop_front() {
                        break request;
                    }
                    if let Some(reason) = &routes.closed {
                        return Err(ProcessError::Unavailable(reason.clone()));
                    }
                }
                self.shared.idle.notified().await;
            };
            let reply = match handler(request.method, request.params, request.metadata).await {
                Ok(result) => json!({"jsonrpc":"2.0","id":request.id,"result":result}),
                Err(error) => json!({"jsonrpc":"2.0","id":request.id,"error":error}),
            };
            self.send(frame(reply)?).await?;
            Ok(true)
        })
        .await
        .unwrap_or(Err(ProcessError::Timeout))
    }

    /// Bounded event delivery retains the caller's guard through pipe backpressure.
    pub async fn notify_bounded(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
        guard: impl Fn() -> Result<(), ProcessError>,
    ) -> Result<(), ProcessError> {
        guard()?;
        let bytes = frame(json!({"jsonrpc":"2.0","method":method,"params":params}))?;
        let (ack, written) = oneshot::channel();
        timeout(deadline, async {
            self.writes
                .send((bytes, Some(ack)))
                .await
                .map_err(|_| self.shared.closed())?;
            written.await.map_err(|_| self.shared.closed())?
        })
        .await
        .map_err(|_| ProcessError::Timeout)??;
        guard()
    }

    pub async fn terminate(&self) -> Result<(), ProcessError> {
        let mut child = self.child.lock().await;
        if child
            .try_wait()
            .map_err(|error| ProcessError::Unavailable(error.to_string()))?
            .is_some()
        {
            return Ok(());
        }
        // Rust owns this child. The two-second grace mirrors the TypeScript transport.
        #[cfg(unix)]
        {
            let pid = child
                .id()
                .ok_or_else(|| ProcessError::Unavailable("missing pid".into()))?;
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()
                .await;
        }
        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            child
                .start_kill()
                .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
            child
                .wait()
                .await
                .map_err(|error| ProcessError::Unavailable(error.to_string()))?;
        }
        Ok(())
    }
}

fn rpc_error(code: &str, message: String) -> Value {
    json!({"code": if code == "unknown_op" { -32601 } else { -32000 },
        "message": message, "data": {"code": code}})
}

fn known_capability(method: &str) -> bool {
    let Some(name) = method.strip_prefix("capability.") else {
        return false;
    };
    [
        "tasks.read",
        "events.subscribe",
        "process.spawn",
        "fs.read",
        "net.http",
        "secrets.resolve",
        "config.get",
        "entitlement.report",
        "log",
        "identity.sign",
        "net.p2p",
        "fs.write",
        "worktree",
        "usage.state",
        "hosts",
        "orca",
    ]
    .iter()
    .any(|capability| name == *capability || name.starts_with(&format!("{capability}.")))
}

#[cfg(test)]
mod tests;
