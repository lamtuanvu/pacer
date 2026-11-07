//! Read-only `files.search` from `src/core/files-search.ts`: tracked-file path search over the
//! registered repositories, annotated with the running local tasks that changed each file.
//! The query never reaches a subprocess and no path outside a repository root is returned.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, LazyLock},
    time::Duration,
};

mod git;
mod matching;

pub use matching::{Scored, match_path, safe_repo_path};
pub use pacer_repos::{RepoRef, list_repos_read_only};

pub struct Limits {
    pub repos: usize,
    pub default_limit: usize,
    pub list_ms: u64,
    pub list_bytes: usize,
    pub list_paths: usize,
    pub cache_ms: u128,
    pub cache_entries: usize,
    pub changed_tasks: usize,
    pub changed_ms: u64,
    pub changed_bytes: usize,
    pub keep_hits: usize,
}

pub const LIMITS: Limits = Limits {
    repos: 20,
    default_limit: 20,
    list_ms: 2000,
    list_bytes: 8 * 1024 * 1024,
    list_paths: 200_000,
    cache_ms: 5000,
    cache_entries: 64,
    changed_tasks: 8,
    changed_ms: 1000,
    changed_bytes: 1024 * 1024,
    keep_hits: 1000,
};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub struct FilesSearchInput {
    pub query: String,
    pub repo: Option<String>,
    pub limit: Option<usize>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Zod string checks with `min`/`max` on `.length`; non-strings with a length are still measured.
fn string_issues(name: &str, value: Option<&Value>, max: usize, issues: &mut Vec<String>) {
    let Some(value) = value else {
        issues.push(format!(
            "{name}: Invalid input: expected string, received undefined"
        ));
        return;
    };
    let (length, origin, verb, unit) = match value {
        Value::String(text) => (
            Some(text.encode_utf16().count() as f64),
            "string",
            "have",
            " characters",
        ),
        Value::Array(items) => (Some(items.len() as f64), "array", "have", " items"),
        Value::Object(map) => (
            map.get("length").and_then(Value::as_f64),
            "unknown",
            "be",
            "",
        ),
        _ => (None, "", "", ""),
    };
    if !value.is_string() {
        issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(value)
        ));
    }
    if let Some(length) = length {
        if length < 1.0 {
            issues.push(format!(
                "{name}: Too small: expected {origin} to {verb} >=1{unit}"
            ));
        } else if length > max as f64 {
            issues.push(format!(
                "{name}: Too big: expected {origin} to {verb} <={max}{unit}"
            ));
        }
    }
}

fn limit_issues(value: &Value, issues: &mut Vec<String>) {
    let Some(n) = value.as_f64() else {
        issues.push(format!(
            "limit: Invalid input: expected number, received {}",
            type_name(value)
        ));
        return;
    };
    if n.fract() != 0.0 {
        issues.push("limit: Invalid input: expected int, received number".into());
        return;
    }
    if n > MAX_SAFE {
        issues.push(format!("limit: Too big: expected int to be <={MAX_SAFE}"));
    } else if n < -MAX_SAFE {
        issues.push(format!(
            "limit: Too small: expected int to be >=-{MAX_SAFE}"
        ));
    }
    if n < 1.0 {
        issues.push("limit: Too small: expected number to be >=1".into());
    } else if n > 50.0 {
        issues.push("limit: Too big: expected number to be <=50".into());
    }
}

/// `filesSearchInputSchema` as reported by `callOp`: every issue, joined, in schema order.
pub fn parse_params(params: &Value) -> Result<FilesSearchInput, CoreError> {
    let empty = Map::new();
    let map = match params {
        Value::Null => &empty,
        Value::Object(map) => map,
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let mut issues = Vec::new();
    string_issues("query", map.get("query"), 200, &mut issues);
    if let Some(repo) = map.get("repo") {
        string_issues("repo", Some(repo), 512, &mut issues);
    }
    if let Some(limit) = map.get("limit") {
        limit_issues(limit, &mut issues);
    }
    let unknown: Vec<String> = map
        .keys()
        .filter(|k| !matches!(k.as_str(), "query" | "repo" | "limit"))
        .map(|k| format!("\"{k}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown.join(", "))),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    Ok(FilesSearchInput {
        query: map
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        repo: map.get("repo").and_then(Value::as_str).map(str::to_owned),
        limit: map.get("limit").and_then(Value::as_f64).map(|n| n as usize),
    })
}

static ORCA_CWD: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"/orca/workspaces/[^/]+/pacer-(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})-([^/]+)(?:/|$)")
        .ok()
});

/// `orcaWorktreeName` from `src/exec/orca/names.ts`.
pub fn orca_worktree_name(name: &str) -> String {
    static STEPS: LazyLock<Option<[Regex; 4]>> = LazyLock::new(|| {
        Some([
            Regex::new(r"[^\p{L}\p{N}._-]+").ok()?,
            Regex::new(r"-+").ok()?,
            Regex::new(r"\.{2,}").ok()?,
            Regex::new(r"^[.-]+|[.-]+$").ok()?,
        ])
    });
    let Some([other, dashes, dots, edges]) = STEPS.as_ref() else {
        return name.to_owned();
    };
    let name = other.replace_all(name, "-");
    let name = dashes.replace_all(&name, "-");
    let name = dots.replace_all(&name, ".");
    edges.replace_all(&name, "").into_owned()
}

/// `isExecutorSession(ctx)` for the serving process's working directory. `providers` is read
/// only for an Orca workspace path and may return nothing when the strategy cannot load.
pub fn executor_session(ctx: &Ctx, cwd: &Path, providers: impl FnOnce() -> Vec<String>) -> bool {
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return true;
    }
    let cwd = cwd.to_string_lossy();
    let own = format!("{}/", ctx.pacer_home.join("worktrees").display());
    if cwd
        .strip_prefix(&own)
        .and_then(|rest| rest.split('/').nth(1))
        .is_some_and(pacer_store::is_task_id)
    {
        return true;
    }
    let Some(found) = ORCA_CWD.as_ref().and_then(|re| re.captures(&cwd)) else {
        return false;
    };
    let (Some(id), Some(name)) = (found.get(1), found.get(2)) else {
        return false;
    };
    pacer_store::is_task_id(id.as_str())
        && providers()
            .iter()
            .any(|p| orca_worktree_name(p) == name.as_str())
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b ?? ...` over JSON values: the first present, non-null value.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().flatten().copied().find(|v| !v.is_null())
}

fn progress_base(task: &Value) -> Option<String> {
    let mode = coalesce(&[task.pointer("/run/mode"), task.pointer("/placement/mode")]);
    let base = match mode.and_then(Value::as_str) {
        Some("new") => coalesce(&[task.get("baseSha"), task.get("baseBranch")]),
        Some("current") => task.get("startSha").filter(|v| !v.is_null()),
        _ => None,
    };
    base.and_then(Value::as_str).map(str::to_owned)
}

/// Git sees only what it needs to run: no inherited `GIT_*` (such as `GIT_DIR`) and no service secrets.
fn git_env(ctx: &Ctx) -> HashMap<String, String> {
    ctx.env
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "PATH" | "HOME" | "USER" | "LOGNAME" | "LANG" | "TMPDIR"
            ) || name.starts_with("LC_")
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ScanState {
    Ok,
    Skipped,
    Timeout,
    TooLarge,
    Error,
}

impl ScanState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Skipped => "skipped",
            Self::Timeout => "timeout",
            Self::TooLarge => "too_large",
            Self::Error => "error",
        }
    }
}

struct Listing {
    paths: Vec<String>,
    state: ScanState,
}

static LISTINGS: git::TtlCache<Arc<Listing>> = git::TtlCache::new();
static CHANGED: git::TtlCache<Option<Arc<Vec<String>>>> = git::TtlCache::new();

fn split_paths(stdout: &str) -> Vec<String> {
    stdout
        .split('\0')
        .filter(|p| safe_repo_path(p))
        .map(str::to_owned)
        .collect()
}

fn list_tracked(env: &HashMap<String, String>, root: &str) -> Arc<Listing> {
    LISTINGS.get(root, || {
        let argv: Vec<String> = [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-C",
            root,
            "ls-files",
            "-z",
            "--cached",
        ]
        .map(str::to_owned)
        .to_vec();
        let failed = || {
            Arc::new(Listing {
                paths: Vec::new(),
                state: ScanState::Error,
            })
        };
        let Ok(out) = git::run(
            &argv,
            Duration::from_millis(LIMITS.list_ms),
            LIMITS.list_bytes,
            env,
        ) else {
            return failed();
        };
        if out.timed_out {
            return Arc::new(Listing {
                paths: Vec::new(),
                state: ScanState::Timeout,
            });
        }
        if out.code != 0 && !out.overflow {
            return failed();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let kept = if out.overflow {
            text.rfind('\0').map_or("", |at| &text[..=at])
        } else {
            &text
        };
        let raw: Vec<&str> = kept.split('\0').collect();
        let capped = raw.len() - 1 > LIMITS.list_paths;
        let paths = raw
            .into_iter()
            .take(LIMITS.list_paths)
            .filter(|p| safe_repo_path(p))
            .map(str::to_owned)
            .collect();
        let state = if out.overflow || capped {
            ScanState::TooLarge
        } else {
            ScanState::Ok
        };
        Arc::new(Listing { paths, state })
    })
}

/// `openReadOnlyStore` + `runningTasksReadOnly`: any failure reads as no running tasks.
fn running_tasks(pacer_home: &Path) -> Vec<Value> {
    let path = pacer_home.join("state").join("tasks.db");
    if !path.exists() {
        return Vec::new();
    }
    let open = |target: &str, flags: OpenFlags| -> rusqlite::Result<Connection> {
        let db = Connection::open_with_flags(target, flags)?;
        db.execute_batch("PRAGMA query_only = ON")?;
        Ok(db)
    };
    let display = path.to_string_lossy();
    let db = match open(
        &display,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(db) => db,
        Err(_) => {
            let wal = pacer_home.join("state").join("tasks.db-wal");
            if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
                return Vec::new();
            }
            let uri = format!("file:{display}?mode=ro&immutable=1");
            match open(
                &uri,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(db) => db,
                Err(_) => return Vec::new(),
            }
        }
    };
    let has_tasks = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .and_then(|mut stmt| {
            let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(names.flatten().any(|name| name == "tasks"))
        })
        .unwrap_or(false);
    if !has_tasks {
        return Vec::new();
    }
    db.prepare("SELECT record FROM tasks WHERE state='running' ORDER BY id DESC")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows
                .flatten()
                .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
                .collect())
        })
        .unwrap_or_default()
}

type ChangedBy = HashMap<String, HashMap<String, Vec<Value>>>;
/// Repository key, `changedBy` entry and the paths one running task changed.
type TaskChanges = (String, Value, Arc<Vec<String>>);

/// Paths changed in the worktrees of running local tasks, keyed by repository key. Failures drop the annotation.
fn changed_by_running_tasks(
    pacer_home: &Path,
    env: &HashMap<String, String>,
    keys: &HashSet<String>,
) -> ChangedBy {
    let local: Vec<Value> = running_tasks(pacer_home)
        .into_iter()
        .filter(|t| {
            !js_truthy(t.pointer("/run/host"))
                && js_truthy(t.get("repo"))
                && t.pointer("/repo/key")
                    .and_then(Value::as_str)
                    .is_some_and(|k| keys.contains(k))
        })
        .take(LIMITS.changed_tasks)
        .collect();
    let found: Vec<Option<TaskChanges>> = std::thread::scope(|scope| {
        let handles: Vec<_> = local
            .iter()
            .map(|task| {
                scope.spawn(move || {
                    let worktree = coalesce(&[
                        task.pointer("/run/workdir"),
                        task.get("worktree"),
                        task.pointer("/result/worktree"),
                        task.pointer("/brief/repo"),
                    ])
                    .and_then(Value::as_str)
                    .filter(|w| w.starts_with('/'))?;
                    let base = progress_base(task);
                    let mut argv: Vec<String> = [
                        "git",
                        "-c",
                        "core.fsmonitor=false",
                        "--literal-pathspecs",
                        "-C",
                        worktree,
                        "diff",
                    ]
                    .map(str::to_owned)
                    .to_vec();
                    if base.is_some() {
                        argv.push("--merge-base".into());
                    }
                    argv.extend(
                        [
                            "--no-ext-diff",
                            "--no-textconv",
                            "--name-only",
                            "-z",
                            "--end-of-options",
                            base.as_deref().unwrap_or("HEAD"),
                            "--",
                        ]
                        .map(str::to_owned),
                    );
                    let id = task.get("id").cloned().unwrap_or(Value::Null);
                    let key = json!([id, worktree, base]).to_string();
                    let paths = CHANGED.get(&key, || {
                        let out = git::run(
                            &argv,
                            Duration::from_millis(LIMITS.changed_ms),
                            LIMITS.changed_bytes,
                            env,
                        )
                        .ok()?;
                        if out.timed_out || out.code != 0 || out.overflow {
                            return None;
                        }
                        Some(Arc::new(split_paths(&String::from_utf8_lossy(&out.stdout))))
                    })?;
                    let mut entry = Map::new();
                    entry.insert("task".into(), id);
                    if let Some(title) = task.get("title").filter(|t| js_truthy(Some(t))) {
                        entry.insert("title".into(), title.clone());
                    }
                    let repo = task
                        .pointer("/repo/key")
                        .and_then(Value::as_str)?
                        .to_owned();
                    Some((repo, Value::Object(entry), paths))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().ok().flatten())
            .collect()
    });
    let mut out: ChangedBy = HashMap::new();
    for (repo, entry, paths) in found.into_iter().flatten() {
        let by_path = out.entry(repo).or_default();
        for path in paths.iter() {
            by_path.entry(path.clone()).or_default().push(entry.clone());
        }
    }
    out
}

/// Size of a regular file reached from `root` without following any symlink below it.
pub fn size_inside(root: &str, path: &str) -> Option<u64> {
    if !safe_repo_path(path) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    let mut at = root.to_owned();
    let mut size = 0;
    for (i, part) in parts.iter().enumerate() {
        at = format!("{at}/{part}");
        let meta = std::fs::symlink_metadata(&at).ok()?;
        let kind = meta.file_type();
        let ok = if i < parts.len() - 1 {
            kind.is_dir()
        } else {
            kind.is_file()
        };
        if !ok {
            return None;
        }
        size = meta.len();
    }
    Some(size)
}

struct Hit {
    repo: String,
    repo_label: String,
    path: String,
    path_len: usize,
    ranges: Vec<[usize; 2]>,
    changed_by: Option<Vec<Value>>,
    tier: u8,
    root: String,
}

fn order(a: &Hit, b: &Hit) -> Ordering {
    a.tier
        .cmp(&b.tier)
        .then(a.changed_by.is_none().cmp(&b.changed_by.is_none()))
        .then(a.path_len.cmp(&b.path_len))
        .then_with(|| matching::cmp_utf16(&a.path, &b.path))
        .then_with(|| matching::cmp_utf16(&a.repo, &b.repo))
}

/// `searchFiles(ctx, params)`. `executor` is `isExecutorSession(ctx)`, asked only after validation.
pub fn files_search(
    ctx: &Ctx,
    params: &Value,
    executor: impl FnOnce() -> bool,
) -> Result<Value, CoreError> {
    let input = parse_params(params)?;
    if executor()
        || ctx
            .env
            .get("PACER_WORK_GRANT")
            .is_some_and(|v| !v.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "File search is not available to executor sessions",
        ));
    }
    let query = pacer_foundation::js_semantics::js_trim(&input.query).to_owned();
    if query.is_empty() {
        return Err(invalid("query must not be blank"));
    }
    let limit = input.limit.unwrap_or(LIMITS.default_limit);
    let mut repos = list_repos_read_only(&ctx.pacer_home);
    if let Some(wanted) = &input.repo {
        repos.retain(|r| &r.key == wanted);
        if repos.is_empty() {
            return Err(invalid(format!("Unknown repository \"{wanted}\""))
                .hint("Use a key from repo.list."));
        }
    }
    repos.truncate(LIMITS.repos);
    let scanned: Vec<&RepoRef> = repos.iter().filter(|r| !r.unreachable).collect();
    let env = git_env(ctx);
    let keys: HashSet<String> = scanned.iter().map(|r| r.key.clone()).collect();
    let (listed, changed) = std::thread::scope(|scope| {
        let lists: Vec<_> = scanned
            .iter()
            .map(|r| {
                let env = &env;
                scope.spawn(move || list_tracked(env, &r.path))
            })
            .collect();
        let changed = changed_by_running_tasks(&ctx.pacer_home, &env, &keys);
        let listed: Vec<Arc<Listing>> = lists
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    Arc::new(Listing {
                        paths: Vec::new(),
                        state: ScanState::Error,
                    })
                })
            })
            .collect();
        (listed, changed)
    });
    let states: HashMap<&str, ScanState> = scanned
        .iter()
        .zip(&listed)
        .map(|(r, l)| (r.key.as_str(), l.state))
        .collect();
    let mut hits: Vec<Hit> = Vec::new();
    let mut total = 0usize;
    for (r, listing) in scanned.iter().zip(&listed) {
        let touched = changed.get(&r.key);
        for path in &listing.paths {
            let Some(m) = match_path(path, &query) else {
                continue;
            };
            total += 1;
            hits.push(Hit {
                repo: r.key.clone(),
                repo_label: r.label.clone(),
                path: path.clone(),
                path_len: path.encode_utf16().count(),
                ranges: m.ranges,
                changed_by: touched.and_then(|t| t.get(path)).cloned(),
                tier: m.tier,
                root: r.path.clone(),
            });
            if hits.len() >= LIMITS.keep_hits {
                hits.sort_by(order);
                hits.truncate(limit);
            }
        }
    }
    hits.sort_by(order);
    hits.truncate(limit);
    let results: Vec<Value> = hits
        .into_iter()
        .map(|hit| {
            let size = size_inside(&hit.root, &hit.path);
            let mut out = Map::new();
            out.insert("repo".into(), Value::String(hit.repo));
            out.insert("repoLabel".into(), Value::String(hit.repo_label));
            out.insert("path".into(), Value::String(hit.path));
            out.insert("ranges".into(), json!(hit.ranges));
            if let Some(changed_by) = hit.changed_by {
                out.insert("changedBy".into(), Value::Array(changed_by));
            }
            if let Some(size) = size {
                out.insert("size".into(), json!(size));
            }
            Value::Object(out)
        })
        .collect();
    Ok(json!({
        "query": query,
        "results": results,
        "truncated": total > limit,
        "repos": repos
            .iter()
            .map(|r| json!({"key": r.key, "state": states.get(r.key.as_str()).copied().unwrap_or(ScanState::Skipped).as_str()}))
            .collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
