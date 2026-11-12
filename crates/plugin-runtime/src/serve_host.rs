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

use crate::{
    BridgeError, BridgeHandle, HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, HOST_SOCKET_NAME,
    OwnerError, PeerAuth, ProcessOwner, ReverseBridge, SharedOwner, connection_socket_name,
    dark_bridge_disabled, dark_bridge_enabled, serve_starts_reverse_bridge_by_default,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::sync::Mutex;

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
    bridge: BridgeHandle,
    socket: PathBuf,
}

impl NativeHostSession {
    /// Claim native supervision, bind `host.sock`, spawn the accept loop with
    /// live owner dispatch, and return Core env pairs (`PACER_HOST_SOCKET`).
    /// Does not mutate process env.
    pub fn start(pacer_home: &Path) -> Result<(Self, Vec<(String, String)>), NativeHostError> {
        Self::start_with(|| {
            ReverseBridge::bind_at(pacer_home, HOST_SOCKET_NAME, PeerAuth::same_uid())
        })
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
        Self::start_with(|| ReverseBridge::bind_connection(pacer_home, &name, PeerAuth::same_uid()))
    }

    fn start_with(
        bind: impl FnOnce() -> Result<ReverseBridge, BridgeError>,
    ) -> Result<(Self, Vec<(String, String)>), NativeHostError> {
        let owner = ProcessOwner::native_for_serve();
        owner.claim_native_supervision()?;
        let owner = Arc::new(Mutex::new(owner));
        let bridge = bind()?.with_live_owner(Arc::clone(&owner));
        let socket = bridge.path().to_path_buf();
        let core_env = vec![(HOST_SOCKET_ENV.to_string(), socket.display().to_string())];
        let bridge = bridge.spawn();
        Ok((
            Self {
                owner,
                bridge,
                socket,
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

    /// Stop the accept loop and unlink the socket. Tracked children (if any)
    /// are dropped with the owner; later slices terminate them explicitly.
    pub async fn shutdown(self) {
        self.bridge.shutdown().await;
    }

    /// End a stdio connection's ownership: unlink its socket first so no new
    /// caller arrives, then terminate every child it still tracks.
    pub async fn shutdown_connection(self) {
        self.bridge.shutdown().await;
        let mut owner = self.owner.lock().await;
        for id in owner.tracked_ids() {
            let _ = owner.terminate(&id).await;
        }
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
