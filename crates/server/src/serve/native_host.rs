//! Optional P4d-1/P4d-4/P4d-5 native plugin-host wiring for serve.
//!
//! Default serve does not start this path (`serve_starts_reverse_bridge_by_default`
//! stays false until TypeScript plugin consumers reach the owner). Truthy `PACER_NATIVE_PLUGIN_HOST`
//! / `PACER_HOST_BRIDGE` opt in; `PACER_NATIVE_PLUGIN_HOST=0` (or `false`/`no`)
//! is the documented escape hatch once default-on lands. When enabled,
//! [`maybe_start`] claims a native ProcessOwner, binds the reverse bridge with
//! live sealed call/find/stop, and returns Core env pairs (`PACER_HOST_SOCKET`).
//! The owner's credential goes to the Core child alone ([`Guard::core_key`]):
//! the native operations' environment never holds it.
//! The shared owner is attached to the HTTP plugin service so native ops spawn
//! children there instead of in TypeScript.
//!
//! OD-7 (ADR 0027): a live `host.sock` is another pacer's lease on the home.
//! [`maybe_start`] polls every 250 ms for up to five seconds
//! (`PACER_SERVE_OWNER_WAIT_MS` overrides the wait), so a restart that overlaps
//! the old serve's shutdown converges, then refuses with [`HomeOwned`]: serve
//! exits with [`EXIT_HOME_OWNED`] (3) beside 1 (runtime) and 2 (usage). A stale
//! socket is replaced. Crashes the owner sees reach Core as `crashed`.

use pacer_plugin_runtime::{
    BridgeError, CrashReport, DoorRequest, HOST_SOCKET_KEY_ENV, NativeHostError, NativeHostSession,
    SharedOwner, native_plugin_host_enabled_from_env, read_owner_pid,
};
use std::{
    collections::HashMap,
    fmt, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};

/// Serve's exit code when another live pacer owns the home's plugin host socket.
pub const EXIT_HOME_OWNED: i32 = 3;
/// Test override for how long serve waits for a live owner to exit.
pub(super) const OWNER_WAIT_ENV: &str = "PACER_SERVE_OWNER_WAIT_MS";
const OWNER_WAIT: Duration = Duration::from_secs(5);
const OWNER_POLL: Duration = Duration::from_millis(250);

/// Another live pacer holds `socket`, the home's plugin host lease.
#[derive(Debug)]
pub struct HomeOwned {
    pub socket: PathBuf,
    pub pid: Option<u32>,
}

impl fmt::Display for HomeOwned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "another pacer owns the plugin host socket at {}",
            self.socket.display()
        )?;
        if let Some(pid) = self.pid {
            write!(f, " (pid {pid})")?;
        }
        f.write_str(": stop the other pacer (pacer service stop) or wait for it to exit")
    }
}

impl std::error::Error for HomeOwned {}

/// The exit code for a serve failure: [`EXIT_HOME_OWNED`] for [`HomeOwned`], else 1.
pub(super) fn exit_code(error: &io::Error) -> i32 {
    match error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<HomeOwned>())
    {
        Some(_) => EXIT_HOME_OWNED,
        None => 1,
    }
}

pub(super) struct Guard {
    session: NativeHostSession,
}

impl Guard {
    pub(super) fn owner(&self) -> SharedOwner {
        Arc::clone(self.session.owner())
    }

    pub(super) fn crash_reports(&self) -> mpsc::UnboundedReceiver<CrashReport> {
        self.session.crash_reports()
    }

    pub(super) fn door_requests(&self) -> mpsc::UnboundedReceiver<DoorRequest> {
        self.session.door_requests()
    }

    /// The Core child's credential pair; add it to the Core child's env only.
    pub(super) fn core_key(&self) -> (String, String) {
        (HOST_SOCKET_KEY_ENV.to_owned(), self.session.key().to_hex())
    }

    pub(super) async fn shutdown(self) {
        self.session.shutdown().await;
    }
}

fn owner_wait(env: &HashMap<String, String>) -> Duration {
    env.get(OWNER_WAIT_ENV)
        .cloned()
        .or_else(|| std::env::var(OWNER_WAIT_ENV).ok())
        .and_then(|ms| ms.trim().parse::<u64>().ok())
        .map_or(OWNER_WAIT, Duration::from_millis)
}

/// Start the native host when enabled; otherwise leave serve unchanged.
pub(super) async fn maybe_start(
    pacer_home: &Path,
    env: &mut HashMap<String, String>,
) -> io::Result<Option<Guard>> {
    // Only the owner this serve starts hands Core a credential.
    env.remove(HOST_SOCKET_KEY_ENV);
    if !native_plugin_host_enabled_from_env(env) {
        return Ok(None);
    }
    let wait = owner_wait(env);
    let deadline = Instant::now() + wait;
    let mut announced = false;
    let (session, core_env) = loop {
        match NativeHostSession::start(pacer_home) {
            Ok(started) => break started,
            Err(NativeHostError::Bridge(BridgeError::LiveSocket(socket))) => {
                let now = Instant::now();
                if now >= deadline {
                    let pid = read_owner_pid(pacer_home);
                    return Err(io::Error::other(HomeOwned { socket, pid }));
                }
                if !announced {
                    announced = true;
                    eprintln!(
                        "pacer: serve: the plugin host socket at {} is live; waiting up to {} ms for its owner to exit",
                        socket.display(),
                        wait.as_millis()
                    );
                }
                tokio::time::sleep(OWNER_POLL.min(deadline - now)).await;
            }
            Err(error) => {
                return Err(io::Error::other(format!("native plugin host: {error}")));
            }
        }
    };
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
mod tests;
