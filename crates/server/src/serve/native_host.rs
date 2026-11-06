//! Optional P4d-1/P4d-4/P4d-5 native plugin-host wiring for serve.
//!
//! Default serve starts this path (`serve_starts_reverse_bridge_by_default`, P4d-13).
//! Set `PACER_NATIVE_PLUGIN_HOST=0` (or `false`/`no`) to escape to TypeScript
//! ownership; truthy flags still opt in when the default is off. When enabled,
//! [`maybe_start`] claims a native ProcessOwner, binds the reverse bridge with
//! live call/find/spawn/stop, and returns Core env pairs (`PACER_HOST_SOCKET`).
//! The shared owner is attached to the HTTP plugin service so native ops spawn
//! children there instead of in TypeScript.

use pacer_plugin_runtime::{NativeHostSession, SharedOwner, native_plugin_host_enabled_from_env};
use std::{collections::HashMap, io, path::Path, sync::Arc};

pub(super) struct Guard {
    session: NativeHostSession,
}

impl Guard {
    pub(super) fn owner(&self) -> SharedOwner {
        Arc::clone(self.session.owner())
    }

    pub(super) async fn shutdown(self) {
        self.session.shutdown().await;
    }
}

/// Start the native host when enabled; otherwise leave serve unchanged.
pub(super) fn maybe_start(
    pacer_home: &Path,
    env: &mut HashMap<String, String>,
) -> io::Result<Option<Guard>> {
    if !native_plugin_host_enabled_from_env(env) {
        return Ok(None);
    }
    let (session, core_env) = NativeHostSession::start(pacer_home)
        .map_err(|error| io::Error::other(format!("native plugin host: {error}")))?;
    for (key, value) in core_env {
        env.insert(key, value);
    }
    eprintln!(
        "pacer: native plugin host enabled (socket={})",
        session.socket_path().display()
    );
    Ok(Some(Guard { session }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_plugin_runtime::{
        HOST_BRIDGE_ENABLE_ENV, HOST_SOCKET_ENV, NATIVE_PLUGIN_HOST_ENABLE_ENV,
    };
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn default_on_sets_socket_env_and_cleans_up() {
        let home = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("PACER_HOME".into(), home.path().display().to_string());
        let guard = maybe_start(home.path(), &mut env).unwrap().unwrap();
        let socket = env.get(HOST_SOCKET_ENV).cloned().unwrap();
        assert!(Path::new(&socket).exists());
        guard.shutdown().await;
        assert!(!Path::new(&socket).exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn zero_escape_leaves_path_dark_even_with_bridge_yes() {
        let home = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "0".into());
        env.insert(HOST_BRIDGE_ENABLE_ENV.into(), "yes".into());
        assert!(maybe_start(home.path(), &mut env).unwrap().is_none());
        assert!(!env.contains_key(HOST_SOCKET_ENV));
        assert!(!home.path().join("run").join("host.sock").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn flag_on_sets_socket_env_and_cleans_up() {
        let home = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert(NATIVE_PLUGIN_HOST_ENABLE_ENV.into(), "1".into());
        let guard = maybe_start(home.path(), &mut env).unwrap().unwrap();
        let socket = env.get(HOST_SOCKET_ENV).cloned().unwrap();
        assert!(Path::new(&socket).exists());
        assert_eq!(
            fs::symlink_metadata(home.path().join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        guard.shutdown().await;
        assert!(!Path::new(&socket).exists());
    }
}
