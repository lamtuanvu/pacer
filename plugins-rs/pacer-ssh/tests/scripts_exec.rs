//! End-to-end execution tests of the fixed SSH shell programs, ported from
//! `test/plugins-ssh-provider.test.ts` and `test/plugins-ssh-prepare-recover.test.ts`.
//!
//! Each test runs the real program with `sh -c <SCRIPT> pacer-prepare <args>`
//! under a temporary `HOME`, with a `git` wrapper on `PATH` so a fetch-heavy
//! script can be observed without touching the real repository or the
//! maintainer's install. The programs under test are taken byte-for-byte from
//! `tests/fixtures/scripts.json` (populated from `test/plugin-parity`), the
//! same source the crate's own `*_SCRIPT` consts are pinned against.
//!
//! These need a POSIX `sh` and a working `git` on the machine.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// Load the authoritative script bundle that `test/plugin-parity` writes.
fn scripts() -> HashMap<String, String> {
    let raw = std::fs::read_to_string("tests/fixtures/scripts.json")
        .expect("tests/fixtures/scripts.json must exist");
    let value: serde_json::Value =
        serde_json::from_str(&raw).expect("tests/fixtures/scripts.json must be valid JSON");
    let map = value.as_object().expect("scripts.json must be an object");
    map.iter()
        .map(|(k, v)| (k.clone(), v.as_str().expect("script must be a string").to_owned()))
        .collect()
}

/// Concatenated shell source for the named scripts, byte-for-byte from the
/// bundle (each program ends with its own newline, so they compose safely).
fn script(names: &[&str]) -> String {
    let all = scripts();
    let mut joined = String::new();
    for name in names {
        let s = all
            .get(*name)
            .unwrap_or_else(|| panic!("script {name} must be present in the bundle"));
        joined.push_str(s);
        joined.push('\n');
    }
    joined
}

/// A fresh unique temporary directory to act as `HOME` for one script.
fn temp_home(tag: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "pacer-rs-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("create temp home");
    dir
}

/// The absolute path to the real `git`, resolved from the current PATH so a
/// script's overridden PATH can still reach it through `REAL_GIT`.
fn real_git() -> String {
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = dir.join("git");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    panic!("git is required for the SSH script execution tests");
}

struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_cmd(cmd: &mut Command) -> Ran {
    let out = cmd.output().expect("spawn script");
    Ran {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Run `sh -c <scripts...> pacer-prepare <args>` under `HOME` and extra env,
/// inheriting the machine environment so `git` and `sh` resolve.
fn run_scripts(home: &Path, body: &str, args: &[&str], extra: &[(String, String)]) -> Ran {
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(body).arg("pacer-prepare");
    for a in args {
        cmd.arg(a);
    }
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("HOME", home);
    for (k, v) in extra {
        cmd.env(k, v);
    }
    run_cmd(&mut cmd)
}

/// A prepared fixture: temp `HOME` with a repository and a `git` wrapper on
/// `PATH` that records `fetch` subcommands to a log then execs the real git.
struct Home {
    path: PathBuf,
    repo: PathBuf,
    bin: PathBuf,
    fetch_log: PathBuf,
    git: String,
}

fn fixture() -> Home {
    let home = temp_home("prepare");
    let repo = home.join("repo");
    let bin = home.join("bin");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let git = real_git();
    let git_wrapper = bin.join("git");
    std::fs::write(
        &git_wrapper,
        format!(
            "#!/bin/sh\ncase \" $* \" in *\" fetch \"*) echo fetch >> \"$PREPARE_FETCH_LOG\";; esac\nexec \"$REAL_GIT\" \"$@\"\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&git_wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fetch_log = home.join("fetch.log");
    Home {
        path: home.clone(),
        repo,
        bin,
        fetch_log,
        git,
    }
}

impl Home {
    fn env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".to_owned(), format!("{}:{}", self.bin.display(), std::env::var("PATH").unwrap_or_default())),
            ("REAL_GIT".to_owned(), self.git.clone()),
            ("PREPARE_FETCH_LOG".to_owned(), self.fetch_log.display().to_string()),
        ]
    }

    /// Run the real git inside `dir` (outside the wrapper's forced PATH),
    /// returning trimmed stdout.
    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let mut cmd = Command::new(&self.git);
        cmd.arg("-C").arg(dir);
        cmd.env("REAL_GIT", &self.git);
        let ran = run_cmd(cmd.args(args));
        assert_eq!(ran.code, Some(0), "git {:?}: {}", args, ran.stderr);
        ran.stdout.trim().to_owned()
    }

    fn fetch_count(&self) -> usize {
        std::fs::read_to_string(&self.fetch_log)
            .map(|s| if s.trim().is_empty() { 0 } else { s.trim().lines().count() })
            .unwrap_or(0)
    }
}

/// Initialize a base repository with one commit; returns `(base_sha, task)`.
fn make_repo(f: &Home) -> (String, String) {
    assert_eq!(f.git(&f.repo, &["init", "-q"]), "");
    assert_eq!(f.git(&f.repo, &["config", "user.name", "Fixture"]), "");
    assert_eq!(f.git(&f.repo, &["config", "user.email", "fixture@example.invalid"]), "");
    assert_eq!(f.git(&f.repo, &["checkout", "-qb", "main"]), "");
    std::fs::write(f.repo.join("base.txt"), "base\n").unwrap();
    assert_eq!(f.git(&f.repo, &["add", "base.txt"]), "");
    assert_eq!(f.git(&f.repo, &["commit", "-qm", "base"]), "");
    let base = f.git(&f.repo, &["rev-parse", "HEAD"]);
    assert_eq!(base.len(), 40, "fixture uses a sha1 base");
    (base, "t-20261027-120000-abcd".to_owned())
}

fn prepare_args(f: &Home, base: &str, task: &str) -> Vec<String> {
    vec![
        f.repo.display().to_string(),
        "repo-12345678".to_owned(),
        task.to_owned(),
        base.to_owned(),
        "main".to_owned(),
        "1".to_owned(),
    ]
}

fn run(f: &Home, names: &[&str], args: &[String], home_override: Option<&Path>) -> Ran {
    let mut extra = f.env();
    if let Some(home) = home_override {
        extra.push(("HOME".to_owned(), home.display().to_string()));
    }
    let body = script(names);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_scripts(&f.path, &body, &arg_refs, &extra)
}

fn worktree_path(f: &Home) -> PathBuf {
    f.path
        .join(".pacer-remote/worktrees/repo-12345678/t-20261027-120000-abcd-1")
}

// ---- test/plugins-ssh-provider.test.ts:53 — SESSION_FILES is bounded and
// contains no recorded bytes.
#[test]
fn session_files_metadata_is_bounded() {
    let home = temp_home("sf-bounded");
    let remote = home.join(".pacer-remote/runs/t-20261124-000000-abcd/1");
    std::fs::create_dir_all(&remote).unwrap();
    std::fs::write(remote.join("session.log"), vec![0x61; 1024 * 1024]).unwrap();
    std::fs::write(remote.join("session.ckpt"), "checkpoint").unwrap();
    let result = run_scripts(&home, &script(&["SESSION_FILES"]), &[remote.to_str().unwrap()], &[]);
    assert_eq!(result.code, Some(0), "stderr: {}", result.stderr);
    assert!(
        result.stdout.contains("session.log.bytes=1048576\n"),
        "large log size: {}",
        result.stdout
    );
    assert!(
        result.stdout.contains("session.ckpt.bytes=10\n"),
        "checkpoint size: {}",
        result.stdout
    );
    assert!(!result.stdout.contains("61616161"), "no recorded bytes leaked");
    assert!(
        result.stdout.len() < 4096,
        "bounded metadata output, got {}",
        result.stdout.len()
    );
    let _ = std::fs::remove_dir_all(&home);
}

// ---- test/plugins-ssh-provider.test.ts:72 — SESSION_FILES stays readable
// while an optional session state file is renamed underneath it.
#[test]
fn session_files_survives_state_renames() {
    let home = temp_home("sf-renames");
    let remote = home.join("run");
    std::fs::create_dir_all(&remote).unwrap();
    std::fs::write(remote.join("session.log"), "stable log").unwrap();
    std::fs::write(remote.join("session.ckpt"), "stable checkpoint").unwrap();
    let state = remote.join("session.state");
    let temporary = remote.join("session.state.tmp");
    std::thread::spawn({
        let state = state.clone();
        let temporary = temporary.clone();
        move || {
            for version in 1..=1000u64 {
                let _ = std::fs::write(&temporary, format!("{{\"viewers\":{version}}}"));
                let _ = std::fs::rename(&temporary, &state);
            }
        }
    });
    for _ in 0..8 {
        let result = run_scripts(&home, &script(&["SESSION_FILES"]), &[remote.to_str().unwrap()], &[]);
        assert_eq!(result.code, Some(0), "stderr: {}", result.stderr);
        assert!(result.stdout.contains("session.log.bytes=10\n"), "{}", result.stdout);
        assert!(result.stdout.contains("session.ckpt.bytes=17\n"), "{}", result.stdout);
    }
    let _ = std::fs::remove_dir_all(&home);
}

// ---- test/plugins-ssh-provider.test.ts:114 — an accepted question is
// clean in a SHA-256 worktree and changed bytes keep the tree dirty.
#[test]
fn accepted_question_clean_in_sha256_repo() {
    let home = temp_home("question");
    let repo = home.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = real_git();
    let git_in = |args: &[&str], dir: &Path| {
        let mut cmd = Command::new(&git);
        cmd.arg("-C").arg(dir);
        let ran = run_cmd(cmd.args(args));
        (ran.code, ran.stdout.trim().to_owned(), ran.stderr)
    };
    assert_eq!(git_in(&["init", "-q", "--object-format=sha256", "-b", "main"], &repo).0, Some(0));
    assert_eq!(git_in(&["config", "user.name", "Fixture"], &repo).0, Some(0));
    assert_eq!(git_in(&["config", "user.email", "fixture@example.invalid"], &repo).0, Some(0));
    assert_eq!(git_in(&["commit", "-q", "--allow-empty", "-m", "base"], &repo).0, Some(0));
    let base = git_in(&["rev-parse", "HEAD"], &repo).1;
    assert_eq!(base.len(), 64, "sha256 base");
    assert_eq!(git_in(&["branch", "pacer/task"], &repo).0, Some(0));

    let file = repo.join(".pacer-question");
    std::fs::write(&file, "which database?\n").unwrap();
    // Blob hash (40-char sha1, 64-char sha256) computed with git, matching
    // the TS `questionBlobHash` used as the PREFLIGHT guard values: outside
    // the sha256 repo git hashes in sha1, inside it hashes in sha256.
    let sha1 = git_in(&["hash-object", file.to_str().unwrap()], &home).1;
    let sha256 = git_in(&["hash-object", "--", ".pacer-question"], &repo).1;
    assert_eq!(sha1.len(), 40, "sha1 question guard");
    assert_eq!(sha256.len(), 64, "sha256 question guard");

    // PREFLIGHT args: `$1` worktree root (the repo itself), `$2` base,
    // `$3` remote branch, `$4` sha1 question guard, `$5` sha256 guard.
    let args: Vec<String> = vec![
        repo.display().to_string(),
        base.clone(),
        "pacer/task".to_owned(),
        sha1,
        sha256,
    ];
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let accepted = run_scripts(&home, &script(&["PREFLIGHT"]), &refs, &[]);
    assert_eq!(accepted.code, Some(0), "stderr: {}", accepted.stderr);
    assert!(accepted.stdout.contains("dirty=0\n"), "{}", accepted.stdout);

    std::fs::write(&file, "another question\n").unwrap();
    let changed = run_scripts(&home, &script(&["PREFLIGHT"]), &refs, &[]);
    assert_eq!(changed.code, Some(0), "stderr: {}", changed.stderr);
    assert!(changed.stdout.contains("dirty=1\n"), "{}", changed.stdout);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "another question\n");
    let _ = std::fs::remove_dir_all(&home);
}

// ---- test/plugins-ssh-prepare-recover.test.ts:43 — recovery is read-only
// for the exact clean worktree created by PREPARE.
#[test]
fn prepare_recovery_is_read_only_for_clean_worktree() {
    let f = fixture();
    let (base, task) = make_repo(&f);
    let args = prepare_args(&f, &base, &task);
    let first = run(&f, &["PREPARE"], &args, None);
    assert_eq!(first.code, Some(0), "prepare: {}", first.stderr);
    let before = f.fetch_count();
    let recovered = run(&f, &["PREPARE_RECOVER"], &args, None);
    assert_eq!(recovered.code, Some(0), "recover: {}", recovered.stderr);
    assert_eq!(recovered.stdout, first.stdout, "recover reports the prepared worktree");
    assert_eq!(f.fetch_count(), before, "recover must not fetch");
    assert_eq!(f.git(&worktree_path(&f), &["rev-parse", "HEAD"]), base);
    let _ = std::fs::remove_dir_all(&f.path);
}

// ---- test/plugins-ssh-prepare-recover.test.ts:60 — recovery refuses a
// missing worktree, a dirty worktree, an advanced worktree and a removed one.
#[test]
fn prepare_recovery_refuses_missing_partial_dirty_advanced() {
    let f = fixture();
    let (base, task) = make_repo(&f);
    let args = prepare_args(&f, &base, &task);
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "no worktree yet");
    assert_eq!(run(&f, &["PREPARE"], &args, None).code, Some(0));
    let before = f.fetch_count();
    let wt = worktree_path(&f);
    std::fs::write(wt.join("dirty.txt"), "dirty\n").unwrap();
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "dirty worktree");
    std::fs::remove_file(wt.join("dirty.txt")).unwrap();
    f.git(&wt, &["commit", "--allow-empty", "-qm", "advanced"]);
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "advanced head");
    f.git(&f.repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "worktree removed");
    assert_eq!(f.fetch_count(), before, "recover must never fetch");
    let _ = std::fs::remove_dir_all(&f.path);
}

// ---- test/plugins-ssh-prepare-recover.test.ts:77 — recovery refuses a
// foreign checkout (a different git repository) at the expected path.
#[test]
fn prepare_recovery_refuses_foreign_checkout() {
    let f = fixture();
    let (base, task) = make_repo(&f);
    let args = prepare_args(&f, &base, &task);
    let wt = worktree_path(&f);
    std::fs::create_dir_all(&wt).unwrap();
    assert_eq!(f.git(&wt, &["init", "-q"]), "");
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "foreign repo");
    assert_eq!(f.fetch_count(), 0, "no fetch for a foreign checkout");
    let _ = std::fs::remove_dir_all(&f.path);
}

// ---- test/plugins-ssh-prepare-recover.test.ts:88 — recovery refuses a
// drifted branch and a symlink at the expected path.
#[test]
fn prepare_recovery_refuses_branch_drift_and_symlink() {
    let f = fixture();
    let (base, task) = make_repo(&f);
    let args = prepare_args(&f, &base, &task);
    assert_eq!(run(&f, &["PREPARE"], &args, None).code, Some(0));
    let wt = worktree_path(&f);
    f.git(&wt, &["checkout", "-qb", "other"]);
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "drifted branch");
    f.git(&f.repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    std::os::unix::fs::symlink(&f.repo, &wt).unwrap();
    assert_ne!(run(&f, &["PREPARE_RECOVER"], &args, None).code, Some(0), "symlink at path");
    let _ = std::fs::remove_dir_all(&f.path);
}

// ---- test/plugins-ssh-prepare-recover.test.ts:101 — recovery accepts a
// symlinked HOME when Git records its canonical worktree.
#[test]
fn prepare_recovery_accepts_symlinked_home() {
    let f = fixture();
    let (base, task) = make_repo(&f);
    let args = prepare_args(&f, &base, &task);
    let alias = f.path.join("home-alias");
    std::os::unix::fs::symlink(&f.path, &alias).unwrap();
    let first = run(&f, &["PREPARE"], &args, Some(&alias));
    assert_eq!(first.code, Some(0), "prepare via alias home: {}", first.stderr);
    let recovered = run(&f, &["PREPARE_RECOVER"], &args, Some(&alias));
    assert_eq!(recovered.code, Some(0), "recover via alias home: {}", recovered.stderr);
    assert_eq!(recovered.stdout, first.stdout);
    let _ = std::fs::remove_dir_all(&f.path);
}