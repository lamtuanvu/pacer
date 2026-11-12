//! `registerRepo` and `addRepo` from `src/core/repos.ts`: the git identity of an absolute
//! checkout path (top level, shared git directory, `origin` key) and its registration in
//! `state/repos.json`, with linked-checkout aliases in `state/repo-paths.json`.
use super::{basename, git::git_read, local_key, mark_unreachable, repo_for, state_file};
use crate::{
    probe::{absent, dirname, remember, resolve},
    read::{Registry, quote, text},
};
use pacer_config::host::repo_key;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::{js_semantics::trim, quoted};
use serde_json::{Value, json};
use std::{path::Path, sync::mpsc, thread, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(2);

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn not_responding(path: &str) -> CoreError {
    mark_unreachable(path);
    invalid(format!("repo folder is not responding: {path}"))
}

/// `withTimeout`: `None` when the filesystem call did not answer in two seconds.
fn bounded<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.recv_timeout(TIMEOUT).ok()
}

/// `canonicalAsync`: the real path, or for a missing path its canonical parent joined with
/// its name. Each resolved level is remembered by the path probe.
pub fn canonical(path: &str) -> Result<String, CoreError> {
    let p = resolve(path);
    let owned = p.clone();
    let result = match bounded(move || std::fs::canonicalize(owned)) {
        Some(Ok(real)) => real.to_string_lossy().into_owned(),
        Some(Err(error)) if absent(&error) => {
            let parent = dirname(&p);
            if parent == p {
                p.clone()
            } else {
                resolve(&format!("{}/{}", canonical(&parent)?, basename(&p)))
            }
        }
        _ => return Err(not_responding(&p)),
    };
    remember(&p, &result);
    Ok(result)
}

enum Identity {
    Known {
        top: String,
        main: String,
        key: Option<String>,
    },
    Unresolved,
}

/// The git half of `registerRepo`; a timed-out read fails the caller, anything else that
/// keeps identity unknown is `Unresolved`.
fn identify(path: &str) -> Result<Identity, CoreError> {
    let git = |dir: &str, args: &[&str]| git_read(dir, args).ok_or_else(|| not_responding(path));
    let canon = |p: &str| match canonical(p) {
        Ok(real) => Ok(Some(real)),
        Err(error) if error.message.contains("timed out") => Err(not_responding(path)),
        Err(_) => Ok(None),
    };
    let (code, stdout) = git(
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
        ],
    )?;
    let mut lines = trim(&stdout).split('\n');
    let (root, common) = (lines.next().unwrap_or(""), lines.next().unwrap_or(""));
    if code != 0 || root.is_empty() || common.is_empty() {
        return Ok(Identity::Unresolved);
    }
    let common = if Path::new(common).is_absolute() {
        resolve(common)
    } else {
        resolve(&format!("{path}/{common}"))
    };
    let Some(top) = canon(root)? else {
        return Ok(Identity::Unresolved);
    };
    let Some(main) = canon(&dirname(&common))? else {
        return Ok(Identity::Unresolved);
    };
    let (code, stdout) = git(&main, &["remote", "get-url", "origin"])?;
    let key = if code == 0 {
        repo_key(trim(&stdout))
    } else {
        let (code, stdout) = git(&main, &["remote"])?;
        if code != 0 || trim(&stdout).split('\n').any(|name| name == "origin") {
            return Ok(Identity::Unresolved);
        }
        None
    };
    Ok(Identity::Known { top, main, key })
}

/// `registerRepo(ctx, path, strict)`: identity, then the registry entry (and a linked
/// checkout's alias) stamped `ctx.now`, returning `repoFor` of the shared checkout. Without
/// identity a strict caller fails and others get `repoFor(path)` marked `identityUnverified`.
pub fn register_repo(ctx: &Ctx, path: &str, strict: bool) -> Result<Value, CoreError> {
    let unresolved = || {
        if strict {
            return Err(invalid("Cannot establish repository identity for project routing")
                .hint("Restore Git access and retry; project policy cannot safely fall back to global routing."));
        }
        let mut repo = repo_for(&ctx.pacer_home, path);
        repo["identityUnverified"] = json!(true);
        Ok(repo)
    };
    let owned = path.to_owned();
    match bounded(move || std::fs::metadata(owned)) {
        Some(Ok(metadata)) if !metadata.is_dir() => return unresolved(),
        Some(Err(error)) if absent(&error) => return unresolved(),
        Some(Ok(_)) => {}
        _ => return Err(not_responding(path)),
    }
    canonical(path)?;
    let Identity::Known { top, main, key } = identify(path)? else {
        return unresolved();
    };
    let Registry {
        mut reg,
        mut aliases,
        ..
    } = Registry::read(&ctx.pacer_home, true);
    let key = key
        .or_else(|| reg.get(&quote(&main))?.get("key")?.as_str().map(text))
        .unwrap_or_else(|| local_key(&main));
    reg.insert(
        quote(&main),
        quoted::from_utf8(json!({"key": key, "path": main, "lastUsed": ctx.now})),
    );
    if top != main {
        aliases.insert(quote(&top), Value::String(quote(&main)));
        let aliases_file = state_file(&ctx.pacer_home, "repo-paths.json");
        write_json(&aliases_file, &Value::Object(aliases))?;
        reg.shift_remove(&quote(&top));
    }
    let file = state_file(&ctx.pacer_home, "repos.json");
    write_json(&file, &Value::Object(reg))?;
    Ok(repo_for(&ctx.pacer_home, &main))
}

fn write_json(file: &Path, value: &Value) -> Result<(), CoreError> {
    write_private(file, quoted::stringify(value).as_bytes()).map_err(internal)
}

/// `addRepo`: an absolute path inside a git work tree, registered under the `repos` lock.
pub fn add_repo(ctx: &Ctx, path: &str) -> Result<Value, CoreError> {
    if !path.starts_with('/') {
        return Err(invalid("path must be absolute"));
    }
    let (code, _) =
        git_read(path, &["rev-parse", "--show-toplevel"]).ok_or_else(|| not_responding(path))?;
    if code != 0 {
        return Err(invalid("path is not a git repository"));
    }
    with_lock(ctx, "repos", LockOptions::default(), || {
        register_repo(ctx, path, false)
    })
    .map_err(internal)?
}
