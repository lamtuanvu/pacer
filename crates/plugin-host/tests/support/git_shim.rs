//! Owned `/bin/sh` git shim for NativeGit host tests.
//!
//! `shim()` writes `<root>/bin/git`, a `/bin/sh` script that wraps
//! `/usr/bin/git`. Every invocation is appended to `<root>/git.log` as one line
//! of `\x1f`-joined argv, so a test can prove exactly which Git commands were
//! dispatched (the log path is baked in as a literal because the NativeGit
//! owner env may be a sealed map that drops caller variables). `calls()` /
//! `ran()` parse that log back.
//!
//! Rules let a test intercept specific argv (matched by substring of the
//! space-joined argv) before real Git runs:
//! * `Print(text)` writes `text`'s *exact bytes* to `<root>/shim-<n>.out` at
//!   creation time and, on a match, `/bin/cat`s them to stdout and exits 0 --
//!   no shell escaping or octal parsing, so arbitrary bytes (LF, TAB, BOM,
//!   NBSP, non-ASCII) survive byte-for-byte;
//! * `Exit(code)` exits with a code;
//! * the default (no match) hands through to `/usr/bin/git`.
//!
//! The shim uses only `/bin/sh`, `/bin/cat` and `/usr/bin/git`; it sets no
//! hooksPath, filters or LFS and touches no shared directory, so the real Git
//! it execs reads only the isolated GIT_CONFIG_*/HOME the owner provides.
//!
//! NOTE on scope: this only logs argv (which is all Task 4's dispatch
//! assertions need). Full `/usr/bin/env -0` capture and exact-key-set
//! assertions belong to the plan's env-split task (Task 1), which is out of
//! scope here.
#![allow(dead_code)]
use std::{
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
}

/// Write `<root>/bin/git` (mode 0700) and an empty, mode-0600 `<root>/git.log`.
/// The first rule whose `(needle, _)` appears as a substring of the
/// space-joined argv wins; the default is `Exec`, so real Git runs for any
/// argv not overridden. Returns the executable path.
pub fn shim(root: &Path, rules: &[(&str, Action)]) -> PathBuf {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let log = root.join("git.log");
    fs::write(&log, b"").unwrap();
    fs::set_permissions(&log, fs::Permissions::from_mode(0o600)).unwrap();

    let script = bin.join("git");
    let mut s = String::new();
    s.push_str("#!/bin/sh\nlog=");
    s.push_str(&single_quote(&log.to_string_lossy()));
    // Log argv (one record per line, fields joined by \x1f); "$@" stays intact
    // so the final `exec /usr/bin/git "$@"` sees the original argv.
    s.push_str("\nall=\"$*\"\n{\n  n=0\n  for a in \"$@\"; do\n    if [ \"$n\" -ne 0 ]; then printf '\\037'; fi\n    printf '%s' \"$a\"\n    n=$((n+1))\n  done\n  printf '\\n'\n} >> \"$log\"\n");
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
        }
    }
    s.push_str("exec /usr/bin/git \"$@\"\n");
    fs::write(&script, s).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    script
}

/// Build a POSIX-sh case pattern that matches any string whose space-joined form
/// *contains* `needle` as a literal (no glob interpretation). Needle must not
/// contain `"`, `$`, backtick or backslash (our needles are simple).
fn double_quoted_pattern(needle: &str) -> String {
    format!("\"{}\"*", needle)
}

/// Parse `<root>/git.log` back into per-invocation argv vectors.
pub fn calls(root: &Path) -> Vec<Vec<String>> {
    let raw = fs::read(root.join("git.log")).unwrap_or_default();
    raw.split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.split(|b| *b == 0x1f)
                .map(|field| String::from_utf8_lossy(field).into_owned())
                .collect()
        })
        .collect()
}

/// True if any recorded invocation's space-joined argv contains `needle`.
pub fn ran(root: &Path, needle: &str) -> bool {
    calls(root)
        .iter()
        .any(|args| args.join(" ").contains(needle))
}

/// Single-quote a literal for use inside a shell single-quoted string.
fn single_quote(s: &str) -> String {
    s.replace('\'', "'\\''")
}
