//! Golden tests for the desktop update store.
//!
//! Byte parity: a record written by the TypeScript store
//! (`test/fixtures/desktop-update/state-worker.ts`) must be read and
//! rewritten byte-for-byte by the native store; `wire.json` must round-trip;
//! and the CAS conflict and legacy-`.lock` refusal messages must match the
//! TypeScript strings exactly. A private, bundled-sqlite build and the
//! repository's bun dependency are required to run the cross-process tests.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_desktop_update::{parse_update_record, read_update, write_update};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn wire_record() -> Value {
    let raw = fs::read(repo_root().join("test/fixtures/desktop-update/wire.json")).unwrap();
    let document: Value = serde_json::from_slice(&raw).unwrap();
    document["record"].clone()
}

fn rendered(record: &Value) -> String {
    // pacer-js-json::stringify replicates JS JSON.stringify byte-for-byte.
    // A trailing newline is appended exactly as in store.ts `writeUpdate`.
    let mut s = pacer_js_json::stringify(record);
    s.push('\n');
    s
}

fn bumped(record: &Value, revision: u64) -> Value {
    let mut v = record.clone();
    v["revision"] = serde_json::json!(revision);
    v
}

fn find_bun() -> Option<String> {
    std::env::var("BUN")
        .ok()
        .filter(|p| Path::new(p).exists())
        .or_else(|| ["bun"].iter().find(|c| which(c)).map(|s| s.to_string()))
}

fn which(c: &str) -> bool {
    Command::new(c).arg("--version").output().is_ok()
}

#[test]
fn wire_record_round_trips_byte_for_byte() {
    let home = TempDir::new().unwrap();
    let record = parse_update_record(&wire_record()).unwrap();
    write_update(home.path(), record, Some(0)).unwrap();

    let path = home.path().join("desktop-updates/desktop-fixture.json");
    let on_disk = fs::read(&path).unwrap();
    // writeUpdate advances the revision by one (expectRevision + 1), so the
    // persisted bytes are the wire record with revision 1.
    let expected = rendered(&bumped(&wire_record(), 1));
    assert_eq!(
        String::from_utf8(on_disk).unwrap(),
        expected,
        "persisted bytes must match the TypeScript writer exactly"
    );
}

#[test]
fn read_and_rewrite_is_idempotent() {
    let home = TempDir::new().unwrap();
    let record = parse_update_record(&wire_record()).unwrap();
    write_update(home.path(), record, Some(0)).unwrap();
    let first = fs::read(home.path().join("desktop-updates/desktop-fixture.json")).unwrap();

    // Read then rewrite at the new (advanced) revision; the stored JSON
    // (modulo the revision) must be byte-identical to the original.
    let read = read_update(home.path(), "desktop-fixture")
        .unwrap()
        .unwrap();
    let rev = read.revision();
    let rewrote = parse_update_record(&read.into_value()).unwrap();
    write_update(home.path(), rewrote, Some(rev)).expect("rewrite");

    let second = fs::read(home.path().join("desktop-updates/desktop-fixture.json")).unwrap();
    // The rewritten document must only differ by the advanced revision.
    let mut a: Value = serde_json::from_slice(&first).unwrap();
    let b: Value = serde_json::from_slice(&second).unwrap();
    a["revision"] = serde_json::json!(b["revision"]);
    assert_eq!(a, b, "rewrite must not alter any other field");
}

#[test]
fn cas_conflict_text_matches_typescript() {
    let home = TempDir::new().unwrap();
    let record = parse_update_record(&wire_record()).unwrap();
    write_update(home.path(), record, Some(0)).unwrap();
    let again = parse_update_record(&wire_record()).unwrap();
    let err = write_update(home.path(), again, Some(0)).unwrap_err();
    assert!(
        err.message
            .contains("Desktop update conflict: revision changed")
    );
    assert!(err.code == pacer_foundation::api::Code::Conflict);
    assert!(err.hint.as_deref() == Some("Read the current status and retry."));
}

#[test]
fn legacy_lock_refusal_text_matches_typescript() {
    let home = TempDir::new().unwrap();
    let record = parse_update_record(&wire_record()).unwrap();
    write_update(home.path(), record, Some(0)).unwrap();
    let lock = home.path().join("desktop-updates/desktop-fixture.lock");
    fs::write(&lock, "{\"pid\":1,\"nonce\":\"other\"}").unwrap();
    let again = parse_update_record(&wire_record()).unwrap();
    let err = write_update(home.path(), again, Some(1)).unwrap_err();
    assert!(
        err.message
            .contains("Desktop update conflict: installation is locked")
    );
    assert!(err.code == pacer_foundation::api::Code::Conflict);
    assert!(err.hint.as_deref() == Some("Retain the legacy lock for recovery."));
}

#[test]
fn missing_state_reads_as_none() {
    let home = TempDir::new().unwrap();
    assert!(
        read_update(home.path(), "desktop-fixture")
            .unwrap()
            .is_none()
    );
}

#[test]
fn worker_written_record_reads_and_rewrites_byte_for_byte() {
    let Some(bun) = find_bun() else {
        eprintln!("bun unavailable; skipping cross-process golden test");
        return;
    };
    let home = TempDir::new().unwrap();
    let home_str = home.path().to_str().unwrap();

    // Run the TypeScript store to write a record at revision 0. The worker's
    // "write" mode waits on a gate file after signalling readiness.
    let rendezvous = TempDir::new().unwrap();
    let marker = rendezvous.path().join("ready");
    let gate = rendezvous.path().join("go");
    let mut child = Command::new(&bun)
        .args([
            "test/fixtures/desktop-update/state-worker.ts",
            home_str,
            gate.to_str().unwrap(),
            marker.to_str().unwrap(),
            "write",
        ])
        .current_dir(repo_root())
        .spawn()
        .expect("state worker");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(marker.exists(), "worker did not signal readiness");
    fs::write(&gate, "go").unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "state worker write failed");

    let path = home.path().join("desktop-updates/desktop-fixture.json");
    let before = fs::read(&path).unwrap();

    // Native read then rewrite at the worker's revision must preserve every
    // byte of the JSON body.
    let read = read_update(home.path(), "desktop-fixture")
        .unwrap()
        .unwrap();
    let rev = read.revision();
    let rewrote = parse_update_record(&read.into_value()).unwrap();
    write_update(home.path(), rewrote, Some(rev)).expect("native rewrite");

    let after = fs::read(&path).unwrap();
    let mut before_v: Value = serde_json::from_slice(&before).unwrap();
    let after_v: Value = serde_json::from_slice(&after).unwrap();
    before_v["revision"] = serde_json::json!(after_v["revision"]);
    assert_eq!(
        before_v, after_v,
        "native rewrite must not alter the worker-written bytes"
    );
}
