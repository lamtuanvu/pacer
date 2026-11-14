//! Owned plugin child transport. Calls may overlap: a reader task routes
//! responses by request id and plugin-to-host requests by `_meta.capabilityCall`,
//! and a writer task keeps every frame whole. Requests sent between calls, and
//! read-owner requests, go to the idle handler ([`PluginProcess::serve_idle`]),
//! never to a later call. A watcher task owns the child:
//! it alone reaps it, so a signal can never reach a reused pid, and it
//! publishes the exit reason the TypeScript registry would record.

use crate::plugin_log::{PluginLog, copy_stderr};
use pacer_plugin_host::{
    MAX_LINE_BYTES, ProcessError, ProcessFrame, SpawnSpec, frame, notification_frame, parse_frame,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    io,
    process::{ExitStatus, Stdio},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Notify, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

/// SIGTERM-to-SIGKILL grace, as the TypeScript transport's `terminate`.
pub const TERMINATE_GRACE: Duration = Duration::from_secs(2);

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
    /// Requests that arrived while no call was pending, or that name a read
    /// owner, before [`PluginProcess::serve_idle`] installed a handler. Only
    /// that handler or [`PluginProcess::handle_idle_request`] answers them,
    /// never a later call.
    idle: VecDeque<Incoming>,
    idle_handler: Option<mpsc::Sender<Incoming>>,
    closed: Option<String>,
}

impl Routes {
    fn idle(&mut self, request: Incoming) -> Result<bool, (Value, &'static str)> {
        let full = (
            request.id.clone(),
            "too many capability requests without a call",
        );
        let Some(handler) = &self.idle_handler else {
            if self.idle.len() >= QUEUED_IDLE {
                return Err(full);
            }
            self.idle.push_back(request);
            return Ok(true);
        };
        handler
            .try_send(request)
            .map(|()| false)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => full,
                mpsc::error::TrySendError::Closed(request) => (request.id, "plugin process closed"),
            })
    }
}

struct Shared {
    routes: StdMutex<Routes>,
    idle: Notify,
    /// Becomes true once the transport closed, whether or not the child exited.
    closed: watch::Sender<bool>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            routes: StdMutex::default(),
            idle: Notify::new(),
            closed: watch::Sender::new(false),
        }
    }
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
        // Before the calls' replies drop: a woken call must not find the
        // transport open, or it reports the closed stream instead of the exit.
        self.closed.send_replace(true);
        routes.calls.clear();
        routes.idle.clear();
        routes.idle_handler = None;
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
    /// the only pending call, or to the only untokened one when calls overlap.
    /// A request naming only a read owner, or one with no call pending, goes
    /// to the idle handler, whose generation alone can authorize it.
    fn route(&self, request: Incoming) -> Result<(), (Value, &'static str)> {
        let meta = request.metadata.as_ref();
        let token = meta
            .and_then(|meta| meta.get("capabilityCall"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let read_owner = meta.is_some_and(|meta| meta.get("readOwner").is_some());
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
            None if read_owner || routes.calls.is_empty() => {
                let queued = routes.idle(request)?;
                drop(routes);
                if queued {
                    self.idle.notify_one();
                }
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
/// Dropping the process aborts the watcher, whose child is `kill_on_drop`.
pub struct PluginProcess {
    pid: Option<u32>,
    writes: mpsc::Sender<Write>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    stops: mpsc::UnboundedSender<Stop>,
    exit: watch::Receiver<Option<String>>,
    stopping: AtomicBool,
    tasks: [JoinHandle<()>; 3],
    idle_task: StdMutex<Option<JoinHandle<()>>>,
}

impl Drop for PluginProcess {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        if let Some(task) = self
            .idle_task
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}

enum Stop {
    Term,
    Kill,
}

/// Reap the child and publish why it exited. Signals go through this task,
/// so they reach the child only while its pid is still unreaped.
async fn watch_child(
    mut child: Child,
    mut stops: mpsc::UnboundedReceiver<Stop>,
    exit: watch::Sender<Option<String>>,
) {
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            Some(stop) = stops.recv() => match stop {
                Stop::Term => {
                    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
                        let _ = nix::sys::signal::kill(
                            nix::unistd::Pid::from_raw(pid),
                            nix::sys::signal::Signal::SIGTERM,
                        );
                    }
                }
                Stop::Kill => {
                    let _ = child.start_kill();
                }
            },
        }
    };
    exit.send_replace(Some(exit_reason(status)));
}

/// The registry's crash reason: `exited with code N` or `exited on SIGNAME`.
fn exit_reason(status: io::Result<ExitStatus>) -> String {
    use std::os::unix::process::ExitStatusExt;
    let Ok(status) = status else {
        return "exited".into();
    };
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exited with code {code}"),
        (None, Some(signal)) => match nix::sys::signal::Signal::try_from(signal) {
            Ok(signal) => format!("exited on {}", signal.as_str()),
            Err(_) => format!("exited on signal {signal}"),
        },
        (None, None) => "exited".into(),
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
    /// A child whose stderr is discarded.
    pub fn spawn(spec: &SpawnSpec) -> Result<Self, ProcessError> {
        Self::spawn_logged(spec, None)
    }

    /// A child whose stderr lines go to `log`, or are discarded without one.
    pub(crate) fn spawn_logged(
        spec: &SpawnSpec,
        log: Option<PluginLog>,
    ) -> Result<Self, ProcessError> {
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
            .stderr(if log.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
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
        let (stops, stop_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit) = watch::channel(None);
        let pid = child.id();
        if let Some((stderr, log)) = child.stderr.take().zip(log) {
            // Not aborted with the process: a descendant that inherited stderr
            // can outlive the child, and the reader ends on its own.
            tokio::spawn(copy_stderr(stderr, log, exit.clone()));
        }
        let tasks = [
            tokio::spawn(write_frames(stdin, queued, shared.clone())),
            tokio::spawn(read_frames(stdout, shared.clone(), writes.clone())),
            tokio::spawn(watch_child(child, stop_rx, exit_tx)),
        ];
        Ok(Self {
            pid,
            writes,
            shared,
            next_id: AtomicU64::new(1),
            stops,
            exit,
            stopping: AtomicBool::new(false),
            tasks,
            idle_task: StdMutex::new(None),
        })
    }

    /// The child's pid until it has been reaped.
    pub fn pid(&self) -> Option<u32> {
        self.pid.filter(|_| self.exit_reason().is_none())
    }

    /// Why the child exited (`exited with code N`, `exited on SIGKILL`), once reaped.
    pub fn exit_reason(&self) -> Option<String> {
        self.exit.borrow().clone()
    }

    /// Observe the exit reason as it is published.
    pub fn exit_watch(&self) -> watch::Receiver<Option<String>> {
        self.exit.clone()
    }

    /// True once stdout or stdin closed; no further call can succeed.
    pub fn transport_closed(&self) -> bool {
        *self.shared.closed.borrow()
    }

    /// Observe the transport closing.
    pub fn closed_watch(&self) -> watch::Receiver<bool> {
        self.shared.closed.subscribe()
    }

    /// Neither exited nor cut off from its transport.
    pub fn is_alive(&self) -> bool {
        self.exit_reason().is_none() && !self.transport_closed()
    }

    /// True once [`Self::terminate`] began: the exit that follows is not a crash.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// SIGTERM without marking a stop, for a child whose transport is gone.
    pub fn term(&self) {
        let _ = self.stops.send(Stop::Term);
    }

    /// SIGKILL without marking a stop, for a child whose transport is gone.
    pub fn kill(&self) {
        let _ = self.stops.send(Stop::Kill);
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

    /// Answer, in order, every request [`Shared::route`] gives the idle
    /// handler from now on, and those already waiting. The first handler
    /// stays; a later install is ignored.
    pub fn serve_idle<F, Fut>(&self, mut handler: F)
    where
        F: FnMut(String, Value, Option<Value>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value, Value>> + Send + 'static,
    {
        let (requests, mut received) = mpsc::channel(QUEUED_IDLE);
        {
            let mut routes = self.shared.routes();
            if routes.closed.is_some() || routes.idle_handler.is_some() {
                return;
            }
            for waiting in routes.idle.drain(..) {
                let _ = requests.try_send(waiting);
            }
            routes.idle_handler = Some(requests);
        }
        let writes = self.writes.clone();
        let task = tokio::spawn(async move {
            while let Some(request) = received.recv().await {
                let reply = match handler(request.method, request.params, request.metadata).await {
                    Ok(result) => json!({"jsonrpc":"2.0","id":request.id,"result":result}),
                    Err(error) => json!({"jsonrpc":"2.0","id":request.id,"error":error}),
                };
                let bytes = frame(reply).or_else(|_| {
                    frame(json!({"jsonrpc":"2.0","id":request.id,
                        "error":rpc_error("too_large", "capability result exceeds transport frame".into())}))
                });
                if let Ok(bytes) = bytes
                    && writes.send((bytes, None)).await.is_err()
                {
                    return;
                }
            }
        });
        *self
            .idle_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
    }

    /// Bounded event delivery retains the caller's guard through pipe backpressure.
    /// The line is the TypeScript transport's: `JSON.stringify` in insertion order.
    pub async fn notify_bounded(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
        guard: impl Fn() -> Result<(), ProcessError>,
    ) -> Result<(), ProcessError> {
        guard()?;
        let bytes = notification_frame(method, &params)?;
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

    /// SIGTERM, then SIGKILL after [`TERMINATE_GRACE`]; returns once the child
    /// has been reaped. The exit is a stop, never reported as a crash.
    pub async fn terminate(&self) -> Result<(), ProcessError> {
        self.stopping.store(true, Ordering::SeqCst);
        let mut exit = self.exit.clone();
        if exit.borrow().is_some() {
            return Ok(());
        }
        let _ = self.stops.send(Stop::Term);
        if timeout(TERMINATE_GRACE, exit.wait_for(Option::is_some))
            .await
            .is_err()
        {
            self.kill();
        }
        exit.wait_for(Option::is_some)
            .await
            .map(|_| ())
            .map_err(|_| ProcessError::Unavailable("plugin process watcher stopped".into()))
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
