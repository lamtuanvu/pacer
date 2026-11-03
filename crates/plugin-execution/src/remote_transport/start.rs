//! Pure START contract helpers: `run-io.ts` composition and the
//! `host-start-issuer.ts` checks, in TS order. No filesystem, admission or SSH.
use crate::{AuthorityError, BrokerError, js_semantics, native_command};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub(super) const MAX_START_INPUT: usize = 52_428_800;
const STDIN_MARKER: &[u8] = b"__PACER_STDIN__\n";

/// The TS issuer's deny text (`host-start-issuer.ts:17`).
pub(super) fn denied() -> BrokerError {
    AuthorityError::Denied("configured remote start changed or was not issued".into()).into()
}

/// `^[A-Za-z_][A-Za-z0-9_]*$` (`run-io.ts:61`).
pub(super) fn env_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Lowercase hex SHA-256 of UTF-8 `"{alias}:{remoteDir}"` (`run-io.ts:67`).
pub(super) fn session_blocker_id(alias: &str, remote_dir: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{alias}:{remote_dir}").as_bytes())
    )
}

pub(super) fn operation_label(name: &str) -> Result<&'static str, BrokerError> {
    match name {
        "PREPARE" => Ok("prepare"),
        "START" => Ok("start"),
        "STOP" => Ok("stop"),
        _ => Err(native_command::denied()),
    }
}

/// Node posix `normalize(p) === p` for an absolute `p`. Unlike
/// `authority::normalize_path`, a trailing `/` is kept and `..` is rejected.
pub(super) fn node_normalized(path: &str) -> bool {
    if path == "/" {
        return true;
    }
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    rest.split('/')
        .all(|s| !s.is_empty() && s != "." && s != "..")
}

/// JS `/^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/`:
/// JS `.` excludes LF, CR, U+2028 and U+2029, and JS `\d` is ASCII.
pub(super) fn remote_dir_parts(remote_dir: &str) -> Option<(&str, &str, &str)> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern = PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"^([^\n\r\u{2028}\u{2029}]+)/\.pacer-remote/runs/(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})/([1-9][0-9]*)$",
            )
            .ok()
        })
        .as_ref()?;
    let c = pattern.captures(remote_dir)?;
    Some((c.get(1)?.as_str(), c.get(2)?.as_str(), c.get(3)?.as_str()))
}

/// Composes the final args exactly as before, with the existing
/// composition-point string checks (native-only, D3-B).
pub(super) fn compose(
    remote_dir: &str,
    workdir: &str,
    env: Option<&Map<String, Value>>,
    id: &str,
    nonce: &str,
    argv: &[Value],
) -> Result<Vec<String>, BrokerError> {
    let mut args = vec![remote_dir.into(), workdir.into(), "pipe".into()];
    for (k, v) in env.into_iter().flatten() {
        if !env_key(k) {
            return Err(native_command::denied());
        }
        args.push(format!(
            "{k}={}",
            v.as_str().ok_or_else(native_command::denied)?
        ));
    }
    args.push("PACER_ROLE=executor".into());
    args.push(format!("PACER_TASK_ID={id}"));
    args.push(format!("PACER_COMPLETION_NONCE={nonce}"));
    args.push("--".into());
    for a in argv {
        args.push(a.as_str().ok_or_else(native_command::denied)?.into());
    }
    Ok(args)
}

/// `wrapper.sh ‖ "__PACER_STDIN__\n" ‖ stdin`.
pub(super) fn input(stdin: &str) -> Vec<u8> {
    let wrapper = include_str!("../native_run/wrapper.sh");
    let mut bytes = Vec::with_capacity(wrapper.len() + STDIN_MARKER.len() + stdin.len());
    bytes.extend_from_slice(wrapper.as_bytes());
    bytes.extend_from_slice(STDIN_MARKER);
    bytes.extend_from_slice(stdin.as_bytes());
    bytes
}

pub(super) struct Issue<'a> {
    pub alias: &'a str,
    pub id: &'a str,
    pub remote_dir: &'a str,
    pub local_dir: &'a str,
    pub run: &'a Value,
    pub args: &'a [String],
    pub input: &'a [u8],
}

fn absolute_normalized(path: &str) -> bool {
    path.starts_with('/') && node_normalized(path)
}

/// `issueConfiguredHostStart` then `snapshot` (`host-start-issuer.ts:20-45`), in
/// TS order; `host` is the current host JSON read at issuance.
pub(super) fn issue(issue: &Issue<'_>, host: &str) -> Result<(), BrokerError> {
    let Issue {
        alias,
        id,
        remote_dir,
        local_dir,
        run,
        args,
        input,
    } = *issue;
    if input.is_empty()
        || input.len() > MAX_START_INPUT
        || !input.windows(STDIN_MARKER.len()).any(|w| w == STDIN_MARKER)
    {
        return Err(denied());
    }
    let (_, task, attempt) = remote_dir_parts(remote_dir).ok_or_else(denied)?;
    if !absolute_normalized(remote_dir) || !absolute_normalized(local_dir) {
        return Err(denied());
    }
    if args.len() < 6
        || args.len() > 25
        || args.iter().any(|a| {
            js_semantics::utf16_len(a) > 1024 || a.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        })
    {
        return Err(denied());
    }
    let separator = args.iter().position(|a| a == "--").ok_or_else(denied)?;
    if args[0] != remote_dir
        || !absolute_normalized(&args[1])
        || !["full", "pty", "pipe"].contains(&args[2].as_str())
        || separator < 3
        || separator >= args.len() - 1
    {
        return Err(denied());
    }
    // `run.attempt === Number(match[3])`: safe integers only, no leading zero.
    let attempt_matches =
        js_semantics::safe_u64(&run["attempt"]).is_some_and(|n| n.to_string() == attempt);
    if run["host"] != alias
        || run["mode"] != "new"
        || run["remoteDir"] != remote_dir
        || run["dir"] != local_dir
        || run["workdir"] != args[1].as_str()
        || !attempt_matches
        || task != id
    {
        return Err(denied());
    }
    let host: Value = serde_json::from_str(host).map_err(|_| denied())?;
    if !host.is_object()
        || host["paused"] == true
        || (host["session"] == "full") != (args[2] == "full")
    {
        return Err(denied());
    }
    // Native mode is never `full`, so the first env slot is 3.
    if args[3..separator]
        .iter()
        .any(|a| !a.split_once('=').is_some_and(|(k, _)| env_key(k)))
    {
        return Err(denied());
    }
    Ok(())
}
