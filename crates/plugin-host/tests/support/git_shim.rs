//! Owned `/bin/sh` git shim for NativeGit host tests.
//!
//! `shim()` writes `<root>/bin/git`, a `/bin/sh` script that wraps
//! `/usr/bin/git`. Every invocation appends one record to `<root>/git.log`
//! (mode 0600, created by the test): the argv as NUL-joined fields, then the
//! separator `\x1f`, then the raw `/usr/bin/env -0` output, then the record
//! separator `\x1e` and a newline. The log path is baked in as a literal
//! because the native owner env (a sealed map) drops caller variables.
//! `calls()` parses each record back into `(args, env)`; `ran()` checks the
//! argv only. `without_shell()` strips the variables `/bin/sh` itself injects
//! (`PWD`, `SHLVL`, `_`, `OLDPWD`) so exact key-set comparisons describe the
//! sequence of commands the owner really provided.
//!
//! Rules let a test intercept specific argv (matched by substring of the
//! space-joined argv) before real Git runs:
//! * `Print(text)` writes `text`'s *exact bytes* to `<root>/shim-<n>.out` at
//!   creation time and, on a match, `/bin/cat`s them to stdout and exits 0 --
//!   no shell escaping or octal parsing, so arbitrary bytes survive;
//! * `Exit(code)` exits with a code;
//! * the default (no match) hands through to `/usr/bin/git`.
//!
//! The shim uses only `/bin/sh`, `/bin/cat`, `/usr/bin/env` and `/usr/bin/git`.
//! It sets no hooksPath, filters or LFS and touches no shared directory.
//!
//! Env capture (all phases), the `Exec`/`Print`/`Exit` actions, and the
//! budget/error actions: `Sleep` (phase-cap timing), `Stdout`/`Stderr`
//! (output-bound timing and overflow).
#![allow(dead_code)]
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

pub enum Action {
    /// Hand through to `/usr/bin/git` (the default when nothing matches).
    Exec,
    /// Emit `text`'s exact bytes to stdout, then exit 0.
    Print(String),
    /// Exit with the given code, stdout empty.
    Exit(i32),
    /// Sleep `ms` milliseconds, then hand through to `/usr/bin/git`. Used to
    /// drive a phase past its cap while the owner remains active.
    Sleep(u64),
    /// Write `n` zero bytes to stdout, then exit 0.
    Stdout(usize),
    /// Write `n` zero bytes to stderr, then exit 0.
    Stderr(usize),
}

/// Write `<root>/bin/git` (mode 0700) and an empty, mode-0600 `<root>/git.log`.
/// The first rule whose `(needle, _)` appears as a substring of the
/// space-joined argv wins; the default is `Exec`, so real Git runs for any
/// argv not overridden. Returns the executable path.
pub fn shim(root: &Path, rules: &[(&str, Action)]) -> PathBuf {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let log = root.join("git.log");
    clear(root);
    let script = bin.join("git");
    let mut s = String::new();
    s.push_str("#!/bin/sh\nlog=");
    s.push_str(&single_quote(&log.to_string_lossy()));
    // Append argv (NUL-joined), then the full environment, then a record
    // separator. `env -0` dumps the environment inherited by the child, so the
    // logged map is exactly what NativeGit dispatched to `native_command::run`.
    s.push_str("\n{\n  for a in \"$@\"; do\n    printf '%s\\000' \"$a\"\n  done\n  printf '\\037'\n  /usr/bin/env -0\n  printf '\\036\\n'\n} >> \"$log\"\nall=\"$*\"\n");
    for (index, (needle, action)) in rules.iter().enumerate() {
        // Case pattern `*"<needle>"*` -> substring match of the joined argv.
        match action {
            Action::Exec => {}
            Action::Print(text) => {
                let out = root.join(format!("shim-p{index}.out"));
                fs::write(&out, text.as_bytes()).unwrap();
                fs::set_permissions(&out, fs::Permissions::from_mode(0o600)).unwrap();
                s.push_str(&format!(
                    "case \"$all\" in\n  *{}) /bin/cat {}; exit 0 ;;\nesac\n",
                    double_quoted_pattern(needle),
                    single_quote(&out.to_string_lossy())
                ));
            }
            Action::Exit(code) => {
                s.push_str(&format!(
                    "case \"$all\" in\n  *{}) exit {} ;;\nesac\n",
                    double_quoted_pattern(needle),
                    code
                ));
            }
            Action::Sleep(ms) => {
                // macOS/BSD `sleep` takes whole seconds only, so round `ms` up
                // to the next second; the guard must exceed the phase cap long
                // enough that native_command's timeout (not the sleep)
                // terminates the run.
                let secs = ms.div_ceil(1000);
                s.push_str(&format!(
                    "case \"$all\" in\n  *{}) /bin/sleep {secs}; exec /usr/bin/git \"$@\" ;;\nesac\n",
                    double_quoted_pattern(needle),
                ));
            }
            Action::Stdout(n) => {
                s.push_str(&format!(
                    "case \"$all\" in\n  *{}) /usr/bin/head -c {} /dev/zero; exit 0 ;;\nesac\n",
                    double_quoted_pattern(needle),
                    n
                ));
            }
            Action::Stderr(n) => {
                s.push_str(&format!(
                    "case \"$all\" in\n  *{}) /usr/bin/head -c {} /dev/zero >&2; exit 0 ;;\nesac\n",
                    double_quoted_pattern(needle),
                    n
                ));
            }
        }
    }
    s.push_str("exec /usr/bin/git \"$@\"\n");
    fs::write(&script, s).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    script
}

/// Truncate the log so a caller can bracket one API call and inspect exactly
/// the records that call produced.
pub fn clear(root: &Path) {
    let log = root.join("git.log");
    fs::write(&log, b"").unwrap();
    fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();
}

/// Build a POSIX-sh case pattern that matches any string whose space-joined form
/// *contains* `needle` as a literal (no glob interpretation).
fn double_quoted_pattern(needle: &str) -> String {
    format!("\"{}\"*", needle)
}

/// Parse `<root>/git.log` back into per-invocation `(argv, env)` records.
pub fn calls(root: &Path) -> Vec<(Vec<String>, HashMap<String, String>)> {
    let raw = fs::read(root.join("git.log")).unwrap_or_default();
    let mut records = Vec::new();
    for record in raw.split(|b| *b == 0x1e) {
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        let sep = match record.iter().position(|b| *b == 0x1f) {
            Some(i) => i,
            None => continue,
        };
        let (argv, env) = (&record[..sep], &record[sep + 1..]);
        let args = argv
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect();
        let mut map = HashMap::new();
        for pair in env.split(|b| *b == 0).filter(|f| !f.is_empty()) {
            if let Some(eq) = pair.iter().position(|b| *b == b'=') {
                map.insert(
                    String::from_utf8_lossy(&pair[..eq]).into_owned(),
                    String::from_utf8_lossy(&pair[eq + 1..]).into_owned(),
                );
            }
        }
        records.push((args, map));
    }
    records
}

/// True if any recorded invocation's space-joined argv contains `needle`.
pub fn ran(root: &Path, needle: &str) -> bool {
    calls(root)
        .iter()
        .any(|(args, _)| args.join(" ").contains(needle))
}

/// Shell variables `/bin/sh` injects, which are not part of any owner map.
pub fn without_shell(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(k, _)| !matches!(k.as_ref(), "PWD" | "SHLVL" | "_" | "OLDPWD"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The exact sealed verification map `NativeGit::prepare` builds from `env`.
pub fn sealed_for(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    let mut m = BTreeMap::from([
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ]);
    for k in ["HOME", "PATH"] {
        if let Some(v) = env.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    m
}

/// Single-quote a literal for use inside a shell single-quoted string.
fn single_quote(s: &str) -> String {
    s.replace('\'', "'\\''")
}
