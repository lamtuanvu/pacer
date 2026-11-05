//! Dark reverse-bridge Unix listener (X1c).
//!
//! Binds `$PACER_HOME/run/host.sock` (dir 0700, socket 0600), accepts line
//! JSON-RPC for `_host.plugin.call` / `_host.plugin.find`, and authorizes peers
//! by Unix credentials. Production serve must not call [`ReverseBridge::bind`]
//! or export [`crate::HOST_SOCKET_ENV`] unless dark wiring is explicitly enabled
//! via [`crate::HOST_BRIDGE_ENABLE_ENV`]. This module never binds TCP.

use crate::host_bridge::{
    HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND,
    dark_bridge_enabled, prepare_host_run_dir,
};
use serde_json::{Value, json};
use std::{
    fs, io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream},
    },
    path::{Path, PathBuf},
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::watch,
};

/// Soft cap matching the plugin process frame budget (1 MiB).
pub const BRIDGE_MAX_LINE_BYTES: usize = 1024 * 1024;

const METHOD_NOT_FOUND: i64 = -32601;
const UNAUTHORIZED: i64 = -32001;
const INVALID_REQUEST: i64 = -32600;

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
    /// must use [`Self::dark_core_env`] under the enable flag.
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
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn auth(&self) -> &PeerAuth {
        &self.auth
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
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, auth).await;
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

fn authorize(stream: &UnixStream, auth: &PeerAuth) -> Result<(), BridgeError> {
    let (uid, _gid) =
        nix::unistd::getpeereid(stream).map_err(|_| BridgeError::PeerCredUnavailable)?;
    if uid.as_raw() != auth.allowed_uid {
        return Err(BridgeError::UntrustedCaller);
    }
    Ok(())
}

async fn handle_connection(stream: UnixStream, auth: PeerAuth) -> Result<(), BridgeError> {
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
        let response = response_for_line(&line);
        let stream = reader.get_mut();
        write_raw(stream, &response).await?;
    }
    Ok(())
}

fn response_for_line(line: &[u8]) -> Value {
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
    // Params are accepted but ignored by the dark stub; ownership is not active.
    let _params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        METHOD_PLUGIN_CALL => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "activated": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        METHOD_PLUGIN_FIND => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "found": false,
                "reason": "native-plugin-ownership-not-activated"
            }
        }),
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": METHOD_NOT_FOUND, "message": "Method not found"}
        }),
    }
}

async fn write_error(
    stream: &mut UnixStream,
    id: Value,
    code: i64,
    message: &str,
) -> Result<(), BridgeError> {
    write_raw(
        stream,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message}
        }),
    )
    .await
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

/// Invariant: default serve must not start this listener or set `PACER_HOST_SOCKET`.
pub const fn serve_starts_reverse_bridge_by_default() -> bool {
    false
}

/// Public client/TCP surfaces must never advertise private bridge methods.
pub fn bridge_methods_are_private(ops: &[&str]) -> bool {
    !ops.iter().any(|name| {
        name.starts_with("_host.") || *name == METHOD_PLUGIN_CALL || *name == METHOD_PLUGIN_FIND
    })
}
