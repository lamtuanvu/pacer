//! Cross-runtime lock contention test for the task store.
//! Verifies that Bun and Rust writers correctly share the same lock protocol.
#![allow(clippy::unwrap_used)]

use pacer_foundation::{Ctx, lock::{LockOptions, with_lock}};
use pacer_store::{TaskStore, task::CreateTaskInput, types::Brief};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tempfile::tempdir;

#[test]
fn bun_and_rust_share_task_lock() {
    let bun = std::env::var_os("PACER_TEST_BUN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("orca/workspaces/pacer/pinfish/.work/tools/bun-1.4.2/bun")
        });

    let version = match Command::new(&bun).arg("--version").output() {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "SKIP: Bun not found at {}; set PACER_TEST_BUN to run cross-runtime contention",
                bun.display()
            );
            return;
        }
        Err(e) => panic!("cannot execute Bun: {e}"),
    };
    assert!(version.status.success(), "Bun --version failed");

    let dir = tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        Default::default(),
        1000.0,
    );

    // Create a task using Rust store
    let mut store = TaskStore::open(ctx.clone()).unwrap();
    let input = CreateTaskInput {
        brief: Brief {
            goal: "test".into(),
            repo: "/tmp/repo".into(),
            ..Default::default()
        },
        kind: None,
        requested_executor: None,
        timeout_s: 60,
        title: Some("0".into()),
        source: None,
        request_id: None,
        repo: None,
        client: None,
        placement: None,
        base_branch: None,
        base_sha: None,
        interaction_mode: None,
        conversation: None,
        session_draft_id: None,
    };
    let task = store.create_task(input, None).unwrap();
    let task_id = task.id.clone();

    let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/task-lock-contend.ts");

    // Hold the shared lock during spawn, forcing Bun to wait for the Rust writer.
    let mut child = with_lock(&ctx, &format!("task-{task_id}"), LockOptions::default(), || {
        let child = Command::new(&bun)
            .arg(&script_path)
            .arg(dir.path())
            .arg(&task_id)
            .arg("200")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        child
    })
    .unwrap();

    // Rust writer: 200 updates
    for _ in 0..200 {
        with_lock(&ctx, &format!("task-{task_id}"), LockOptions::default(), || {
            let mut store = TaskStore::open(ctx.clone()).unwrap();
            store.update_task(&task_id, |t| {
                let n = t.title.as_ref().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                t.title = Some((n + 1).to_string());
            }).unwrap();
        })
        .unwrap();
    }

    // Wait for Bun to complete
    let start = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        if start.elapsed() > Duration::from_secs(30) {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("Bun contention writer timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // Verify final count: 200 (Rust) + 200 (Bun) = 400
    let final_task = store.read_task(&task_id).unwrap().unwrap();
    assert_eq!(final_task.title, Some("400".to_string()), "expected 400, got {:?}", final_task.title);
    assert_eq!(final_task.rev, 401); // 1 initial + 400 updates
}