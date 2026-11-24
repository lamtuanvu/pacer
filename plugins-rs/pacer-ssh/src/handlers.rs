//! The `hostRunner.*` handlers (`index.ts`): SSH lookglass provider that
//! validates each host-issued snapshot and forwards a single exact
//! `capability.process.spawn` (or `stageBundle`) per operation.

use crate::argv::*;
use crate::payload::probe_payload;
use crate::session_stream::stream_session;
use pacer_plugin::{Ctx, PluginError, js};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct Session {
    pub ssh_target: String,
    pub control_path: String,
}

pub type Sessions = Arc<std::sync::Mutex<HashMap<String, Session>>>;

fn fail(code: &str, message: &str) -> PluginError {
    PluginError::new(code.to_owned(), message.to_owned())
}

fn as_record(value: &Value) -> &Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => {
            // Senders always pass an object; a non-object is treated as empty.
            static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
            EMPTY.get_or_init(Map::new)
        }
    }
}

fn valid_target(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(s)) if regex_of("^[A-Za-z0-9._@][A-Za-z0-9._@-]*$").is_match(s))
}

fn valid_session(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(s)) if regex_of("^[A-Za-z0-9_-]{16,128}$").is_match(s))
}

fn valid_control_path(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(s))
        if js::utf16_len(s) <= 512 && regex_of(r"^\/[^\u0000-\u001f]*\/cm-%C$").is_match(s))
}

fn regex_of(pattern: &'static str) -> &'static regex::Regex {
    static RE: std::sync::OnceLock<HashMap<&str, regex::Regex>> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(pattern, regex::Regex::new(pattern).unwrap());
        m
    })
    .get(pattern)
    .expect("regex compiled")
}

fn is_completion_nonce(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if regex_of("^[a-f0-9-]{36}$").is_match(s))
}

fn is_safe_int(v: Option<&Value>) -> bool {
    v.and_then(js::safe_integer).is_some()
}

/// `Number.isSafeInteger` is satisfied by `js::safe_integer`; this
/// separates the value range check from the presence checks.
fn int_range(v: &Value, lo: i64, hi: i64) -> bool {
    js::safe_integer(v).is_some_and(|n| n >= lo && n <= hi)
}

/// Extract the inline spawn result with `stdout`, failing `too_large` when
/// the host returned the oversized `output` variant instead.
fn inline_spawn(result: &Value) -> Result<(), PluginError> {
    if result.get("output").is_some() {
        return Err(fail(
            "too_large",
            "SSH check output exceeds the inline bound",
        ));
    }
    Ok(())
}

fn as_script(v: &Value) -> Option<&str> {
    v.get("script").and_then(Value::as_str)
}

/// The `hostRunner.check` handler.
pub async fn check(input: &Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let rec = as_record(input);
    let alias = rec.get("alias");
    let ssh_target = rec.get("sshTarget");
    let control_path = rec.get("controlPath");
    let repo = rec.get("repo");
    let home = rec.get("home");
    let repo_bad = matches!(repo, Some(v) if !matches!(v, Value::String(s) if !s.trim().is_empty() && !s.contains('\0')));
    let home_bad = matches!(home, Some(v) if !matches!(v, Value::String(s) if !s.trim().is_empty() && !s.contains('\0')));
    if ctx.cancel.is_cancelled()
        || !matches!(alias, Some(Value::String(s)) if regex_of("^[a-z0-9][a-z0-9-]*$").is_match(s))
        || !valid_target(ssh_target)
        || !valid_control_path(control_path)
        || repo_bad
        || home_bad
        || (repo.is_some() && home.is_some())
    {
        return Err(fail(
            "capability_denied",
            "host check has no issued SSH snapshot",
        ));
    }
    let ssh_target = ssh_target.and_then(Value::as_str).unwrap_or_default();
    let control_path = control_path.and_then(Value::as_str).unwrap_or_default();
    let home = home.and_then(Value::as_str);
    let repo = repo.and_then(Value::as_str);
    let argv = match home {
        Some(h) => check_home_argv(ssh_target, control_path, h),
        None => match repo {
            Some(r) => check_repo_argv(ssh_target, control_path, r),
            None => probe_argv(ssh_target, control_path),
        },
    }
    .map_err(|_| fail("capability_denied", "host check has no issued SSH snapshot"))?;
    let result = ctx
        .host
        .call(
            "capability.process.spawn",
            json!({ "argv": argv, "timeoutMs": 50_000 }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH check cancelled"));
    }
    inline_spawn(&result)?;
    if result.get("code").and_then(Value::as_i64) == Some(255) {
        return Err(fail("plugin_unavailable", "SSH check connection failed"));
    }
    let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or_default();
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or_default();
    let framed = probe_payload(stdout).map_err(|_| {
        fail("plugin_refused", "SSH check returned no payload frame")
    })?;
    if js::utf16_len(framed) as usize + js::utf16_len(stderr) as usize > 65_536 {
        return Err(fail("too_large", "SSH check output exceeds the issued bound"));
    }
    let code = result.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let timed_out = result.get("timedOut").and_then(Value::as_bool).unwrap_or(false);
    let checked = code == 0 && !timed_out;
    let facts = parse_facts(framed);
    if home.is_some() {
        return Ok(json!({
            "ok": checked,
            "checks": [{
                "name": "account home",
                "ok": checked,
                "detail": if checked { "" } else { "missing account home" },
            }],
        }));
    }
    if repo.is_none() {
        let keep = ["os", "arch", "glibc", "git", "setsid", "script", "tail", "codex", "claude"];
        return Ok(json!({
            "ok": checked,
            "checks": [{
                "name": "ssh",
                "ok": checked,
                "detail": if checked { "" } else { "unreachable" },
            }],
            "facts": filter_facts(&facts, &keep, 256),
        }));
    }
    let ok = checked && facts.get("exists") == Some(&json!("1"))
        && facts.get("git") == Some(&json!("1"));
    let keep = ["exists", "git", "origin", "name", "email"];
    let repo_facts = if checked {
        filter_facts(&facts, &keep, 256)
    } else {
        Map::new()
    };
    Ok(json!({
        "ok": ok,
        "checks": [{
            "name": "checkout",
            "ok": ok,
            "detail": if ok { "" } else { "checkout unavailable" },
        }],
        "facts": repo_facts,
    }))
}

fn parse_facts(data: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for line in data.split('\n') {
        if let Some(eq) = line.find('=') {
            out.insert(line[..eq].to_owned(), json!(line[eq + 1..].to_owned()));
        }
    }
    out
}

fn filter_facts(facts: &Map<String, Value>, keep: &[&str], max: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for key in keep {
        if let Some(value) = facts.get(*key) {
            if js::utf16_len(value.as_str().unwrap_or_default()) <= max {
                out.insert(key.to_string(), value.clone());
            }
        }
    }
    out
}

/// The `hostRunner.open` handler: allocate a session id.
pub async fn open(input: &Value, ctx: &Ctx, sessions: &Sessions) -> Result<Value, PluginError> {
    let rec = as_record(input);
    let target = rec.get("sshTarget");
    let path = rec.get("controlPath");
    let path_valid = matches!(path, Some(Value::String(s))
        if js::utf16_len(s) <= 512 && regex_of(r"^\/[^\u0000-\u001f]*\/cm-%C$").is_match(s));
    if ctx.cancel.is_cancelled() || !valid_target(target) || !path_valid {
        return Err(fail("invalid_input", "invalid host-issued SSH snapshot"));
    }
    let session = new_session_id();
    sessions
        .lock()
        .map_err(|_| fail("plugin_unavailable", "session registry unavailable"))?
        .insert(
            session.clone(),
            Session {
                ssh_target: target.and_then(Value::as_str).unwrap_or_default().to_owned(),
                control_path: path.and_then(Value::as_str).unwrap_or_default().to_owned(),
            },
        );
    Ok(json!({ "session": session }))
}

fn new_session_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The `hostRunner.close` handler.
pub async fn close(input: &Value, sessions: &Sessions) -> Result<Value, PluginError> {
    let session = input.get("session");
    let mut map = sessions
        .lock()
        .map_err(|_| fail("plugin_unavailable", "session registry unavailable"))?;
    if !valid_session(session)
        || map.remove(&session.and_then(Value::as_str).unwrap_or_default().to_owned()).is_none()
    {
        return Err(fail("capability_denied", "unknown provider SSH session"));
    }
    Ok(json!({ "ok": true }))
}

fn lookup(session: Option<&Value>, sessions: &Sessions) -> Result<Session, PluginError> {
    let map = sessions
        .lock()
        .map_err(|_| fail("plugin_unavailable", "session registry unavailable"))?;
    map.get(&session.and_then(Value::as_str).unwrap_or_default().to_owned())
        .cloned()
        .ok_or_else(|| fail("capability_denied", "unknown provider SSH session"))
}

/// The `hostRunner.run` handler: validate the script tuple, build the exact
/// ssh argv, spawn it, and return the payload frame.
pub async fn run(input: &Value, ctx: &Ctx, sessions: &Sessions) -> Result<Value, PluginError> {
    let _rec = as_record(input);
    let script = as_script(input);
    let args = input.get("args").and_then(Value::as_array);
    let session_id = input.get("session");
    let probe = script == Some("PROBE") && args.is_some_and(|a| a.is_empty());
    let repo_check = script == Some("CHECK_REPO") && args.is_some_and(|a| a.len() == 2)
        && matches!(args.and_then(|a| a.get(0)), Some(Value::String(s)) if !s.is_empty() && !s.contains('\0'))
        && matches!(args.and_then(|a| a.get(1)), Some(Value::String(s)) if s == "check");
    let preflight = script == Some("PREFLIGHT") && args.is_some_and(|a| [3, 5].contains(&a.len()));
    let identity = script == Some("SET_IDENTITY") && args.is_some_and(|a| a.len() == 3)
        && is_completion_nonce(input.get("completionNonce"));
    let clone = script == Some("CHECK_REPO") && args.is_some_and(|a| a.len() == 3)
        && matches!(args.and_then(|a| a.get(1)), Some(Value::String(s)) if s == "clone")
        && is_completion_nonce(input.get("completionNonce"));
    let clean = script == Some("CLEAN") && args.is_some_and(|a| [5, 6].contains(&a.len()))
        && is_completion_nonce(input.get("completionNonce"));
    let prepare = script == Some("PREPARE") && args.is_some_and(|a| a.len() == 6)
        && is_completion_nonce(input.get("completionNonce"));
    let prepare_recover = script == Some("PREPARE_RECOVER") && args.is_some_and(|a| a.len() == 6);
    let report = script == Some("REPORT") && args.is_some_and(|a| a.len() == 1);
    let session_files = script == Some("SESSION_FILES") && args.is_some_and(|a| a.len() == 1);
    let read_from = script == Some("READ_FROM") && args.is_some_and(|a| a.len() == 5);
    let binary_check = script == Some("BINARY") && args.is_some_and(|a| a.len() == 2)
        && matches!(args.and_then(|a| a.get(1)), Some(Value::String(s)) if s == "check");
    let stop = script == Some("STOP") && args.is_some_and(|a| a.len() == 2)
        && is_completion_nonce(input.get("completionNonce"));
    let start = script == Some("START") && args.is_some_and(|a| a.len() >= 6 && a.len() <= 25)
        && is_completion_nonce(input.get("completionNonce"));
    let question = script == Some("QUESTION") && args.is_some_and(|a| a.len() == 1);
    let usage = script == Some("CODEX_USAGE") && args.is_some_and(|a| a.len() <= 1);
    let any = probe || repo_check || preflight || identity || clone || clean || stop || start
        || prepare || prepare_recover || report || session_files || read_from || binary_check
        || question || usage;
    // Nonce must be a valid completion UUID exactly for the completing ops.
    let nonce_ok = if identity || clone || clean || stop || start || prepare {
        is_completion_nonce(input.get("completionNonce"))
    } else {
        input.get("completionNonce").is_none()
    };
    let timeout_ms = input.get("timeoutMs");
    let max_bytes = input.get("maxBytes");
    let timeout_ok = is_safe_int(timeout_ms) && int_range(timeout_ms.unwrap_or(&Value::Null), 1, 120_000);
    let max_ok = is_safe_int(max_bytes) && int_range(max_bytes.unwrap_or(&Value::Null), 1, 65_536);
    let read_from_cap = read_from
        && int_range(max_bytes.unwrap_or(&Value::Null), 1, 524_288);
    if !valid_session(session_id)
        || !any
        || !nonce_ok
        || input.get("stdin").is_some()
        || input.get("env").is_some()
        || input.get("secretEnv").is_some()
        || !timeout_ok
        || !(max_ok || read_from_cap)
    {
        return Err(fail(
            "capability_denied",
            "host operation is not issued for this provider",
        ));
    }
    let session = lookup(session_id, sessions)?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH operation cancelled"));
    }
    let args: &[Value] = args.expect("args present for an admitted op");
    let nonce = input.get("completionNonce").and_then(Value::as_str).unwrap_or_default();
    let built = (|| {
        if probe {
            probe_argv(&session.ssh_target, &session.control_path)
        } else if usage {
            usage_argv(&session.ssh_target, &session.control_path, args)
        } else if question {
            question_argv(&session.ssh_target, &session.control_path, args)
        } else if preflight {
            preflight_argv(&session.ssh_target, &session.control_path, args)
        } else if identity {
            set_identity_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if stop {
            stop_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if prepare {
            prepare_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if prepare_recover {
            prepare_recover_argv(&session.ssh_target, &session.control_path, args)
        } else if start {
            start_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if report {
            report_argv(&session.ssh_target, &session.control_path, args)
        } else if session_files {
            session_files_argv(&session.ssh_target, &session.control_path, args)
        } else if read_from {
            read_from_argv(&session.ssh_target, &session.control_path, args)
        } else if binary_check {
            binary_check_argv(&session.ssh_target, &session.control_path, args)
        } else if clean {
            clean_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if clone {
            clone_repo_argv(&session.ssh_target, &session.control_path, args, nonce)
        } else if repo_check {
            check_repo_argv(&session.ssh_target, &session.control_path, args_iter_get(args, 0))
        } else {
            unreachable!("an admitted op implies a builder")
        }
    })();
    let argv = built.map_err(|_| fail("capability_denied", "invalid host-issued operation"))?;
    let result = ctx
        .host
        .call(
            "capability.process.spawn",
            json!({ "argv": argv, "timeoutMs": timeout_ms }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH operation cancelled"));
    }
    if result.get("output").is_some() {
        return Err(fail("too_large", "SSH probe output exceeds the inline bound"));
    }
    if result.get("code").and_then(Value::as_i64) == Some(255) {
        return Err(fail("plugin_unavailable", "SSH probe connection failed"));
    }
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or_default();
    let code = result.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if result.get("timedOut").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(json!({ "code": code, "stdout": "", "stderr": stderr, "timedOut": true }));
    }
    let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or_default();
    let framed = probe_payload(stdout).map_err(|_| {
        fail("plugin_refused", "SSH probe returned no payload frame")
    })?;
    let max_bytes_n = js::safe_integer(max_bytes.unwrap_or(&Value::Null)).unwrap_or(0) as usize;
    if js::utf16_len(framed) + js::utf16_len(stderr) > max_bytes_n {
        return Err(fail("too_large", "SSH probe output exceeds the issued bound"));
    }
    Ok(json!({ "code": code, "stdout": framed, "stderr": stderr, "timedOut": false }))
}

fn args_iter_get(args: &[Value], i: usize) -> &str {
    args.get(i)
        .and_then(Value::as_str)
        .expect("admitted check_repo has a non-empty string first arg")
}

/// The `hostRunner.fetch` handler: bundle stage via `stageBundle`.
pub async fn fetch(input: &Value, ctx: &Ctx, sessions: &Sessions) -> Result<Value, PluginError> {
    let _rec = as_record(input);
    let session_id = input.get("session");
    let args = input.get("args").and_then(Value::as_array);
    let timeout_ms = input.get("timeoutMs");
    let max_bytes = input.get("maxBytes");
    let ok = valid_session(session_id)
        && as_script(input) == Some("BUNDLE_OUT")
        && args.is_some_and(|a| a.len() == 3)
        && input.get("stdin").is_none()
        && is_safe_int(timeout_ms) && int_range(timeout_ms.unwrap_or(&Value::Null), 1, 60_000)
        && is_safe_int(max_bytes)
        && int_range(max_bytes.unwrap_or(&Value::Null), 1, 50 * 1024 * 1024);
    if !ok {
        return Err(fail(
            "capability_denied",
            "bundle fetch is not issued for this provider",
        ));
    }
    let session = lookup(session_id, sessions)?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH bundle fetch cancelled"));
    }
    let args: &[Value] = args.expect("3-arg bundle tuple");
    let argv = bundle_out_argv(&session.ssh_target, &session.control_path, args)
        .map_err(|_| fail("capability_denied", "invalid host-issued bundle tuple"))?;
    let result = ctx
        .host
        .call(
            "capability.process.stageBundle",
            json!({ "argv": argv, "timeoutMs": timeout_ms, "maxBytes": max_bytes }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH bundle fetch cancelled"));
    }
    let handle = result.get("handle").and_then(Value::as_str).unwrap_or_default();
    let bytes = result.get("bytes").and_then(js::safe_integer);
    let sha256 = result.get("sha256").and_then(Value::as_str).unwrap_or_default();
    let handle_ok = regex_of(r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
        .is_match(handle);
    let bytes_ok = bytes.is_some() && bytes.unwrap_or(0) >= 0
        && bytes.unwrap_or(0) <= max_bytes.and_then(js::safe_integer).unwrap_or(0);
    let sha_ok = regex_of("^[a-f0-9]{64}$").is_match(sha256);
    if !handle_ok || !bytes_ok || !sha_ok {
        return Err(fail("plugin_refused", "bundle stage returned invalid metadata"));
    }
    Ok(json!({
        "handle": handle,
        "bytes": bytes.unwrap_or(0),
        "sha256": sha256,
    }))
}

/// The `hostRunner.upload` handler: binary upload via spawn.
pub async fn upload(input: &Value, ctx: &Ctx, sessions: &Sessions) -> Result<Value, PluginError> {
    let _rec = as_record(input);
    let session_id = input.get("session");
    let args = input.get("args").and_then(Value::as_array);
    let timeout_ms = input.get("timeoutMs");
    let max_bytes = input.get("maxBytes");
    let attempt = input.get("completionNonce");
    let ok = valid_session(session_id)
        && as_script(input) == Some("BINARY")
        && args.is_some_and(|a| a.len() == 2)
        && matches!(args.and_then(|a| a.get(1)), Some(Value::String(s)) if s == "upload")
        && input.get("stdin").is_none()
        && matches!(attempt, Some(Value::String(_)))
        && is_safe_int(timeout_ms) && int_range(timeout_ms.unwrap_or(&Value::Null), 1, 300_000)
        && is_safe_int(max_bytes) && int_range(max_bytes.unwrap_or(&Value::Null), 1, 4096);
    if !ok {
        return Err(fail(
            "capability_denied",
            "binary upload is not issued for this provider",
        ));
    }
    let session = lookup(session_id, sessions)?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH binary upload cancelled"));
    }
    let args: &[Value] = args.expect("2-arg upload tuple");
    let nonce = attempt.and_then(Value::as_str).unwrap_or_default();
    let argv = binary_upload_argv(&session.ssh_target, &session.control_path, args, nonce)
        .map_err(|_| fail("capability_denied", "invalid host-issued binary upload"))?;
    let result = ctx
        .host
        .call(
            "capability.process.spawn",
            json!({ "argv": argv, "timeoutMs": timeout_ms }),
        )
        .await?;
    if ctx.cancel.is_cancelled() {
        return Err(fail("capability_denied", "SSH binary upload cancelled"));
    }
    if result.get("output").is_some() {
        return Err(fail("too_large", "SSH binary upload output exceeds the inline bound"));
    }
    if result.get("code").and_then(Value::as_i64) == Some(255) {
        return Err(fail("plugin_unavailable", "SSH binary upload connection failed"));
    }
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or_default();
    let code = result.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if result.get("timedOut").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(json!({ "code": code, "stdout": "", "stderr": stderr, "timedOut": true }));
    }
    let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or_default();
    let framed = probe_payload(stdout).map_err(|_| {
        fail("plugin_refused", "SSH binary upload returned no payload frame")
    })?;
    if js::utf16_len(framed) as usize + js::utf16_len(stderr) as usize
        > max_bytes.and_then(js::safe_integer).unwrap_or(0) as usize
    {
        return Err(fail("too_large", "SSH binary upload output exceeds the issued bound"));
    }
    Ok(json!({ "code": code, "stdout": framed, "stderr": stderr, "timedOut": false }))
}

/// The `hostRunner.stream` handler: delegate to the owned session stream.
pub async fn stream(input: &Value, ctx: &Ctx, sessions: &Sessions) -> Result<Value, PluginError> {
    let session_id = input.get("session");
    if !valid_session(session_id) {
        return Err(fail("capability_denied", "unknown provider SSH session"));
    }
    let session = lookup(session_id, sessions)?;
    stream_session(input, ctx, &session).await
}