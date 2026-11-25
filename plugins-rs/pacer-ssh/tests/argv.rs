//! Tests of the exact `ssh` argv the provider issues, ported from
//! `plugins/pacer-ssh/probe.ts` (`issuedArgv` at `probe.ts:334-349` and the
//! builder validations at `probe.ts:351-521`). The argv builders live in a
//! private `mod argv` (see `src/lib.rs`), so this exercises them through the
//! handlers: it opens a session, drives `hostRunner.run`, and asserts the exact
//! spawn argv the plugin hands back to the host.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_plugin::testing::Harness;
use regex::Regex;
use serde_json::{Value, json};

/// A fixed valid host target (`^[A-Za-z0-9._@][A-Za-z0-9._@-]*$`).
const TARGET: &str = "host.example.com";
/// A fixed valid control path (`^\/[^\u0000-\u001f]*\/cm-%C$`, length <= 512).
const CONTROL: &str = "/tmp/private/cm-%C";
/// A fixed valid completion nonce (`^[a-f0-9-]{36}$`).
const NONCE: &str = "123e4567-e89b-12d3-a456-426614174000";
/// A valid task tag (`^t-\d{8}-\d{6}-[0-9a-f]{4}$`).
const TASK: &str = "t-20261124-000000-abcd";
/// A valid run dir under `.pacer-remote/runs`.
const RUN_D: &str = "/home/test/.pacer-remote/runs/t-20261124-000000-abcd/1";

/// The exact fixed head of every issued argv (probe.ts:342-348), up to and
/// including the target.
fn issued_head() -> Vec<String> {
    vec![
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
        format!("ControlPath={CONTROL}"),
        "-o".to_owned(),
        "ControlPersist=60".to_owned(),
        "--".to_owned(),
        TARGET.to_owned(),
    ]
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

/// Assert the captured spawn `argv` has the exact fixed head plus a remote
/// command of the expected shell shape.
fn assert_argv(argv: &Value, nonce: Option<&str>, args: &[&str]) {
    let list: &Vec<Value> = argv
        .as_array()
        .expect("argv must be an array");
    let expected_head = issued_head();
    assert_eq!(list.len(), expected_head.len() + 1, "argv length");
    assert_eq!(
        &list[..expected_head.len()],
        &expected_head
            .iter()
            .map(|s| Value::String(s.clone()))
            .collect::<Vec<Value>>()[..],
        "argv fixed head"
    );
    let command = list.last().expect("argv tail").as_str().expect("command string");
    assert!(command.starts_with("bash -lc "), "remote command must be bash -lc quoted");
    assert!(command.contains("__PACER_BEGIN__"), "program must carry the payload marker");
    if let Some(nonce) = nonce {
        assert!(
            command.contains(&format!("__PACER_DONE__={nonce}")),
            "completing op must embed the completion nonce"
        );
    } else {
        assert!(
            !command.contains("pacer_result"),
            "non-completing op must not wrap the DONE marker"
        );
    }
    // Per-argument shq appends after the `... pacer` program name. The program
    // build may itself embed ` pacer` inline (`pacer_result=`, or a script that
    // drives ` pacer `), and an appended branch arg can begin with `pacer/`.
    // The builder always emits a ` pacer` delimiter directly before the first
    // trailing arg, so scan from the end for the first match that is either at
    // end-of-string (empty arg list) or followed by a space (the arg
    // separator); skip `pacer/` (a branch arg) and `pacer_result` matches.
    let marker = " pacer";
    let mut tail = "";
    for (idx, _) in command.rmatch_indices(marker) {
        let after = &command[idx + marker.len()..];
        if after.is_empty() || after.starts_with(' ') {
            tail = after;
            break;
        }
    }
    assert!(
        !command.is_empty() && (tail.starts_with(' ') || tail.is_empty()),
        "pacer program marker missing: {command:?}"
    );
    for (i, arg) in args.iter().enumerate() {
        let expected_arg = format!(" {}", shq(arg));
        assert!(
            tail.starts_with(&expected_arg),
            "arg {i} must be shell-quoted and appended: {arg:?}"
        );
        tail = &tail[expected_arg.len()..];
    }
}

/// Open a session on a fresh harness and return (harness, session id).
async fn open(h: &mut Harness) -> String {
    let result = h
        .call(
            "hostRunner.open",
            json!({ "alias": "box", "sshTarget": TARGET, "controlPath": CONTROL }),
        )
        .await
        .expect("open succeeds");
    let session = result.get("session").and_then(Value::as_str).expect("session id");
    let re = Regex::new(r"^[0-9a-f]{32}$").expect("session regex");
    assert!(re.is_match(session), "session id must be dashed-less hex uuid");
    session.to_owned()
}

/// The valid spawn answer every argv test returns: a framed payload.
fn spawn_answer() -> Value {
    json!({ "code": 0, "stdout": "__PACER_BEGIN__\nok", "stderr": "", "timedOut": false })
}

// probe.ts:351-353 — PROBE (empty args, no nonce) issues the bare probe argv.
#[tokio::test]
async fn probe_issues_the_exact_bare_argv() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "PROBE", "args": [],
            "timeoutMs": 10_000, "maxBytes": 4096
        }),
    )
    .await
    .expect("probe run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    let (method, params) = &spawn[0];
    assert_eq!(method, "capability.process.spawn");
    assert_eq!(params["timeoutMs"], 10_000);
    assert_argv(&params["argv"], None, &[]);
    h.close().await;
}

// probe.ts:419-423 — PREPARE (6 args + completionNonce) issues the wrapping
// completely-remote argv with the nonce.
#[tokio::test]
async fn prepare_appends_nonce_and_six_tuple_args() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let args = [
        "~/work".to_string(),
        "v1-1234abcd".to_string(),
        TASK.to_string(),
        "a".repeat(40),
        "pacer/main".to_string(),
        "1".to_string(),
    ];
    let call_args: Vec<Value> = args.iter().cloned().map(Value::String).collect();
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "PREPARE", "args": call_args,
            "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 65_536
        }),
    )
    .await
    .expect("prepare run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(&spawn[0].1["argv"], Some(NONCE), &[]);
    h.close().await;
}

// probe.ts:397-407 — START (>= 6 args + completionNonce) with a pipe mode and
// a single command group after `--`.
#[tokio::test]
async fn start_appends_command_args_after_double_dash() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let full = json!([
        RUN_D, "/home/test", "pipe", "--", "echo", "hi"
    ]);
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "START", "args": full,
            "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 65_536
        }),
    )
    .await
    .expect("start run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(&spawn[0].1["argv"], Some(NONCE), &[RUN_D, "/home/test", "pipe", "--", "echo", "hi"]);
    h.close().await;
}

// probe.ts:375-387 — CLEAN (5-6 args + completionNonce).
#[tokio::test]
async fn clean_appends_five_tuple_args() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let branch = format!("pacer/{TASK}");
    let args = json!([
        "/home/test/wt", "/home/test/.pacer-remote/runs", "/home/test/co",
        TASK, branch,
    ]);
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "CLEAN", "args": args,
            "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 65_536
        }),
    )
    .await
    .expect("clean run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(
        &spawn[0].1["argv"],
        Some(NONCE),
        &["/home/test/wt", "/home/test/.pacer-remote/runs", "/home/test/co", TASK, &branch],
    );
    h.close().await;
}

// probe.ts:389-395 — STOP (2 args + completionNonce).
#[tokio::test]
async fn stop_appends_two_tuple_args() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let args = json!([RUN_D, "60"]);
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "STOP", "args": args,
            "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 65_536
        }),
    )
    .await
    .expect("stop run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(&spawn[0].1["argv"], Some(NONCE), &[]);
    h.close().await;
}

// probe.ts:463-467 — BINARY check (2 args, no nonce).
#[tokio::test]
async fn binary_check_appends_two_args() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let args = json!([("a").repeat(64), "check"]);
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "BINARY", "args": args,
            "timeoutMs": 60_000, "maxBytes": 65_536
        }),
    )
    .await
    .expect("binary check succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(&spawn[0].1["argv"], None, &[]);
    h.close().await;
}

// probe.ts:443-453 — READ_FROM (5 args, no nonce) with a large maxBytes cap.
#[tokio::test]
async fn read_from_appends_five_range_args() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let args = json!([RUN_D, "stdout", "0", "1024", "hex"]);
    h.call(
        "hostRunner.run",
        json!({
            "session": session, "script": "READ_FROM", "args": args,
            "timeoutMs": 60_000, "maxBytes": 262_144
        }),
    )
    .await
    .expect("read_from run succeeds");
    let spawn = h.capability_calls();
    assert_eq!(spawn.len(), 1);
    assert_argv(&spawn[0].1["argv"], None, &[]);
    h.close().await;
}

// index.ts:101 — an unmatched tuple for a known script is denied before spawn.
#[tokio::test]
async fn unissued_tuple_is_denied_before_spawn() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    // A PROBE with a completion nonce is not an issued PROBE (probe requires
    // completionNonce absent).
    let err = h
        .call(
            "hostRunner.run",
            json!({
                "session": session, "script": "PROBE", "args": [],
                "completionNonce": NONCE, "timeoutMs": 10_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("probe must not accept a nonce");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "host operation is not issued for this provider");
    assert!(h.capability_calls().is_empty(), "no spawn issued for an unissued tuple");
    h.close().await;
}

// index.ts:109 — a run for an unknown session is denied with the session text.
#[tokio::test]
async fn run_with_unknown_session_is_denied() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let err = h
        .call(
            "hostRunner.run",
            json!({
                "session": "0123456789abcdef0123456789abcdef", "script": "PROBE", "args": [],
                "timeoutMs": 10_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("unknown session is denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "unknown provider SSH session");
    assert!(h.capability_calls().is_empty());
    h.close().await;
}

// index.ts:38/134 — a spawn result with an `output` handle is `too_large`
// before any payload parsing for run operations.
#[tokio::test]
async fn run_output_handle_is_too_large() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({
            "code": 0, "timedOut": false,
            "output": { "stdout": NONCE, "stderr": NONCE }
        }))
    });
    let err = h
        .call(
            "hostRunner.run",
            json!({
                "session": session, "script": "PROBE", "args": [],
                "timeoutMs": 10_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("output handle must be refused");
    assert_eq!(err.code, "too_large");
    assert_eq!(err.message, "SSH probe output exceeds the inline bound");
    h.close().await;
}