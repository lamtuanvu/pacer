//! Task diff composition aligned with `src/tasks/diff.ts` (git argv, snapshot fallback, caps).
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use thiserror::Error;

mod parse;
pub use parse::{DiffFile, cap_patch, parse_name_status, parse_numstat, select_patch_section};

#[derive(Debug, Error)]
pub enum TaskDiffError {
    #[error("unknown task")]
    NotFound,
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

pub struct DiffOptions<'a> {
    pub path: Option<&'a str>,
    pub summary_only: bool,
    pub snapshot: bool,
}

pub struct TaskDiff {
    pub base: Option<String>,
    pub worktree: String,
    pub files: Vec<DiffFile>,
    pub patch: String,
    pub untracked: Vec<String>,
    pub truncated: bool,
    pub note: Option<String>,
}

pub struct GitRunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait GitRun {
    fn run(&self, argv: &[String], timeout_ms: u64) -> Result<GitRunResult, TaskDiffError>;
}

pub struct CommandGit;

impl GitRun for CommandGit {
    fn run(&self, argv: &[String], _timeout_ms: u64) -> Result<GitRunResult, TaskDiffError> {
        use std::process::Command;
        if argv.is_empty() || argv[0] != "git" {
            return Err(TaskDiffError::InvalidInput(
                "argv must start with git".into(),
            ));
        }
        let output = Command::new(&argv[0]).args(&argv[1..]).output()?;
        Ok(GitRunResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Commit baseline for in-place vs new worktrees (Orca placement included).
pub fn progress_base(task: &Value) -> Option<String> {
    let mode = task
        .pointer("/run/mode")
        .or_else(|| task.pointer("/placement/mode"))
        .and_then(Value::as_str);
    match mode {
        Some("new") => task
            .get("baseSha")
            .or_else(|| task.get("baseBranch"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        Some("current") => task
            .get("startSha")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn snapshot_path(pacer_home: &Path, task: &Value) -> PathBuf {
    let id = task.get("id").and_then(Value::as_str).unwrap_or("");
    let attempt = task
        .pointer("/run/attempt")
        .and_then(Value::as_i64)
        .or_else(|| {
            task.get("attempts")
                .and_then(Value::as_array)
                .map(|a| a.len() as i64)
        })
        .unwrap_or(0);
    pacer_home
        .join("runs")
        .join(id)
        .join(attempt.to_string())
        .join("diff.json")
}

fn resolve_worktree(task: &Value) -> String {
    let review = task
        .pointer("/result/worktree")
        .and_then(Value::as_str)
        .filter(|w| {
            task.pointer("/run/host")
                .and_then(Value::as_str)
                .is_none_or(|host| !w.starts_with(&format!("{host}:")))
        });
    if task.pointer("/run/host").and_then(Value::as_str).is_some() {
        return review
            .map(str::to_owned)
            .or_else(|| {
                task.pointer("/brief/repo")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
    }
    task.pointer("/run/workdir")
        .or_else(|| task.get("worktree"))
        .or_else(|| task.pointer("/result/worktree"))
        .or_else(|| task.pointer("/brief/repo"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn worktree_accessible(worktree: &str) -> bool {
    if worktree.is_empty() {
        return false;
    }
    std::fs::metadata(worktree)
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

fn read_snapshot(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn apply_snapshot(stored: &Value, path: Option<&str>, summary_only: bool) -> TaskDiff {
    let files: Vec<DiffFile> = stored
        .get("files")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let full_patch = stored.get("patch").and_then(Value::as_str).unwrap_or("");
    let output = match path {
        None => full_patch.to_owned(),
        Some(p) => select_patch_section(full_patch, &files, p),
    };
    let cap_mb = if path.is_none() { 1 } else { 4 };
    let patch = if summary_only {
        String::new()
    } else {
        cap_patch(&output, cap_mb)
    };
    let truncated = !summary_only && patch != output;
    let untracked: Vec<String> = stored
        .get("untracked")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .filter(|p| path.is_none() || path == Some(p.as_str()))
                .collect()
        })
        .unwrap_or_default();
    TaskDiff {
        base: stored
            .get("base")
            .and_then(|v| v.as_str().map(str::to_owned)),
        worktree: stored
            .get("worktree")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned(),
        files,
        patch: patch.clone(),
        untracked,
        truncated,
        note: stored
            .get("note")
            .and_then(|v| v.as_str().map(str::to_owned)),
    }
}

pub fn task_diff<G: GitRun>(
    pacer_home: &Path,
    task: &Value,
    options: DiffOptions<'_>,
    git: &G,
) -> Result<TaskDiff, TaskDiffError> {
    let worktree = resolve_worktree(task);
    let base = progress_base(task);
    let host = task.pointer("/run/host").and_then(Value::as_str);
    let review_worktree = task.pointer("/result/worktree").and_then(Value::as_str);
    let review_local =
        review_worktree.is_some_and(|w| host.is_none_or(|h| !w.starts_with(&format!("{h}:"))));
    let state = task.get("state").and_then(Value::as_str).unwrap_or("");
    if host.is_some() && (!review_local || state == "running") {
        let host = host.unwrap_or("remote");
        return Ok(TaskDiff {
            base,
            worktree,
            files: vec![],
            patch: String::new(),
            untracked: vec![],
            truncated: false,
            note: Some(format!("changes are on {host} until the run ends")),
        });
    }
    if !options.snapshot
        && !worktree_accessible(&worktree)
        && let Some(stored) = read_snapshot(&snapshot_path(pacer_home, task))
    {
        return Ok(apply_snapshot(&stored, options.path, options.summary_only));
    }
    let git_cmd = |args: Vec<&str>| -> Result<String, TaskDiffError> {
        let mut argv = vec![
            "git".to_owned(),
            "--literal-pathspecs".to_owned(),
            "-C".to_owned(),
            worktree.clone(),
        ];
        argv.extend(args.into_iter().map(str::to_owned));
        let timeout = if options.summary_only { 250 } else { 10_000 };
        let result = git.run(&argv, timeout)?;
        if result.code != 0 {
            let line = result.stderr.lines().next().unwrap_or("").trim();
            let why = if line.is_empty() {
                format!("git exited with code {}", result.code)
            } else {
                line.to_owned()
            };
            return Err(TaskDiffError::Git(format!("cannot diff: {why}")));
        }
        Ok(result.stdout)
    };
    let diff_args = [
        "diff",
        if base.is_some() { "--merge-base" } else { "" },
        "--no-ext-diff",
        "--no-textconv",
        "-M",
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>();
    let against_start = base.as_deref().unwrap_or("HEAD");
    let name_output = git_cmd({
        let mut a = diff_args.clone();
        a.extend([
            "--name-status",
            "-z",
            "--end-of-options",
            against_start,
            "--",
        ]);
        a
    })?;
    let stat_output = git_cmd({
        let mut a = diff_args.clone();
        a.extend(["--numstat", "-z", "--end-of-options", against_start, "--"]);
        a
    })?;
    let mut untrack_args = vec!["ls-files", "--others", "--exclude-standard", "-z"];
    if let Some(path) = options.path {
        untrack_args.push("--");
        untrack_args.push(path);
    }
    let untracked_output = git_cmd(untrack_args)?;
    let (statuses, renamed_from) = parse_name_status(&name_output);
    let files = parse_numstat(&stat_output, &statuses);
    let untracked: Vec<String> = untracked_output
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if options.summary_only {
        return Ok(TaskDiff {
            base,
            worktree,
            files,
            patch: String::new(),
            untracked,
            truncated: false,
            note: None,
        });
    }
    let mut paths: Vec<&str> = Vec::new();
    if let Some(path) = options.path {
        if let Some(from) = renamed_from.get(path) {
            paths.push(from.as_str());
        }
        paths.push(path);
    }
    let patch_output = git_cmd({
        let mut a = diff_args;
        a.extend(["--end-of-options", against_start, "--"]);
        a.extend(paths);
        a
    })?;
    let cap_mb = if options.path.is_none() { 1 } else { 4 };
    let patch = if options.snapshot {
        patch_output.clone()
    } else {
        cap_patch(&patch_output, cap_mb)
    };
    let truncated = !options.snapshot && patch != patch_output;
    Ok(TaskDiff {
        base,
        worktree,
        files,
        patch,
        untracked,
        truncated,
        note: None,
    })
}

pub fn task_diff_to_json(diff: &TaskDiff) -> Value {
    let mut value = json!({
        "base": diff.base,
        "worktree": diff.worktree,
        "files": diff.files,
        "patch": diff.patch,
        "untracked": diff.untracked,
        "truncated": diff.truncated,
    });
    if let Some(note) = &diff.note {
        value["note"] = json!(note);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn progress_base_modes() {
        assert_eq!(
            progress_base(&json!({"run": {"mode": "new"}, "baseSha": "abc"})),
            Some("abc".into())
        );
        assert_eq!(
            progress_base(&json!({"placement": {"mode": "current"}, "startSha": "def"})),
            Some("def".into())
        );
    }

    #[test]
    fn cap_patch_truncates_by_bytes() {
        let big = "x".repeat(2 * 1024 * 1024);
        assert!(cap_patch(&big, 1).len() <= 1024 * 1024);
    }
}
