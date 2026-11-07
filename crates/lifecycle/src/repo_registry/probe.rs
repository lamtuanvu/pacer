//! The stale-while-revalidate path probe from `src/core/path-probe.ts`. The cache belongs to
//! this process, like the TypeScript service's: a read reports only what earlier probes saw
//! and schedules a bounded refresh in the background.
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError, mpsc},
    thread,
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const REFRESH: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Probe {
    pub exists: Option<bool>,
    pub real: String,
    pub unreachable: bool,
}

#[derive(Default)]
struct Probes {
    cache: HashMap<String, Probe>,
    pending: HashSet<String>,
    retry_at: HashMap<String, Instant>,
    /// Filesystem calls still running past their deadline; identical calls reuse them.
    stuck: HashSet<String>,
}

static PROBES: LazyLock<Mutex<Probes>> = LazyLock::new(Mutex::default);

fn probes() -> std::sync::MutexGuard<'static, Probes> {
    PROBES.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `path.resolve`: lexical, relative paths against the working directory.
pub fn resolve(path: &str) -> String {
    let mut out = if Path::new(path).is_absolute() {
        PathBuf::from("/")
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    for part in Path::new(path).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => {}
        }
    }
    out.to_string_lossy().into_owned()
}

fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => path[..i].into(),
    }
}

fn inherit(state: &Probes, p: &str) -> Probe {
    if let Some(known) = state.cache.get(p) {
        return known.clone();
    }
    let mut parent = dirname(p);
    loop {
        if let Some(ancestor) = state.cache.get(&parent) {
            let rest = p[parent.len()..].trim_start_matches('/');
            return Probe {
                real: resolve(&format!("{}/{rest}", ancestor.real)),
                ..Probe::default()
            };
        }
        if dirname(&parent) == parent {
            break;
        }
        parent = dirname(&parent);
    }
    Probe {
        real: p.into(),
        ..Probe::default()
    }
}

/// `cachedPath`: cache only; missing descendants inherit a canonicalized parent.
pub fn cached_path(path: &str) -> Probe {
    inherit(&probes(), &resolve(path))
}

/// `markPathUnreachable`.
pub fn mark_unreachable(path: &str) {
    let p = resolve(path);
    let mut state = probes();
    let probe = Probe {
        unreachable: true,
        ..inherit(&state, &p)
    };
    state.cache.insert(p, probe);
}

fn absent(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

enum Seen {
    Exists(String),
    Absent,
    Unreachable,
}

/// `access` then `realpath`, each bounded; only ENOENT/ENOTDIR mean absent.
fn observe(path: &str) -> Seen {
    if !probes().stuck.insert(path.to_owned()) {
        return Seen::Unreachable;
    }
    let (tx, rx) = mpsc::channel();
    let owned = path.to_owned();
    thread::spawn(move || {
        let access = std::fs::metadata(&owned).map(|_| String::new());
        let failed = access.is_err();
        let _ = tx.send(access);
        if !failed {
            let real = std::fs::canonicalize(&owned).map(|p| p.to_string_lossy().into_owned());
            let _ = tx.send(real);
        }
        probes().stuck.remove(&owned);
    });
    let mut real = String::new();
    for _ in 0..2 {
        match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok(Ok(seen)) => real = seen,
            Ok(Err(error)) if absent(&error) => return Seen::Absent,
            Ok(Err(_)) | Err(_) => return Seen::Unreachable,
        }
    }
    Seen::Exists(real)
}

/// `refreshPath` body; an absent path first refreshes its parent so it inherits a real parent.
fn probe_now(path: &str) {
    match observe(path) {
        Seen::Exists(real) => {
            probes().cache.insert(
                path.into(),
                Probe {
                    exists: Some(true),
                    real,
                    unreachable: false,
                },
            );
        }
        Seen::Absent => {
            let parent = dirname(path);
            if parent != path {
                probes()
                    .retry_at
                    .insert(parent.clone(), Instant::now() + REFRESH);
                probe_now(&parent);
            }
            let mut state = probes();
            let real = inherit(&state, path).real;
            state.cache.insert(
                path.into(),
                Probe {
                    exists: Some(false),
                    real,
                    unreachable: false,
                },
            );
        }
        Seen::Unreachable => mark_unreachable(path),
    }
}

fn refresh(path: String) {
    {
        let mut state = probes();
        if !state.pending.insert(path.clone()) {
            return;
        }
        state
            .retry_at
            .insert(path.clone(), Instant::now() + REFRESH);
    }
    thread::spawn(move || {
        probe_now(&path);
        probes().pending.remove(&path);
    });
}

/// `schedulePathRefresh`.
pub fn schedule_refresh(path: &str) {
    let path = resolve(path);
    let due = probes()
        .retry_at
        .get(&path)
        .is_none_or(|at| Instant::now() >= *at);
    if due {
        refresh(path);
    }
}

/// `cachedCanonical` in `src/core/repos.ts`: the cached real path, then a background refresh.
pub fn cached_canonical(path: &str) -> String {
    let real = cached_path(path).real;
    schedule_refresh(path);
    real
}

/// Probe now and wait, for tests that need the state a later read would see.
#[cfg(test)]
pub(crate) fn probe_for_tests(path: &str) {
    probe_now(&resolve(path));
}
