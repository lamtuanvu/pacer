//! `createRepoBranchReader` from `src/core/repos.ts`: picker metadata only, so successful reads
//! are reused for two seconds. A git read that does not finish in two seconds marks the
//! folder unreachable and fails the caller.
use super::mark_unreachable;
use crate::semantics::js_trim;
use pacer_foundation::api::{Code, CoreError};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{LazyLock, Mutex, PoisonError, mpsc},
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(2);
const ENTRIES: usize = 128;
const MAX_BRANCHES: usize = 50;

type Cached = ((PathBuf, String), Instant, Vec<String>);
static CACHE: LazyLock<Mutex<Vec<Cached>>> = LazyLock::new(Mutex::default);

fn not_responding(path: &str) -> CoreError {
    mark_unreachable(path);
    CoreError::new(
        Code::InvalidInput,
        format!("repo folder is not responding: {path}"),
    )
}

/// `boundedGitRead(ctx.run, ["git", "-C", path, ...args], 2000)` with the service environment.
fn git(path: &str, args: &[&str]) -> Result<(i32, String), CoreError> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| not_responding(path))?;
    let mut stdout = child.stdout.take().ok_or_else(|| not_responding(path))?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let deadline = Instant::now() + TIMEOUT;
    let Ok(bytes) = rx.recv_timeout(TIMEOUT) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(not_responding(path));
    };
    loop {
        if let Some(status) = child.try_wait().map_err(|_| not_responding(path))? {
            return Ok((
                status.code().unwrap_or(1),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(not_responding(path));
        }
        thread::sleep(Duration::from_millis(2));
    }
}

/// The current branch first, then local branches, at most fifty.
pub fn read_branches(pacer_home: &Path, path: &str) -> Result<Vec<String>, CoreError> {
    let key = (pacer_home.to_path_buf(), path.to_owned());
    let now = Instant::now();
    {
        let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        cache.retain(|(_, expires, _)| now < *expires);
        if let Some((_, _, branches)) = cache.iter().find(|(k, _, _)| *k == key) {
            return Ok(branches.clone());
        }
    }
    let current = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let all = git(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    let mut branches: Vec<String> = Vec::new();
    let head = (current.0 == 0).then(|| js_trim(&current.1).to_owned());
    let listed: Vec<String> = if all.0 == 0 {
        js_trim(&all.1).split('\n').map(str::to_owned).collect()
    } else {
        Vec::new()
    };
    for branch in head.into_iter().chain(listed) {
        if !branch.is_empty() && !branches.contains(&branch) {
            branches.push(branch);
        }
    }
    branches.truncate(MAX_BRANCHES);
    if all.0 == 0 && matches!(current.0, 0 | 1) {
        let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        cache.push((key, now + TIMEOUT, branches.clone()));
        while cache.len() > ENTRIES {
            cache.remove(0);
        }
    }
    Ok(branches)
}
