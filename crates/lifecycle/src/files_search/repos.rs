//! Read-only `listRepos(ctx, [])` from `src/core/repos.ts`, with the stale-while-revalidate
//! path probe from `src/core/path-probe.ts`: a read reports only what earlier probes saw.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError, mpsc},
    thread,
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const REFRESH: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub key: String,
    pub path: String,
    pub label: String,
    pub unreachable: bool,
}

#[derive(Clone, Copy, Default)]
struct Probe {
    exists: Option<bool>,
    unreachable: bool,
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

/// `path.resolve` for an absolute path: lexical, no filesystem access.
fn resolve(path: &str) -> String {
    let mut out = PathBuf::from("/");
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

fn cached_probe(path: &str) -> Probe {
    probes()
        .cache
        .get(&resolve(path))
        .copied()
        .unwrap_or_default()
}

fn absent(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// `access` then `realpath`, each bounded; only ENOENT/ENOTDIR mean absent.
fn observe(path: &str) -> Option<bool> {
    if !probes().stuck.insert(path.to_owned()) {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let owned = path.to_owned();
    thread::spawn(move || {
        let access = std::fs::metadata(&owned).map(|_| ());
        let failed = access.is_err();
        let _ = tx.send(access);
        if !failed {
            let _ = tx.send(std::fs::canonicalize(&owned).map(|_| ()));
        }
        probes().stuck.remove(&owned);
    });
    for _ in 0..2 {
        match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) if absent(&error) => return Some(false),
            Ok(Err(_)) | Err(_) => return None,
        }
    }
    Some(true)
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
        let seen = observe(&path);
        let mut state = probes();
        let probe = match seen {
            Some(exists) => Probe {
                exists: Some(exists),
                unreachable: false,
            },
            None => Probe {
                unreachable: true,
                ..state.cache.get(&path).copied().unwrap_or_default()
            },
        };
        state.cache.insert(path.clone(), probe);
        state.pending.remove(&path);
    });
}

fn schedule_refresh(path: &str) {
    let path = resolve(path);
    let due = probes()
        .retry_at
        .get(&path)
        .is_none_or(|at| Instant::now() >= *at);
    if due {
        refresh(path);
    }
}

/// Node `path.basename` without an extension argument.
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

struct Entry {
    key: String,
    path: String,
    last_used: f64,
}

pub(crate) fn labels_for(entries: &[(String, String)]) -> HashMap<String, String> {
    let short = |(key, path): &(String, String)| -> String {
        if key.starts_with("local:") {
            basename(path).to_owned()
        } else {
            key.split('/').skip(1).collect::<Vec<_>>().join("/")
        }
    };
    let mut keys_by_short: HashMap<String, HashSet<&str>> = HashMap::new();
    let shorts: Vec<String> = entries.iter().map(short).collect();
    for (entry, s) in entries.iter().zip(&shorts) {
        keys_by_short
            .entry(s.clone())
            .or_default()
            .insert(entry.0.as_str());
    }
    let mut labels = HashMap::new();
    for ((key, _), s) in entries.iter().zip(shorts) {
        let collides = keys_by_short.get(&s).map_or(0, HashSet::len) > 1;
        let label = if !collides {
            s
        } else if key.starts_with("local:") {
            format!("{s} ({key})")
        } else {
            key.clone()
        };
        labels.insert(key.clone(), label);
    }
    labels
}

fn registry(pacer_home: &Path) -> Vec<(String, Entry)> {
    let Ok(text) = std::fs::read_to_string(pacer_home.join("state").join("repos.json")) else {
        return Vec::new();
    };
    let items: Vec<(String, Value)> = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map.into_iter().collect(),
        Ok(Value::Array(list)) => list
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|(name, value)| {
            let key = value.get("key")?.as_str()?.to_owned();
            let path = value.get("path")?.as_str()?.to_owned();
            let last_used = value
                .get("lastUsed")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            Some((
                name,
                Entry {
                    key,
                    path,
                    last_used,
                },
            ))
        })
        .collect()
}

/// Registered repositories for a read-only caller: nothing is pruned or written.
pub fn list_repos_read_only(pacer_home: &Path) -> Vec<RepoRef> {
    let reg = registry(pacer_home);
    let stale: HashSet<&str> = reg
        .iter()
        .filter(|(_, e)| {
            let probe = cached_probe(&e.path);
            probe.exists == Some(false) && !probe.unreachable
        })
        .map(|(name, _)| name.as_str())
        .collect();
    for (_, entry) in &reg {
        schedule_refresh(&entry.path);
    }
    let mut entries: Vec<&Entry> = reg
        .iter()
        .filter(|(name, _)| !stale.contains(name.as_str()))
        .map(|(_, e)| e)
        .collect();
    entries.sort_by(|a, b| {
        (b.last_used - a.last_used)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e.key.clone(), e.path.clone()))
        .collect();
    let labels = labels_for(&pairs);
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|e| seen.insert(e.key.clone()))
        .map(|e| RepoRef {
            key: e.key.clone(),
            path: e.path.clone(),
            label: labels.get(&e.key).cloned().unwrap_or_default(),
            unreachable: cached_probe(&e.path).unreachable,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, p)| ((*k).to_owned(), (*p).to_owned()))
            .collect()
    }

    #[test]
    fn labels_disambiguate_collisions() {
        let labels = labels_for(&pairs(&[
            ("github.com/acme/app", "/a"),
            ("gitlab.com/acme/app", "/b"),
            ("local:1", "/x/tool/"),
            ("local:2", "/y/tool"),
            ("github.com/acme/web", "/c"),
        ]));
        assert_eq!(labels["github.com/acme/app"], "github.com/acme/app");
        assert_eq!(labels["local:1"], "tool (local:1)");
        assert_eq!(labels["github.com/acme/web"], "acme/web");
    }

    #[test]
    fn registry_order_and_dedup() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(
            state.join("repos.json"),
            r#"{"/r/one":{"key":"github.com/a/one","path":"/r/one","lastUsed":1},
                "/r/two":{"key":"github.com/a/two","path":"/r/two","lastUsed":5},
                "/r/dup":{"key":"github.com/a/one","path":"/r/dup","lastUsed":3}}"#,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let repos = list_repos_read_only(dir.path());
        let keys: Vec<_> = repos
            .iter()
            .map(|r| (r.key.as_str(), r.path.as_str()))
            .collect();
        assert_eq!(
            keys,
            [
                ("github.com/a/two", "/r/two"),
                ("github.com/a/one", "/r/dup")
            ]
        );
        assert_eq!(repos[0].label, "a/two");
    }

    #[test]
    fn resolve_is_lexical() {
        assert_eq!(resolve("/a/b/../c/./d/"), "/a/c/d");
        assert_eq!(basename("/x/y/"), "y");
    }
}
