//! Bounded Git identity and file-backed repository registration.

use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    fsutil::write_private,
    lock::{LockOptions, with_lock_async},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use url::Url;

use crate::repos::requires_core_repo_parser;

const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const GIT_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
struct GitRead {
    code: i32,
    stdout: String,
}
#[derive(Clone, Debug)]
enum GitError {
    Timeout,
    Io,
    TooLarge,
}

trait GitReader {
    async fn read(&self, ctx: &Ctx, path: &Path, args: &[&str]) -> Result<GitRead, GitError>;
}
struct SystemGit;
impl GitReader for SystemGit {
    async fn read(&self, ctx: &Ctx, path: &Path, args: &[&str]) -> Result<GitRead, GitError> {
        git(ctx, path, args).await
    }
}

async fn git(ctx: &Ctx, path: &Path, args: &[&str]) -> Result<GitRead, GitError> {
    let mut command = Command::new("git");
    command.arg("-C").arg(path).args(args).kill_on_drop(true);
    command.envs(&ctx.env);
    bounded_output(command).await
}

async fn read_bounded<R: AsyncRead + Unpin>(mut stream: R) -> Result<Vec<u8>, GitError> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = stream.read(&mut chunk).await.map_err(|_| GitError::Io)?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > GIT_OUTPUT_LIMIT {
            return Err(GitError::TooLarge);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

async fn bounded_output(mut command: Command) -> Result<GitRead, GitError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| GitError::Io)?;
    let stdout = child.stdout.take().ok_or(GitError::Io)?;
    let stderr = child.stderr.take().ok_or(GitError::Io)?;
    let result = tokio::time::timeout(GIT_TIMEOUT, async {
        tokio::try_join!(read_bounded(stdout), read_bounded(stderr), async {
            child.wait().await.map_err(|_| GitError::Io)
        })
    })
    .await;
    match result {
        Ok(Ok((stdout, _, status))) => Ok(GitRead {
            code: status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
        }),
        Ok(Err(error)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(error)
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(GitError::Timeout)
        }
    }
}

async fn canonical(path: &Path) -> Result<PathBuf, GitError> {
    tokio::time::timeout(GIT_TIMEOUT, tokio::fs::canonicalize(path))
        .await
        .map_err(|_| GitError::Timeout)?
        .map_err(|_| GitError::Io)
}

async fn directory(path: &Path) -> Result<bool, GitError> {
    tokio::time::timeout(GIT_TIMEOUT, tokio::fs::metadata(path))
        .await
        .map_err(|_| GitError::Timeout)?
        .map(|metadata| metadata.is_dir())
        .map_err(|_| GitError::Io)
}

fn local_key(path: &str) -> String {
    let hash = Sha256::digest(path.as_bytes());
    format!("local:{:x}", hash)[..18].to_owned()
}

fn canonical_key(key: &str) -> bool {
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 3 || key.ends_with(".git") {
        return false;
    }
    let host = parts[0].as_bytes();
    !host.is_empty()
        && (host[0].is_ascii_lowercase() || host[0].is_ascii_digit())
        && host
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
        && parts[1..].iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
                })
        })
}

fn repo_key(raw: &str) -> Option<String> {
    let (host, path) = if let Some((user_host, path)) = raw.split_once(':') {
        if !raw.contains("://") {
            let (user, host) = user_host.split_once('@')?;
            if user.is_empty()
                || user
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b':'))
                || host.is_empty()
                || !host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
                || path.bytes().any(|b| b.is_ascii_whitespace())
            {
                return None;
            }
            (host.to_owned(), path.to_owned())
        } else {
            url_host_path(raw)?
        }
    } else {
        url_host_path(raw)?
    };
    let key = format!("{host}/{path}").to_ascii_lowercase();
    let key = key.strip_suffix(".git").unwrap_or(&key).to_owned();
    canonical_key(&key).then_some(key)
}

fn url_host_path(raw: &str) -> Option<(String, String)> {
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "https" | "ssh")
        || url.query().is_some()
        || url.fragment().is_some()
        || url.password().is_some()
    {
        return None;
    }
    Some((
        url.host_str()?.to_owned(),
        url.path().trim_start_matches('/').to_owned(),
    ))
}

fn read_map(path: &Path) -> Map<String, Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn state_file(ctx: &Ctx, name: &str) -> PathBuf {
    ctx.pacer_home.join("state").join(name)
}
fn conflict(message: &str) -> CoreError {
    CoreError::new(Code::Conflict, message)
}
fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn guard_state(ctx: &Ctx) -> Result<(), CoreError> {
    let state = ctx.pacer_home.join("state");
    if fs::symlink_metadata(&state).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(invalid("state directory is a symlink"));
    }
    for path in [
        state_file(ctx, "repos.json"),
        state_file(ctx, "repo-paths.json"),
    ] {
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(invalid("repository state file must be regular"));
        }
        match fs::metadata(&path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(invalid("repository state file must be regular"));
            }
            Ok(_) if fs::read(&path).is_err() => {
                return Err(conflict("repository registry is unreadable"));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(conflict("repository registry is unreadable"));
            }
            _ => {}
        }
    }
    if requires_core_repo_parser(ctx) {
        return Err(conflict("repository registry changed during registration"));
    }
    Ok(())
}

fn short(key: &str, path: &str) -> String {
    if key.starts_with("local:") {
        Path::new(path)
            .file_name()
            .map_or("", |name| name.to_str().unwrap_or(""))
            .to_owned()
    } else {
        key.split_once('/').map_or("", |(_, rest)| rest).to_owned()
    }
}

fn label(registry: &Map<String, Value>, key: &str, path: &str) -> String {
    let name = short(key, path);
    let duplicate = registry.values().any(|entry| {
        let other_key = entry.get("key").and_then(Value::as_str).unwrap_or("");
        let other_path = entry.get("path").and_then(Value::as_str).unwrap_or("");
        other_key != key && short(other_key, other_path) == name
    });
    if !duplicate {
        name
    } else if key.starts_with("local:") {
        format!("{name} ({key})")
    } else {
        key.to_owned()
    }
}

fn fallback(ctx: &Ctx, path: &Path) -> Value {
    let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = real.to_string_lossy().into_owned();
    let reg = read_map(&state_file(ctx, "repos.json"));
    let aliases = read_map(&state_file(ctx, "repo-paths.json"));
    let root = reg
        .keys()
        .chain(aliases.keys())
        .filter(|root| path == root.as_str() || path.starts_with(&format!("{root}/")))
        .max_by_key(|root| root.len());
    let known = root.and_then(|root| {
        let main = aliases.get(root).and_then(Value::as_str).unwrap_or(root);
        reg.get(main)
    });
    if let Some(entry) = known {
        let key = entry.get("key").and_then(Value::as_str).unwrap_or("");
        let main = entry.get("path").and_then(Value::as_str).unwrap_or("");
        return json!({"key":key,"path":main,"label":label(&reg,key,main),"identityUnverified":true});
    }
    json!({"key":local_key(&path),"label":short("local:",&path),"path":path,"identityUnverified":true})
}

fn write_registration(
    ctx: &Ctx,
    main: &str,
    top: &str,
    origin: Option<String>,
) -> Result<Value, CoreError> {
    guard_state(ctx)?;
    let repos_path = state_file(ctx, "repos.json");
    let aliases_path = state_file(ctx, "repo-paths.json");
    let mut reg = read_map(&repos_path);
    let key = origin
        .or_else(|| {
            reg.get(main)
                .and_then(|entry| entry.get("key"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| local_key(main));
    let used = if ctx.now.fract() == 0.0 && ctx.now >= i64::MIN as f64 && ctx.now <= i64::MAX as f64
    {
        json!(ctx.now as i64)
    } else {
        json!(ctx.now)
    };
    reg.insert(
        main.to_owned(),
        json!({"key":key,"path":main,"lastUsed":used}),
    );
    if top != main {
        let mut aliases = read_map(&aliases_path);
        aliases.insert(top.to_owned(), Value::String(main.to_owned()));
        write_private(
            &aliases_path,
            &serde_json::to_vec(&aliases).map_err(|e| invalid(e.to_string()))?,
        )
        .map_err(|e| invalid(e.to_string()))?;
        reg.remove(top);
    }
    write_private(
        &repos_path,
        &serde_json::to_vec(&reg).map_err(|e| invalid(e.to_string()))?,
    )
    .map_err(|e| invalid(e.to_string()))?;
    Ok(json!({"key":key,"path":main,"label":label(&reg,&key,main)}))
}

pub async fn add_repo(ctx: &Ctx, path: &str) -> Result<Value, CoreError> {
    add_repo_with(ctx, path, &SystemGit).await
}

async fn add_repo_with<R: GitReader>(
    ctx: &Ctx,
    path: &str,
    reader: &R,
) -> Result<Value, CoreError> {
    if path.is_empty() {
        return Err(invalid(
            "path: Too small: expected string to have >=1 characters",
        ));
    }
    if path.encode_utf16().count() > 4096 {
        return Err(invalid(
            "path: Too big: expected string to have <=4096 characters",
        ));
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(invalid("path must be absolute"));
    }
    let preflight = reader
        .read(ctx, path, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| invalid(format!("repo folder is not responding: {}", path.display())))?;
    if preflight.code != 0 {
        return Err(invalid("path is not a git repository"));
    }
    with_lock_async(ctx, "repos", LockOptions::default(), || async {
        resolve_and_register(ctx, path, reader).await
    })
    .await
    .map_err(|e| invalid(e.to_string()))?
}

async fn resolve_and_register<R: GitReader>(
    ctx: &Ctx,
    path: &Path,
    reader: &R,
) -> Result<Value, CoreError> {
    guard_state(ctx)?;
    match directory(path).await {
        Ok(true) => {}
        Ok(false) => return Ok(fallback(ctx, path)),
        Err(GitError::Timeout) => {
            return Err(invalid(format!(
                "repo folder is not responding: {}",
                path.display()
            )));
        }
        Err(GitError::Io | GitError::TooLarge) => return Ok(fallback(ctx, path)),
    }
    let info = match reader
        .read(
            ctx,
            path,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-common-dir",
            ],
        )
        .await
    {
        Ok(info) if info.code == 0 => info,
        Ok(_) | Err(GitError::Io | GitError::TooLarge) => return Ok(fallback(ctx, path)),
        Err(GitError::Timeout) => {
            return Err(invalid(format!(
                "repo folder is not responding: {}",
                path.display()
            )));
        }
    };
    let mut lines = info.stdout.trim().lines();
    let Some(root) = lines.next().filter(|value| !value.is_empty()) else {
        return Ok(fallback(ctx, path));
    };
    let Some(common) = lines.next().filter(|value| !value.is_empty()) else {
        return Ok(fallback(ctx, path));
    };
    let top = canonical(Path::new(root))
        .await
        .map_err(|_| invalid(format!("repo folder is not responding: {}", root)))?;
    let common = canonical(&path.join(common))
        .await
        .map_err(|_| invalid(format!("repo folder is not responding: {}", path.display())))?;
    let Some(main) = common.parent() else {
        return Ok(fallback(ctx, path));
    };
    let main = main.to_string_lossy().into_owned();
    let top = top.to_string_lossy().into_owned();
    let origin = match reader
        .read(ctx, Path::new(&main), &["remote", "get-url", "origin"])
        .await
    {
        Ok(value) if value.code == 0 => repo_key(value.stdout.trim()),
        Ok(_) => {
            let remotes = reader.read(ctx, Path::new(&main), &["remote"]).await;
            match remotes {
                Ok(value)
                    if value.code == 0
                        && !value.stdout.lines().any(|line| line.trim() == "origin") =>
                {
                    None
                }
                Ok(_) | Err(GitError::Io | GitError::TooLarge) => return Ok(fallback(ctx, path)),
                Err(GitError::Timeout) => {
                    return Err(invalid(format!(
                        "repo folder is not responding: {}",
                        path.display()
                    )));
                }
            }
        }
        Err(GitError::Io | GitError::TooLarge) => return Ok(fallback(ctx, path)),
        Err(GitError::Timeout) => {
            return Err(invalid(format!(
                "repo folder is not responding: {}",
                path.display()
            )));
        }
    };
    write_registration(ctx, &main, &top, origin)
}

fn add(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(async move {
        if !params.is_object() && !params.is_null() {
            let received = match params {
                Value::Array(_) => "array",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => "unknown",
            };
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {received}"
            )));
        }
        let path = params.get("path").and_then(Value::as_str).ok_or_else(|| {
            let received = match params.get("path") {
                None => "undefined",
                Some(Value::Number(_)) => "number",
                Some(Value::Bool(_)) => "boolean",
                Some(Value::Null) => "null",
                Some(Value::Array(_)) => "array",
                Some(Value::Object(_)) => "object",
                Some(Value::String(_)) => unreachable!(),
            };
            invalid(format!(
                "path: Invalid input: expected string, received {received}"
            ))
        })?;
        add_repo(ctx, path).await
    })
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "repo.add",
        call: add,
    }]
}

#[cfg(test)]
#[path = "repo_add_tests.rs"]
mod tests;
