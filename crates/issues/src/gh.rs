//! Running the user's `gh` (`defaultGh`, `limited`, `ghFailure` and `parseGh` in
//! `src/core/issue-import.ts`): an argument vector, an allowlisted environment, a 20 s deadline,
//! a 4 MiB stdout cap, at most two concurrent runs and eight waiting.
use crate::text::{clean_line, strip_controls};
use crate::{IssueError, fail};
use pacer_foundation::api::Code;
use regex::Regex;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncReadExt, sync::Semaphore};

#[cfg(not(test))]
const TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const TIMEOUT: Duration = Duration::from_secs(2);
const GRACE: Duration = Duration::from_secs(2);
pub(crate) const OUTPUT_MAX: usize = 4 * 1024 * 1024;
const STDERR_MAX: usize = 1024 * 1024;
const CONCURRENCY: usize = 2;
const QUEUE_MAX: usize = 8;

// What gh needs to find its login, config, proxy and certificates. Everything else in the service
// environment (pacer tokens, endpoint keys) stays out of the child. GH_HOST, GH_REPO and GH_DEBUG
// are not listed: the host and repository are always named in argv.
const ENV_NAMES: &[&str] = &[
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "TZ",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_CONFIG_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "SystemRoot",
];
const ENV_PREFIXES: &[&str] = &["LC_", "XDG_"];

/// `ghEnv`: the allowlisted variables plus the non-interactive gh settings.
pub(crate) fn gh_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = env
        .iter()
        .filter(|(name, _)| {
            ENV_NAMES.contains(&name.as_str()) || ENV_PREFIXES.iter().any(|p| name.starts_with(p))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    for (name, value) in [
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GH_SPINNER_DISABLED", "1"),
        ("NO_COLOR", "1"),
        ("CLICOLOR", "0"),
    ] {
        out.insert(name.into(), value.into());
    }
    out
}

/// `Bun.which("gh")` over the service `PATH`.
fn which(env: &HashMap<String, String>, bin: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    env.get("PATH")?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(bin))
        .find(|path| {
            std::fs::metadata(path)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

pub(crate) struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub overflow: bool,
}

fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid.and_then(|p| rustix::process::Pid::from_raw(p as i32)) {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
}

async fn read_capped<R: AsyncReadExt + Unpin>(
    reader: Option<R>,
    cap: usize,
    pid: Option<u32>,
    kill_on_overflow: bool,
) -> (Vec<u8>, bool) {
    let Some(mut reader) = reader else {
        return (Vec::new(), false);
    };
    let (mut bytes, mut chunk, mut overflow) = (Vec::new(), [0u8; 16 * 1024], false);
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(_) if overflow => {}
            Ok(n) if bytes.len() + n > cap => {
                overflow = true;
                if kill_on_overflow {
                    kill_group(pid);
                    break;
                }
            }
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
        }
    }
    (bytes, overflow)
}

type Output = (Vec<u8>, bool);

/// The exit status and both streams; a descendant that keeps a pipe open keeps this pending.
async fn finish(
    child: &mut tokio::process::Child,
    out: &mut tokio::task::JoinHandle<Output>,
    err: &mut tokio::task::JoinHandle<Output>,
) -> (Option<std::process::ExitStatus>, Output, Output) {
    let status = child.wait().await.ok();
    (
        status,
        out.await.unwrap_or_default(),
        err.await.unwrap_or_default(),
    )
}

/// `execProcess` with `maxStdoutBytes`: a spawn failure exits 127; the deadline covers the exit
/// and both streams, and past it the process group is killed and given two seconds to finish.
async fn run(bin: &Path, argv: &[String], mut env: HashMap<String, String>) -> Run {
    use std::os::unix::process::CommandExt as _;
    if let Ok(cwd) = std::env::current_dir() {
        env.insert("PWD".into(), cwd.to_string_lossy().into_owned());
    }
    let mut command = std::process::Command::new(bin);
    command
        .args(argv)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Run {
                code: 127,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
                overflow: false,
            };
        }
    };
    let pid = child.id();
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let mut out = tokio::spawn(read_capped(stdout, OUTPUT_MAX, pid, true));
    let mut err = tokio::spawn(read_capped(stderr, STDERR_MAX, pid, false));
    let finished = tokio::time::timeout(TIMEOUT, finish(&mut child, &mut out, &mut err)).await;
    let timed_out = finished.is_err();
    let (status, (stdout, overflow), (stderr, _)) = match finished {
        Ok(done) => done,
        Err(_) => {
            kill_group(pid);
            let late = tokio::time::timeout(GRACE, finish(&mut child, &mut out, &mut err)).await;
            out.abort();
            err.abort();
            late.unwrap_or_else(|_| {
                (
                    child.try_wait().ok().flatten(),
                    (Vec::new(), false),
                    (Vec::new(), false),
                )
            })
        }
    };
    let mut code = status.and_then(|s| s.code()).unwrap_or(1);
    if overflow && code == 0 {
        code = 1;
    }
    Run {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
        overflow,
    }
}

static RUNNING: Semaphore = Semaphore::const_new(CONCURRENCY);
static WAITING: AtomicUsize = AtomicUsize::new(0);

struct Waiting;
impl Drop for Waiting {
    fn drop(&mut self) {
        WAITING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// `limited(() => defaultGh(ctx)(argv))`: the gh lookup and run under the shared concurrency cap.
pub(crate) async fn limited_gh(
    env: &HashMap<String, String>,
    argv: Vec<String>,
) -> Result<Run, IssueError> {
    let permit = match RUNNING.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            let waiting = Waiting;
            if WAITING.fetch_add(1, Ordering::SeqCst) >= QUEUE_MAX {
                return Err(fail(
                    Code::Unavailable,
                    "gh_failed",
                    "Too many GitHub requests are waiting",
                    Some("Wait a moment and retry."),
                ));
            }
            let permit = RUNNING.acquire().await;
            drop(waiting);
            permit.map_err(|_| fail(Code::Unavailable, "gh_failed", "gh is unavailable", None))?
        }
    };
    let Some(bin) = which(env, "gh") else {
        return Err(fail(
            Code::Unavailable,
            "gh_missing",
            "The GitHub CLI (gh) is not installed",
            Some("Install gh from https://cli.github.com and run gh auth login."),
        ));
    };
    // The user's own gh login is used as is; pacer never reads or stores the token.
    let result = run(&bin, &argv, gh_env(env)).await;
    drop(permit);
    Ok(result)
}

static RATE_LIMIT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i-u)rate limit|HTTP 429|abuse detection").ok());
static UNAUTHENTICATED: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)HTTP 401|gh auth login|not logged in|authentication required|Bad credentials",
    )
    .ok()
});
static NO_REPO: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i-u)Could not resolve to a Repository").ok());
static NO_ISSUE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i-u)Could not resolve to an issue|HTTP 404|no issue found|not found").ok()
});

fn matches(pattern: &LazyLock<Option<Regex>>, text: &str) -> bool {
    pattern.as_ref().is_some_and(|re| re.is_match(text))
}

/// The first 64 Ki UTF-16 code units, dropping half of a split surrogate pair as the control
/// filter does in TypeScript.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum What {
    Issue,
    Repo,
}

/// `ghFailure`: a failed gh run as a typed error.
fn failure(run: &Run, what: What) -> IssueError {
    let stderr = strip_controls(utf16_prefix(&run.stderr, 64 * 1024));
    if run.timed_out {
        return fail(
            Code::Unavailable,
            "gh_failed",
            "gh did not answer in time",
            Some("Check the network connection and retry."),
        );
    }
    if matches(&RATE_LIMIT, &stderr) {
        return fail(
            Code::RateLimited,
            "rate_limited",
            "GitHub rate limit reached",
            Some("Wait a few minutes and retry."),
        );
    }
    if run.code == 4 || matches(&UNAUTHENTICATED, &stderr) {
        return fail(
            Code::NotAllowed,
            "gh_unauthenticated",
            "gh is not signed in to github.com",
            Some("Run gh auth login -h github.com, then retry."),
        );
    }
    if matches(&NO_REPO, &stderr) {
        return fail(
            Code::NotFound,
            "repo_not_found",
            "GitHub repository not found or not visible to your gh login",
            None,
        );
    }
    if what == What::Issue && matches(&NO_ISSUE, &stderr) {
        return fail(Code::NotFound, "issue_not_found", "Issue not found", None);
    }
    let first = stderr
        .split('\n')
        .find(|line| !pacer_foundation::js_semantics::js_trim(line).is_empty())
        .map_or_else(
            || format!("gh exited with code {}", run.code),
            str::to_owned,
        );
    let (line, _) = clean_line(&first, 200);
    fail(
        Code::Unavailable,
        "gh_failed",
        &format!("gh failed: {line}"),
        None,
    )
}

/// `parseGh` up to `JSON.parse`; the caller checks the shape.
pub(crate) fn parse(run: &Run, what: What) -> Result<serde_json::Value, IssueError> {
    if run.overflow {
        return Err(fail(
            Code::Unavailable,
            "gh_failed",
            "gh returned more output than expected",
            None,
        ));
    }
    if run.code != 0 || run.timed_out {
        return Err(failure(run, what));
    }
    serde_json::from_str(&run.stdout).map_err(|_| {
        fail(
            Code::Unavailable,
            "gh_failed",
            "gh returned output that is not JSON",
            None,
        )
    })
}
