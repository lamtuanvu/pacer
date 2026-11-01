#![allow(clippy::unwrap_used)]
use pacer_config::host::{HostEdit, edit_host, repo_key, save_host};
use std::fs;

const BASE: &str = "# keep this comment\nplanner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n";

#[test]
fn identity_accepts_supported_urls_and_rejects_unsafe_shapes() {
    for url in [
        "git@GitHub.com:Acme/API.git",
        "https://github.com/Acme/API.git",
        "ssh://git@github.com/Acme/API",
    ] {
        assert_eq!(repo_key(url).as_deref(), Some("github.com/acme/api"));
    }
    for url in [
        "file:///tmp/repo",
        "https://github.com/acme/api?x=1",
        "git@host:one",
        "https://github.com/a/b.git/",
        "https://user:secret@host/a/b",
        "https://.host/owner/repo",
        "https://host//owner/repo",
        "u\u{a0}x@host:owner/repo",
    ] {
        assert_eq!(repo_key(url), None, "{url}");
    }
    assert_eq!(
        repo_key("https://host/.owner/repo").as_deref(),
        Some("host/.owner/repo")
    );
}

#[test]
fn host_edits_preserve_unrelated_bytes_and_refuse_invalid_inputs() {
    let path = std::path::Path::new("strategy.yaml");
    let mapped = edit_host(
        BASE,
        path,
        "default",
        HostEdit::MapRepo {
            alias: "devbox",
            key: "GitHub.com/Acme/API",
            path: "~/src/api",
        },
    )
    .unwrap();
    assert_eq!(
        mapped,
        "# keep this comment\nplanner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {github.com/acme/api: ~/src/api}}\n"
    );
    let added = edit_host(
        BASE,
        path,
        "default",
        HostEdit::Add {
            alias: "new-host",
            ssh: "build",
        },
    )
    .unwrap();
    assert_eq!(
        added,
        "# keep this comment\nplanner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n  new-host: { ssh: build }\n"
    );
    assert!(
        edit_host(
            BASE,
            path,
            "default",
            HostEdit::MapRepo {
                alias: "devbox",
                key: "acme/api",
                path: "x"
            }
        )
        .is_err()
    );
    assert!(
        edit_host(
            BASE,
            path,
            "default",
            HostEdit::Add {
                alias: "local",
                ssh: "host"
            }
        )
        .is_err()
    );
    assert!(edit_host(BASE, path, "default", HostEdit::Remove { alias: "missing" }).is_err());
}

#[test]
fn save_uses_private_atomic_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    fs::write(&path, BASE).unwrap();
    save_host(
        &path,
        "default",
        HostEdit::Set {
            alias: "devbox",
            max_tasks: Some(4.),
            paused: Some(true),
            session: None,
        },
    )
    .unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("max_tasks: 4"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
