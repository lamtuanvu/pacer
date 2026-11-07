use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, Notify, mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("plugin process is unavailable: {0}")]
    Unavailable(String),
    #[error("plugin frame exceeds 1 MiB")]
    TooLarge,
    #[error("plugin request timed out")]
    Timeout,
    #[error("plugin response is malformed")]
    Malformed,
    #[error("plugin request was cancelled")]
    Cancelled,
}

/// The caller supplies a complete, already sealed environment. No shell is used.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}

#[derive(Debug, PartialEq)]
pub enum ProcessFrame {
    Response {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
        metadata: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
}

pub fn frame(value: Value) -> Result<Vec<u8>, ProcessError> {
    let mut bytes = crate::js_canonical_json(&value)
        .map_err(|_| ProcessError::Malformed)?
        .into_bytes();
    bytes.push(b'\n');
    if bytes.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    Ok(bytes)
}

pub fn parse_frame(line: &[u8]) -> Result<ProcessFrame, ProcessError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ProcessError::TooLarge);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| ProcessError::Malformed)?;
    let object = value.as_object().ok_or(ProcessError::Malformed)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(ProcessError::Malformed);
    }
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        return Ok(match object.get("id") {
            Some(id) if !id.is_null() => ProcessFrame::Request {
                id: id.clone(),
                method: method.into(),
                params,
                metadata: object.get("_meta").cloned(),
            },
            _ => ProcessFrame::Notification {
                method: method.into(),
                params,
            },
        });
    }
    let id = object
        .get("id")
        .and_then(crate::js_semantics::safe_u64)
        .ok_or(ProcessError::Malformed)?;
    if let Some(error) = object.get("error") {
        return Ok(ProcessFrame::Error {
            id,
            error: error.clone(),
        });
    }
    Ok(ProcessFrame::Response {
        id,
        result: object
            .get("result")
            .cloned()
            .ok_or(ProcessError::Malformed)?,
    })
}

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

/// A plugin-to-host request waiting for the call that owns it.
struct Incoming {
    id: Value,
    method: String,
    params: Value,
    metadata: Option<Value>,
}

enum Inbound {
    Reply(Result<Value, Value>),
    Request(Incoming),
}

struct Route {
    token: Option<String>,
    inbound: mpsc::UnboundedSender<Inbound>,
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
        if let Some(route) = self.routes().calls.get(&id) {
            let _ = route.inbound.send(Inbound::Reply(reply));
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
            .inbound
            .send(Inbound::Request(request))
            .map_err(|mpsc::error::SendError(inbound)| match inbound {
                Inbound::Request(request) => (request.id, "owning plugin call ended"),
                Inbound::Reply(_) => (Value::Null, "owning plugin call ended"),
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
    writes: mpsc::UnboundedSender<Write>,
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
    mut writes: mpsc::UnboundedReceiver<Write>,
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

async fn read_frames(
    stdout: ChildStdout,
    shared: Arc<Shared>,
    writes: mpsc::UnboundedSender<Write>,
) {
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
                    let _ = writes.send((bytes, None));
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
        let (writes, queued) = mpsc::unbounded_channel();
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

    fn send(&self, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.writes
            .send((bytes, None))
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
        let (inbound, mut received) = mpsc::unbounded_channel();
        {
            let mut routes = self.shared.routes();
            if let Some(reason) = &routes.closed {
                return Err(ProcessError::Unavailable(reason.clone()));
            }
            if routes.calls.is_empty() {
                for waiting in routes.idle.drain(..) {
                    let _ = inbound.send(Inbound::Request(waiting));
                }
            }
            routes.calls.insert(id, Route { token, inbound });
        }
        let _route = RouteGuard {
            shared: &self.shared,
            id,
        };
        let expires = Instant::now() + deadline;
        let exchange = async {
            self.send(request)?;
            loop {
                let request = match received.recv().await {
                    None => return Err(self.shared.closed()),
                    Some(Inbound::Reply(Ok(result))) => return Ok(result),
                    Some(Inbound::Reply(Err(error))) => {
                        return Err(ProcessError::Unavailable(error.to_string()));
                    }
                    Some(Inbound::Request(request)) => request,
                };
                let reply = match handler(request.method, request.params, request.metadata).await {
                    Ok(result) => json!({"jsonrpc":"2.0","id":request.id,"result":result}),
                    Err(error) => json!({"jsonrpc":"2.0","id":request.id,"error":error}),
                };
                self.send(frame(reply)?)?;
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
            let _ = self.send(frame(
                json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":id}}),
            )?);
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
            self.send(frame(reply)?)?;
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
        self.writes
            .send((bytes, Some(ack)))
            .map_err(|_| self.shared.closed())?;
        timeout(deadline, written)
            .await
            .map_err(|_| ProcessError::Timeout)?
            .map_err(|_| self.shared.closed())??;
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
