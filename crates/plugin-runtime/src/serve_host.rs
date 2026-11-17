//! Flag-gated native plugin-host session for serve (P4d-1 … P4d-5).
//!
//! Default serve stays TypeScript-owned until
//! [`crate::serve_starts_reverse_bridge_by_default`] flips. Truthy
//! [`NATIVE_PLUGIN_HOST_ENABLE_ENV`] / [`crate::HOST_BRIDGE_ENABLE_ENV`] opt in
//! today; falsy values (`0` / `false` / `no`) are the documented escape hatch
//! for the future default-on cutover. When enabled, serve claims a
//! [`ProcessOwner`], binds the reverse bridge with live call/find/spawn/stop,
//! and exports [`crate::HOST_SOCKET_ENV`] for the Core child. A stdio
//! connection with no live serve owner starts the same session on its own
//! connection socket ([`NativeHostSession::start_connection`]).
//!
//! Serve's session also writes `run/host.sock.pid` (0600) beside the socket so
//! a refused second serve and `pacer doctor` can name the owner, and
//! `run/host.key` (0600) so attaching stdio connections can prove the
//! credential ([`crate::bridge_auth`]). Every session draws a fresh key; the
//! env pairs it returns carry only the socket, and the caller hands
//! [`NativeHostSession::key`] to its Core child alone. Both
//! shutdowns refuse new children, terminate every child together (SIGTERM,
//! then SIGKILL after [`crate::TERMINATE_GRACE`]) and only then remove the
//! sidecar and unlink the socket, so the lease outlives the children it
//! supervised. Shutdown reaches the children through the owner's lane roster,
//! not the owner lock, so a call in flight never delays it; that call fails
//! once its child exits, and every observation generation retires. Crashes go
//! to [`NativeHostSession::crash_reports`], observation requests to
//! [`NativeHostSession::door_requests`].

use crate::{
    BridgeError, BridgeHandle, DoorRequest, HOST_BRIDGE_ENABLE_ENV, HOST_KEY_NAME, HOST_SOCKET_ENV,
    HOST_SOCKET_NAME, OwnerError, OwnerKey, PeerAuth, ProcessOwner, ReverseBridge, SharedOwner,
    connection_socket_name,
    crash::{CrashBook, CrashReport},
    dark_bridge_disabled, dark_bridge_enabled,
    owner::LaneRoster,
    serve_starts_reverse_bridge_by_default, terminate_lanes,
};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::sync::{Mutex, mpsc};

/// The serve owner's pid, beside `host.sock` in `run/`.
pub const HOST_SOCKET_PID_NAME: &str = "host.sock.pid";

/// The pid `run/host.sock.pid` names, when it holds one.
pub fn read_owner_pid(pacer_home: &Path) -> Option<u32> {
    fs::read_to_string(pacer_home.join("run").join(HOST_SOCKET_PID_NAME))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Write `text` to `path` through a 0600 temporary and a rename.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    let _ = fs::remove_file(&temp);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let written = writeln!(file, "{text}").and_then(|()| fs::rename(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Remove `path` only while it still holds `text`: a later owner's file stays.
fn remove_if_holds(path: &Path, text: &str) {
    if fs::read_to_string(path).is_ok_and(|held| held.trim() == text) {
        let _ = fs::remove_file(path);
    }
}

/// Enable / escape env for serve-owned native plugin supervision (P4d-1 / P4d-5).
///
/// Truthy values opt in while the default const is still off. `0` / `false` /
/// `no` disable the path (escape hatch once default-on lands).
pub const NATIVE_PLUGIN_HOST_ENABLE_ENV: &str = "PACER_NATIVE_PLUGIN_HOST";

#[derive(Debug, Error)]
pub enum NativeHostError {
    #[error(transparent)]
    Owner(#[from] OwnerError),
    #[error(transparent)]
    Bridge(#[from] BridgeError),
}

/// True when serve may own a native [`ProcessOwner`] and reverse bridge.
///
/// Explicit disable on either flag wins. Otherwise the path is on when
/// [`serve_starts_reverse_bridge_by_default`] is true, or when either flag is
/// an explicit truthy opt-in.
pub fn native_plugin_host_enabled(native_flag: Option<&str>, bridge_flag: Option<&str>) -> bool {
    if dark_bridge_disabled(native_flag) || dark_bridge_disabled(bridge_flag) {
        return false;
    }
    if serve_starts_reverse_bridge_by_default() {
        return true;
    }
    dark_bridge_enabled(native_flag) || dark_bridge_enabled(bridge_flag)
}

/// Read enable flags from a serve env map, falling back to process env so Core
/// inheritance and library callers agree.
pub fn native_plugin_host_enabled_from_env(
    env: &std::collections::HashMap<String, String>,
) -> bool {
    let native = env
        .get(NATIVE_PLUGIN_HOST_ENABLE_ENV)
        .cloned()
        .or_else(|| std::env::var(NATIVE_PLUGIN_HOST_ENABLE_ENV).ok());
    let bridge = env
        .get(HOST_BRIDGE_ENABLE_ENV)
        .cloned()
        .or_else(|| std::env::var(HOST_BRIDGE_ENABLE_ENV).ok());
    native_plugin_host_enabled(native.as_deref(), bridge.as_deref())
}

/// Live serve-owned ProcessOwner + reverse-bridge accept loop.
pub struct NativeHostSession {
    owner: SharedOwner,
    crashes: Arc<CrashBook>,
    roster: Arc<LaneRoster>,
    bridge: BridgeHandle,
    socket: PathBuf,
    key: OwnerKey,
    /// Serve's `run/host.sock.pid`; connection sessions write none.
    pid_file: Option<PathBuf>,
    /// Serve's `run/host.key`; a connection's key never touches disk.
    key_file: Option<PathBuf>,
}

impl NativeHostSession {
    /// Claim native supervision, bind `host.sock`, publish `run/host.key`,
    /// spawn the accept loop with live owner dispatch, and return Core env
    /// pairs (`PACER_HOST_SOCKET`). A live socket fails with
    /// [`BridgeError::LiveSocket`]. Does not mutate process env.
    pub fn start(pacer_home: &Path) -> Result<(Self, Vec<(String, String)>), NativeHostError> {
        let key = OwnerKey::generate().map_err(BridgeError::from)?;
        let key_text = key.to_hex();
        let (mut session, env) = Self::start_with(pacer_home, key.clone(), || {
            let bridge =
                ReverseBridge::bind_at(pacer_home, HOST_SOCKET_NAME, PeerAuth::same_uid(key))?;
            // The socket is the lease and is bound first, so a refused second
            // serve never overwrites the live owner's key.
            if let Err(error) =
                write_private(&bridge.path().with_file_name(HOST_KEY_NAME), &key_text)
            {
                let _ = fs::remove_file(bridge.path());
                return Err(error.into());
            }
            Ok(bridge)
        })?;
        session.key_file = Some(session.socket.with_file_name(HOST_KEY_NAME));
        let pid_file = session.socket.with_file_name(HOST_SOCKET_PID_NAME);
        // Diagnostics only: the socket, not this file, is the lease.
        if write_private(&pid_file, &std::process::id().to_string()).is_ok() {
            session.pid_file = Some(pid_file);
        }
        Ok((session, env))
    }

    /// The same owner for one stdio connection, on its own connection socket
    /// rather than `host.sock`: the connection never claims the home's lease
    /// (ADR 0027). The socket is `run/s<12-hex>.sock`, or the private per-user
    /// directory when that path is too long ([`ReverseBridge::bind_connection`]).
    /// End it with [`Self::shutdown_connection`].
    pub fn start_connection(
        pacer_home: &Path,
        tag: [u8; 6],
    ) -> Result<(Self, Vec<(String, String)>), NativeHostError> {
        let name = connection_socket_name(tag);
        let key = OwnerKey::generate().map_err(BridgeError::from)?;
        Self::start_with(pacer_home, key.clone(), || {
            ReverseBridge::bind_connection(pacer_home, &name, PeerAuth::same_uid(key))
        })
    }

    /// Children log stderr to `$PACER_HOME/logs/plugins/<id>.log`, as the
    /// TypeScript host does.
    fn start_with(
        pacer_home: &Path,
        key: OwnerKey,
        bind: impl FnOnce() -> Result<ReverseBridge, BridgeError>,
    ) -> Result<(Self, Vec<(String, String)>), NativeHostError> {
        let mut owner = ProcessOwner::native_for_serve();
        owner.claim_native_supervision()?;
        owner.set_log_dir(pacer_home.join("logs").join("plugins"));
        let crashes = owner.crash_book();
        let roster = owner.roster();
        let owner = Arc::new(Mutex::new(owner));
        let bridge = bind()?.with_live_owner(Arc::clone(&owner));
        let socket = bridge.path().to_path_buf();
        let core_env = vec![(HOST_SOCKET_ENV.to_string(), socket.display().to_string())];
        let bridge = bridge.spawn();
        Ok((
            Self {
                owner,
                crashes,
                roster,
                bridge,
                socket,
                key,
                pid_file: None,
                key_file: None,
            },
            core_env,
        ))
    }

    pub fn owner(&self) -> &SharedOwner {
        &self.owner
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// This start's credential. Hand it to the owner's own Core child only,
    /// as [`crate::HOST_SOCKET_KEY_ENV`]; never to any other child.
    pub fn key(&self) -> &OwnerKey {
        &self.key
    }

    /// Crashes this owner detects from now on; the door delivers each to its
    /// Core as the private `crashed` kind and then drops the report.
    pub fn crash_reports(&self) -> mpsc::UnboundedReceiver<CrashReport> {
        let (sink, reports) = mpsc::unbounded_channel();
        self.crashes.set_sink(Some(sink));
        reports
    }

    /// Requests this owner's lanes make of the owning door's Core from now on
    /// (observation events and reads, idle `capability.log` lines); the door
    /// answers each from its Core. Closing the owner ends them.
    pub fn door_requests(&self) -> mpsc::UnboundedReceiver<DoorRequest> {
        let (sink, requests) = mpsc::unbounded_channel();
        self.roster.set_door(Some(sink));
        requests
    }

    /// Serve shutdown: refuse new children, terminate every child at once
    /// (even one a caller holding the owner lock is waiting on), then remove
    /// the pid and key sidecars and unlink `host.sock`.
    pub async fn shutdown(self) {
        self.crashes.set_sink(None);
        terminate_lanes(self.roster.close()).await;
        if let Some(pid_file) = &self.pid_file {
            remove_if_holds(pid_file, &std::process::id().to_string());
        }
        if let Some(key_file) = &self.key_file {
            remove_if_holds(key_file, &self.key.to_hex());
        }
        self.bridge.shutdown().await;
    }

    /// End a stdio connection's ownership the same way: no child outlives it.
    pub async fn shutdown_connection(self) {
        self.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn flags_default_off_with_zero_escape() {
        assert!(!serve_starts_reverse_bridge_by_default());
        assert!(!native_plugin_host_enabled(None, None));
        assert!(!native_plugin_host_enabled(Some("0"), None));
        assert!(!native_plugin_host_enabled(None, Some("false")));
        assert!(!native_plugin_host_enabled(Some("0"), Some("false")));
        // Explicit disable wins over a conflicting truthy companion flag.
        assert!(!native_plugin_host_enabled(Some("true"), Some("0")));
        assert!(!native_plugin_host_enabled(Some("0"), Some("1")));
        assert!(native_plugin_host_enabled(Some("1"), None));
        assert!(native_plugin_host_enabled(None, Some("1")));
        assert!(native_plugin_host_enabled(Some("true"), Some("yes")));
        assert_eq!(NATIVE_PLUGIN_HOST_ENABLE_ENV, "PACER_NATIVE_PLUGIN_HOST");
    }

    #[test]
    fn env_map_reads_either_flag_and_honors_zero() {
        let mut env = HashMap::new();
        assert!(!native_plugin_host_enabled_from_env(&env));
        env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "1".into());
        assert!(native_plugin_host_enabled_from_env(&env));
        env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "0".into());
        assert!(!native_plugin_host_enabled_from_env(&env));
        env.clear();
        env.insert(HOST_BRIDGE_ENABLE_ENV.into(), "yes".into());
        assert!(native_plugin_host_enabled_from_env(&env));
        env.insert(HOST_BRIDGE_ENABLE_ENV.into(), "no".into());
        assert!(!native_plugin_host_enabled_from_env(&env));
    }
}
