//! Bounded git reads and their short-lived in-memory caches.
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock, PoisonError, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use super::LIMITS;

pub(crate) struct RunOut {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub timed_out: bool,
    pub overflow: bool,
}

fn find_program(name: &str, env: &HashMap<String, String>) -> PathBuf {
    let search = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    search
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Runs `argv` with exactly `env`; output past `max_stdout` stops the process instead of being buffered.
pub(crate) fn run(
    argv: &[String],
    timeout: Duration,
    max_stdout: usize,
    env: &HashMap<String, String>,
) -> std::io::Result<RunOut> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::other("empty argv"))?;
    let mut child = Command::new(find_program(program, env))
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("stdout unavailable"))?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        let mut overflow = false;
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let room = max_stdout - buf.len();
                    if n > room {
                        buf.extend_from_slice(chunk.get(..room).unwrap_or_default());
                        overflow = true;
                        break;
                    }
                    buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = tx.send((buf, overflow));
    });
    let Ok((stdout, overflow)) = rx.recv_timeout(timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(RunOut {
            code: 124,
            stdout: Vec::new(),
            timed_out: true,
            overflow: false,
        });
    };
    if overflow {
        let _ = child.kill();
    }
    loop {
        if let Some(status) = child.try_wait()? {
            let code = status.code().unwrap_or(1);
            return Ok(RunOut {
                code: if overflow && code == 0 { 1 } else { code },
                stdout,
                timed_out: false,
                overflow,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(RunOut {
                code: 124,
                stdout: Vec::new(),
                timed_out: true,
                overflow: false,
            });
        }
        thread::sleep(Duration::from_millis(2));
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

type Cell<T> = Arc<OnceLock<T>>;

/// Entries expire after the TTL and the oldest go first past the size bound; a hit may still be loading.
pub(crate) struct TtlCache<T> {
    entries: Mutex<Vec<(String, u128, Cell<T>)>>,
}

impl<T: Clone> TtlCache<T> {
    pub(crate) const fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn get(&self, key: &str, load: impl FnOnce() -> T) -> T {
        let cell = {
            let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
            let now = now_ms();
            entries.retain(|(_, at, _)| now.saturating_sub(*at) < LIMITS.cache_ms);
            if let Some((_, _, cell)) = entries.iter().find(|(k, _, _)| k == key) {
                cell.clone()
            } else {
                let cell: Cell<T> = Arc::new(OnceLock::new());
                entries.push((key.to_owned(), now, cell.clone()));
                while entries.len() > LIMITS.cache_entries {
                    entries.remove(0);
                }
                cell
            }
        };
        cell.get_or_init(load).clone()
    }

    #[cfg(test)]
    pub(crate) fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}
