//! The repository registry from `src/core/repos.ts`. `listRepos`: the registry file, keys of
//! active and recent tasks, stale filtering and throttled pruning, over the per-process path
//! probe in `probe`. `branches` adds the local branch reads of `repo.list`; `identity` owns
//! git identity and registration of absolute checkout paths (`registerRepo`, `addRepo`).
#![allow(clippy::result_large_err)]
mod branches;
mod git;
mod identity;
mod json;
mod probe;
#[cfg(test)]
mod tests;

pub use branches::read_branches;
pub use git::git_read_within;
pub use identity::{add_repo, canonical, register_repo};
pub use probe::{Probe, cached_canonical, cached_path, mark_unreachable, schedule_refresh};

use json::stringify;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError},
};

const PRUNE_EVERY_S: f64 = 60.0;
const RECENT_S: f64 = 86400.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub key: String,
    pub path: String,
    pub label: String,
    pub unreachable: bool,
}

impl RepoRef {
    /// The `RepoRef` wire shape: `unreachable` appears only when true.
    pub fn to_json(&self) -> Value {
        let mut out = json!({"key": self.key, "path": self.path, "label": self.label});
        if self.unreachable {
            out["unreachable"] = json!(true);
        }
        out
    }
}

fn state_file(home: &Path, name: &str) -> PathBuf {
    home.join("state").join(name)
}

/// Integer-index keys, which JavaScript objects enumerate first.
fn index_key(key: &str) -> bool {
    key.parse::<u32>()
        .is_ok_and(|n| n != u32::MAX && n.to_string() == key)
}

fn plain_entry(value: &Value) -> bool {
    value.get("key").is_some_and(Value::is_string)
        && value
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path.starts_with('/'))
        && value.get("lastUsed").is_some_and(Value::is_number)
}

/// Registry files whose JavaScript reading this module does not reproduce: non-object JSON
/// that `readJson` keeps, text serde rejects (lone surrogates, out-of-range numbers),
/// entries without the written shape, relative paths and integer-index keys.
pub fn registry_needs_core(home: &Path) -> bool {
    type Valid = fn(&Value) -> bool;
    let files: [(&str, Valid); 2] = [
        ("repos.json", plain_entry),
        ("repo-paths.json", |v| {
            v.as_str().is_some_and(|p| p.starts_with('/'))
        }),
    ];
    for (name, valid) in files {
        let path = state_file(home, name);
        match std::fs::metadata(&path) {
            Ok(metadata) if !metadata.is_file() => return true,
            Ok(_) => {}
            Err(_) => continue,
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Null | Value::Bool(_) | Value::Number(_)) => {}
            Ok(Value::Object(map)) => {
                if map
                    .iter()
                    .any(|(key, value)| index_key(key) || key == "__proto__" || !valid(value))
                {
                    return true;
                }
            }
            _ => return true,
        }
    }
    false
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

fn read_object(path: &Path) -> Map<String, Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn registry(pacer_home: &Path) -> Vec<(String, Entry)> {
    let Ok(text) = std::fs::read_to_string(state_file(pacer_home, "repos.json")) else {
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

/// `fallback(path).key`.
fn local_key(path: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(path.as_bytes()));
    format!("local:{}", &digest[..12])
}

/// `registered`: the entry of the registered root or linked-checkout alias holding the
/// cached canonical path.
fn registered(reg: &Map<String, Value>, aliases: &Map<String, Value>, path: &str) -> Option<Value> {
    let real = cached_canonical(path);
    let mut roots: Vec<&String> = reg.keys().chain(aliases.keys()).collect();
    roots.sort_by_key(|root| std::cmp::Reverse(root.encode_utf16().count()));
    roots
        .into_iter()
        .find(|root| real == **root || real.starts_with(&format!("{root}/")))
        .and_then(|root| reg.get(aliases.get(root).and_then(Value::as_str).unwrap_or(root)))
        .cloned()
}

/// `repoFor(ctx, path)` in its wire key order: the registered entry with its label, else the
/// `fallback` reference of the cached canonical path.
pub fn repo_for(pacer_home: &Path, path: &str) -> Value {
    let reg = read_object(&state_file(pacer_home, "repos.json"));
    let aliases = read_object(&state_file(pacer_home, "repo-paths.json"));
    if let Some(entry) = registered(&reg, &aliases, path) {
        let pairs: Vec<(String, String)> = reg
            .values()
            .map(|e| {
                let text = |field: &str| e[field].as_str().unwrap_or_default().to_owned();
                (text("key"), text("path"))
            })
            .collect();
        let key = entry["key"].as_str().unwrap_or_default();
        return json!({"key": key, "path": entry["path"], "label": labels_for(&pairs).get(key)});
    }
    let real = cached_canonical(path);
    json!({"key": local_key(&real), "label": basename(&real), "path": real})
}

/// `repoFor(ctx, path).key`.
pub fn repo_key_for(pacer_home: &Path, path: &str) -> String {
    repo_for(pacer_home, path)["key"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn number(value: &Value, nullish: f64) -> f64 {
    match value {
        Value::Null => nullish,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// Keys of `taskRepos(ctx)`: queued and running tasks, and undismissed ones active in the last day.
fn recent_keys(ctx: &Ctx) -> Result<HashSet<String>, CoreError> {
    let mut store = pacer_store::TaskStore::open(&ctx.pacer_home).map_err(internal)?;
    let tasks = store
        .list_active_and_recent(ctx.now - RECENT_S)
        .map_err(internal)?;
    let mut keys = HashSet::new();
    for task in &tasks {
        let last = task["attempts"].as_array().and_then(|a| a.last());
        let at = |field: &str| last.map_or(0.0, |a| number(&a[field], 0.0));
        let created = task.get("createdAt").map_or(f64::NAN, |v| number(v, 0.0));
        let updated = [
            at("startedAt"),
            at("endedAt"),
            number(&task["attemptStartedAt"], 0.0),
        ]
        .into_iter()
        .fold(created, |max, n| {
            if max.is_nan() || n.is_nan() {
                f64::NAN
            } else {
                max.max(n)
            }
        });
        let active = matches!(task["state"].as_str(), Some("queued" | "running"));
        if !active
            && (json::truthy(&task["dismissed"])
                || updated < ctx.now - RECENT_S
                || updated.is_nan())
        {
            continue;
        }
        if !task["repo"].is_null() {
            if let Some(key) = task["repo"]["key"].as_str() {
                keys.insert(key.to_owned());
            }
        } else if let Some(path) = task["brief"]["repo"].as_str() {
            keys.insert(repo_key_for(&ctx.pacer_home, path));
        }
    }
    Ok(keys)
}

fn list(pacer_home: &Path, keys: &HashSet<String>) -> (Vec<RepoRef>, Vec<String>) {
    let reg = registry(pacer_home);
    let stale: Vec<String> = reg
        .iter()
        .filter(|(_, e)| {
            let probe = cached_path(&e.path);
            probe.exists == Some(false) && !probe.unreachable && !keys.contains(&e.key)
        })
        .map(|(name, _)| name.clone())
        .collect();
    for (_, entry) in &reg {
        schedule_refresh(&entry.path);
    }
    let mut entries: Vec<&Entry> = reg
        .iter()
        .filter(|(name, _)| !stale.contains(name))
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
    let repos = entries
        .into_iter()
        .filter(|e| seen.insert(e.key.clone()))
        .map(|e| RepoRef {
            key: e.key.clone(),
            path: e.path.clone(),
            label: labels.get(&e.key).cloned().unwrap_or_default(),
            unreachable: cached_path(&e.path).unreachable,
        })
        .collect();
    (repos, stale)
}

/// `listRepos(ctx, [])`: no task keys and nothing pruned or written.
pub fn list_repos_read_only(pacer_home: &Path) -> Vec<RepoRef> {
    list(pacer_home, &HashSet::new()).0
}

static LAST_PRUNED: LazyLock<Mutex<HashMap<PathBuf, f64>>> = LazyLock::new(Mutex::default);

/// At most once a minute per registry, drop entries whose checkout is gone. Unlike the
/// unlocked TypeScript write, the removal re-reads the registry under the `repos` lock.
fn prune(ctx: &Ctx, stale: &[String]) -> Result<(), CoreError> {
    let file = state_file(&ctx.pacer_home, "repos.json");
    {
        let mut last = LAST_PRUNED.lock().unwrap_or_else(PoisonError::into_inner);
        if last
            .get(&file)
            .is_some_and(|previous| ctx.now - previous < PRUNE_EVERY_S)
        {
            return Ok(());
        }
        last.insert(file.clone(), ctx.now);
    }
    if stale.is_empty() {
        return Ok(());
    }
    with_lock(ctx, "repos", LockOptions::default(), || {
        if registry_needs_core(&ctx.pacer_home) {
            return Ok(());
        }
        let mut map = read_object(&file);
        map.retain(|path, _| !stale.contains(path));
        let text = stringify(&Value::Object(map)).map_err(internal)?;
        write_private(&file, text.as_bytes()).map_err(internal)
    })
    .map_err(internal)?
}

/// `listRepos(ctx)`: registered repositories, newest first, keeping missing checkouts that
/// active or recent tasks still use. A caller that is not read-only also prunes the rest.
pub fn list_repos(ctx: &Ctx, read_only: bool) -> Result<Vec<RepoRef>, CoreError> {
    let keys = recent_keys(ctx)?;
    let (repos, stale) = list(&ctx.pacer_home, &keys);
    if !read_only {
        prune(ctx, &stale)?;
    }
    Ok(repos)
}
