//! Reverse-bridge Unix listener (X1c / P4d-1 / P4d-2).
//!
//! Binds `$PACER_HOME/run/host.sock` (dir 0700, socket 0600), accepts line
//! JSON-RPC for `_host.plugin.call` / `_host.plugin.find`, and authorizes peers
//! by Unix credentials. Default serve must not call [`ReverseBridge::bind`] or
//! export [`crate::HOST_SOCKET_ENV`] unless flag wiring is explicitly enabled
//! (`PACER_NATIVE_PLUGIN_HOST` and/or [`crate::HOST_BRIDGE_ENABLE_ENV`]). This
//! module never binds TCP.
//!
//! Without a live [`SharedOwner`], call/find/spawn/stop stay dark stubs.
//! Flag-on serve attaches the owner so handlers reach tracked
//! [`crate::PluginProcess`] children (P4d-2 / P4d-4). A `_host.plugin.call`
//! carrying `spawn` is a Core-sealed call (`crate::bridge_call`): the owner
//! starts, hellos and authorizes the child before calling it.

use crate::bridge_call::{SealedCall, call_sealed};
use crate::capability::{CoreForward, CoreRequest};
use crate::host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND,
    METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP, dark_bridge_enabled, prepare_host_run_dir,
};
use crate::owner::ProcessOwner;
use pacer_plugin_host::SpawnSpec;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs, io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, mpsc, oneshot, watch},
};

/// Soft cap matching the plugin process frame budget (1 MiB).
pub const BRIDGE_MAX_LINE_BYTES: usize = 1024 * 1024;

const METHOD_NOT_FOUND: i64 = -32601;
const UNAUTHORIZED: i64 = -32001;
const INVALID_REQUEST: i64 = -32600;
const INVALID_PARAMS: i64 = -32602;
const PLUGIN_UNAVAILABLE: i64 = -32002;

const DEFAULT_CALL_DEADLINE: Duration = Duration::from_secs(30);

/// Shared serve-owned process map for live bridge RPC.
pub type SharedOwner = Arc<Mutex<ProcessOwner>>;

/// How `_host.plugin.*` is answered on an accepted connection.
#[derive(Clone)]
pub enum BridgeDispatch {
    /// Dark stub: ownership not activated (library / pre-owner bind).
    Stub,
    /// Live call/find against children under the shared owner.
    Live(SharedOwner),
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("reverse-bridge dark wiring is disabled (set {HOST_BRIDGE_ENABLE_ENV}=1)")]
    DarkWiringDisabled,
    #[error("live reverse-bridge socket already present at {0}")]
    LiveSocket(PathBuf),
    #[error("peer credentials unavailable")]
    PeerCredUnavailable,
    #[error("untrusted reverse-bridge caller")]
    UntrustedCaller,
    #[error("reverse-bridge frame exceeds 1 MiB")]
    TooLarge,
    #[error("reverse-bridge frame is malformed")]
    Malformed,
}

/// Peer authorization policy for accepted Unix connections.
#[derive(Clone, Debug)]
pub struct PeerAuth {
    /// Only this uid may speak on the bridge. Defaults to the process uid.
    pub allowed_uid: u32,
}

impl PeerAuth {
    pub fn same_uid() -> Self {
        Self {
            allowed_uid: current_uid(),
        }
    }

    /// Test helper: reject every real peer (allowed uid never matches).
    pub fn deny_all_for_tests() -> Self {
        let uid = current_uid();
        Self {
            allowed_uid: if uid == 0 { 1 } else { 0 },
        }
    }
}

impl Default for PeerAuth {
    fn default() -> Self {
        Self::same_uid()
    }
}

/// Bound private reverse-bridge listener. Does not set [`HOST_SOCKET_ENV`].
///
/// Holds a std listener so [`Self::bind`] works outside a Tokio runtime; the
/// listener is moved onto Tokio inside [`Self::run`].
pub struct ReverseBridge {
    listener: StdUnixListener,
    path: PathBuf,
    auth: PeerAuth,
    dispatch: BridgeDispatch,
}

/// Background accept loop with graceful shutdown.
pub struct BridgeHandle {
    path: PathBuf,
    shutdown: watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
}

impl ReverseBridge {
    /// Bind `$PACER_HOME/run/host.sock` after ensuring the run directory is 0700.
    ///
    /// Does **not** export `PACER_HOST_SOCKET`. Callers that need Core to dial
    /// must use [`Self::dark_core_env`] under the enable flag. Starts in
    /// [`BridgeDispatch::Stub`] until [`Self::with_live_owner`].
    pub fn bind(pacer_home: &Path) -> Result<Self, BridgeError> {
        Self::bind_with_auth(pacer_home, PeerAuth::same_uid())
    }

    pub fn bind_with_auth(pacer_home: &Path, auth: PeerAuth) -> Result<Self, BridgeError> {
        let path = prepare_host_run_dir(pacer_home)?;
        remove_stale_socket(&path)?;
        let listener = bind_private(&path)?;
        Ok(Self {
            listener,
            path,
            auth,
            dispatch: BridgeDispatch::Stub,
        })
    }

    /// Attach a serve-owned [`ProcessOwner`] so call/find hit live children.
    pub fn with_live_owner(mut self, owner: SharedOwner) -> Self {
        self.dispatch = BridgeDispatch::Live(owner);
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn auth(&self) -> &PeerAuth {
        &self.auth
    }

    pub fn dispatch(&self) -> &BridgeDispatch {
        &self.dispatch
    }

    /// Socket file mode bits (expects 0600).
    pub fn socket_mode(&self) -> io::Result<u32> {
        let meta = fs::symlink_metadata(&self.path)?;
        Ok(meta.mode() & 0o777)
    }

    /// Env pairs for a Core child under explicit dark wiring only.
    ///
    /// Reads [`HOST_BRIDGE_ENABLE_ENV`] from the process environment. Prefer
    /// [`Self::dark_core_env_if`] in tests so the process env stays untouched.
    /// Never mutates the process env.
    pub fn dark_core_env(&self) -> Result<Vec<(String, String)>, BridgeError> {
        self.dark_core_env_if(std::env::var(HOST_BRIDGE_ENABLE_ENV).ok().as_deref())
    }

    /// Same as [`Self::dark_core_env`] with an injected enable-flag value.
    pub fn dark_core_env_if(
        &self,
        enable_flag: Option<&str>,
    ) -> Result<Vec<(String, String)>, BridgeError> {
        if !dark_bridge_enabled(enable_flag) {
            return Err(BridgeError::DarkWiringDisabled);
        }
        Ok(vec![(
            HOST_SOCKET_ENV.to_string(),
            self.path.display().to_string(),
        )])
    }

    /// Spawn the accept loop. Dropping via [`BridgeHandle::shutdown`] unlinks
    /// the socket when this process still owns the path.
    pub fn spawn(self) -> BridgeHandle {
        let path = self.path.clone();
        let (shutdown, rx) = watch::channel(false);
        let join = tokio::spawn(async move {
            let _ = self.run(rx).await;
        });
        BridgeHandle {
            path,
            shutdown,
            join,
        }
    }

    /// Accept connections until `shutdown` becomes true.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), BridgeError> {
        self.listener.set_nonblocking(true)?;
        let listener = UnixListener::from_std(self.listener)?;
        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let (stream, _) = accepted?;
                    let auth = self.auth.clone();
                    let dispatch = self.dispatch.clone();
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, auth, dispatch).await;
                    });
                }
            }
        }
        Ok(())
    }
}

impl BridgeHandle {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.join.await;
        let _ = fs::remove_file(&self.path);
    }
}

fn current_uid() -> u32 {
    nix::unistd::getuid().as_raw()
}

fn bind_private(path: &Path) -> io::Result<StdUnixListener> {
    use nix::sys::stat::{Mode, umask};
    static BIND: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = BIND
        .lock()
        .map_err(|_| io::Error::other("reverse-bridge bind lock poisoned"))?;
    struct Restore(Mode);
    impl Drop for Restore {
        fn drop(&mut self) {
            umask(self.0);
        }
    }
    // Restrict at creation; never chmod a pathname that could have been redirected.
    let _mask = Restore(umask(Mode::from_bits_truncate(0o177)));
    StdUnixListener::bind(path)
}

fn remove_stale_socket(path: &Path) -> Result<(), BridgeError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(meta) => {
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "host.sock path exists and is not a socket",
                )
                .into());
            }
            match StdUnixStream::connect(path) {
                Ok(_) => Err(BridgeError::LiveSocket(path.to_path_buf())),
                Err(_) => {
                    fs::remove_file(path)?;
                    Ok(())
                }
            }
        }
    }
}

fn peer_uid(stream: &UnixStream) -> Result<u32, BridgeError> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
        getsockopt(stream, PeerCredentials)
            .map(|cred| cred.uid())
            .map_err(|_| BridgeError::PeerCredUnavailable)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        nix::unistd::getpeereid(stream)
            .map(|(uid, _)| uid.as_raw())
            .map_err(|_| BridgeError::PeerCredUnavailable)
    }
}

fn authorize(stream: &UnixStream, auth: &PeerAuth) -> Result<(), BridgeError> {
    if peer_uid(stream)? != auth.allowed_uid {
        return Err(BridgeError::UntrustedCaller);
    }
    Ok(())
}

async fn handle_connection(
    stream: UnixStream,
    auth: PeerAuth,
    dispatch: BridgeDispatch,
) -> Result<(), BridgeError> {
    if let Err(error) = authorize(&stream, &auth) {
        let mut stream = stream;
        let _ = write_error(&mut stream, Value::Null, UNAUTHORIZED, "unauthorized").await;
        return Err(error);
    }
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 {
            break;
        }
        if line.len() > BRIDGE_MAX_LINE_BYTES {
            let mut stream = reader.into_inner();
            let _ = write_error(&mut stream, Value::Null, INVALID_REQUEST, "frame too large").await;
            return Err(BridgeError::TooLarge);
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        let (cancel, cancelled) = watch::channel(false);
        let (forward, mut forwarded) = mpsc::channel::<CoreRequest>(1);
        let work = response_for_line(&line, &dispatch, &cancelled, forward);
        tokio::pin!(work);
        // One forwarded request at a time; Core answers it before anything else.
        let mut pending: Option<(Value, oneshot::Sender<Result<Value, Value>>)> = None;
        let mut forwarded_count = 0_u64;
        let mut reply_line = Vec::new();
        let mut pipelined = false;
        let response = loop {
            let event = if pending.is_some() {
                tokio::select! {
                    response = &mut work => Turn::Done(response),
                    read = reader.read_until(b'\n', &mut reply_line) => Turn::Read(read),
                }
            } else {
                tokio::select! {
                    response = &mut work => Turn::Done(response),
                    Some(request) = forwarded.recv() => Turn::Forward(request),
                    closed = peer_closed(&mut reader), if !pipelined => Turn::Peer(closed),
                }
            };
            match event {
                Turn::Done(response) => break Some(response),
                Turn::Peer(false) => pipelined = true,
                Turn::Peer(true) | Turn::Read(Ok(0) | Err(_)) => {
                    let _ = cancel.send(true);
                    drop(pending.take());
                    work.await;
                    break None;
                }
                Turn::Forward((method, params, reply)) => {
                    forwarded_count += 1;
                    let request_id = json!(format!("core-{forwarded_count}"));
                    let frame = json!({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params});
                    match write_raw(reader.get_mut(), &frame).await {
                        Ok(()) => pending = Some((request_id, reply)),
                        Err(BridgeError::TooLarge) => {
                            let _ = reply.send(Err(core_failure(
                                "too_large",
                                "capability request exceeds the 1 MiB bridge frame",
                            )));
                        }
                        Err(_) => {
                            let _ = cancel.send(true);
                            work.await;
                            break None;
                        }
                    }
                }
                Turn::Read(Ok(_)) => {
                    if reply_line.len() > BRIDGE_MAX_LINE_BYTES || reply_line.last() != Some(&b'\n')
                    {
                        let _ = cancel.send(true);
                        drop(pending.take());
                        work.await;
                        break None;
                    }
                    let frame = std::mem::take(&mut reply_line);
                    if let Some((request_id, reply)) = pending.take() {
                        let _ = reply.send(core_reply(&frame, &request_id));
                    }
                }
            }
        };
        let Some(response) = response else {
            break;
        };
        let stream = reader.get_mut();
        write_raw(stream, &response).await?;
    }
    Ok(())
}

enum Turn {
    Done(Value),
    Forward(CoreRequest),
    Peer(bool),
    Read(io::Result<usize>),
}

fn core_failure(code: &str, message: &str) -> Value {
    json!({"code": -32000, "message": message, "data": {"code": code}})
}

/// Core's reply to a forwarded capability request, as the plugin should see it.
fn core_reply(frame: &[u8], request_id: &Value) -> Result<Value, Value> {
    let reply = serde_json::from_slice::<Value>(frame)
        .ok()
        .filter(|reply| reply.get("id") == Some(request_id));
    match reply {
        Some(mut reply) => match reply.get_mut("error").map(Value::take) {
            Some(error) if error.is_object() => Err(error),
            Some(_) => Err(core_failure(
                "plugin_unavailable",
                "Core sent a malformed capability reply",
            )),
            None => Ok(reply
                .get_mut("result")
                .map(Value::take)
                .unwrap_or(Value::Null)),
        },
        None => Err(core_failure(
            "plugin_unavailable",
            "Core sent a malformed capability reply",
        )),
    }
}

/// True once the peer hung up; buffered pipelined bytes are left for the next read.
async fn peer_closed(reader: &mut BufReader<UnixStream>) -> bool {
    reader.fill_buf().await.map_or(true, <[u8]>::is_empty)
}

async fn response_for_line(
    line: &[u8],
    dispatch: &BridgeDispatch,
    cancel: &watch::Receiver<bool>,
    forward: CoreForward,
) -> Value {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {"code": INVALID_REQUEST, "message": "parse error"}
        });
    };
    let Some(object) = value.as_object() else {
        return json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {"code": INVALID_REQUEST, "message": "invalid request"}
        });
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": INVALID_REQUEST, "message": "invalid request"}
        });
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": INVALID_REQUEST, "message": "invalid request"}
        });
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        METHOD_PLUGIN_CALL => dispatch_call(id, params, dispatch, cancel, forward).await,
        METHOD_PLUGIN_FIND => dispatch_find(id, params, dispatch).await,
        METHOD_PLUGIN_SPAWN => dispatch_spawn(id, params, dispatch).await,
        METHOD_PLUGIN_STOP => dispatch_stop(id, params, dispatch).await,
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": METHOD_NOT_FOUND, "message": "Method not found"}
        }),
    }
}

async fn dispatch_call(
    id: Value,
    params: Value,
    dispatch: &BridgeDispatch,
    cancel: &watch::Receiver<bool>,
    forward: CoreForward,
) -> Value {
    match dispatch {
        BridgeDispatch::Stub => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "activated": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        BridgeDispatch::Live(owner) => {
            let Some(plugin_id) = params.get("id").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing plugin id");
            };
            let Some(method) = params.get("method").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing method");
            };
            let call_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
            let deadline = params
                .get("deadlineMs")
                .and_then(Value::as_u64)
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_CALL_DEADLINE);
            match SealedCall::from_params(&params) {
                Err(message) => return rpc_error(id, INVALID_PARAMS, message),
                Ok(Some(sealed)) => {
                    let until = Instant::now() + deadline;
                    return match call_sealed(
                        owner,
                        plugin_id,
                        method,
                        call_params,
                        until,
                        cancel,
                        sealed,
                        Some(forward),
                    )
                    .await
                    {
                        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        Err(failure) => {
                            let mut data = json!({"code": failure.code});
                            if let Some(hint) = failure.hint {
                                data["hint"] = Value::String(hint);
                            }
                            if failure.from_plugin {
                                data["origin"] = Value::String("plugin".into());
                            }
                            json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {
                                    "code": PLUGIN_UNAVAILABLE,
                                    "message": failure.message,
                                    "data": data
                                }
                            })
                        }
                    };
                }
                Ok(None) => {}
            }
            let mut guard = owner.lock().await;
            match guard
                .call_plugin(plugin_id, method, call_params, deadline)
                .await
            {
                Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Err(error) => rpc_error(id, PLUGIN_UNAVAILABLE, &error.to_string()),
            }
        }
    }
}

async fn dispatch_find(id: Value, params: Value, dispatch: &BridgeDispatch) -> Value {
    match dispatch {
        BridgeDispatch::Stub => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "found": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        BridgeDispatch::Live(owner) => {
            let Some(plugin_id) = params.get("id").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing plugin id");
            };
            let guard = owner.lock().await;
            match guard.find_plugin(plugin_id) {
                Some(pid) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"found": true, "id": plugin_id, "pid": pid}
                }),
                None => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"found": false, "id": plugin_id}
                }),
            }
        }
    }
}

async fn dispatch_spawn(id: Value, params: Value, dispatch: &BridgeDispatch) -> Value {
    match dispatch {
        BridgeDispatch::Stub => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "activated": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        BridgeDispatch::Live(owner) => {
            let Some(plugin_id) = params.get("id").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing plugin id");
            };
            let Some(argv) = params.get("argv").and_then(Value::as_array).map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            }) else {
                return rpc_error(id, INVALID_PARAMS, "missing argv");
            };
            if argv.is_empty() {
                return rpc_error(id, INVALID_PARAMS, "empty argv");
            }
            let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing cwd");
            };
            let mut env = HashMap::new();
            if let Some(object) = params.get("env").and_then(Value::as_object) {
                for (key, value) in object {
                    if let Some(text) = value.as_str() {
                        env.insert(key.clone(), text.to_owned());
                    }
                }
            }
            let spec = SpawnSpec {
                argv,
                cwd: cwd.into(),
                env,
            };
            let mut guard = owner.lock().await;
            match guard.ensure(plugin_id, &spec) {
                Ok(created) => {
                    let pid = guard.find_plugin(plugin_id);
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "id": plugin_id,
                            "created": created,
                            "pid": pid,
                        }
                    })
                }
                Err(error) => rpc_error(id, PLUGIN_UNAVAILABLE, &error.to_string()),
            }
        }
    }
}

async fn dispatch_stop(id: Value, params: Value, dispatch: &BridgeDispatch) -> Value {
    match dispatch {
        BridgeDispatch::Stub => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "activated": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        BridgeDispatch::Live(owner) => {
            let Some(plugin_id) = params.get("id").and_then(Value::as_str) else {
                return rpc_error(id, INVALID_PARAMS, "missing plugin id");
            };
            let mut guard = owner.lock().await;
            if guard.find_plugin(plugin_id).is_none() {
                return json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"id": plugin_id, "stopped": false}
                });
            }
            match guard.terminate(plugin_id).await {
                Ok(()) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"id": plugin_id, "stopped": true}
                }),
                Err(error) => rpc_error(id, PLUGIN_UNAVAILABLE, &error.to_string()),
            }
        }
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

async fn write_error(
    stream: &mut UnixStream,
    id: Value,
    code: i64,
    message: &str,
) -> Result<(), BridgeError> {
    write_raw(stream, &rpc_error(id, code, message)).await
}

async fn write_raw(stream: &mut UnixStream, value: &Value) -> Result<(), BridgeError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| BridgeError::Malformed)?;
    bytes.push(b'\n');
    if bytes.len() > BRIDGE_MAX_LINE_BYTES {
        return Err(BridgeError::TooLarge);
    }
    stream.write_all(&bytes).await?;
    Ok(())
}

/// When true, unset env enables the native plugin host; set
/// `PACER_NATIVE_PLUGIN_HOST=0` (or `false`/`no`) to escape.
///
/// Kept `false`: with the host on, Core refuses to spawn plugin children, and
/// only native HTTP `plugin.*` operations start them through the owner. Every
/// TypeScript plugin consumer (usage refresh, doctor, setup.health, planners)
/// must reach the owner over the bridge, with Core's spawn spec, call authority
/// and per-call resources, before this can flip. P4d-13 flipped it without
/// that and was reverted.
pub const fn serve_starts_reverse_bridge_by_default() -> bool {
    false
}

/// Public client/TCP surfaces must never advertise private bridge methods.
pub fn bridge_methods_are_private(ops: &[&str]) -> bool {
    !ops.iter().any(|name| {
        name.starts_with("_host.")
            || *name == METHOD_PLUGIN_CALL
            || *name == METHOD_PLUGIN_FIND
            || *name == METHOD_PLUGIN_SPAWN
            || *name == METHOD_PLUGIN_STOP
    })
}
