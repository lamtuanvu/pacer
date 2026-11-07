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
    let (repos, stale) = list(home.path(), &HashSet::new());
    assert_eq!(stale, std::slice::from_ref(&gone));
    assert_eq!(repos.len(), 1);
    let (repos, stale) = list(home.path(), &HashSet::from(["github.com/a/gone".into()]));
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
    assert!(!registry_needs_core(usual.path()));
    for text in [
        r#"[]"#,
        r#""abc""#,
        r#"{"/r":{"key":"k","path":"r","lastUsed":1}}"#,
        r#"{"/r":{"key":"k","path":"/r"}}"#,
        r#"{"1":{"key":"k","path":"/r","lastUsed":1}}"#,
        r#"{"/r":{"key":"k","path":"/r","lastUsed":1e400}}"#,
        "{",
    ] {
        assert!(registry_needs_core(home_with(text).path()), "{text}");
    }
    for text in ["null", "5", "true"] {
        assert!(!registry_needs_core(home_with(text).path()), "{text}");
    }
    fs::write(usual.path().join("state/repo-paths.json"), r#"{"/w":1}"#).unwrap();
    assert!(registry_needs_core(usual.path()));
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
