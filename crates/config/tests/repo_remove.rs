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
    fs::write(
        state.join("repos.json"),
        r#"{"/a":{"key":"one","path":"/a","lastUsed":1},"/b":{"key":"two","path":"/b","lastUsed":2}}"#,
    )
    .unwrap();
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
        pacer_config::repos::remove_repo(&ctx, "one").unwrap(),
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
        pacer_config::repos::remove_repo(&ctx, "absent").unwrap(),
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
fn directory_leaf_forwards_via_requires_core_parser() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = ctx.pacer_home.join("state");
    fixture(&state);
    fs::remove_file(state.join("repo-paths.json")).unwrap();
    fs::create_dir(state.join("repo-paths.json")).unwrap();
    assert!(pacer_config::repos::requires_core_repo_parser(&ctx));
}
