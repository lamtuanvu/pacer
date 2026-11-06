//! Flag-gated native plugin-host session for serve (P4d-1 … P4d-5).
//!
//! Default serve owns a native [`ProcessOwner`] when
//! [`crate::serve_starts_reverse_bridge_by_default`] is true (P4d-13). Falsy
//! [`NATIVE_PLUGIN_HOST_ENABLE_ENV`] / [`crate::HOST_BRIDGE_ENABLE_ENV`] values
//! (`0` / `false` / `no`) escape to TypeScript ownership. Explicit truthy flags
//! still opt in when the default is off. When enabled, serve claims a
//! [`ProcessOwner`], binds the reverse bridge with live call/find/spawn/stop,
//! and exports [`crate::HOST_SOCKET_ENV`] for the Core child.

use crate::{
    BridgeError, BridgeHandle, HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, OwnerError, ProcessOwner,
    ReverseBridge, SharedOwner, dark_bridge_disabled, dark_bridge_enabled,
    serve_starts_reverse_bridge_by_default,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::sync::Mutex;

/// Enable / escape env for serve-owned native plugin supervision (P4d-1 / P4d-5).
///
/// `0` / `false` / `no` disable the path; truthy values opt in when the
/// default const is off.
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
        let owner = ProcessOwner::native_for_serve();
        owner.claim_native_supervision()?;
        let owner = Arc::new(Mutex::new(owner));
        let bridge = ReverseBridge::bind(pacer_home)?.with_live_owner(Arc::clone(&owner));
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
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn flags_default_on_with_zero_escape() {
        assert!(serve_starts_reverse_bridge_by_default());
        assert!(native_plugin_host_enabled(None, None));
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
        assert!(native_plugin_host_enabled_from_env(&env));
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
