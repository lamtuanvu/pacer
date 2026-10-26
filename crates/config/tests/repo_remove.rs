#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::json;
use std::{collections::HashMap, fs, path::Path};

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        0.0,
    )
}

fn fixture(state: &Path) {
    fs::create_dir_all(state).unwrap();
    fs::write(state.join("repos.json"), r#"{"/a":{"key":"one","path":"/a","lastUsed":1},"/b":{"key":"two","path":"/b","lastUsed":2}}"#).unwrap();
    fs::write(
        state.join("repo-paths.json"),
        r#"{"/alias-a":"/a","/alias-b":"/b"}"#,
    )
    .unwrap();
}

#[test]
fn removes_all_matching_entries_and_aliases_with_typescript_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    assert_eq!(
        pacer_config::remove_repo(&ctx, "one").unwrap(),
        json!({"removed":true})
    );
    assert_eq!(
        fs::read_to_string(state.join("repos.json")).unwrap(),
        r#"{"/b":{"key":"two","path":"/b","lastUsed":2}}"#
    );
    assert_eq!(
        fs::read_to_string(state.join("repo-paths.json")).unwrap(),
        r#"{"/alias-b":"/b"}"#
    );
}

#[test]
fn missing_key_still_rewrites_both_files_without_dropping_entries() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    assert_eq!(
        pacer_config::remove_repo(&ctx, "absent").unwrap(),
        json!({"removed":true})
    );
    assert_eq!(
        fs::read_to_string(state.join("repos.json")).unwrap(),
        r#"{"/a":{"key":"one","path":"/a","lastUsed":1},"/b":{"key":"two","path":"/b","lastUsed":2}}"#
    );
    assert_eq!(
        fs::read_to_string(state.join("repo-paths.json")).unwrap(),
        r#"{"/alias-a":"/a","/alias-b":"/b"}"#
    );
}

#[test]
fn failed_second_private_write_leaves_the_first_committed() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    let temp = state.join(format!("repo-paths.json.{}.tmp", std::process::id()));
    fs::write(&temp, "occupied").unwrap();
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
    assert_eq!(
        pacer_config::remove_repo(&ctx, "one").unwrap_err().code,
        pacer_foundation::api::error::Code::InvalidInput
    );
    assert_eq!(
        fs::read_to_string(state.join("repos.json")).unwrap(),
        r#"{"/b":{"key":"two","path":"/b","lastUsed":2}}"#
    );
    assert_eq!(
        fs::read_to_string(state.join("repo-paths.json")).unwrap(),
        r#"{"/alias-a":"/a","/alias-b":"/b"}"#
    );
    assert_eq!(fs::read_to_string(temp).unwrap(), "occupied");
}

#[test]
fn failed_first_write_keeps_both_original_files() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    let aliases = fs::read(state.join("repo-paths.json")).unwrap();
    fs::remove_file(state.join("repos.json")).unwrap();
    fs::create_dir(state.join("repos.json")).unwrap();
    assert!(pacer_config::remove_repo(&ctx, "one").is_err());
    assert_eq!(fs::read(state.join("repo-paths.json")).unwrap(), aliases);
}

#[test]
fn directory_leaf_is_forwarded_to_preserve_core_error_and_partial_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    fs::remove_file(state.join("repo-paths.json")).unwrap();
    fs::create_dir(state.join("repo-paths.json")).unwrap();
    assert!(pacer_config::requires_core_repo_parser(&ctx));
}

#[test]
fn unsupported_legacy_json_stays_with_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
    for body in [
        r#"{"/a":{"key":"one","path":"/a","lastUsed":1.5}}"#,
        r#"{"/a":{"key":"one","path":"/a","lastUsed":1,"2":"indexed"}}"#,
        r#"{"/a":{"key":"one","path":"/a","lastUsed":9007199254740993}}"#,
        r#"{"/a":{"key":"\ud800","path":"/a","lastUsed":1}}"#,
        "[1,2]",
        "not json",
    ] {
        fs::write(state.join("repos.json"), body).unwrap();
        assert!(pacer_config::requires_core_repo_parser(&ctx), "{body}");
    }
}

#[cfg(unix)]
#[test]
fn writes_private_files_and_rejects_symlinked_state_directory() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    assert_eq!(
        pacer_config::remove_repo(&ctx, "missing").unwrap(),
        json!({"removed":true})
    );
    for path in [state.join("repos.json"), state.join("repo-paths.json")] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(&state).unwrap().permissions().mode() & 0o777,
        0o700
    );
    fs::remove_dir_all(&state).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &state).unwrap();
    assert!(pacer_config::remove_repo(&ctx, "missing").is_err());
    assert!(!outside.join("repos.json").exists());
}

#[test]
fn waits_for_the_same_repos_lock_used_by_typescript() {
    use std::time::{Duration, Instant};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(170));
        fs::remove_file(lock).unwrap();
    });
    let start = Instant::now();
    assert_eq!(
        pacer_config::remove_repo(&ctx, "missing").unwrap(),
        json!({"removed":true})
    );
    release.join().unwrap();
    assert!(start.elapsed() >= Duration::from_millis(150));
}

#[test]
fn rejects_newly_unsupported_registry_after_waiting_for_repos_lock() {
    use std::{sync::mpsc, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let (ready, started) = mpsc::channel();
    let native = std::thread::spawn(move || {
        ready.send(()).unwrap();
        pacer_config::remove_repo(&ctx, "one")
    });
    started.recv().unwrap();
    std::thread::sleep(Duration::from_millis(80));
    let aliases = fs::read(state.join("repo-paths.json")).unwrap();
    fs::write(state.join("repos.json"), "not json").unwrap();
    fs::remove_file(lock).unwrap();
    let error = native.join().unwrap().unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::Conflict);
    assert_eq!(fs::read(state.join("repos.json")).unwrap(), b"not json");
    assert_eq!(fs::read(state.join("repo-paths.json")).unwrap(), aliases);
}

#[cfg(unix)]
#[test]
fn unreadable_regular_registry_is_not_replaced_with_empty_map() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    let path = state.join("repos.json");
    let before = fs::read(&path).unwrap();
    let aliases = fs::read(state.join("repo-paths.json")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&path).is_ok() {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        return;
    }
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
    let error = pacer_config::remove_repo(&ctx, "one").unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::Conflict);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(fs::read(path).unwrap(), before);
    assert_eq!(fs::read(state.join("repo-paths.json")).unwrap(), aliases);
}

#[cfg(unix)]
#[test]
fn fifo_registry_is_rejected_without_a_reader_or_core_forwarding() {
    use std::{
        process::Command,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    let repo = state.join("repos.json");
    fs::remove_file(&repo).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
    let start = Instant::now();
    assert!(pacer_config::remove_repo(&ctx, "one").is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
}
