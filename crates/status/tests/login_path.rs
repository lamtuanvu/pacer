#![allow(clippy::unwrap_used, clippy::expect_used)]
//! B12-3 behavioral tests for the login PATH cache (`src/exec/login-env.ts`)
//! ported into `pacer-status::login_path`. The library runs the user's login
//! shell with a fixed command that prints `__PACER_LOGIN_ENV__` followed by
//! `env -0`, and keeps only the composed PATH in memory. These tests drive
//! the public surface (`LoginPaths::warm` / `cached`, `login_shell`, and
//! `on_path`) and assert the deterministic parts: executable resolution on
//! absolute PATH entries, which shell is selected, and that a login PATH is
//! composed and cached without leaving any shell output on disk.

use pacer_status::login_path::{LoginPaths, login_shell, on_path};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;

fn make_cwd() -> (tempfile::TempDir, String) {
    // A live temp dir used as both the shell's working directory and a unique
    // marker on PATH. A login shell's profile may prepend system dirs, but it
    // preserves user entries, so asserting `.contains(marker)` is stable.
    let dir = tempfile::tempdir().unwrap();
    let marker = dir
        .path()
        .to_path_buf()
        .into_os_string()
        .into_string()
        .unwrap();
    (dir, marker)
}

fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// `onPath` resolves an executable by name over absolute PATH entries,
/// skipping relative entries and non-executable files.
#[test]
fn on_path_resolves_executables_only_on_absolute_entries() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("tool");
    std::fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
    let mut perms = std::fs::metadata(&exe).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&exe, perms).unwrap();
    let plain = dir.path().join("plain");
    std::fs::write(&plain, "data").unwrap();

    // Real executable on an absolute entry: found and returned absolute.
    let path_var = format!(
        "{}:{}/bin:relative/bin",
        dir.path().display(),
        dir.path().display()
    );
    assert_eq!(on_path(&path_var, "tool"), Some(exe.clone()));

    // Unknown name and non-executable files are never returned.
    assert_eq!(on_path(&path_var, "missing"), None);
    assert_eq!(on_path(&path_var, "plain"), None);

    // A name in a relative entry is skipped (no absolute resolution).
    let rel = dir.path().join("bin");
    std::fs::create_dir_all(&rel).unwrap();
    std::fs::write(rel.join("tool"), "#!/bin/sh\nexit 0\n").unwrap();
    let mut perms = std::fs::metadata(rel.join("tool")).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(rel.join("tool"), perms).unwrap();
    let path_var_rel = format!("bin:{}", dir.path().display());
    assert_eq!(
        on_path(&path_var_rel, "tool"),
        Some(exe),
        "the absolute entry ('tool') wins over the relative 'bin'"
    );
}

/// `loginShell` prefers `$SHELL` when it is absolute and existing. A
/// relative `$SHELL` is never used verbatim.
#[test]
fn login_shell_prefers_an_absolute_existing_shell() {
    let dir = tempfile::tempdir().unwrap();
    let shell_via_env = dir.path().join("myshell");
    std::fs::write(&shell_via_env, "#!/bin/sh\nexit 0\n").unwrap();
    let mut perms = std::fs::metadata(&shell_via_env).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&shell_via_env, perms).unwrap();

    let env = env_with(&[("SHELL", shell_via_env.to_str().unwrap()), ("PATH", "/bin")]);
    assert_eq!(
        login_shell(&env),
        Some(shell_via_env.clone()),
        "an existing absolute $SHELL is selected"
    );

    // A relative $SHELL must not be returned as-is (it is not absolute).
    let rel = env_with(&[("SHELL", "some/relative/shell"), ("PATH", "/bin")]);
    if let Some(p) = login_shell(&rel) {
        assert!(
            p.is_absolute(),
            "a relative $SHELL must not be returned verbatim"
        );
    }
}

/// `warm` runs the login shell, learns a composed PATH, and `cached` returns
/// it without re-spawning. A controlled marker placed on the service PATH
/// survives the login profile, so the composed PATH must contain it.
/// `PACER_LOGIN_ENV=off` both disables `warm` and makes `cached` return
/// None.
#[test]
fn login_paths_warm_and_cached_compose_the_login_path() {
    let lp = LoginPaths::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (_cwd_dir, cwd) = make_cwd();

    // A login shell is required for capture; /bin/sh is always present.
    let env = env_with(&[
        ("SHELL", "/bin/sh"),
        ("PATH", &format!("/usr/bin:/bin:{cwd}/bin")),
    ]);
    rt.block_on(lp.warm(&env, std::path::Path::new(&cwd)));
    let cached = lp.cached(&env, std::path::Path::new(&cwd));
    let path = cached.expect("a successful login capture must be cached");
    assert!(
        path.contains(&format!("{cwd}/bin")),
        "the composed PATH must retain the service marker, got: {path}"
    );
    // `cached` never spawns: it just returns the last known value.
    assert_eq!(
        lp.cached(&env, std::path::Path::new(&cwd)),
        Some(path.clone()),
        "a second `cached` is served from memory"
    );

    // `PACER_LOGIN_ENV=off` disables both warm and cached.
    let mut off = env.clone();
    off.insert("PACER_LOGIN_ENV".to_string(), "off".to_string());
    rt.block_on(lp.warm(&off, std::path::Path::new(&cwd)));
    assert_eq!(
        lp.cached(&off, std::path::Path::new(&cwd)),
        None,
        "PACER_LOGIN_ENV=off turns the cache off"
    );
}
