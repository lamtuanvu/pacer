#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(k, p)| ((*k).to_owned(), (*p).to_owned()))
        .collect()
}

fn home_with(registry: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("state")).unwrap();
    fs::write(dir.path().join("state/repos.json"), registry).unwrap();
    dir
}

fn ctx(home: &Path, now: f64) -> Ctx {
    Ctx::with(home.into(), home.into(), Default::default(), now)
}

#[test]
fn labels_disambiguate_collisions() {
    let labels = labels_for(&pairs(&[
        ("github.com/acme/app", "/a"),
        ("gitlab.com/acme/app", "/b"),
        ("local:1", "/x/tool/"),
        ("local:2", "/y/tool"),
        ("github.com/acme/web", "/c"),
    ]));
    assert_eq!(labels["github.com/acme/app"], "github.com/acme/app");
    assert_eq!(labels["local:1"], "tool (local:1)");
    assert_eq!(labels["github.com/acme/web"], "acme/web");
}

#[test]
fn registry_order_and_dedup() {
    let dir = home_with(
        r#"{"/r/one":{"key":"github.com/a/one","path":"/r/one","lastUsed":1},
            "/r/two":{"key":"github.com/a/two","path":"/r/two","lastUsed":5},
            "/r/dup":{"key":"github.com/a/one","path":"/r/dup","lastUsed":3}}"#,
    );
    let repos = list_repos_read_only(dir.path());
    let keys: Vec<_> = repos
        .iter()
        .map(|r| (r.key.as_str(), r.path.as_str()))
        .collect();
    assert_eq!(
        keys,
        [
            ("github.com/a/two", "/r/two"),
            ("github.com/a/one", "/r/dup")
        ]
    );
    assert_eq!(repos[0].label, "a/two");
    assert_eq!(
        repos[0].to_json(),
        json!({"key":"github.com/a/two","path":"/r/two","label":"a/two"})
    );
}

#[test]
fn resolve_and_inherited_real_paths_are_lexical() {
    assert_eq!(probe::resolve("/a/b/../c/./d/"), "/a/c/d");
    assert_eq!(basename("/x/y/"), "y");
    let dir = tempfile::tempdir().unwrap();
    let real = fs::canonicalize(dir.path()).unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    probe::probe_for_tests(&base);
    let child = cached_path(&format!("{base}/missing/x"));
    assert_eq!(child.exists, None);
    assert_eq!(child.real, format!("{}/missing/x", real.display()));
}

#[test]
fn missing_checkouts_are_stale_unless_a_recent_task_uses_them() {
    let dir = tempfile::tempdir().unwrap();
    let gone = format!("{}/gone-checkout", dir.path().display());
    let kept = dir.path().to_string_lossy().into_owned();
    let home = home_with(&format!(
        r#"{{"{gone}":{{"key":"github.com/a/gone","path":"{gone}","lastUsed":2.5}},"{kept}":{{"key":"github.com/a/kept","path":"{kept}","lastUsed":1}}}}"#
    ));
    probe::probe_for_tests(&gone);
    let (repos, stale) = list(&Registry::read(home.path(), false), &HashSet::new());
    assert_eq!(stale, std::slice::from_ref(&gone));
    assert_eq!(repos.len(), 1);
    let (repos, stale) = list(
        &Registry::read(home.path(), false),
        &HashSet::from(["github.com/a/gone".into()]),
    );
    assert!(stale.is_empty());
    assert_eq!(repos[0].key, "github.com/a/gone");

    let c = ctx(home.path(), 1000.0);
    assert_eq!(list_repos(&c, true).unwrap().len(), 1);
    assert!(
        fs::read_to_string(home.path().join("state/repos.json"))
            .unwrap()
            .contains("gone")
    );
    list_repos(&c, false).unwrap();
    assert_eq!(
        fs::read_to_string(home.path().join("state/repos.json")).unwrap(),
        format!(r#"{{"{kept}":{{"key":"github.com/a/kept","path":"{kept}","lastUsed":1}}}}"#)
    );
}

#[test]
fn unusual_registries_need_the_core_reader() {
    let usual = home_with(r#"{"/r":{"key":"k","path":"/r","lastUsed":1.5}}"#);
    assert!(!registry_needs_core(usual.path(), false));
    for text in [
        r#""abc""#,
        r#"{"/r":{"key":"k","path":"r","lastUsed":1}}"#,
        r#"{"/r":{"key":"k"}}"#,
        r#"{"/r":null}"#,
        r#"{"/r":{"key":"k","path":"/r","lastUsed":1},"/s":{"key":"k","path":"/s","lastUsed":2},"/t":{"key":"k","path":"/t"}}"#,
    ] {
        assert!(registry_needs_core(home_with(text).path(), false), "{text}");
    }
    for text in [
        "null",
        "5",
        "true",
        "[]",
        "{",
        r#"{"/r":{"key":"k","path":"/r"}}"#,
        r#"{"1":{"key":"k","path":"/r","lastUsed":1}}"#,
        r#"{"/r":{"key":"k","path":"/r","lastUsed":1e400}}"#,
    ] {
        assert!(
            !registry_needs_core(home_with(text).path(), false),
            "{text}"
        );
    }
    fs::write(usual.path().join("state/repo-paths.json"), r#"{"/w":"w"}"#).unwrap();
    assert!(registry_needs_core(usual.path(), false));
}

#[test]
fn task_paths_resolve_through_roots_and_aliases() {
    let home =
        home_with(r#"{"/srv/app":{"key":"github.com/a/app","path":"/srv/app","lastUsed":1}}"#);
    fs::write(
        home.path().join("state/repo-paths.json"),
        r#"{"/wt/app-feature":"/srv/app"}"#,
    )
    .unwrap();
    assert_eq!(
        repo_key_for(home.path(), "/srv/app/sub"),
        "github.com/a/app"
    );
    assert_eq!(
        repo_key_for(home.path(), "/wt/app-feature"),
        "github.com/a/app"
    );
    assert_eq!(
        repo_key_for(home.path(), "/srv/application"),
        "local:fafd35548949"
    );
}

#[test]
fn branches_put_the_current_branch_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(["-C", &path, "-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "{args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["commit", "-q", "--allow-empty", "-m", "x"]);
    git(&["branch", "a-feature"]);
    git(&["checkout", "-q", "-b", "z-work"]);
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        read_branches(home.path(), &path).unwrap(),
        ["z-work", "a-feature", "main"]
    );
    let empty = tempfile::tempdir().unwrap();
    let missing = empty.path().join("none").to_string_lossy().into_owned();
    assert!(read_branches(home.path(), &missing).unwrap().is_empty());
}

fn git_in(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .output()
        .unwrap();
    assert!(status.status.success(), "{args:?}");
}

fn checkout(root: &Path, name: &str) -> String {
    let path = root.join(name);
    fs::create_dir(&path).unwrap();
    git_in(&path, &["init", "-q", "-b", "main"]);
    git_in(&path, &["commit", "-q", "--allow-empty", "-m", "x"]);
    fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn add_registers_origin_keys_and_linked_checkout_aliases() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let c = ctx(home.path(), 1_700_000_000.5);
    let app = checkout(root.path(), "app");
    git_in(
        Path::new(&app),
        &["remote", "add", "origin", "git@GitHub.com:Acme/App.git"],
    );
    let wt = format!("{app}-wt");
    git_in(Path::new(&app), &["worktree", "add", "-q", &wt]);
    let repo = add_repo(&c, &format!("{wt}/")).unwrap();
    assert_eq!(
        serde_json::to_string(&repo).unwrap(),
        format!(r#"{{"key":"github.com/acme/app","path":"{app}","label":"acme/app"}}"#)
    );
    assert_eq!(
        fs::read_to_string(home.path().join("state/repos.json")).unwrap(),
        format!(
            r#"{{"{app}":{{"key":"github.com/acme/app","path":"{app}","lastUsed":1700000000.5}}}}"#
        )
    );
    assert_eq!(
        fs::read_to_string(home.path().join("state/repo-paths.json")).unwrap(),
        format!(r#"{{"{wt}":"{app}"}}"#)
    );
    assert_eq!(repo_key_for(home.path(), &wt), "github.com/acme/app");
}

#[test]
fn add_without_origin_keeps_the_local_key_and_refuses_other_paths() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let c = ctx(home.path(), 7.0);
    let tool = checkout(root.path(), "tool");
    let local = local_key(&tool);
    let repo = add_repo(&c, &tool).unwrap();
    assert_eq!(repo, json!({"key": local, "path": tool, "label": "tool"}));
    // A known checkout without origin keeps its saved key.
    fs::write(
        home.path().join("state/repos.json"),
        format!(r#"{{"{tool}":{{"key":"github.com/a/tool","path":"{tool}","lastUsed":1}}}}"#),
    )
    .unwrap();
    assert_eq!(add_repo(&c, &tool).unwrap()["key"], "github.com/a/tool");
    git_in(
        Path::new(&tool),
        &["remote", "add", "origin", "file:///srv/tool.git"],
    );
    assert_eq!(add_repo(&c, &tool).unwrap()["key"], "github.com/a/tool");
    for (path, message) in [
        ("relative", "path must be absolute"),
        ("/", "path is not a git repository"),
    ] {
        assert_eq!(add_repo(&c, path).unwrap_err().message, message);
    }
}

#[test]
fn unresolved_identity_is_unverified_or_refused_when_strict() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let c = ctx(home.path(), 7.0);
    let plain = root.path().join("plain");
    fs::create_dir(&plain).unwrap();
    let plain = plain.to_string_lossy().into_owned();
    let repo = register_repo(&c, &plain, false).unwrap();
    let keys: Vec<&String> = repo.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["key", "label", "path", "identityUnverified"]);
    assert_eq!(repo["label"], "plain");
    let strict = register_repo(&c, &format!("{plain}/missing"), true).unwrap_err();
    assert_eq!(
        strict.message,
        "Cannot establish repository identity for project routing"
    );
    assert!(!home.path().join("state/repos.json").exists());
    let real = fs::canonicalize(root.path()).unwrap();
    assert_eq!(
        canonical(&format!("{plain}/missing/x")).unwrap(),
        format!("{}/plain/missing/x", real.display())
    );
}
