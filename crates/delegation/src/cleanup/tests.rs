#![allow(clippy::unwrap_used)]
//! Rust tests for the native auto-clean port. Each fixture builds a real git
//! repository and a task worktree under a sandboxed pacer home.

use std::{collections::HashMap, future::Future, path::PathBuf, process::Command, sync::Arc};

use pacer_foundation::Ctx;
use pacer_store::TaskStore;
use serde_json::{Value, json};

use super::*;
use crate::runtime::{NoPlugins, NoSpawn, NoSupervisor, Runtime};

const NOW: f64 = 1_800_000_000.0;

/// The lock recorder is process-global, so tests that observe it must not run in
/// parallel with the other fixtures.
static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub ctx: Ctx,
    pub rt: Runtime,
    pub id: String,
    pub worktree: PathBuf,
    pub run_dir: PathBuf,
    pub repo: PathBuf,
    short_names: HashMap<String, String>,
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("HOME", dir)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

fn full_id(n: usize) -> String {
    format!("t-20260101-000000-a{n:03x}")
}

impl Fixture {
    fn base() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let pacer_home = home.join(".pacer");
        std::fs::create_dir_all(&pacer_home).unwrap();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "init\n").unwrap();
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-qm", "init"]);
        let ctx = Ctx::with(home, pacer_home, HashMap::new(), NOW);
        Self {
            _dir: dir,
            ctx,
            rt: Runtime {
                plugins: Arc::new(NoPlugins),
                spawn: Arc::new(NoSpawn),
                supervisor: Arc::new(NoSupervisor),
            },
            id: full_id(1),
            worktree: PathBuf::new(),
            run_dir: PathBuf::new(),
            repo,
            short_names: HashMap::new(),
        }
    }

    /// A settled, accepted task whose new-mode worktree and disposable run files exist.
    pub fn accepted_task_with_worktree() -> Self {
        let mut f = Self::base();
        f.add_worktree(&f.id.clone(), true);
        f
    }

    /// `t-b.retryOf = t-a`; only the successor is cleanable, so the sorted clean
    /// locks are taken before the one `agent-sessions` scope.
    pub fn retry_chain(names: &[&str]) -> Self {
        let mut f = Self::base();
        assert_eq!(names.len(), 2);
        let ancestor = full_id(1);
        let successor = full_id(2);
        f.short_names.insert(ancestor.clone(), names[1].to_owned());
        f.short_names.insert(successor.clone(), names[0].to_owned());
        f.repo_for(&ancestor, false);
        f.add_worktree(&successor, true);
        let mut store = TaskStore::open(&f.ctx.pacer_home).unwrap();
        store
            .update(&ancestor, 1, NOW, |t| {
                t["retryOf"] = json!(null);
            })
            .unwrap();
        let rev = store
            .read(&successor)
            .unwrap()
            .and_then(|t| t.get("rev").and_then(Value::as_i64))
            .unwrap_or(1);
        store
            .update(&successor, rev, NOW, |t| {
                t["retryOf"] = json!(ancestor);
            })
            .unwrap();
        f.id = successor;
        f
    }

    fn repo_for(&self, id: &str, accepted: bool) -> Value {
        let repo = self.repo.to_string_lossy().into_owned();
        let mut task = json!({
            "id": id,
            "rev": 1,
            "createdAt": NOW - 60.0,
            "settledAt": NOW,
            "state": "done",
            "repo": repo,
            "brief": {"goal": "fixture", "repo": repo},
            "run": {"mode": "new", "workdir": "", "attempt": 1, "executor": "codex"},
            "attempts": [{"startedAt": NOW - 60.0, "endedAt": NOW, "executor": "codex"}],
        });
        if accepted {
            task["review"] = json!({"status": "accepted"});
        }
        let mut store = TaskStore::open(&self.ctx.pacer_home).unwrap();
        store.insert(&task, NOW).unwrap();
        task
    }

    fn add_worktree(&mut self, id: &str, accepted: bool) {
        let task = self.repo_for(id, accepted);
        let tag = format!("repo-{}", "00000000");
        let worktree = self.ctx.pacer_home.join("worktrees").join(tag).join(id);
        std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        git(
            &self.repo,
            &[
                "-C",
                &self.repo.to_string_lossy(),
                "worktree",
                "add",
                "-q",
                "-b",
                &format!("pacer/{id}"),
                &worktree.to_string_lossy(),
                "HEAD",
            ],
        );
        self.worktree = worktree.clone();
        self.run_dir = self.ctx.pacer_home.join("runs").join(id);
        std::fs::create_dir_all(self.run_dir.join("1")).unwrap();
        std::fs::write(self.run_dir.join("1/run.log"), "log\n").unwrap();
        let mut store = TaskStore::open(&self.ctx.pacer_home).unwrap();
        store
            .update(id, 1, NOW, |t| {
                t["run"]["workdir"] = json!(worktree.to_string_lossy());
            })
            .unwrap();
        assert!(task.get("id").is_some());
    }

    pub fn with_strategy(self, yaml: &str) -> Self {
        std::fs::write(self.ctx.pacer_home.join("strategy.yaml"), yaml).unwrap();
        self
    }

    pub async fn capture_lock_order<F: Future<Output = ()>>(&self, f: F) -> Vec<String> {
        LOCK_ORDER.lock().unwrap().clear();
        f.await;
        LOCK_ORDER
            .lock()
            .unwrap()
            .iter()
            .map(|name| {
                let mut name = name.clone();
                for (full, short) in &self.short_names {
                    name = name.replace(full, short);
                }
                name
            })
            .collect()
    }

    pub fn last_activity_text(&self) -> String {
        let text = std::fs::read_to_string(self.ctx.pacer_home.join("state/activity.jsonl"))
            .unwrap_or_default();
        text.lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|entry| {
                let text = entry.get("text")?.as_str()?;
                text.contains("Kept worktree:").then(|| text.to_owned())
            })
            .last()
            .unwrap_or_default()
    }
}

#[tokio::test]
async fn accepted_task_worktree_is_removed_and_runs_pruned() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let f = Fixture::accepted_task_with_worktree();
    auto_clean_task(&f.ctx, &f.rt, &f.id).await;
    assert!(!f.worktree.exists());
    assert!(!f.run_dir.exists());
}

#[tokio::test]
async fn dirty_worktree_is_kept_with_activity() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let f = Fixture::accepted_task_with_worktree();
    std::fs::write(f.worktree.join("x"), "dirty").unwrap();
    auto_clean_task(&f.ctx, &f.rt, &f.id).await;
    assert!(f.worktree.exists());
    assert_eq!(f.last_activity_text(), "Kept worktree: uncommitted changes; use --force");
}

#[tokio::test]
async fn auto_clean_disabled_by_strategy_does_nothing() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let f = Fixture::accepted_task_with_worktree()
        .with_strategy("execution:\n  autoClean: false\n");
    auto_clean_task(&f.ctx, &f.rt, &f.id).await;
    assert!(f.worktree.exists());
}

#[tokio::test]
async fn retry_chain_locks_in_sorted_order() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let f = Fixture::retry_chain(&["t-b", "t-a"]);
    let order = f
        .capture_lock_order(auto_clean_task(&f.ctx, &f.rt, &f.id))
        .await;
    assert_eq!(order, ["clean-t-a", "clean-t-b", "agent-sessions"]);
}
