#![allow(clippy::unwrap_used)]

use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

struct SequenceGit(Mutex<VecDeque<Result<GitRead, GitError>>>);
impl SequenceGit {
    fn new(results: Vec<Result<GitRead, GitError>>) -> Self {
        Self(Mutex::new(results.into()))
    }
}
impl GitReader for SequenceGit {
    async fn read(&self, _ctx: &Ctx, _path: &Path, _args: &[&str]) -> Result<GitRead, GitError> {
        self.0.lock().unwrap().pop_front().unwrap()
    }
}
fn ok(stdout: impl Into<String>) -> Result<GitRead, GitError> {
    Ok(GitRead {
        code: 0,
        stdout: stdout.into(),
    })
}
fn fixture() -> (tempfile::TempDir, Ctx, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("repo");
    fs::create_dir(&path).unwrap();
    fs::create_dir(path.join(".git")).unwrap();
    let ctx = Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        12345.0,
    );
    (dir, ctx, path)
}

#[tokio::test]
async fn second_git_read_failure_returns_unverified_identity_without_writes() {
    let (_dir, ctx, path) = fixture();
    let git = SequenceGit::new(vec![
        ok("repo"),
        Ok(GitRead {
            code: 1,
            stdout: String::new(),
        }),
    ]);
    let result = add_repo_with(&ctx, path.to_str().unwrap(), &git)
        .await
        .unwrap();
    assert_eq!(result["identityUnverified"], true);
    assert!(result["key"].as_str().unwrap().starts_with("local:"));
    assert_eq!(
        result["path"],
        fs::canonicalize(path).unwrap().to_string_lossy().as_ref()
    );
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn timed_out_bounded_git_read_maps_to_recoverable_input_error() {
    let (_dir, ctx, path) = fixture();
    for results in [
        vec![Err(GitError::Timeout)],
        vec![ok("repo"), Err(GitError::Timeout)],
    ] {
        let git = SequenceGit::new(results);
        let error = add_repo_with(&ctx, path.to_str().unwrap(), &git)
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(
            error.message,
            format!("repo folder is not responding: {}", path.display())
        );
    }
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn origin_timeout_has_same_error_without_registry_write() {
    let (_dir, ctx, path) = fixture();
    let info = format!("{}\n.git\n", path.display());
    let git = SequenceGit::new(vec![ok("repo"), ok(info), Err(GitError::Timeout)]);
    let error = add_repo_with(&ctx, path.to_str().unwrap(), &git)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(
        error.message,
        format!("repo folder is not responding: {}", path.display())
    );
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn failed_inner_git_io_is_unverified_but_failed_preflight_is_error() {
    let (_dir, ctx, path) = fixture();
    let error = add_repo_with(
        &ctx,
        path.to_str().unwrap(),
        &SequenceGit::new(vec![Err(GitError::Io)]),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(
        error.message,
        format!("repo folder is not responding: {}", path.display())
    );
    let info = format!("{}\n.git\n", path.display());
    for results in [
        vec![ok("repo"), Err(GitError::Io)],
        vec![ok("repo"), ok(info), Err(GitError::Io)],
    ] {
        let value = add_repo_with(&ctx, path.to_str().unwrap(), &SequenceGit::new(results))
            .await
            .unwrap();
        assert_eq!(value["identityUnverified"], true);
    }
    assert!(!ctx.pacer_home.join("state/repos.json").exists());
}

#[tokio::test]
async fn parser_change_during_lock_wait_blocks_unverified_fallback() {
    use std::time::Duration;
    let (_dir, ctx, path) = fixture();
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(&state).unwrap();
    let lock_dir = ctx.pacer_home.join("orca");
    fs::create_dir_all(&lock_dir).unwrap();
    let lock = lock_dir.join("repos.lock");
    fs::write(&lock, "").unwrap();
    let path = path.to_string_lossy().into_owned();
    let spawned = tokio::spawn({
        let ctx = ctx.clone();
        async move {
            add_repo_with(
                &ctx,
                &path,
                &SequenceGit::new(vec![ok("repo"), Err(GitError::Io)]),
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    fs::write(state.join("repos.json"), "{invalid").unwrap();
    fs::remove_file(lock).unwrap();
    let error = spawned.await.unwrap().unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(fs::read(state.join("repos.json")).unwrap(), b"{invalid");
}

#[test]
fn origin_keys_match_typescript_supported_url_forms() {
    assert_eq!(
        repo_key("git@github.com:LamTuanVu/Pacer.git").as_deref(),
        Some("github.com/lamtuanvu/pacer")
    );
    assert_eq!(
        repo_key("https://github.com/lamtuanvu/pacer").as_deref(),
        Some("github.com/lamtuanvu/pacer")
    );
    assert_eq!(
        repo_key("ssh://git@git.example.com:2222/a/b.git").as_deref(),
        Some("git.example.com/a/b")
    );
    assert_eq!(repo_key("/local/path"), None);
    assert_eq!(repo_key("https://github.com/a/b?x=1"), None);
}

#[test]
fn unverified_lookup_uses_the_longest_registered_or_alias_root() {
    let (dir, ctx, parent) = fixture();
    let alias = parent.join("linked");
    let main = dir.path().join("main");
    fs::create_dir(&alias).unwrap();
    fs::create_dir(&main).unwrap();
    let parent = fs::canonicalize(parent)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let alias = fs::canonicalize(alias)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let main = fs::canonicalize(main)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let state = ctx.pacer_home.join("state");
    fs::create_dir_all(&state).unwrap();
    fs::write(
        state.join("repos.json"),
        serde_json::to_vec(&json!({
            parent.clone(): {"key":"local:parent","path":parent,"lastUsed":1},
            main.clone(): {"key":"github.com/acme/main","path":main,"lastUsed":2}
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        state.join("repo-paths.json"),
        serde_json::to_vec(&json!({alias.clone():main})).unwrap(),
    )
    .unwrap();
    let result = fallback(&ctx, Path::new(&alias));
    assert_eq!(result["key"], "github.com/acme/main");
    assert_eq!(result["identityUnverified"], true);
}

#[tokio::test]
async fn path_length_validation_counts_utf16_code_units_like_zod() {
    let (_dir, ctx, _) = fixture();
    let path = format!("/{}", "é".repeat(3000));
    let result = add_repo_with(
        &ctx,
        &path,
        &SequenceGit::new(vec![Ok(GitRead {
            code: 1,
            stdout: String::new(),
        })]),
    )
    .await;
    assert_eq!(result.unwrap_err().message, "path is not a git repository");
}
