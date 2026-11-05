//! Private reverse-bridge path contract from the Rust migration design §0.3.
//!
//! TypeScript reaches Rust-owned plugin memory only through `$PACER_HOME/run/host.sock`
//! (directory 0700, socket 0600), discovered via `PACER_HOST_SOCKET`. Without that
//! env var the core keeps its own host. Path helpers live here; the dark accept
//! loop is [`crate::ReverseBridge`].

use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Environment variable the TypeScript core reads for the reverse bridge.
pub const HOST_SOCKET_ENV: &str = "PACER_HOST_SOCKET";

/// Explicit opt-in for dark bridge wiring (library tests / future serve).
///
/// Production serve must leave this unset so it neither binds `host.sock` nor
/// exports [`HOST_SOCKET_ENV`].
pub const HOST_BRIDGE_ENABLE_ENV: &str = "PACER_HOST_BRIDGE";

/// Socket file name under `$PACER_HOME/run/`.
pub const HOST_SOCKET_NAME: &str = "host.sock";

/// Private JSON-RPC method: call a Rust-owned plugin.
pub const METHOD_PLUGIN_CALL: &str = "_host.plugin.call";

/// Private JSON-RPC method: resolve a Rust-owned plugin entry.
pub const METHOD_PLUGIN_FIND: &str = "_host.plugin.find";

/// `$PACER_HOME/run/host.sock` — never a TCP address.
pub fn host_socket_path(pacer_home: &Path) -> PathBuf {
    pacer_home.join("run").join(HOST_SOCKET_NAME)
}

/// True when dark reverse-bridge wiring may export [`HOST_SOCKET_ENV`].
pub fn dark_bridge_enabled(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true") | Some("TRUE") | Some("yes"))
}

/// Ensure `$PACER_HOME/run` exists as a real directory with mode 0700.
///
/// Does not create the socket or start a listener. Refuses to proceed when
/// `run` exists but is not a directory (for example a symlink to a file).
pub fn prepare_host_run_dir(pacer_home: &Path) -> io::Result<PathBuf> {
    let run = pacer_home.join("run");
    match fs::symlink_metadata(&run) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "PACER_HOME/run must be a real directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(&run)?;
        }
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run, fs::Permissions::from_mode(0o700))?;
    }
    Ok(host_socket_path(pacer_home))
}
