//! The repository registry from `src/core/repos.ts`. `listRepos`: the registry file, keys of
//! active and recent tasks, stale filtering and throttled pruning, over the per-process path
//! probe in `probe`. `branches` adds the local branch reads of `repo.list`; `identity` owns
//! git identity and registration of absolute checkout paths (`registerRepo`, `addRepo`);
//! `remove` owns `removeRepo`.
#![allow(clippy::result_large_err)]
mod branches;
mod git;
mod identity;
mod probe;
mod read;
mod remove;
#[cfg(test)]
mod tests;

pub use branches::read_branches;
pub use git::git_read_within;
pub use identity::{add_repo, canonical, register_repo};
pub use probe::{Probe, cached_canonical, cached_path, mark_unreachable, schedule_refresh};
pub use remove::{remove_needs_core, remove_repo};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::{js_semantics::truthy, quoted};
use read::{Entry, Registry, newest_first};
use serde_json::{Value, json};
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

/// Registries TypeScript reads in ways this crate does not reproduce: lone surrogates, nesting
/// deeper than 128 levels, a FIFO or other special file, entries `listRepos` fails on with
/// engine `TypeError` text (not an object, a non-string `key` or `path`, a `lastUsed` without a
/// primitive value), relative entry paths and alias texts (maintainer decision Q4), sort keys
/// whose NaN comparisons make the order engine-specific, aliases that throw on conversion to a
/// property key or name an inherited `Object.prototype` property, and, for a caller that
/// `writes` the registry, a directory at either path.
pub fn registry_needs_core(home: &Path, writes: bool) -> bool {
    Registry::read(home, writes).needs_core
}

/// Node `path.basename` without an extension argument.
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
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

/// `fallback(path).key`.
fn local_key(path: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(path.as_bytes()));
    format!("local:{}", &digest[..12])
}

fn pairs<'a>(entries: impl IntoIterator<Item = &'a Entry>) -> Vec<(String, String)> {
    entries
        .into_iter()
        .map(|e| (e.key.clone(), e.path.clone()))
        .collect()
}

/// `repoFor(ctx, path)` in its wire key order: the registered entry with its label, else the
/// `fallback` reference of the cached canonical path.
pub fn repo_for(pacer_home: &Path, path: &str) -> Value {
    let registry = Registry::read(pacer_home, false);
    let real = cached_canonical(path);
    if let Some(entry) = registry.registered(&real) {
        let labels = labels_for(&pairs(&registry.entries()));
        return json!({"key": entry.key, "path": entry.path, "label": labels.get(&entry.key)});
    }
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
            && (truthy(&task["dismissed"]) || updated < ctx.now - RECENT_S || updated.is_nan())
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

fn list(registry: &Registry, keys: &HashSet<String>) -> (Vec<RepoRef>, Vec<String>) {
    let entries = registry.entries();
    let stale: Vec<String> = entries
        .iter()
        .filter(|e| {
            let probe = cached_path(&e.path);
            probe.exists == Some(false) && !probe.unreachable && !keys.contains(&e.key)
        })
        .map(|e| e.name.clone())
        .collect();
    for entry in &entries {
        schedule_refresh(&entry.path);
    }
    let mut kept: Vec<&Entry> = entries
        .iter()
        .filter(|e| !stale.contains(&e.name))
        .collect();
    newest_first(&mut kept);
    let labels = labels_for(&pairs(kept.iter().copied()));
    let mut seen = HashSet::new();
    let repos = kept
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
    list(&Registry::read(pacer_home, false), &HashSet::new()).0
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
        let Registry {
            mut reg,
            needs_core,
            ..
        } = Registry::read(&ctx.pacer_home, false);
        if needs_core || file.is_dir() {
            return Ok(());
        }
        reg.retain(|name, _| !stale.contains(name));
        let text = quoted::stringify(&Value::Object(reg));
        write_private(&file, text.as_bytes()).map_err(internal)
    })
    .map_err(internal)?
}

/// `listRepos(ctx)`: registered repositories, newest first, keeping missing checkouts that
/// active or recent tasks still use. A caller that is not read-only also prunes the rest.
pub fn list_repos(ctx: &Ctx, read_only: bool) -> Result<Vec<RepoRef>, CoreError> {
    let keys = recent_keys(ctx)?;
    let (repos, stale) = list(&Registry::read(&ctx.pacer_home, false), &keys);
    if !read_only {
        prune(ctx, &stale)?;
    }
    Ok(repos)
}
