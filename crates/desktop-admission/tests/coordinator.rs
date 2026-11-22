//! Coordinator race and privacy tests.
//!
//! The two-process race test runs a bundled TypeScript worker
//! (`test/fixtures/desktop-update/admission-worker.ts`, `count` mode) racing a
//! native Rust writer. Both increment a `counter` inside the `admission`
//! row under the shared `BEGIN IMMEDIATE` coordinator; with no lost update the
//! final count is exactly the sum. A private, fully-synchronous coordinator
//! (and the repository's bun dependency) is required to run this test.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_desktop_admission::{AdmissionError, coordinator};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

const WORKERS_TS: &str = "test/fixtures/desktop-update/admission-worker.ts";
const ITERATIONS: u64 = 200;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn counter(db: &rusqlite::Transaction<'_>) -> Result<u64, AdmissionError> {
    let text: String = db.query_row("SELECT state FROM admission WHERE id=1", [], |r| r.get(0))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| AdmissionError::Denied)?;
    Ok(value["counter"].as_u64().unwrap_or(0))
}

fn bump(home: &Path) {
    coordinator::with_coordinator(home, |tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
            .map_err(|_| AdmissionError::Denied)?;
        let next = counter(tx)? + 1;
        let state = serde_json::json!({ "counter": next });
        tx.execute(
            "INSERT INTO admission(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
            [state.to_string()],
        )
        .map(|_| ())
        .map_err(|_| AdmissionError::Denied)
    })
    .expect("coordinator bump succeeds");
}

#[test]
fn serialized_increment_accumulates() {
    let home = TempDir::new().unwrap();
    // Seed the counter row once.
    coordinator::with_coordinator(home.path(), |tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
            .map_err(|_| AdmissionError::Denied)?;
        tx.execute(
            "INSERT INTO admission(id,state) VALUES(1,?)",
            ["{\"counter\":0}"],
        )
        .map(|_| ())
        .map_err(|_| AdmissionError::Denied)
    })
    .expect("seed succeeds");
    for _ in 0..ITERATIONS {
        bump(home.path());
    }
    coordinator::with_coordinator(home.path(), |tx| {
        assert_eq!(
            counter(tx)?,
            ITERATIONS,
            "native-only increments are serialized"
        );
        Ok(())
    })
    .expect("read succeeds");
}

#[test]
fn native_and_worker_race_has_no_lost_update() {
    let bun = find_bun();
    let home = TempDir::new().unwrap();
    // Native seed of the shared counter row.
    coordinator::with_coordinator(home.path(), |tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
            .map_err(|_| AdmissionError::Denied)?;
        tx.execute(
            "INSERT INTO admission(id,state) VALUES(1,?)",
            ["{\"counter\":0}"],
        )
        .map(|_| ())
        .map_err(|_| AdmissionError::Denied)
    })
    .expect("seed succeeds");

    // The worker seat-parallel to our increments; the coordinator's BEGIN
    // IMMEDIATE serializes both sides so no increment is lost.
    let child = Command::new(&bun)
        .args([
            WORKERS_TS,
            home.path().to_str().unwrap(),
            "count",
            &ITERATIONS.to_string(),
        ])
        .current_dir(repo_root())
        .spawn()
        .expect("spawn admission worker");

    for _ in 0..ITERATIONS {
        bump(home.path());
    }

    let status = child.wait_with_output().expect("worker finished");
    assert!(
        status.status.success(),
        "worker failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );

    coordinator::with_coordinator(home.path(), |tx| {
        let total = 2 * ITERATIONS;
        assert_eq!(
            counter(tx)?,
            total,
            "no lost update under the shared coordinator"
        );
        Ok(())
    })
    .expect("final read succeeds");
}

fn find_bun() -> String {
    std::env::var("BUN")
        .ok()
        .filter(|p| Path::new(p).exists())
        .unwrap_or_else(|| "bun".to_string())
}
