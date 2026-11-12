//! Registry reads as `src/core/repos.ts` does them: the object spread of `readJson`,
//! JavaScript key order, `Number(lastUsed)` sort keys, alias values converted to property
//! keys, and `JSON.stringify` on write. Expected values come from Bun runs of the TypeScript
//! functions on the same files.
#![allow(clippy::unwrap_used)]
use pacer_foundation::Ctx;
use pacer_repos::{add_repo, list_repos_read_only, repo_key_for};
use std::{fs, path::Path, process::Command};

fn home(repos: Option<&[u8]>, aliases: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("state")).unwrap();
    if let Some(repos) = repos {
        fs::write(dir.path().join("state/repos.json"), repos).unwrap();
    }
    if let Some(aliases) = aliases {
        fs::write(dir.path().join("state/repo-paths.json"), aliases).unwrap();
    }
    dir
}

fn keys(repos: &str) -> Vec<String> {
    let dir = home(Some(repos.as_bytes()), None);
    list_repos_read_only(dir.path())
        .into_iter()
        .map(|repo| repo.key)
        .collect()
}

/// Listed paths exist: the path probe is shared by every test in the process, and a refreshed
/// missing path is stale and filtered, as in TypeScript.
const DIRS: [&str; 6] = ["/usr", "/bin", "/etc", "/tmp", "/var", "/dev"];

fn entry(name: &str, last_used: &str) -> String {
    let path = DIRS[usize::from(name.as_bytes()[0] - b'a')];
    format!(r#""{path}":{{"key":"github.com/a/{name}","path":"{path}","lastUsed":{last_used}}}"#)
}

fn expect(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| format!("github.com/a/{n}")).collect()
}

#[test]
fn sort_keys_convert_like_javascript_numbers() {
    let mixed = [
        entry("a", r#""5""#),
        entry("b", "true"),
        entry("c", "null"),
        entry("d", "3"),
        entry("e", r#"" 0x10 ""#),
        entry("f", r#""""#),
    ];
    assert_eq!(
        keys(&format!("{{{}}}", mixed.join(","))),
        expect(&["e", "a", "d", "b", "c", "f"])
    );
    let infinite = [
        entry("a", "1e400"),
        entry("b", "5"),
        entry("c", "-1e400"),
        entry("d", r#""Infinity""#),
    ];
    assert_eq!(
        keys(&format!("{{{}}}", infinite.join(","))),
        expect(&["a", "d", "b", "c"])
    );
    let arrays = [
        entry("a", "[7]"),
        entry("b", "[]"),
        entry("c", "[[9]]"),
        entry("d", "3"),
    ];
    assert_eq!(
        keys(&format!("{{{}}}", arrays.join(","))),
        expect(&["c", "a", "d", "b"])
    );
    // One NaN among equal keys compares equal to everything: registry order stays.
    let nan = [entry("a", "1"), entry("b", r#""x""#), entry("c", "1")];
    assert_eq!(
        keys(&format!("{{{}}}", nan.join(","))),
        expect(&["a", "b", "c"])
    );
}

#[test]
fn integer_index_keys_enumerate_first_and_proto_is_an_own_key() {
    let index = r#"{"/z":{"key":"github.com/a/z","path":"/usr","lastUsed":1},"10":{"key":"github.com/a/ten","path":"/bin","lastUsed":1},"2":{"key":"github.com/a/two","path":"/etc","lastUsed":1}}"#;
    assert_eq!(keys(index), expect(&["two", "ten", "z"]));
    let proto = r#"{"__proto__":{"key":"github.com/a/p","path":"/usr","lastUsed":3},"/q":{"key":"github.com/a/q","path":"/bin","lastUsed":1}}"#;
    assert_eq!(keys(proto), expect(&["p", "q"]));
}

#[test]
fn alias_values_name_registry_keys_like_property_keys() {
    let names = [
        ("/main", "main"),
        ("1", "one"),
        ("true", "true"),
        ("null", "null"),
        ("[object Object]", "obj"),
        ("1,2", "arr"),
        ("", "empty"),
        ("Infinity", "inf"),
        ("1e+21", "big"),
    ];
    let reg: Vec<String> = names
        .iter()
        .map(|(name, key)| {
            format!(r#""{name}":{{"key":"github.com/a/{key}","path":"/{key}","lastUsed":1}}"#)
        })
        .collect();
    let reg = format!("{{{}}}", reg.join(","));
    for (alias, want) in [
        ("1", "github.com/a/one"),
        ("1.0", "github.com/a/one"),
        ("true", "github.com/a/true"),
        ("null", "local:6b09760a0c02"),
        (r#"{"a":1}"#, "github.com/a/obj"),
        (r#"{"valueOf":1}"#, "github.com/a/obj"),
        ("[1,2]", "github.com/a/arr"),
        ("[[1],[2]]", "github.com/a/arr"),
        ("[]", "github.com/a/empty"),
        ("[null]", "github.com/a/empty"),
        ("1e400", "github.com/a/inf"),
        ("1e21", "github.com/a/big"),
        ("-0", "local:6b09760a0c02"),
        (r#""/main""#, "github.com/a/main"),
    ] {
        let dir = home(Some(reg.as_bytes()), Some(&format!(r#"{{"/wt":{alias}}}"#)));
        assert_eq!(repo_key_for(dir.path(), "/wt/x"), want, "{alias}");
    }
}

#[test]
fn spread_registries_resolve_index_keys_and_the_empty_root_matches_nothing() {
    let array = br#"[{"key":"github.com/a/one","path":"/usr","lastUsed":1},{"key":"github.com/a/two","path":"/bin","lastUsed":2}]"#;
    let dir = home(Some(array), Some(r#"{"/wt":0}"#));
    assert_eq!(repo_key_for(dir.path(), "/wt/x"), "github.com/a/one");
    assert_eq!(
        list_repos_read_only(dir.path())
            .into_iter()
            .map(|r| r.key)
            .collect::<Vec<_>>(),
        expect(&["two", "one"])
    );
    // A string alias file spreads into index keys, which never hold an absolute path.
    let dir = home(Some(array), Some(r#""/wt""#));
    assert_eq!(repo_key_for(dir.path(), "/wt/x"), "local:6b09760a0c02");
    let empty = br#"{"":{"key":"github.com/a/e","path":"/usr","lastUsed":1}}"#;
    let dir = home(Some(empty), None);
    assert_eq!(repo_key_for(dir.path(), "/x"), "local:b3d1db318671");
    assert_eq!(keys(std::str::from_utf8(empty).unwrap()), expect(&["e"]));
}

#[test]
fn unreadable_text_reads_as_an_empty_registry() {
    for text in [
        &b"{"[..],
        b"\xef\xbb\xbf{}",
        b"NaN",
        br#"{"/a":{"key":"k","path":"/a","lastUsed":1},}"#,
        b"",
    ] {
        let dir = home(Some(text), None);
        assert!(list_repos_read_only(dir.path()).is_empty());
    }
    let lossy = b"{\"/a\xff\":{\"key\":\"github.com/a/a\",\"path\":\"/a\xff\",\"lastUsed\":1}}";
    let repos = list_repos_read_only(home(Some(lossy), None).path());
    assert_eq!(repos[0].path, "/a\u{fffd}");
    let dir = home(None, None);
    fs::create_dir(dir.path().join("state/repos.json")).unwrap();
    assert!(list_repos_read_only(dir.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn a_fifo_registry_never_blocks_a_read() {
    let dir = home(None, None);
    let fifo = dir.path().join("state/repos.json");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert!(list_repos_read_only(dir.path()).is_empty());
}

fn checkout(root: &Path) -> (String, String) {
    let app = root.join("app");
    fs::create_dir(&app).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&app)
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["commit", "-q", "--allow-empty", "-m", "x"]);
    let app = fs::canonicalize(&app).unwrap().display().to_string();
    let wt = format!("{app}-wt");
    git(&["worktree", "add", "-q", &wt]);
    (app, wt)
}

/// `registerRepo` writes the spread registry and aliases with `JSON.stringify`.
#[test]
fn registration_rewrites_spread_registries_like_json_stringify() {
    let cases = [
        (
            r#"[{"key":"github.com/a/one","path":"/one","lastUsed":1},{"key":"github.com/a/two","path":"/two","lastUsed":2,"x":{"b":1,"0":2}}]"#,
            r#""ab""#,
            r#"{"0":{"key":"github.com/a/one","path":"/one","lastUsed":1},"1":{"key":"github.com/a/two","path":"/two","lastUsed":2,"x":{"0":2,"b":1}},"<app>":{"key":"<key>","path":"<app>","lastUsed":1700000000.5}}"#,
            r#"{"0":"a","1":"b","<wt>":"<app>"}"#,
        ),
        (
            r#"{"/q":{"key":"github.com/a/q","path":"/q","lastUsed":1e400},"__proto__":{"key":"github.com/a/p","path":"/p","lastUsed":-0,"n":1e21},"7":{"key":"github.com/a/s","path":"/s","lastUsed":"5"}}"#,
            r#"["/x",1]"#,
            r#"{"7":{"key":"github.com/a/s","path":"/s","lastUsed":"5"},"/q":{"key":"github.com/a/q","path":"/q","lastUsed":null},"__proto__":{"key":"github.com/a/p","path":"/p","lastUsed":0,"n":1e+21},"<app>":{"key":"<key>","path":"<app>","lastUsed":1700000000.5}}"#,
            r#"{"0":"/x","1":1,"<wt>":"<app>"}"#,
        ),
    ];
    for (repos, aliases, want_repos, want_aliases) in cases {
        let root = tempfile::tempdir().unwrap();
        let (app, wt) = checkout(root.path());
        let dir = home(Some(repos.as_bytes()), Some(aliases));
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            1_700_000_000.5,
        );
        let reply = add_repo(&ctx, &wt).unwrap();
        let key = reply["key"].as_str().unwrap().to_owned();
        assert_eq!(reply["path"], app.as_str());
        let read = |name: &str| {
            fs::read_to_string(dir.path().join("state").join(name))
                .unwrap()
                .replace(&wt, "<wt>")
                .replace(&app, "<app>")
                .replace(&key, "<key>")
        };
        assert_eq!(read("repos.json"), want_repos);
        assert_eq!(read("repo-paths.json"), want_aliases);
    }
}
