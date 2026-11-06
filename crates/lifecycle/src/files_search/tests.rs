use super::*;
use std::{fs, path::PathBuf, process::Command};

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "{args:?}");
    String::from_utf8(out.stdout).unwrap()
}

fn repo_with(dir: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let repo = dir.join(name);
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (path, text) in files {
        let at = repo.join(path);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "files"]);
    fs::canonicalize(repo).unwrap()
}

fn ctx_with(dir: &Path, repos: &[(&str, &Path)], env: &[(&str, &str)]) -> Ctx {
    let home = dir.join("pacer");
    fs::create_dir_all(home.join("state")).unwrap();
    let mut registry = Map::new();
    for (i, (key, path)) in repos.iter().enumerate() {
        let path = path.to_string_lossy().into_owned();
        registry.insert(
            path.clone(),
            json!({"key": key, "path": path, "lastUsed": 100 - i}),
        );
    }
    fs::write(
        home.join("state/repos.json"),
        Value::Object(registry).to_string(),
    )
    .unwrap();
    let mut vars: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    if let Ok(path) = std::env::var("PATH") {
        vars.entry("PATH".into()).or_insert(path);
    }
    Ctx {
        home: dir.to_path_buf(),
        pacer_home: home,
        env: vars,
        now: 0.0,
    }
}

fn search(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    files_search(ctx, &params, || false)
}

#[test]
fn ranks_basename_then_path_then_fuzzy_with_sizes() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with(
        dir.path(),
        "app",
        &[
            ("src/remote/access.ts", "x"),
            ("src/access/index.ts", ""),
            ("src/a/c/c/e/s/s.ts", ""),
            ("docs/readme.md", ""),
        ],
    );
    let ctx = ctx_with(dir.path(), &[("github.com/acme/app", &repo)], &[]);
    let r = search(&ctx, json!({"query": " access "})).unwrap();
    assert_eq!(r["query"], "access");
    let paths: Vec<_> = r["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [
            "src/remote/access.ts",
            "src/access/index.ts",
            "src/a/c/c/e/s/s.ts"
        ]
    );
    assert_eq!(
        r["results"][0],
        json!({"repo": "github.com/acme/app", "repoLabel": "acme/app", "path": "src/remote/access.ts", "ranges": [[11, 17]], "size": 1})
    );
    assert_eq!(r["truncated"], false);
    assert_eq!(
        r["repos"],
        json!([{"key": "github.com/acme/app", "state": "ok"}])
    );
}

#[test]
fn limit_truncation_and_unknown_repo() {
    let dir = tempfile::tempdir().unwrap();
    let files: Vec<(String, &str)> = (0..30).map(|i| (format!("f{i:02}.ts"), "")).collect();
    let refs: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    let repo = repo_with(dir.path(), "many", &refs);
    let ctx = ctx_with(dir.path(), &[("local:many", &repo)], &[]);
    let r = search(&ctx, json!({"query": "f", "limit": 5})).unwrap();
    assert_eq!(r["results"].as_array().unwrap().len(), 5);
    assert_eq!(r["truncated"], true);
    let error = search(&ctx, json!({"query": "f", "repo": "local:none"})).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(error.message, "Unknown repository \"local:none\"");
    assert_eq!(error.hint.as_deref(), Some("Use a key from repo.list."));
}

#[test]
fn running_task_changes_rank_first_and_are_annotated() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with(
        dir.path(),
        "node",
        &[
            ("src/remote/access.ts", "a"),
            ("src/remote/accessor.ts", "b"),
        ],
    );
    let base = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let worktree = dir.path().join("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "task",
            worktree.to_str().unwrap(),
        ],
    );
    fs::write(worktree.join("src/remote/accessor.ts"), "changed").unwrap();
    let ctx = ctx_with(dir.path(), &[("github.com/econ-v1/node", &repo)], &[]);
    let db = Connection::open(ctx.pacer_home.join("state/tasks.db")).unwrap();
    db.execute_batch("CREATE TABLE tasks (id TEXT, state TEXT, record TEXT)")
        .unwrap();
    let repo_ref = json!({"key": "github.com/econ-v1/node", "path": repo, "label": "econ-v1/node"});
    for record in [
        json!({"id": "t-20261028-100000-aaaa", "state": "running", "title": "Harden access", "repo": repo_ref, "brief": {"repo": repo}, "baseSha": base, "run": {"mode": "new", "workdir": worktree}}),
        json!({"id": "t-20261028-100000-bbbb", "state": "running", "repo": repo_ref, "brief": {"repo": repo}, "run": {"mode": "new", "workdir": "/nowhere", "host": "box"}}),
    ] {
        db.execute(
            "INSERT INTO tasks VALUES (?1, 'running', ?2)",
            (record["id"].as_str().unwrap(), record.to_string()),
        )
        .unwrap();
    }
    drop(db);
    let r = search(&ctx, json!({"query": "access"})).unwrap();
    let paths: Vec<_> = r["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["src/remote/accessor.ts", "src/remote/access.ts"]);
    assert_eq!(
        r["results"][0]["changedBy"],
        json!([{"task": "t-20261028-100000-aaaa", "title": "Harden access"}])
    );
    assert!(r["results"][1].get("changedBy").is_none());
}

#[test]
fn symlinked_directories_report_no_size() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with(
        dir.path(),
        "x",
        &[("d/secret.txt", "inside"), ("top.txt", "12345")],
    );
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside file").unwrap();
    fs::rename(repo.join("d"), repo.join("d-moved")).unwrap();
    std::os::unix::fs::symlink(&outside, repo.join("d")).unwrap();
    let root = repo.to_string_lossy();
    assert_eq!(size_inside(&root, "top.txt"), Some(5));
    assert_eq!(size_inside(&root, "d/secret.txt"), None);
    assert_eq!(size_inside(&root, "../x"), None);
}

#[test]
fn executors_and_work_grants_are_refused_after_validation() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(dir.path(), &[], &[("PACER_WORK_GRANT", "pwg_x")]);
    let error = search(&ctx, json!({"query": "a"})).unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(
        error.message,
        "File search is not available to executor sessions"
    );
    assert_eq!(
        search(&ctx, json!({"query": ""})).unwrap_err().code,
        Code::InvalidInput
    );
    let plain = ctx_with(dir.path(), &[], &[]);
    let error = files_search(&plain, &json!({"query": "a"}), || true).unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(
        search(&plain, json!({"query": " \u{FEFF} "}))
            .unwrap_err()
            .message,
        "query must not be blank"
    );
}

#[test]
fn executor_session_paths() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx_with(dir.path(), &[], &[]);
    let own = ctx
        .pacer_home
        .join("worktrees/repo/t-20261028-100000-aaaa/src");
    assert!(executor_session(&ctx, &own, Vec::new));
    let orca = Path::new("/u/orca/workspaces/ws/pacer-t-20261028-100000-aaaa-claude-code/src");
    assert!(executor_session(&ctx, orca, || vec!["claude-code".into()]));
    assert!(!executor_session(&ctx, orca, || vec!["codex".into()]));
    assert!(!executor_session(&ctx, Path::new("/tmp"), || panic!(
        "not an orca path"
    )));
    assert_eq!(orca_worktree_name("..a b//c..d--"), "a-b-c.d");
}

#[test]
fn validation_matches_zod_messages() {
    let cases = [
        (
            json!({}),
            "query: Invalid input: expected string, received undefined",
        ),
        (
            json!({"query": ""}),
            "query: Too small: expected string to have >=1 characters",
        ),
        (
            json!({"query": "x".repeat(201)}),
            "query: Too big: expected string to have <=200 characters",
        ),
        (
            json!({"query": "a", "limit": 0}),
            "limit: Too small: expected number to be >=1",
        ),
        (
            json!({"query": "a", "limit": 51.5}),
            "limit: Invalid input: expected int, received number",
        ),
        (
            json!({"query": "a", "limit": 1e20}),
            "limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=50",
        ),
        (
            json!({"bogus": 1}),
            "query: Invalid input: expected string, received undefined; params: Unrecognized key: \"bogus\"",
        ),
        (
            json!({"z": 1, "query": 1, "repo": 3, "limit": 0, "y": 2}),
            "query: Invalid input: expected string, received number; repo: Invalid input: expected string, received number; limit: Too small: expected number to be >=1; params: Unrecognized keys: \"z\", \"y\"",
        ),
        (
            json!({"query": []}),
            "query: Invalid input: expected string, received array; query: Too small: expected array to have >=1 items",
        ),
        (
            json!({"query": {"length": 0}}),
            "query: Invalid input: expected string, received object; query: Too small: expected unknown to be >=1",
        ),
        (
            json!({"query": "a", "repo": null}),
            "repo: Invalid input: expected string, received null",
        ),
        (
            json!([]),
            "params: Invalid input: expected object, received array",
        ),
    ];
    for (params, message) in cases {
        let error = parse_params(&params)
            .err()
            .unwrap_or_else(|| panic!("{params}"));
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(error.message, message, "{params}");
    }
    assert!(parse_params(&Value::Null).is_err());
    assert_eq!(
        parse_params(&json!({"query": "a", "limit": 50.0}))
            .unwrap()
            .limit,
        Some(50)
    );
}

#[test]
fn listing_cache_reuses_a_recent_read() {
    LISTINGS.clear();
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with(dir.path(), "c", &[("a.ts", "")]);
    let env: HashMap<String, String> = std::env::vars().filter(|(k, _)| k == "PATH").collect();
    let root = repo.to_string_lossy().into_owned();
    assert_eq!(list_tracked(&env, &root).paths, ["a.ts"]);
    fs::write(repo.join("b.ts"), "").unwrap();
    git(&repo, &["add", "b.ts"]);
    assert_eq!(list_tracked(&env, &root).paths, ["a.ts"]);
}
