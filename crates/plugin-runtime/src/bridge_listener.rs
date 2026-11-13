//! Reverse-bridge Unix listener (X1c / P4d-1 / P4d-2).
//!
//! Binds `$PACER_HOME/run/host.sock` (dir 0700, socket 0600), accepts line
//! JSON-RPC for `_host.plugin.call` / `_host.plugin.find` / `_host.plugin.stop`,
//! and authorizes peers by Unix credentials and then by the owner's
//! per-start credential ([`crate::bridge_auth`], #918): a same-user process
//! that cannot prove the key is refused before its first request.
//! Sockets are bound in a verified private directory and
//! narrowed to 0600 by path; the process umask is never changed. A stdio
//! connection's socket may live outside the home (`connection_dir`).
//! Default serve must not call [`ReverseBridge::bind`] or
//! export [`crate::HOST_SOCKET_ENV`] unless flag wiring is explicitly enabled
//! (`PACER_NATIVE_PLUGIN_HOST` and/or [`crate::HOST_BRIDGE_ENABLE_ENV`]). This
//! module never binds TCP.
//!
//! Without a live [`SharedOwner`], call/find/stop stay dark stubs.
//! Flag-on serve attaches the owner so handlers reach tracked
//! [`crate::PluginProcess`] children (P4d-2 / P4d-4). A live owner answers
//! only Core-sealed calls (`_host.plugin.call` carrying `spawn`, see
//! `crate::bridge_call`): the owner starts, hellos and authorizes the child
//! from Core's spec before calling it. The unsealed call and
//! `_host.plugin.spawn` are refused, so no caller can start a lane from its
//! own spec for a later sealed call to reuse.
//!
//! An existing socket path is probed with a non-blocking connect before bind:
//! a refused connect marks it stale and it is removed, while an accepted or
//! still-pending connect (full backlog) is [`BridgeError::LiveSocket`]. A bind
//! that loses a race with another owner reports `LiveSocket` as well, so serve
//! can wait for the owner and then exit 3 (ADR 0027, OD-7).

use crate::bridge_auth::{AUTH_DEADLINE, OwnerKey, accept};
use crate::bridge_call::{SealedCall, call_sealed};
use crate::capability::{CoreForward, CoreRequest};
use crate::connection_dir::{
    Probe, check_private_dir, connection_socket_dir, probe_socket, sweep_stale_sockets,
};
use crate::host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME, METHOD_PLUGIN_CALL,
    METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP, SOCKET_PATH_MAX,
    dark_bridge_enabled, prepare_run_dir,
};
use crate::owner::ProcessOwner;
use serde_json::{Value, json};
use std::{
    fs, io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixListener as StdUnixListener,
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
    #[error("reverse-bridge socket path exceeds {SOCKET_PATH_MAX} bytes: {0}")]
    PathTooLong(PathBuf),
    #[error(
        "reverse-bridge socket path exceeds {SOCKET_PATH_MAX} bytes: {path}, and the private \
         per-user directory is unusable: {reason}. Set PACER_NATIVE_PLUGIN_HOST=0 or use a \
         shorter PACER_HOME"
    )]
    NoPrivateDir { path: PathBuf, reason: String },
    #[error("reverse-bridge socket directory is not private: {0}")]
    UntrustedDir(String),
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
    /// Only this uid may speak on the bridge, normally the process uid.
    pub allowed_uid: u32,
    /// The credential a connection must prove before its first request.
    pub key: OwnerKey,
}

impl PeerAuth {
    pub fn same_uid(key: OwnerKey) -> Self {
        Self {
            allowed_uid: current_uid(),
            key,
        }
    }

    /// Test helper: reject every real peer (allowed uid never matches).
    pub fn deny_all_for_tests(key: OwnerKey) -> Self {
        let uid = current_uid();
        Self {
            allowed_uid: if uid == 0 { 1 } else { 0 },
            key,
        }
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
    auth_deadline: Duration,
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
    /// [`BridgeDispatch::Stub`] until [`Self::with_live_owner`]. Draws a fresh
    /// credential; read it back through [`Self::auth`].
    pub fn bind(pacer_home: &Path) -> Result<Self, BridgeError> {
        Self::bind_with_auth(pacer_home, PeerAuth::same_uid(OwnerKey::generate()?))
    }

    pub fn bind_with_auth(pacer_home: &Path, auth: PeerAuth) -> Result<Self, BridgeError> {
        Self::bind_at(pacer_home, HOST_SOCKET_NAME, auth)
    }

    /// Bind `$PACER_HOME/run/<name>` with the same 0700 directory, 0600 socket
    /// and stale-socket rules as `host.sock`. Refuses paths longer than
    /// [`SOCKET_PATH_MAX`] before touching the filesystem.
    pub fn bind_at(pacer_home: &Path, name: &str, auth: PeerAuth) -> Result<Self, BridgeError> {
        let path = pacer_home.join("run").join(name);
        if path.as_os_str().len() > SOCKET_PATH_MAX {
            return Err(BridgeError::PathTooLong(path));
        }
        let run = prepare_run_dir(pacer_home)?;
        Self::bind_in(&run, name, auth)
    }

    /// Bind a stdio connection's socket `name`: in `run/` when the path fits,
    /// otherwise in the private per-user directory of `connection_dir`.
    /// Stale connection sockets in that directory are swept first.
    pub fn bind_connection(
        pacer_home: &Path,
        name: &str,
        auth: PeerAuth,
    ) -> Result<Self, BridgeError> {
        let uid = current_uid();
        let dir = connection_socket_dir(pacer_home, name, uid)?;
        sweep_stale_sockets(&dir, uid);
        Self::bind_in(&dir, name, auth)
    }

    fn bind_in(dir: &Path, name: &str, auth: PeerAuth) -> Result<Self, BridgeError> {
        let uid = current_uid();
        let before = check_private_dir(dir, uid).map_err(BridgeError::UntrustedDir)?;
        let path = dir.join(name);
        remove_stale_socket(&path)?;
        // Another process bound the path since the probe: it owns it now.
        let listener = StdUnixListener::bind(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::AddrInUse {
                BridgeError::LiveSocket(path.clone())
            } else {
                error.into()
            }
        })?;
        if let Err(error) = seal_socket(dir, &path, &before, uid) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self {
            listener,
            path,
            auth,
            auth_deadline: AUTH_DEADLINE,
            dispatch: BridgeDispatch::Stub,
        })
    }

    /// How long a connection may take to prove the key; [`AUTH_DEADLINE`]
    /// unless a test shortens it.
    pub fn with_auth_deadline(mut self, deadline: Duration) -> Self {
        self.auth_deadline = deadline;
        self
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

    /// Env pairs for a Core child under explicit dark wiring only. Carries
    /// the socket, not the credential: dark wiring has no Core caller.
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
                    let deadline = self.auth_deadline;
                    let dispatch = self.dispatch.clone();
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, auth, deadline, dispatch).await;
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

pub(crate) fn current_uid() -> u32 {
    nix::unistd::getuid().as_raw()
}

/// Narrow a just-bound socket to 0600 by path. Only `uid` can create or
/// replace entries in the verified private `dir`, so the path cannot have been
/// redirected; the directory's identity and the socket's owner are rechecked.
/// The process umask stays untouched, so concurrent threads are unaffected.
fn seal_socket(
    dir: &Path,
    path: &Path,
    before: &fs::Metadata,
    uid: u32,
) -> Result<(), BridgeError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    let socket = fs::symlink_metadata(path)?;
    let after = check_private_dir(dir, uid).map_err(BridgeError::UntrustedDir)?;
    if (after.dev(), after.ino()) != (before.dev(), before.ino()) {
        return Err(BridgeError::UntrustedDir(format!(
            "{} was replaced while binding",
            dir.display()
        )));
    }
    if !socket.file_type().is_socket() || socket.uid() != uid || socket.mode() & 0o777 != 0o600 {
        return Err(BridgeError::UntrustedDir(format!(
            "{} is not a private socket",
            path.display()
        )));
    }
    Ok(())
}

fn remove_stale_socket(path: &Path) -> Result<(), BridgeError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(meta) => {
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "reverse-bridge socket path exists and is not a socket",
                )
                .into());
            }
            match probe_socket(path) {
                Probe::Live => Err(BridgeError::LiveSocket(path.to_path_buf())),
                Probe::Missing => Ok(()),
                Probe::Refused | Probe::Other(_) => {
                    fs::remove_file(path)?;
                    Ok(())
                }
            }
        }
    }
}

pub(crate) fn peer_uid(stream: &impl std::os::fd::AsFd) -> Result<u32, BridgeError> {
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
    deadline: Duration,
    dispatch: BridgeDispatch,
) -> Result<(), BridgeError> {
    if let Err(error) = authorize(&stream, &auth) {
        let mut stream = stream;
        let _ = write_error(&mut stream, Value::Null, UNAUTHORIZED, "unauthorized").await;
        return Err(error);
    }
    let mut reader = BufReader::new(stream);
    match tokio::time::timeout(deadline, accept(&mut reader, &auth.key)).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return Ok(()),
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            let _ = write_error(reader.get_mut(), Value::Null, UNAUTHORIZED, "unauthorized").await;
            return Err(BridgeError::UntrustedCaller);
        }
    }
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
        let bridge_request_id = serde_json::from_slice::<Value>(&line)
            .ok()
            .and_then(|call| call.get("id").cloned())
            .unwrap_or(Value::Null);
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
                Turn::Forward((method, mut params, reply)) => {
                    // The process exchange validated the child request id/token. Core
                    // sees its own connection-scoped request identity.
                    if method == "$/resultChunk"
                        && params.get("request").and_then(Value::as_u64).is_some()
                    {
                        params["request"] = bridge_request_id.clone();
                    }
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
            let sealed = match SealedCall::from_params(&params) {
                Err(message) => return rpc_error(id, INVALID_PARAMS, message),
                Ok(None) => {
                    return rpc_error(
                        id,
                        INVALID_PARAMS,
                        "call must carry Core's spawn spec and authority",
                    );
                }
                Ok(Some(sealed)) => sealed,
            };
            let until = Instant::now() + deadline;
            match call_sealed(
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
