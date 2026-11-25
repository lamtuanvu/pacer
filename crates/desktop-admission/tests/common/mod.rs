//! Shared fixture helpers for the desktop-admission tests.
//!
//! Each test gets a throwaway `HOME` with an on-demand `desktop-updates`
//! admission store, seeded the same way the TypeScript runtime seeds a fresh
//! pacer home. `read_admission(tx, true)` creates the row on first use, so a
//! bare fixture starts with an empty, idle admission.
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]
use pacer_desktop_admission::{coordinator, state};
use serde_json::{Value, json};
use std::path::Path;
use tempfile::TempDir;

/// A temporary pacer home; the backing dir is removed on drop.
pub struct Home {
    dir: TempDir,
}

impl Home {
    pub fn new() -> Self {
        Home {
            dir: TempDir::new().unwrap(),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

/// Overwrite the admission row's reservation and leases, creating the row when
/// the file has never been initialized.
pub fn write_state(home: &Path, reservation: Option<&str>, leases: Vec<Value>) {
    coordinator::with_coordinator(home, |tx| {
        let mut state = state::read_admission(tx, true).expect("admission readable");
        state.reservation = reservation.map(str::to_owned);
        state.leases = leases;
        state::write_admission(tx, &state)
    })
    .expect("seed admission");
}

/// The decoded reservation field of the current admission row.
pub fn reservation_of(home: &Path) -> Option<String> {
    coordinator::with_coordinator(home, |tx| {
        let state = state::read_admission(tx, false).expect("admission readable");
        Ok(state.reservation)
    })
    .expect("read reservation")
}

/// A valid lease with a `launch` blocker, like `beginWorkSync` produces.
pub fn lease(id: &str) -> Value {
    json!({
        "id": id,
        "blocker": { "kind": "launch", "id": id, "label": "Launch" },
        "owner": "inc0",
        "process": { "pid": 1234, "bootId": "boot", "birth": "0:0" },
        "state": "pending"
    })
}

/// Create a directory relative to `home` (e.g. `tasks` or `runs/a/1`).
pub fn mkdir(home: &Path, path: &str) {
    std::fs::create_dir_all(home.join(path)).unwrap();
}

/// Write a JSON value to a path relative to `home`.
pub fn write_json(home: &Path, path: &str, value: &Value) {
    let full = home.join(path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, serde_json::to_vec(value).unwrap()).unwrap();
}

/// Write a plain text file to a path relative to `home`.
pub fn write_str(home: &Path, path: &str, text: &str) {
    let full = home.join(path);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, text).unwrap();
}

/// A stored task that blocks while `running` and is quiet otherwise. Uses the
/// exact shape `parse_stored_task` accepts (`brief`, `attempts`).
pub fn task(id: &str, state: &str) -> Value {
    json!({
        "id": id,
        "state": state,
        "brief": { "goal": "Work", "repo": "/repo" },
        "title": "Task",
        "attempts": []
    })
}

/// A stored operation job, the shape `parse_stored_job` accepts.
pub fn job(id: &str, kind: &str, state: &str) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "state": state,
        "pid": 1234,
        "startedAt": 1.0,
        "steps": []
    })
}
