#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs, path::Path, process::Command};

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        12345.0,
    )
}

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn repo(dir: &tempfile::TempDir, name: &str, commit: bool) -> std::path::PathBuf {
    let path = dir.path().join(name);
    fs::create_dir(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    if commit {
        git(
            &path,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
    }
    path
}

fn registry(ctx: &Ctx) -> Value {
    serde_json::from_slice(&fs::read(ctx.pacer_home.join("state/repos.json")).unwrap()).unwrap()
}
fn golden() -> Value {
    serde_json::from_str(include_str!("../../../test/fixtures/repo-add.json")).unwrap()
}

#[tokio::test]
async fn local_repository_uses_canonical_path_and_stable_hash() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "local", true);
    let result = pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    let real = fs::canonicalize(&path)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(result["path"], real);
    assert_eq!(result["label"], "local");
    assert!(result["key"].as_str().unwrap().starts_with("local:"));
    assert_eq!(
        registry(&ctx)[&real],
        json!({"key":result["key"],"path":real,"lastUsed":12345})
    );
    assert!(!ctx.pacer_home.join("state/repo-paths.json").exists());
}

#[tokio::test]
async fn remote_and_unborn_repositories_have_typescript_identities() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let remote = repo(&dir, "remote", true);
    git(
        &remote,
        &["remote", "add", "origin", "git@github.com:Acme/API.git"],
    );
    let result = pacer_config::add_repo(&ctx, remote.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(result["key"], "github.com/acme/api");
    assert_eq!(result["label"], "acme/api");
    let remote_path = fs::canonicalize(&remote)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("state/repos.json")).unwrap(),
        golden()["remote"]["repos"]
            .as_str()
            .unwrap()
            .replace("$MAIN", &remote_path)
    );
    let unborn = repo(&dir, "unborn", false);
    let unborn_result = pacer_config::add_repo(&ctx, unborn.to_str().unwrap())
        .await
        .unwrap();
    assert!(unborn_result["key"].as_str().unwrap().starts_with("local:"));
    assert_eq!(unborn_result["label"], "unborn");
}

#[tokio::test]
async fn linked_worktree_registers_main_and_alias_before_registry() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let main = repo(&dir, "main", true);
    git(
        &main,
        &["remote", "add", "origin", "git@github.com:Acme/API.git"],
    );
    let linked = dir.path().join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let result = pacer_config::add_repo(&ctx, linked.to_str().unwrap())
        .await
        .unwrap();
    let main = fs::canonicalize(main)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let linked = fs::canonicalize(linked)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        result,
        json!({"key":"github.com/acme/api","path":main,"label":"acme/api"})
    );
    assert_eq!(registry(&ctx)[&main]["key"], "github.com/acme/api");
    let aliases: Value =
        serde_json::from_slice(&fs::read(ctx.pacer_home.join("state/repo-paths.json")).unwrap())
            .unwrap();
    assert_eq!(aliases[&linked], main);
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("state/repos.json")).unwrap(),
        golden()["linked"]["repos"]
            .as_str()
            .unwrap()
            .replace("$MAIN", &main)
    );
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("state/repo-paths.json")).unwrap(),
        golden()["linked"]["aliases"]
            .as_str()
            .unwrap()
            .replace("$MAIN", &main)
            .replace("$LINKED", &linked)
    );
}

#[tokio::test]
async fn non_git_and_missing_paths_fail_before_any_registry_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let non_git = dir.path().join("plain");
    fs::create_dir(&non_git).unwrap();
    for path in [non_git, dir.path().join("missing")] {
        let error = pacer_config::add_repo(&ctx, path.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.code, pacer_foundation::api::error::Code::InvalidInput);
        assert_eq!(error.message, "path is not a git repository");
    }
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn existing_identity_survives_origin_removal_and_duplicate_labels_expand() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let a_parent = dir.path().join("a");
    let b_parent = dir.path().join("b");
    fs::create_dir_all(&a_parent).unwrap();
    fs::create_dir_all(&b_parent).unwrap();
    let a_dir = tempfile::tempdir_in(a_parent).unwrap();
    let b_dir = tempfile::tempdir_in(b_parent).unwrap();
    let a = repo(&a_dir, "api", true);
    let b = repo(&b_dir, "api", true);
    git(
        &a,
        &["remote", "add", "origin", "git@github.com:acme/api.git"],
    );
    git(
        &b,
        &["remote", "add", "origin", "git@gitlab.com:acme/api.git"],
    );
    assert_eq!(
        pacer_config::add_repo(&ctx, a.to_str().unwrap())
            .await
            .unwrap()["label"],
        "acme/api"
    );
    let second = pacer_config::add_repo(&ctx, b.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(second["label"], "gitlab.com/acme/api");
    git(&a, &["remote", "remove", "origin"]);
    let again = pacer_config::add_repo(&ctx, a.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(again["key"], "github.com/acme/api");
    assert_eq!(again["label"], "github.com/acme/api");
}

#[tokio::test]
async fn linked_alias_first_write_survives_registry_temp_collision() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let main = repo(&dir, "main", true);
    let linked = dir.path().join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(&state).unwrap();
    let temp = state.join(format!("repos.json.{}.tmp", std::process::id()));
    fs::write(&temp, "occupied").unwrap();
    assert!(
        pacer_config::add_repo(&ctx, linked.to_str().unwrap())
            .await
            .is_err()
    );
    let aliases: Value =
        serde_json::from_slice(&fs::read(state.join("repo-paths.json")).unwrap()).unwrap();
    let top = fs::canonicalize(linked)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let main = fs::canonicalize(main)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(aliases[&top], main);
    assert!(!state.join("repos.json").exists());
    assert_eq!(fs::read_to_string(temp).unwrap(), "occupied");
}

#[tokio::test]
async fn waits_for_the_same_repos_lock_as_forwarded_writers() {
    use std::time::{Duration, Instant};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo", true);
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(170));
        fs::remove_file(lock).unwrap();
    });
    let start = Instant::now();
    assert!(
        pacer_config::add_repo(&ctx, path.to_str().unwrap())
            .await
            .is_ok()
    );
    release.join().unwrap();
    assert!(start.elapsed() >= Duration::from_millis(150));
}

#[cfg(unix)]
#[tokio::test]
async fn private_registry_and_symlinked_state_guard() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo", true);
    pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    let state = ctx.pacer_home.join("state");
    assert_eq!(
        fs::metadata(&state).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(state.join("repos.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::remove_dir_all(&state).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &state).unwrap();
    assert!(
        pacer_config::add_repo(&ctx, path.to_str().unwrap())
            .await
            .is_err()
    );
    assert!(!outside.join("repos.json").exists());
}

#[tokio::test]
async fn argv_git_handles_a_repository_path_with_spaces() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo with spaces", true);
    let result = pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(result["label"], "repo with spaces");
}

#[tokio::test]
async fn local_origin_keeps_the_hash_identity() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "local-origin", true);
    let origin = dir.path().join("local.git").to_string_lossy().into_owned();
    git(&path, &["remote", "add", "origin", &origin]);
    let result = pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    assert!(result["key"].as_str().unwrap().starts_with("local:"));
}

#[tokio::test]
async fn registry_change_during_lock_wait_is_conflict_without_writes() {
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo", true);
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(&state).unwrap();
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let spawned = tokio::spawn({
        let ctx = ctx.clone();
        async move { pacer_config::add_repo(&ctx, path.to_str().unwrap()).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    fs::write(state.join("repos.json"), "not json").unwrap();
    fs::remove_file(lock).unwrap();
    let error = spawned.await.unwrap().unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::Conflict);
    assert_eq!(fs::read(state.join("repos.json")).unwrap(), b"not json");
    assert!(!state.join("repo-paths.json").exists());
}

#[tokio::test]
async fn origin_changed_while_waiting_for_repos_lock_is_resolved_inside_lock() {
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo", true);
    git(
        &path,
        &["remote", "add", "origin", "git@github.com:acme/old.git"],
    );
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let repo_path = path.to_string_lossy().into_owned();
    let spawned = tokio::spawn({
        let ctx = ctx.clone();
        async move { pacer_config::add_repo(&ctx, &repo_path).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    git(
        &path,
        &["remote", "set-url", "origin", "git@github.com:acme/new.git"],
    );
    fs::remove_file(lock).unwrap();
    let result = spawned.await.unwrap().unwrap();
    assert_eq!(result["key"], "github.com/acme/new");
    let main = fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(registry(&ctx)[&main]["key"], "github.com/acme/new");
}

#[tokio::test]
async fn directory_registry_rejects_linked_checkout_without_alias_first_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let main = repo(&dir, "main", true);
    let linked = dir.path().join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(state.join("repos.json")).unwrap();
    let error = pacer_config::add_repo(&ctx, linked.to_str().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code, pacer_foundation::api::error::Code::InvalidInput);
    assert!(!state.join("repo-paths.json").exists());
    assert!(state.join("repos.json").is_dir());
}

#[tokio::test]
async fn oversized_origin_output_is_unverified_and_does_not_write_registry() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    let path = repo(&dir, "repo", true);
    let config = path.join(".git/config");
    let mut original = fs::read_to_string(&config).unwrap();
    original.push_str(&format!(
        "\n[remote \"origin\"]\n\turl = https://github.com/acme/{}\n",
        "a".repeat(70_000)
    ));
    fs::write(config, original).unwrap();
    let result = pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(result["identityUnverified"], true);
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn fractional_last_used_matches_typescript_golden_and_stays_native_compatible() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = ctx(&dir);
    ctx.now = 1_793_042_681.555;
    let path = repo(&dir, "repo", true);
    git(
        &path,
        &["remote", "add", "origin", "git@github.com:Acme/API.git"],
    );
    pacer_config::add_repo(&ctx, path.to_str().unwrap())
        .await
        .unwrap();
    let main = fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        fs::read_to_string(ctx.pacer_home.join("state/repos.json")).unwrap(),
        golden()["fractional"]["repos"]
            .as_str()
            .unwrap()
            .replace("$MAIN", &main)
    );
    assert!(!pacer_config::requires_core_repo_parser(&ctx));
}
