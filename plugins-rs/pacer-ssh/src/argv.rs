//! The exact `ssh` argv the provider issues (port of `plugins/pacer-ssh/probe.ts:330-521`).
//!
//! `shq` must match `src/install/fsx.ts:28-29` so the plugin argv matches the
//! host pin byte for byte. Each builder validates its tuple exactly as the TS
//! does and returns `Result<Vec<String>, String>`, where `Err` mirrors the
//! `Error` the TS function throws and the handler maps to a `capability_denied`.

use crate::scripts::*;
use serde_json::Value;

fn re(pattern: &'static str) -> &'static regex::Regex {
    // Lazy per-pattern cache: compile and leak each distinct pattern to a
    // static so call sites can hand out `&'static Regex`. A single
    // `OnceLock` keyed on the first pattern would only ever register that
    // pattern and fall over for any other one.
    static RE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<&'static str, &'static regex::Regex>>> =
        std::sync::OnceLock::new();
    let cache = RE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|_| panic!("regex cache lock poisoned"));
    if let Some(re) = guard.get(pattern) {
        return re;
    }
    let re = match regex::Regex::new(pattern) {
        Ok(re) => re,
        Err(_) => panic!("invalid static regex"),
    };
    let re = Box::leak(Box::new(re));
    guard.insert(pattern, re);
    re
}

fn is_match(pattern: &'static str, s: &str) -> bool {
    re(pattern).is_match(s)
}

/// POSIX quoting identical to the host's `src/install/fsx.ts` `shq`.
fn shq(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'/' | b'.' | b':' | b'=' | b'@' | b'%' | b'+' | b'-'))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// The length in UTF-16 code units, matching JS `String.prototype.length`.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Exact argv issued separately by the host's process capability
/// (`probe.ts:335-349`).
fn issued_argv(
    ssh_target: &str,
    control_path: &str,
    script: &str,
    args: &[String],
    completion_nonce: Option<&str>,
) -> Result<Vec<String>, String> {
    if !is_match("^[A-Za-z0-9._@][A-Za-z0-9._@-]*$", ssh_target)
        || !control_path.starts_with('/')
        || control_path.contains('\0')
        || !control_path.ends_with("/cm-%C")
    {
        return Err("invalid host-issued SSH snapshot".to_owned());
    }
    let program = match completion_nonce {
        Some(nonce) => format!(
            "printf '__PACER_BEGIN__\\n'; ( {script}\n); pacer_result=$?; printf '\\n__PACER_DONE__={nonce}\\n'; exit \"$pacer_result\""
        ),
        None => format!("printf '__PACER_BEGIN__\\n'; {script}"),
    };
    let mut argv = vec![
        "ssh".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=10".to_owned(),
        "-o".to_owned(),
        "ServerAliveInterval=15".to_owned(),
        "-o".to_owned(),
        "ServerAliveCountMax=2".to_owned(),
        "-o".to_owned(),
        "ControlMaster=auto".to_owned(),
        "-o".to_owned(),
        format!("ControlPath={control_path}"),
        "-o".to_owned(),
        "ControlPersist=60".to_owned(),
        "--".to_owned(),
        ssh_target.to_owned(),
    ];
    let mut command = format!("bash -lc {} pacer", shq(&program));
    for arg in args {
        command.push(' ');
        command.push_str(&shq(arg));
    }
    argv.push(command);
    Ok(argv)
}

macro_rules! string_arg {
    ($args:expr, $i:expr, $msg:expr) => {
        $args
            .get($i)
            .and_then(Value::as_str)
            .ok_or_else(|| $msg.to_owned())?
    };
}

pub fn probe_argv(ssh_target: &str, control_path: &str) -> Result<Vec<String>, String> {
    issued_argv(ssh_target, control_path, PROBE_SCRIPT, &[], None)
}

pub fn check_repo_argv(ssh_target: &str, control_path: &str, repo: &str) -> Result<Vec<String>, String> {
    if repo.is_empty() || repo.contains('\0') {
        return Err("invalid host-issued repo path".to_owned());
    }
    issued_argv(ssh_target, control_path, CHECK_REPO_SCRIPT, &[repo.to_owned(), "check".to_owned()], None)
}

pub fn check_home_argv(ssh_target: &str, control_path: &str, home: &str) -> Result<Vec<String>, String> {
    if home.is_empty() || home.contains('\0') {
        return Err("invalid host-issued account home".to_owned());
    }
    issued_argv(ssh_target, control_path, CHECK_REPO_SCRIPT, &[home.to_owned(), "home".to_owned()], None)
}

pub fn clone_repo_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a0 = string_arg!(args, 0, "invalid host-issued clone tuple");
    let a2 = string_arg!(args, 2, "invalid host-issued clone tuple");
    if args.len() != 3
        || !(a0.starts_with('/') || a0.starts_with("~/"))
        || utf16_len(a0) > 4096
        || (args
            .get(1)
            .and_then(Value::as_str) != Some("clone"))
        || a2.is_empty()
        || utf16_len(a2) > 4096
        || args.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f))
        })
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued clone tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, CHECK_REPO_SCRIPT, &owned, Some(nonce))
}

fn control_char(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f))
}

pub fn clean_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a3 = args.get(3).and_then(Value::as_str).unwrap_or_default();
    let a4 = args.get(4).and_then(Value::as_str).unwrap_or_default();
    let branch_ok = a4.is_empty()
        || a4 == format!("pacer/{a3}")
        || regex::Regex::new(&format!(
            "^pacer/{}-[1-9][0-9]*$",
            regex::escape(a3)
        ))
        .map(|re| re.is_match(a4))
        .unwrap_or(false);
    if (args.len() != 5 && args.len() != 6)
        || (args.len() == 6
            && args
                .get(5)
                .and_then(Value::as_str)
                .is_none_or(|s| !s.is_empty() && s != "force"))
        || args
            .iter()
            .any(|v| v.as_str().is_none_or(|s| utf16_len(s) > 4096) || control_char(v))
        || !args
            .iter()
            .take(2)
            .all(|v| v.as_str().is_some_and(|s| s.starts_with('/')))
        || !args
            .get(2)
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with('/') || s.starts_with("~/"))
        || !is_match("^t-\\d{8}-\\d{6}-[0-9a-f]{4}$", a3)
        || !branch_ok
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued clean tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, CLEAN_SCRIPT, &owned, Some(nonce))
}

pub fn stop_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    if args.len() != 2
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        || !is_match("^(?:[1-9]|[1-5][0-9]|60)$", a1)
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued stop tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, STOP_SCRIPT, &owned, Some(nonce))
}

pub fn start_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    let a2 = args.get(2).and_then(Value::as_str).unwrap_or_default();
    let a3 = args.get(3).and_then(Value::as_str).unwrap_or_default();
    let runs_ok = is_match("^/.*?/\\.pacer-remote/runs/t-\\d{8}-\\d{6}-[0-9a-f]{4}/[1-9][0-9]*$", a0);
    let env_start = if a2 == "full" { 4 } else { 3 };
    let dd = args.iter().position(|v| v.as_str() == Some("--"));
    let env_ok = dd.is_some_and(|d| {
        args.iter().take(d).skip(env_start).all(|v| {
            v.as_str()
                .is_some_and(|s| is_match("^[A-Za-z_][A-Za-z0-9_]*=", s))
        })
    });
    // TS: `args.indexOf("--") < env_start` (dash not early) and
    // `args.indexOf("--") >= args.length - 1` (at least one command arg after).
    let dash_ok = dd.is_some_and(|d| d >= env_start && d < args.len() - 1);
    let mode_ok = a2 == "full" || a2 == "pty" || a2 == "pipe";
    let full_ok = a2 != "full"
        || is_match("^/.*?/\\.pacer-remote/bin/[a-f0-9]{64}/pacer$", a3);
    if args.len() < 6
        || args.len() > 25
        || args
            .iter()
            .any(|v| v.as_str().is_none_or(|s| s.len() > 1024) || control_char(v))
        || !runs_ok
        || !a1.starts_with('/')
        || !mode_ok
        || !full_ok
        || !dash_ok
        || !env_ok
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued start tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, START_SCRIPT, &owned, Some(nonce))
}

fn valid_prepare_args(args: &[Value]) -> bool {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    let a2 = args.get(2).and_then(Value::as_str).unwrap_or_default();
    let a3 = args.get(3).and_then(Value::as_str).unwrap_or_default();
    let a4 = args.get(4).and_then(Value::as_str).unwrap_or_default();
    let a5 = args.get(5).and_then(Value::as_str).unwrap_or_default();
    args.len() == 6
        && !args.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 4096) || control_char(v))
        && (a0.starts_with('/') || a0.starts_with("~/"))
        && is_match("^[A-Za-z0-9._-]+-[a-f0-9]{8}$", a1)
        && is_match("^t-\\d{8}-\\d{6}-[0-9a-f]{4}$", a2)
        && is_match("^[a-f0-9]{40,64}$", a3)
        && !a4.is_empty()
        && is_match("^[1-9][0-9]*$", a5)
}

pub fn prepare_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    if !valid_prepare_args(args) || !is_match("^[a-f0-9-]{36}$", nonce) {
        return Err("invalid host-issued prepare tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, PREPARE_SCRIPT, &owned, Some(nonce))
}

pub fn prepare_recover_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    if !valid_prepare_args(args) {
        return Err("invalid host-issued prepare recovery tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, PREPARE_RECOVER_SCRIPT, &owned, None)
}

pub fn report_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    if args.len() != 1
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
    {
        return Err("invalid host-issued report directory".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, REPORT_SCRIPT, &owned, None)
}

pub fn session_files_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    if args.len() != 1 || !is_match("^(?:/|~/)[^\\u0000-\\u001f\\u007f]+$", a0) {
        return Err("invalid host-issued session files path".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, SESSION_FILES_SCRIPT, &owned, None)
}

const READ_NAMES: &[&str] = &[
    "stdout", "stderr", "session.raw", "session.log", "session.log.1", "session.ckpt",
    "session.state", "last.md",
];

/// `Number.isSafeInteger` over an `f64`, matching the JS side's parse of a
/// numeric string (probe.ts readFromArgv).
fn safe_int_f64(n: f64) -> bool {
    if !n.is_finite() || n.fract() != 0.0 {
        return false;
    }
    let max = (2f64).powi(53) - 1.0;
    n >= -max && n <= max
}

pub fn read_from_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    let a2 = args.get(2).and_then(Value::as_str).unwrap_or_default();
    let a3 = args.get(3).and_then(Value::as_str).unwrap_or_default();
    let a4 = args.get(4).and_then(Value::as_str).unwrap_or_default();
    let n2 = a2.parse::<f64>().ok();
    let n3 = a3.parse::<f64>().ok();
    let in_range = READ_NAMES.contains(&a1);
    let off_ok = is_match("^(?:0|[1-9][0-9]*)$", a2) && n2.is_some_and(safe_int_f64);
    let len_ok = is_match("^[1-9][0-9]*$", a3) && n3.is_some_and(|n| n <= 262_144.0);
    // `Number.isSafeInteger(Number(args[2]) + Number(args[3]))` (offset + length).
    let sum_ok = match (n2, n3) {
        (Some(x), Some(y)) => safe_int_f64(x + y),
        _ => false,
    };
    if args.len() != 5
        || args.iter().any(|v| v.as_str().is_none())
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        || !in_range
        || !off_ok
        || !len_ok
        || !sum_ok
        || a4 != "hex"
    {
        return Err("invalid host-issued output range".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, READ_FROM_SCRIPT, &owned, None)
}

pub fn session_pipe_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    if args.len() != 1
        || !is_match("^/.*?/\\.pacer-remote/runs/t-\\d{8}-\\d{6}-[0-9a-f]{4}/[1-9][0-9]*$", a0)
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
    {
        return Err("invalid host-issued session pipe directory".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, SESSION_PIPE_SCRIPT, &owned, None)
}

pub fn binary_check_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    if args.len() != 2 || !is_match("^[a-f0-9]{64}$", a0) || a1 != "check" {
        return Err("invalid host-issued binary check".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, BINARY_SCRIPT, &owned, None)
}

pub fn binary_upload_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    if args.len() != 2
        || !is_match("^[a-f0-9]{64}$", a0)
        || a1 != "upload"
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued binary upload".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, BINARY_SCRIPT, &owned, Some(nonce))
}

pub fn bundle_out_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    let a2 = args.get(2).and_then(Value::as_str).unwrap_or_default();
    if args.len() != 3
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        || !is_match("^[a-f0-9]{40,64}$", a1)
        || !is_match("^pacer/[A-Za-z0-9._/-]+$", a2)
        || a2.contains("..")
        || a2.contains("//")
    {
        return Err("invalid host-issued bundle tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, BUNDLE_OUT_SCRIPT, &owned, None)
}

pub fn preflight_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let n = args.len();
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let a1 = args.get(1).and_then(Value::as_str).unwrap_or_default();
    let a2 = args.get(2).and_then(Value::as_str).unwrap_or_default();
    let bad_base_sha = args
        .get(3)
        .and_then(Value::as_str)
        .is_none_or(|s| !is_match("^[a-f0-9]{40}$", s));
    let bad_sha256 = args
        .get(4)
        .and_then(Value::as_str)
        .is_none_or(|s| !is_match("^[a-f0-9]{64}$", s));
    let five_ok = n != 5 || (!bad_base_sha && !bad_sha256);
    if (n != 3 && n != 5)
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        || !is_match("^[a-f0-9]{40,64}$", a1)
        || !is_match("^pacer/[A-Za-z0-9._/-]+$", a2)
        || a2.contains("..")
        || a2.contains("//")
        || !five_ok
    {
        return Err("invalid host-issued preflight tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, PREFLIGHT_SCRIPT, &owned, None)
}

pub fn set_identity_argv(
    ssh_target: &str,
    control_path: &str,
    args: &[Value],
    nonce: &str,
) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    let rest_bad = args.get(1..).is_some_and(|s| {
        s.iter()
            .any(|v| v.as_str().is_none_or(|x| x.is_empty() || x.len() > 256))
    });
    if args.len() != 3
        || !(a0.starts_with('/') || a0.starts_with("~/"))
        || utf16_len(a0) > 4096
        || rest_bad
        || args.iter().any(control_char)
        || !is_match("^[a-f0-9-]{36}$", nonce)
    {
        return Err("invalid host-issued identity tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, SET_IDENTITY_SCRIPT, &owned, Some(nonce))
}

pub fn question_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let a0 = args.first().and_then(Value::as_str).unwrap_or_default();
    if args.len() != 1
        || !a0.starts_with('/')
        || utf16_len(a0) > 4096
        || a0.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
    {
        return Err("invalid host-issued question tuple".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, QUESTION_SCRIPT, &owned, None)
}

pub fn usage_argv(ssh_target: &str, control_path: &str, args: &[Value]) -> Result<Vec<String>, String> {
    let bad_one = args.len() == 1
        && args.first().and_then(Value::as_str).is_none_or(|s| {
            s.len() > 4096
                || !(s.starts_with('/') || s.starts_with("~/"))
                || s.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
        });
    if args.len() > 1 || bad_one {
        return Err("invalid host-issued Codex usage home".to_owned());
    }
    let owned: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    issued_argv(ssh_target, control_path, CODEX_USAGE_SCRIPT, &owned, None)
}

/// Export for the query test below. `dead_code` is expected in non-test
/// builds because only the in-crate unit tests exercise it.
#[allow(dead_code)]
pub fn shell_quote(value: &str) -> String {
    shq(value)
}