//! Optional P4d-1/P4d-2 native plugin-host wiring for serve.
//!
//! Default serve does not start this path. When `PACER_NATIVE_PLUGIN_HOST` or
//! `PACER_HOST_BRIDGE` is set, [`maybe_start`] claims a native ProcessOwner,
//! binds the reverse bridge with live call/find dispatch, and returns Core env
//! pairs (`PACER_HOST_SOCKET`).

use pacer_plugin_runtime::{NativeHostSession, native_plugin_host_enabled_from_env};
use std::{collections::HashMap, io, path::Path};

pub(super) struct Guard {
    session: NativeHostSession,
}

impl Guard {
    pub(super) async fn shutdown(self) {
        self.session.shutdown().await;
    }
}

/// Start the flag-on native host when enabled; otherwise leave serve unchanged.
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
    use pacer_plugin_runtime::{HOST_SOCKET_ENV, NATIVE_PLUGIN_HOST_ENABLE_ENV};
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn flag_off_leaves_env_and_socket_untouched() {
        let home = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("PACER_HOME".into(), home.path().display().to_string());
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
