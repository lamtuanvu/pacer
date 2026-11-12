#![allow(clippy::unwrap_used)]
//! Expected bytes are what TypeScript `removeRepo` writes for the same files (Bun 1.4).

use pacer_foundation::Ctx;
use pacer_repos::{remove_needs_core, remove_repo};
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

fn seed(ctx: &Ctx, repos: Option<&[u8]>, aliases: Option<&[u8]>) -> std::path::PathBuf {
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(&state).unwrap();
    if let Some(bytes) = repos {
        fs::write(state.join("repos.json"), bytes).unwrap();
    }
    if let Some(bytes) = aliases {
        fs::write(state.join("repo-paths.json"), bytes).unwrap();
    }
    state
}

fn read(state: &Path, name: &str) -> String {
    fs::read_to_string(state.join(name)).unwrap()
}

/// Removes `key` natively and returns the written registry and aliases.
fn removed(repos: Option<&str>, aliases: Option<&str>, key: &str) -> (String, String) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = seed(&ctx, repos.map(str::as_bytes), aliases.map(str::as_bytes));
    assert!(
        !remove_needs_core(&ctx.pacer_home, key),
        "{repos:?} {aliases:?}"
    );
    assert_eq!(remove_repo(&ctx, key).unwrap(), json!({"removed": true}));
    (read(&state, "repos.json"), read(&state, "repo-paths.json"))
}

fn forwarded(repos: Option<&[u8]>, aliases: Option<&[u8]>, key: &str) -> bool {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    seed(&ctx, repos, aliases);
    remove_needs_core(&ctx.pacer_home, key)
}

const FIXTURE: &str =
    r#"{"/a":{"key":"one","path":"/a","lastUsed":1},"/b":{"key":"two","path":"/b","lastUsed":2}}"#;
const ALIASES: &str = r#"{"/alias-a":"/a","/alias-b":"/b"}"#;

#[test]
fn removes_all_matching_entries_and_aliases_with_typescript_bytes() {
    assert_eq!(
        removed(Some(FIXTURE), Some(ALIASES), "one"),
        (
            r#"{"/b":{"key":"two","path":"/b","lastUsed":2}}"#.into(),
            r#"{"/alias-b":"/b"}"#.into()
        )
    );
    assert_eq!(
        removed(Some(FIXTURE), Some(ALIASES), "absent"),
        (FIXTURE.into(), ALIASES.into())
    );
    assert_eq!(removed(None, None, "one"), ("{}".into(), "{}".into()));
}

#[test]
fn removal_waits_for_the_shared_repos_lock() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = seed(&ctx, Some(FIXTURE.as_bytes()), Some(ALIASES.as_bytes()));
    let lock = ctx.pacer_home.join("orca/repos.lock");
    fs::create_dir_all(lock.parent().unwrap()).unwrap();
    fs::write(&lock, "").unwrap();
    std::thread::scope(|scope| {
        let removal = scope.spawn(|| remove_repo(&ctx, "one").map_err(|error| error.message));
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(read(&state, "repos.json"), FIXTURE);
        assert_eq!(read(&state, "repo-paths.json"), ALIASES);
        assert!(!removal.is_finished());
        fs::remove_file(&lock).unwrap();
        assert_eq!(removal.join().unwrap().unwrap(), json!({"removed": true}));
    });
    assert_eq!(
        read(&state, "repos.json"),
        r#"{"/b":{"key":"two","path":"/b","lastUsed":2}}"#
    );
    assert_eq!(read(&state, "repo-paths.json"), r#"{"/alias-b":"/b"}"#);
    assert!(!lock.exists());
}

#[test]
fn typescript_written_numbers_and_extra_fields_round_trip() {
    let registry = r#"{"/a":{"key":"k","path":"/a","lastUsed":1e400,"n":-0,"m":9007199254740993,"f":1731380000.123456789,"e":1e21,"s":1e-7,"x":[1.0,-1e-400]},"/b":{"key":"one","path":"/b","lastUsed":1731380000.5}}"#;
    assert_eq!(
        removed(Some(registry), None, "one").0,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":null,"n":0,"m":9007199254740992,"f":1731380000.1234567,"e":1e+21,"s":1e-7,"x":[1,0]}}"#
    );
}

#[test]
fn index_keys_proto_keys_and_duplicates_follow_javascript_objects() {
    assert_eq!(
        removed(
            Some(
                r#"{"/b":{"key":"x"},"10":{"key":"one"},"2":{"key":"y"},"4294967295":{"key":"z"}}"#
            ),
            Some(r#"{"/z":"10","5":"2"}"#),
            "one"
        ),
        (
            r#"{"2":{"key":"y"},"/b":{"key":"x"},"4294967295":{"key":"z"}}"#.into(),
            r#"{"5":"2"}"#.into()
        )
    );
    let proto = r#"{"__proto__":{"key":"one","path":"/p"},"/b":{"key":"two","x":1}}"#;
    let proto_aliases = r#"{"__proto__":"__proto__","/q":"/b"}"#;
    assert_eq!(
        removed(Some(proto), Some(proto_aliases), "one"),
        (
            r#"{"/b":{"key":"two","x":1}}"#.into(),
            r#"{"/q":"/b"}"#.into()
        )
    );
    assert_eq!(
        removed(Some(proto), Some(proto_aliases), "two"),
        (
            r#"{"__proto__":{"key":"one","path":"/p"}}"#.into(),
            r#"{"__proto__":"__proto__"}"#.into()
        )
    );
    assert_eq!(
        removed(
            Some(r#"{"/a":{"key":"k"},"/b":1,"/a":{"key":"k2"}}"#),
            None,
            "x"
        )
        .0,
        r#"{"/a":{"key":"k2"},"/b":1}"#
    );
}

#[test]
fn non_object_registries_spread_like_typescript() {
    let cases = [
        (r#""ab""#, r#"{"0":"a","1":"b"}"#),
        ("\"\u{1F600}x\"", r#"{"0":"\ud83d","1":"\ude00","2":"x"}"#),
        (
            r#"[{"key":"one","path":"/a"},{"key":"two"},5,"s"]"#,
            r#"{"1":{"key":"two"},"2":5,"3":"s"}"#,
        ),
        ("5", "{}"),
        ("false", "{}"),
        ("null", "{}"),
        ("1e400", "{}"),
    ];
    for (registry, expected) in cases {
        assert_eq!(
            removed(Some(registry), None, "one").0,
            expected,
            "{registry}"
        );
    }
}

#[test]
fn non_object_aliases_are_written_back_without_spreading() {
    let registry =
        Some(r#"{"/a":{"key":"one"},"1":{"key":"one"},"null":{"key":"one"},"a":{"key":"one"}}"#);
    let cases = [
        (r#"["/a","/b",1,"/a"]"#, r#"[null,"/b",1,null]"#),
        ("7", "7"),
        (r#""""#, r#""""#),
        (r#""bc""#, r#""bc""#),
        ("true", "true"),
        ("false", "false"),
        ("null", "{}"),
        ("1e400", "null"),
        (
            r#"{"/x":1,"/y":null,"/z":true,"/w":{"a":1},"/v":["/a"],"/u":"/a"}"#,
            r#"{"/x":1,"/y":null,"/z":true,"/w":{"a":1},"/v":["/a"]}"#,
        ),
    ];
    for (aliases, expected) in cases {
        assert_eq!(
            removed(registry, Some(aliases), "one").1,
            expected,
            "{aliases}"
        );
    }
}

#[test]
fn unparsable_files_read_as_empty_objects() {
    let mut bom = "\u{feff}".as_bytes().to_vec();
    bom.extend_from_slice(FIXTURE.as_bytes());
    for bytes in [bom.as_slice(), b"{\"/a\":{\"key\":\"one\"},}", b"{", b""] {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        let state = seed(&ctx, Some(bytes), Some(bytes));
        assert!(!remove_needs_core(&ctx.pacer_home, "zzz"));
        remove_repo(&ctx, "zzz").unwrap();
        assert_eq!(read(&state, "repos.json"), "{}");
        assert_eq!(read(&state, "repo-paths.json"), "{}");
    }
    let mut lossy = b"{\"/a".to_vec();
    lossy.push(0xff);
    lossy.extend_from_slice(br#"":{"key":"k","path":"/a","lastUsed":1}}"#);
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = seed(&ctx, Some(&lossy), None);
    remove_repo(&ctx, "zzz").unwrap();
    assert_eq!(
        read(&state, "repos.json"),
        "{\"/a\u{fffd}\":{\"key\":\"k\",\"path\":\"/a\",\"lastUsed\":1}}"
    );
}

#[test]
fn engine_errors_lone_surrogates_and_deep_files_forward() {
    assert!(forwarded(Some(b"[null]"), None, "one"));
    assert!(forwarded(Some(br#"{"/a":null}"#), None, "one"));
    assert!(forwarded(
        Some(br#"{"a":{"key":"one"}}"#),
        Some(br#""ab""#),
        "one"
    ));
    assert!(!forwarded(
        Some(br#"{"a":{"key":"one"}}"#),
        Some(br#""ab""#),
        "two"
    ));
    assert!(forwarded(Some(br#""\ud800""#), None, "one"));
    assert!(forwarded(Some(br#"{"/a":{"key":"\udc00"}}"#), None, "one"));
    assert!(forwarded(None, Some(br#"{"/x\ud800":"/a"}"#), "one"));
    let deep = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels)).into_bytes();
    assert!(!forwarded(Some(&deep(129)), None, "one"));
    assert!(forwarded(Some(&deep(130)), None, "one"));
    assert!(forwarded(Some(&deep(600)), None, "one"));
}

#[test]
fn directories_and_unusable_state_forward() {
    for name in ["repos.json", "repo-paths.json"] {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        let state = seed(&ctx, Some(FIXTURE.as_bytes()), Some(ALIASES.as_bytes()));
        fs::remove_file(state.join(name)).unwrap();
        fs::create_dir(state.join(name)).unwrap();
        assert!(remove_needs_core(&ctx.pacer_home, "one"));
        assert_eq!(
            remove_repo(&ctx, "one").unwrap_err().message,
            "repository registry changed during removal"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    fs::write(ctx.pacer_home.join("state"), "").unwrap();
    assert!(remove_needs_core(&ctx.pacer_home, "one"));
}

#[cfg(unix)]
#[test]
fn fifo_registries_forward_without_blocking() {
    for name in ["repos.json", "repo-paths.json"] {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        let state = seed(&ctx, None, None);
        let status = std::process::Command::new("mkfifo")
            .arg(state.join(name))
            .status()
            .unwrap();
        assert!(status.success());
        assert!(remove_needs_core(&ctx.pacer_home, "one"));
        assert!(remove_repo(&ctx, "one").is_err());
    }
}

#[cfg(unix)]
#[test]
fn symlinked_files_are_read_through_and_replaced_by_regular_files() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = seed(&ctx, None, None);
    let target = dir.path().join("real.json");
    fs::write(&target, FIXTURE).unwrap();
    symlink(&target, state.join("repos.json")).unwrap();
    let dangling = dir.path().join("nowhere.json");
    symlink(&dangling, state.join("repo-paths.json")).unwrap();
    assert!(!remove_needs_core(&ctx.pacer_home, "one"));
    remove_repo(&ctx, "one").unwrap();
    for name in ["repos.json", "repo-paths.json"] {
        assert!(fs::symlink_metadata(state.join(name)).unwrap().is_file());
    }
    assert_eq!(
        read(&state, "repos.json"),
        r#"{"/b":{"key":"two","path":"/b","lastUsed":2}}"#
    );
    assert_eq!(read(&state, "repo-paths.json"), "{}");
    assert_eq!(fs::read_to_string(&target).unwrap(), FIXTURE);
    assert!(!dangling.exists());
}

#[cfg(unix)]
#[test]
fn symlinked_state_directory_is_written_through() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let real = dir.path().join("real-state");
    fs::create_dir_all(&real).unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(real.join("repos.json"), FIXTURE).unwrap();
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    symlink(&real, ctx.pacer_home.join("state")).unwrap();
    remove_repo(&ctx, "two").unwrap();
    assert_eq!(
        fs::read_to_string(real.join("repos.json")).unwrap(),
        r#"{"/a":{"key":"one","path":"/a","lastUsed":1}}"#
    );
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&real), 0o700);
    assert_eq!(mode(&real.join("repos.json")), 0o600);
    assert_eq!(mode(&real.join("repo-paths.json")), 0o600);
}

#[cfg(unix)]
#[test]
fn unreadable_registries_are_overwritten_as_empty() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let state = seed(&ctx, Some(FIXTURE.as_bytes()), Some(ALIASES.as_bytes()));
    fs::set_permissions(state.join("repos.json"), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(state.join("repos.json")).is_ok() {
        return; // Running as root: permissions do not deny the read.
    }
    assert!(!remove_needs_core(&ctx.pacer_home, "one"));
    remove_repo(&ctx, "one").unwrap();
    assert_eq!(read(&state, "repos.json"), "{}");
    assert_eq!(read(&state, "repo-paths.json"), ALIASES);
}
