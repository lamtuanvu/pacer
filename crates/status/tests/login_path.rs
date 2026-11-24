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
use std::path::Path;

/// Write an executable fake login shell at `dir/fake` returning the temp
/// dir. The script's body (`$body`) runs before the fixed `-c` command is
/// executed through a real shell, so it can emulate profile output, PATH
/// edits, sleep, or a marker file. Invoked as `fake -l -i -c COMMAND`.
fn fake_shell(body: &str) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let script = format!(
        "#!/bin/sh\n{body}\nprev=\"\"\nfor a in \"$@\"; do\n  if [ \"$prev\" = \"-c\" ]; then exec sh -c \"$a\"; fi\n  prev=\"$a\"\ndone\n"
    );
    let path = d.path().join("fake");
    std::fs::write(&path, script).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    d
}

/// A service environment pointing `SHELL` at a fake shell in `dir`.
fn env_with_shell(dir: &tempfile::TempDir, cwd: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        "SHELL".to_string(),
        dir.path().join("fake").to_string_lossy().into_owned(),
    );
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    env.insert("PWD".to_string(), cwd.to_string());
    env
}

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

/// `PACER_LOGIN_ENV=off` makes `warm` spawn nothing: a fake login shell
/// that would leave a marker file on the filesystem is never executed.
#[test]
fn login_off_warm_spawns_nothing() {
    let lp = LoginPaths::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (_cwd_dir, cwd) = make_cwd();

    // A fake shell that would write a marker file when executed.
    let dir = fake_shell(r#"echo spawned >> "$PWD"/marker"#);
    let mut env = env_with_shell(&dir, &cwd);
    env.insert("PACER_LOGIN_ENV".to_string(), "off".to_string());

    rt.block_on(lp.warm(&env, Path::new(&cwd)));
    assert!(
        !Path::new(&cwd).join("marker").exists(),
        "PACER_LOGIN_ENV=off must not spawn the login shell"
    );
    assert_eq!(
        lp.cached(&env, Path::new(&cwd)),
        None,
        "off means no cached PATH"
    );
}

/// A fake login shell printing profile noise, the marker line and an
/// `env -0` block gives a composed PATH via `cached`: profile output
/// before the marker is ignored, and the login shell's PATH wins.
#[test]
fn fake_shell_profile_noise_composes_path() {
    let lp = LoginPaths::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (_cwd_dir, cwd) = make_cwd();

    // Fake shell: prints real profile noise, prepends a tool dir to PATH,
    // then runs the fixed COMMAND (umask marker, env marker, env -0).
    let dir = fake_shell("echo noisy-profile-output\nexport PATH=\"/opt/tool/bin:$PATH\"");
    let env = env_with_shell(&dir, &cwd);

    rt.block_on(lp.warm(&env, Path::new(&cwd)));
    let cached = lp.cached(&env, Path::new(&cwd));
    let path = cached.expect("a successful login capture must be cached");
    assert!(
        path.starts_with("/opt/tool/bin:"),
        "the login shell's PATH additions must be composed first: {path}"
    );
    assert_eq!(
        lp.cached(&env, Path::new(&cwd)),
        Some(path),
        "cached is served from memory"
    );
}

/// A hanging login shell times out: `warm` returns after about 5 s with no
/// cached value, and a second `warm` within 60 s does not spawn again
/// because the failure is cached (login-env.ts:211).
#[test]
fn hanging_login_is_timed_out_and_cached() {
    let lp = LoginPaths::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (_cwd_dir, cwd) = make_cwd();

    // A fake shell that, each spawn, records a line and then sleeps 10 s
    // (never reaching the `-c` command).
    let dir = fake_shell(r#"echo ran >> "$PWD"/spawn-count; exec sh -c 'sleep 10'"#);
    let env = env_with_shell(&dir, &cwd);

    let started = std::time::Instant::now();
    rt.block_on(lp.warm(&env, Path::new(&cwd)));
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(8),
        "warm should time out around 5 s, took {elapsed:?}"
    );
    assert_eq!(
        lp.cached(&env, Path::new(&cwd)),
        None,
        "a failed capture is not cached as a value"
    );

    // A second warm within the 60 s TTL must not spawn again.
    rt.block_on(lp.warm(&env, Path::new(&cwd)));
    let count = std::fs::read_to_string(Path::new(&cwd).join("spawn-count"))
        .map(|s| s.matches("ran").count())
        .unwrap_or(0);
    assert_eq!(
        count, 1,
        "the failed first capture is cached; a second warm must not spawn again"
    );
}
