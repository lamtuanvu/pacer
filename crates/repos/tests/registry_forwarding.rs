//! Which registries stay with the TypeScript reader (`registry_needs_core`): only inputs whose
//! JavaScript outcome is engine text, engine-specific or cwd-dependent.
#![allow(clippy::unwrap_used)]
use pacer_repos::registry_needs_core;
use std::{fs, process::Command};

fn home(repos: Option<&str>, aliases: Option<&str>) -> tempfile::TempDir {
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

const REG: &str = r#"{"/a":{"key":"github.com/a/a","path":"/a","lastUsed":1}}"#;

fn forwarded(repos: &str, aliases: Option<&str>) -> bool {
    let dir = home(Some(repos), aliases);
    let read = registry_needs_core(dir.path(), false);
    assert_eq!(
        registry_needs_core(dir.path(), true),
        read,
        "{repos} {aliases:?}"
    );
    read
}

fn deep(levels: usize) -> String {
    format!(
        r#"{{"/a":{{"key":"k","path":"/a","lastUsed":1,"d":{}{}}}}}"#,
        "[".repeat(levels),
        "]".repeat(levels)
    )
}

#[test]
fn javascript_reads_of_unusual_registries_are_native() {
    for repos in [
        "[]",
        r#"[{"key":"github.com/a/one","path":"/one","lastUsed":1}]"#,
        r#""""#,
        "null",
        "5",
        "false",
        "1e400",
        "{",
        "\u{feff}{}",
        "NaN",
        r#"{"10":{"key":"k","path":"/t","lastUsed":1},"__proto__":{"key":"p","path":"/p","lastUsed":2}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":1e400,"extra":[1,{"x":null}]}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":"5"},"/b":{"key":"k","path":"/b","lastUsed":true},"/c":{"key":"k","path":"/c","lastUsed":null},"/d":{"key":"k","path":"/d","lastUsed":[2]}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":{}}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":1},"/b":{"key":"k","path":"/b"},"/c":{"key":"k","path":"/c","lastUsed":1}}"#,
        &deep(127),
    ] {
        assert!(!forwarded(repos, None), "{repos}");
    }
    for aliases in [
        r#"{"/w":"/a"}"#,
        r#"{"/w":1,"/x":true,"/y":null,"/z":{"a":1},"/v":[1,2],"/u":1e400,"/t":"/missing"}"#,
        r#"{"rel":"rel","0":{"toString":1}}"#,
        r#"["/a","rel"]"#,
        r#""abc""#,
        "{",
    ] {
        assert!(!forwarded(REG, Some(aliases)), "{aliases}");
    }
}

#[test]
fn engine_errors_and_cwd_dependent_reads_stay_forwarded() {
    for repos in [
        r#""ab""#,
        r#"[5]"#,
        r#"{"/a":null}"#,
        r#"{"/a":"x"}"#,
        r#"{"/a":{"path":"/a","lastUsed":1}}"#,
        r#"{"/a":{"key":5,"path":"/a","lastUsed":1}}"#,
        r#"{"/a":{"key":"k","lastUsed":1}}"#,
        r#"{"/a":{"key":"k","path":"rel","lastUsed":1}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":{"toString":1}}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":[{"toString":1}]}}"#,
        r#"{"/a":{"key":"k","path":"/a","lastUsed":1},"/b":{"key":"k","path":"/b","lastUsed":"x"},"/c":{"key":"k","path":"/c","lastUsed":2}}"#,
        r#"{"/a\ud800":{"key":"k","path":"/a","lastUsed":1}}"#,
        &deep(128),
    ] {
        assert!(forwarded(repos, None), "{repos}");
    }
    for aliases in [
        r#"{"/w":"rel"}"#,
        r#"{"/w":"constructor"}"#,
        r#"{"/w":["constructor"]}"#,
        r#"{"/w":{"toString":1}}"#,
        r#"{"/w":[{"toString":"x"}]}"#,
        r#"{"/w":"\udc00"}"#,
    ] {
        assert!(forwarded(REG, Some(aliases)), "{aliases}");
    }
    // An own `__proto__` key is a registry entry, not the inherited prototype.
    let proto = r#"{"/a":{"key":"k","path":"/a","lastUsed":1},"__proto__":{"key":"p","path":"/p","lastUsed":1}}"#;
    assert!(!forwarded(proto, Some(r#"{"/w":["__proto__"]}"#)));
    assert!(forwarded(REG, Some(r#"{"/w":["__proto__"]}"#)));
}

#[test]
fn directories_forward_only_writes_and_special_files_always_forward() {
    for name in ["repos.json", "repo-paths.json"] {
        let dir = home(Some(REG), None);
        let path = dir.path().join("state").join(name);
        fs::remove_file(&path).ok();
        fs::create_dir(&path).unwrap();
        assert!(!registry_needs_core(dir.path(), false), "{name}");
        assert!(registry_needs_core(dir.path(), true), "{name}");
        fs::remove_dir(&path).unwrap();
        #[cfg(unix)]
        {
            assert!(
                Command::new("mkfifo")
                    .arg(&path)
                    .status()
                    .unwrap()
                    .success()
            );
            assert!(registry_needs_core(dir.path(), false), "{name}");
            assert!(registry_needs_core(dir.path(), true), "{name}");
        }
    }
    let missing = tempfile::tempdir().unwrap();
    assert!(!registry_needs_core(missing.path(), true));
}
