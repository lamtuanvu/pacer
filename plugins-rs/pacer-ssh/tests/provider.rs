//! Provider-level tests for the `hostRunner.*` handlers, ported from
//! `test/plugins-ssh.test.ts` and `plugins/pacer-ssh/index.ts`. These cover the
//! session lifecycle (`check` / `open` / `run` / `fetch` / `upload` / `close`)
//! and the exact error codes and messages each handler returns for a malformed
//! or denied operation.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_plugin::testing::Harness;
use serde_json::{Value, json};

/// A fixed valid host target.
const TARGET: &str = "host.example.com";
/// A fixed valid control path (`^\/[^\u0000-\u001f]*\/cm-%C$`, length <= 512).
const CONTROL: &str = "/tmp/private/cm-%C";
/// A fixed valid completion nonce (`^[a-f0-9-]{36}$`).
const NONCE: &str = "123e4567-e89b-12d3-a456-426614174000";
/// A valid run dir under `.pacer-remote/runs`.
const RUN_D: &str = "/home/test/.pacer-remote/runs/t-20261124-000000-abcd/1";

/// A valid bundle sha (`^[a-f0-9]{40,64}$`).
fn sha() -> String {
    "a".repeat(40)
}

/// A valid full 64-hex sha (`^[a-f0-9]{64}$`), as required by the binary
/// upload/check tuples and the `stageBundle` result `sha256`.
fn sha64() -> String {
    "a".repeat(64)
}

/// The valid spawn answer: a framed payload at a line start.
fn spawn_answer() -> Value {
    json!({ "code": 0, "stdout": "__PACER_BEGIN__\nok", "stderr": "", "timedOut": false })
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
    result.get("session").and_then(Value::as_str).expect("session id").to_owned()
}

// index.ts:check — unavailable (ssh	connection failed, code 255) is
// `plugin_unavailable`.
#[tokio::test]
async fn check_connection_failure_is_unavailable() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 255, "stdout": "", "stderr": "ssh: connect failed", "timedOut": false }))
    });
    let err = h
        .call(
            "hostRunner.check",
            json!({ "alias": "box", "sshTarget": TARGET, "controlPath": CONTROL }),
        )
        .await
        .expect_err("code 255 must be unavailable");
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "SSH check connection failed");
    h.close().await;
}

// index.ts:run — a run result carrying an oversized `output` (instead of
// inline stdout) is `too_large` before any payload parsing.
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

// index.ts:run — a spawn result with no payload frame is `plugin_refused`.
#[tokio::test]
async fn run_missing_marker_is_refused() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "stdout": "no marker here", "stderr": "", "timedOut": false }))
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
        .expect_err("missing marker must be refused");
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "SSH probe returned no payload frame");
    h.close().await;
}

// index.ts:check — the probe `check` surfaces only the kept fact keys.
#[tokio::test]
async fn check_surfaces_only_kept_facts() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let facts = "__PACER_BEGIN__\nos=linux\narch=x86_64\nglibc=2.35\ngit=2.39\nsetsid=1\n"
        .to_owned()
        + "script=1\n" + "tail=1\n" + "codex=1\n" + "claude=1\n"
        + "exists=1\n" + "email=nope\n";
    h.on_capability("capability.process.spawn", move |_| {
        Ok(json!({ "code": 0, "stdout": facts, "stderr": "", "timedOut": false }))
    });
    let result = h
        .call(
            "hostRunner.check",
            json!({ "alias": "box", "sshTarget": TARGET, "controlPath": CONTROL }),
        )
        .await
        .expect("check succeeds");
    assert_eq!(result["ok"], json!(true));
    let facts = result.get("facts").expect("facts").as_object().expect("facts object");
    let keys: Vec<_> = facts.keys().cloned().collect();
    let expected = vec!["os", "arch", "glibc", "git", "setsid", "script", "tail", "codex", "claude"];
    assert_eq!(keys, expected, "probe check keeps only the whitelisted fact keys");
    assert_eq!(facts.get("email"), None, "email is not a kept probe fact");
    h.close().await;
}

// index.ts:check — an invalid alias is denied before spawn.
#[tokio::test]
async fn check_invalid_alias_is_denied() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let err = h
        .call(
            "hostRunner.check",
            json!({ "alias": "Bad Alias!", "sshTarget": TARGET, "controlPath": CONTROL }),
        )
        .await
        .expect_err("bad alias must be denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "host check has no issued SSH snapshot");
    assert!(h.capability_calls().is_empty(), "no spawn issued for a denied check");
    h.close().await;
}

// index.ts:open — a bad control path is `invalid_input`.
#[tokio::test]
async fn open_bad_control_path_is_invalid_input() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let err = h
        .call(
            "hostRunner.open",
            json!({ "alias": "box", "sshTarget": TARGET, "controlPath": "/tmp/no-cm-or-c" }),
        )
        .await
        .expect_err("bad control path must be invalid input");
    assert_eq!(err.code, "invalid_input");
    assert_eq!(err.message, "invalid host-issued SSH snapshot");
    h.close().await;
}

// index.ts:open — a bad target is `invalid_input`.
#[tokio::test]
async fn open_bad_target_is_invalid_input() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let err = h
        .call(
            "hostRunner.open",
            json!({ "alias": "box", "sshTarget": "no spaces", "controlPath": CONTROL }),
        )
        .await
        .expect_err("bad target must be invalid input");
    assert_eq!(err.code, "invalid_input");
    assert_eq!(err.message, "invalid host-issued SSH snapshot");
    h.close().await;
}

// index.ts:open → run → close — the full session lifecycle.
#[tokio::test]
async fn open_run_close_session_lifecycle() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    h.on_capability("capability.process.spawn", |_| Ok(spawn_answer()));
    let session = open(&mut h).await;
    let run = h
        .call(
            "hostRunner.run",
            json!({
                "session": session, "script": "PROBE", "args": [],
                "timeoutMs": 10_000, "maxBytes": 4096
            }),
        )
        .await
        .expect("run succeeds");
    assert_eq!(run["code"], json!(0));
    assert_eq!(run["stdout"], json!("ok"));
    let close = h
        .call("hostRunner.close", json!({ "session": session }))
        .await
        .expect("close succeeds");
    assert_eq!(close, json!({ "ok": true }));
    h.close().await;
}

// index.ts:run — a bad session id denies the run.
#[tokio::test]
async fn run_bad_session_is_denied() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let err = h
        .call(
            "hostRunner.run",
            json!({
                "session": "short", "script": "PROBE", "args": [],
                "timeoutMs": 10_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("bad session must be denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "host operation is not issued for this provider");
    h.close().await;
}

// index.ts:run — a run on a well-formed but never-opened session is denied
// with the session error, not the tuple error.
#[tokio::test]
async fn run_unknown_session_is_denied() {
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
        .expect_err("unknown session must be denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "unknown provider SSH session");
    h.close().await;
}

// index.ts:run — a probe bearing a completion nonce is an unissued tuple.
#[tokio::test]
async fn run_probe_with_nonce_is_denied() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
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
    assert!(h.capability_calls().is_empty(), "no spawn for an unissued tuple");
    h.close().await;
}

// index.ts:fetch — a bundle stage returning invalid metadata is `plugin_refused`.
#[tokio::test]
async fn fetch_invalid_stage_metadata_is_refused() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    h.on_capability("capability.process.stageBundle", |_| {
        Ok(json!({ "handle": "short", "bytes": 10, "sha256": "not-a-sha" }))
    });
    let err = h
        .call(
            "hostRunner.fetch",
            json!({
                "session": session, "script": "BUNDLE_OUT", "args": [RUN_D, sha(), "pacer/main"],
                "timeoutMs": 30_000, "maxBytes": 1_048_576
            }),
        )
        .await
        .expect_err("bad stage metadata must be refused");
    assert_eq!(err.code, "plugin_refused");
    assert_eq!(err.message, "bundle stage returned invalid metadata");
    h.close().await;
}

// index.ts:fetch — valid stage metadata is passed through.
#[tokio::test]
async fn fetch_valid_stage_metadata_is_returned() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let handle = "12345678-1234-4123-8123-123456789abc";
    h.on_capability("capability.process.stageBundle", move |_| {
        Ok(json!({ "handle": handle, "bytes": 15, "sha256": sha64() }))
    });
    let result = h
        .call(
            "hostRunner.fetch",
            json!({
                "session": session, "script": "BUNDLE_OUT", "args": [RUN_D, sha(), "pacer/main"],
                "timeoutMs": 30_000, "maxBytes": 1_048_576
            }),
        )
        .await
        .expect("fetch succeeds");
    assert_eq!(result["handle"], json!(handle));
    assert_eq!(result["bytes"], json!(15));
    assert_eq!(result["sha256"], json!(sha64()));
    h.close().await;
}

// index.ts:upload — the BINARY upload happy path returns the framed payload.
#[tokio::test]
async fn upload_binary_succeeds() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let sha = sha64();
    h.on_capability("capability.process.spawn", move |_| Ok(spawn_answer()));
    let result = h
        .call(
            "hostRunner.upload",
            json!({
                "session": session, "script": "BINARY", "args": [sha, "upload"],
                "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 4096
            }),
        )
        .await
        .expect("upload succeeds");
    assert_eq!(result["code"], json!(0));
    assert_eq!(result["stdout"], json!("ok"));
    h.close().await;
}

// index.ts:upload — an oversized upload output is `too_large`.
#[tokio::test]
async fn upload_too_large_is_too_large() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let sha = sha64();
    h.on_capability("capability.process.spawn", move |_| {
        Ok(json!({
            "code": 0, "timedOut": false,
            "output": { "stdout": NONCE, "stderr": NONCE }
        }))
    });
    let err = h
        .call(
            "hostRunner.upload",
            json!({
                "session": session, "script": "BINARY", "args": [sha, "upload"],
                "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("oversized upload must be too_large");
    assert_eq!(err.code, "too_large");
    assert_eq!(err.message, "SSH binary upload output exceeds the inline bound");
    h.close().await;
}

// index.ts:upload — connection failure (code 255) is `plugin_unavailable`.
#[tokio::test]
async fn upload_connection_failure_is_unavailable() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let sha = sha64();
    h.on_capability("capability.process.spawn", move |_| {
        Ok(json!({ "code": 255, "stdout": "", "stderr": "connect broken", "timedOut": false }))
    });
    let err = h
        .call(
            "hostRunner.upload",
            json!({
                "session": session, "script": "BINARY", "args": [sha, "upload"],
                "completionNonce": NONCE, "timeoutMs": 60_000, "maxBytes": 4096
            }),
        )
        .await
        .expect_err("connection failure must be unavailable");
    assert_eq!(err.code, "plugin_unavailable");
    assert_eq!(err.message, "SSH binary upload connection failed");
    h.close().await;
}

// index.ts:close — closing a session twice is `capability_denied`.
#[tokio::test]
async fn close_twice_is_denied() {
    let mut h = Harness::start(pacer_bundled_ssh::plugin(), Default::default()).await;
    let session = open(&mut h).await;
    let first = h
        .call("hostRunner.close", json!({ "session": session }))
        .await
        .expect("first close succeeds");
    assert_eq!(first, json!({ "ok": true }));
    let err = h
        .call("hostRunner.close", json!({ "session": session }))
        .await
        .expect_err("second close must be denied");
    assert_eq!(err.code, "capability_denied");
    assert_eq!(err.message, "unknown provider SSH session");
    h.close().await;
}