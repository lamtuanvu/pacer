use super::*;
use crate::{NativeGit, native_process::Image};
use std::time::Duration;

pub(super) fn selected_git(
    home: &Path,
    repo: &str,
    env: &HashMap<String, String>,
) -> Option<NativeGit> {
    let selected = std::env::split_paths(env.get("PATH")?)
        .map(|p| p.join("git"))
        .find(|p| p.is_absolute() && p.to_str().is_some_and(|p| Image::pin(p, true).is_ok()))?;
    NativeGit::prepare(home, Path::new(repo), selected.to_str()?, env).ok()
}
impl OrcaAttempt {
    pub(super) async fn fingerprint(&self) -> Option<String> {
        let git = self.git.as_ref()?;
        let repo = self.worktree.as_deref().unwrap_or(&self.spec.top);
        repo_fingerprint(git, repo).await
    }
}
async fn repo_fingerprint(git: &NativeGit, repo: &str) -> Option<String> {
    let mut hash = Sha256::new();
    let mut untracked = String::new();
    for args in [
        vec!["rev-parse", "HEAD"],
        vec!["diff", "--binary", "HEAD"],
        vec!["ls-files", "--others", "--exclude-standard", "-z"],
    ] {
        let argv = ["-C", repo]
            .into_iter()
            .chain(args)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let result = git
            .command(
                &argv,
                &[],
                4 * 1024 * 1024,
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .ok()?;
        if result.code != 0 {
            return None;
        }
        let stdout = String::from_utf8_lossy(&result.stdout);
        hash.update(stdout.as_bytes());
        hash.update([0]);
        untracked = stdout.into_owned();
    }
    for path in untracked.split('\0').filter(|s| !s.is_empty()) {
        let file = Path::new(repo).join(path);
        hash.update(path.as_bytes());
        hash.update([0]);
        let metadata = std::fs::symlink_metadata(&file).ok()?;
        if metadata.is_symlink() {
            hash.update(std::fs::read_link(file).ok()?.to_string_lossy().as_bytes());
        } else {
            hash.update(std::fs::read(file).ok()?);
        }
        hash.update([0]);
    }
    Some(format!("{:x}", hash.finalize()))
}
fn matches(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(text))
}
pub(super) fn detect_limit(
    provider: &str,
    code: i64,
    timed_out: bool,
    stderr: &str,
    stdout: &str,
) -> bool {
    if code == 0 || timed_out {
        return false;
    }
    let text = super::supervision::tail(&format!("{stderr}\n{stdout}"), 8000);
    matches(
        r"(?i-u:rate[ _-]?limit|usage limit|quota (?:exceeded|exhausted|reached)|too many requests|\b429\b|limit (?:reached|exceeded)|out of (?:credits|quota)|insufficient (?:quota|credits|balance))",
        &text,
    ) || (provider.split('@').next() == Some("claude-code")
        && matches(
            r"(?i-u:you've hit your [\w-]+ limit)",
            &text.replace('’', "'"),
        ))
}
pub(super) fn broken_reason(
    code: i64,
    timed_out: bool,
    duration: f64,
    unchanged: Option<bool>,
    stderr: &str,
) -> Option<String> {
    if unchanged == Some(false) || !(0.0..=10.0).contains(&duration) || code == 0 || timed_out {
        return None;
    }
    let text = super::supervision::tail(stderr, 8000);
    // JavaScript's non-Unicode regex uses ASCII word boundaries and excludes
    // all four line terminators from dot. Normalize only its whitespace set.
    let flat = |s: &str| {
        let mut out = String::new();
        let mut whitespace = false;
        for c in s.chars() {
            if crate::js_semantics::trim(&c.to_string()).is_empty() {
                if !whitespace {
                    out.push(' ');
                }
                whitespace = true;
            } else {
                out.push(c);
                whitespace = false;
            }
        }
        out
    };
    let whitespace = flat(&text);
    let usage = matches(
        r"(?i-u:(?:unknown|unrecognized|unexpected|invalid) (?:option|argument|flag)\b|(?:option|argument|flag) (?u:[^\n\r\x{2028}\x{2029}])*?(?:requires|expected|missing|not recognized|not supported)|error: -p took (?u:[^\n\r\x{2028}\x{2029}])*? as its prompt|\bENOENT\b|command not found|executable not found|ConnectionRefused|ECONNREFUSED|connection refused)",
        &text,
    ) || matches(
        r"(?i-u:usage: *(?:agy|codex|cursor-agent|agent|claude|opencode)\b)",
        &whitespace,
    );
    if ![126, 127].contains(&code) && !usage {
        return None;
    }
    let detail = flat(crate::js_semantics::trim(&text));
    Some(slice(
        if detail.is_empty() {
            return Some(format!("CLI exited with code {code}"));
        } else {
            &detail
        },
        0,
        500,
    ))
}

#[cfg(test)]
mod tests;
