//! Read-only view of the cached ask-mode check (`src/assistant/selftest.ts`) and the
//! version probes it compares against. No credential is read: only the CLI's
//! `--version` line and the private self-test record under `state/`.

use super::*;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// `binaryFor` (`selftest.ts:54`).
pub(super) fn binary_for(adapter: &str) -> &'static str {
    match adapter {
        "claude-code" => "claude",
        "codex" => "codex",
        _ => "opencode",
    }
}

const STATE_FILE: &str = "assistant-selftest.json";
/// `spawnSync` timeout in `cliVersion` / `claudeCliVersion` / `codexCliVersion`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

fn records(ctx: &Ctx) -> Map<String, Value> {
    let text = std::fs::read_to_string(ctx.pacer_home.join("state").join(STATE_FILE))
        .unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_default()
}

/// Bare semver from a `claude --version` line (`claudeVersionSemver`, `ask-mode.ts:296`).
fn claude_version_semver(line: &str) -> Option<String> {
    for (at, c) in line.char_indices() {
        if !c.is_ascii_digit() {
            continue;
        }
        let mut dots = line[at..].splitn(3, '.');
        let major = dots.next()?;
        if major.is_empty() || !major.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let minor = dots.next()?;
        if minor.is_empty() || !minor.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let rest = dots.next()?;
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        let suffix: String = rest[digits.len()..]
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        return Some(format!("{major}.{minor}.{digits}{suffix}"));
    }
    None
}

/// `cliVersion` (`selftest.ts:58`): the first trimmed line of `<bin> --version`, with only
/// `HOME` and `PATH` in the child's environment (RUST-3 argv, no shell, SEC-1 no secrets).
pub(super) fn cli_version(ctx: &Ctx, adapter: &str) -> Option<String> {
    let path = ctx
        .env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or("/usr/bin:/bin");
    let bin = pacer_install::which(binary_for(adapter), path)?;
    let mut child = Command::new(bin)
        .arg("--version")
        .env_clear()
        .env("HOME", &ctx.home)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // `spawnSync(..., {timeout})` kills a child that overruns the deadline.
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut bytes = Vec::new();
    child.stdout.take()?.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // `stdout.trim().split("\n")[0]!.trim()`: a leading blank line is skipped too.
    let line = text.trim().lines().next().unwrap_or("").trim().to_owned();
    if line.is_empty() {
        return None;
    }
    if adapter == "claude-code" {
        claude_version_semver(&line)
    } else {
        Some(line)
    }
}

pub(super) struct Check {
    pub(super) ok: bool,
    pub(super) reason: Option<String>,
    pub(super) live_tools: bool,
}

impl Check {
    fn fail(reason: String) -> Self {
        Self {
            ok: false,
            reason: Some(reason),
            live_tools: false,
        }
    }
}

/// `selfTestStatus` (`selftest.ts:77`): a passing check recorded for the CLI installed today.
pub(super) fn check(ctx: &Ctx, account: &str, adapter: &str) -> Check {
    let Some(record) = records(ctx).get(account).cloned() else {
        return Check::fail(format!("{account} has not passed the ask-mode check yet."));
    };
    if record.get("passed").and_then(Value::as_bool) != Some(true) {
        let why = record["reason"].as_str().unwrap_or("no reason recorded");
        return Check::fail(format!("{account} failed the ask-mode check: {why}"));
    }
    let cli = binary_for(adapter);
    if record["version"].as_str() != cli_version(ctx, adapter).as_deref() {
        return Check::fail(format!("{cli} changed since {account} passed the ask-mode check."));
    }
    Check {
        ok: true,
        reason: None,
        live_tools: record["liveTools"]
            .as_bool()
            .unwrap_or(adapter == "opencode" || adapter == "codex"),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn claude_versions_keep_the_bare_semver() {
        assert_eq!(
            claude_version_semver("2.1.281 (Claude Code)"),
            Some("2.1.281".into())
        );
        assert_eq!(claude_version_semver("1.2.3-rc.1+build"), Some("1.2.3-rc.1+build".into()));
        assert_eq!(claude_version_semver("no version here"), None);
    }

    #[test]
    fn missing_record_refuses_with_the_cli_name() {
        let dir = tempfile::tempdir().unwrap();
        let c = pacer_foundation::Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            1_700_000_000.0,
        );
        let check = check(&c, "ep", "opencode");
        assert!(!check.ok);
        assert_eq!(
            check.reason.as_deref(),
            Some("ep has not passed the ask-mode check yet.")
        );
    }
}
