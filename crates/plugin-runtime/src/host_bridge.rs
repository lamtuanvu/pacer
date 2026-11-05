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

/// Companion / legacy enable flag for reverse-bridge wiring.
///
/// Together with [`crate::NATIVE_PLUGIN_HOST_ENABLE_ENV`], truthy values enable
/// the native serve path that binds `host.sock` and exports [`HOST_SOCKET_ENV`].
/// Falsy values (`0` / `false` / `no`) are the escape hatch once
/// [`crate::serve_starts_reverse_bridge_by_default`] flips on (P4d-5).
pub const HOST_BRIDGE_ENABLE_ENV: &str = "PACER_HOST_BRIDGE";

/// Socket file name under `$PACER_HOME/run/`.
pub const HOST_SOCKET_NAME: &str = "host.sock";

/// Private JSON-RPC method: call a Rust-owned plugin.
pub const METHOD_PLUGIN_CALL: &str = "_host.plugin.call";

/// Private JSON-RPC method: resolve a Rust-owned plugin entry.
pub const METHOD_PLUGIN_FIND: &str = "_host.plugin.find";

/// Private JSON-RPC method: spawn and track a child under the native owner.
pub const METHOD_PLUGIN_SPAWN: &str = "_host.plugin.spawn";

/// Private JSON-RPC method: terminate a tracked child.
pub const METHOD_PLUGIN_STOP: &str = "_host.plugin.stop";

/// `$PACER_HOME/run/host.sock` — never a TCP address.
pub fn host_socket_path(pacer_home: &Path) -> PathBuf {
    pacer_home.join("run").join(HOST_SOCKET_NAME)
}

/// True when an env value is an explicit truthy opt-in.
pub fn dark_bridge_enabled(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true") | Some("TRUE") | Some("yes"))
}

/// True when an env value is an explicit disable (`PACER_NATIVE_PLUGIN_HOST=0`).
pub fn dark_bridge_disabled(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("0") | Some("false") | Some("FALSE") | Some("no")
    )
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
