//! `createRepoBranchReader` from `src/core/repos.ts`: picker metadata only, so successful reads
//! are reused for two seconds. A git read that does not finish in two seconds marks the
//! folder unreachable and fails the caller.
use super::{git::git_read, mark_unreachable};
use pacer_foundation::api::{Code, CoreError};
use pacer_js_json::js_semantics::trim as js_trim;
use std::{
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(2);
const ENTRIES: usize = 128;
const MAX_BRANCHES: usize = 50;

type Cached = ((PathBuf, String), Instant, Vec<String>);
static CACHE: LazyLock<Mutex<Vec<Cached>>> = LazyLock::new(Mutex::default);

/// `repoGit`: a read that does not finish in time fails the caller.
fn git(path: &str, args: &[&str]) -> Result<(i32, String), CoreError> {
    git_read(path, args).ok_or_else(|| {
        mark_unreachable(path);
        CoreError::new(
            Code::InvalidInput,
            format!("repo folder is not responding: {path}"),
        )
    })
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
