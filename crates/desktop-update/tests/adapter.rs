//! Adapter tests for the Rust port of `src/update/desktop/adapter.ts`
//! (PR B7-DA4 in the M3 desktop-update lane).
//!
//! The surface here is the library's reduced `VerifiedPipe` model: a
//! command resolves only after a terminal frame **and** a clean EOF
//! (`recv` returning `Ok(None)`), recovery starts with an uncertain
//! handoff, and the authorize-install continuation is written
//! synchronously on `prepared`. Capability checks and signal gating are
//! the composition root's job, so they are not exercised here.
#![allow(
    clippy::result_large_err,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unwrap_used,
    clippy::expect_used
)]
use pacer_desktop_update::adapter::{
    AdapterError, AdapterFailure, AdapterOutcome, AdapterRequest, FrameDecoder, HandoffState,
    MAX_FRAME_BYTES, VerifiedPipe, encode_frame, parse_adapter_command, parse_adapter_frame,
    parse_install_authorization, run_adapter_command,
};
use pacer_update::Channel;
use serde_json::{Map, Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// The shared wire fixture, verified byte-for-byte against the TS writer.
const WIRE: &str = include_str!("../../../test/fixtures/desktop-update/adapter-wire.json");
const IDENTITY: (&str, &str, &str) = ("1.0.0", "dev.pacer.desktop", "aarch64");
const B64: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn wire() -> Value {
    serde_json::from_str(WIRE).expect("fixture parses")
}

/// Build an ad-hoc object of frame variant fields.
fn avec(entries: &[(&str, Value)]) -> Value {
    let mut m = Map::new();
    for (k, v) in entries {
        m.insert(k.to_string(), v.clone());
    }
    Value::Object(m)
}

/// Decode a written command frame (strip the 4 length bytes).
fn decode_frame(bytes: &[u8]) -> Value {
    serde_json::from_slice(&bytes[4..]).expect("frame json")
}

/// Bind a helper frame to the actual command envelope. The random
/// commandId and nonce come from `build_command`, so they are read from
/// the sent frame; `extra` carries the frame's variant fields.
fn bind(command: &Value, sequence: u64, extra: Value) -> Value {
    let mut m = Map::new();
    for k in [
        "schema",
        "commandId",
        "installationId",
        "transactionId",
        "revision",
        "nonce",
    ] {
        m.insert(k.to_string(), command.get(k).expect("envelope").clone());
    }
    m.insert("sequence".into(), json!(sequence));
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            m.insert(k.clone(), v.clone());
        }
    } else {
        panic!("frame extra fields must be an object");
    }
    Value::Object(m)
}

fn candidate() -> Value {
    wire()["commands"][1]["candidate"].clone()
}
fn target() -> Value {
    wire()["commands"][2]["target"].clone()
}

fn check_request() -> AdapterRequest {
    AdapterRequest::Check {
        installation_id: "fixture".into(),
        revision: 2,
        channel: None,
    }
}
fn install_request() -> AdapterRequest {
    AdapterRequest::Install {
        installation_id: "fixture".into(),
        revision: 2,
        transaction_id: "tx-1".into(),
        candidate: candidate(),
        target: target(),
    }
}
fn download_request() -> AdapterRequest {
    AdapterRequest::Download {
        installation_id: "fixture".into(),
        revision: 2,
        candidate: candidate(),
    }
}
fn adopt_request() -> AdapterRequest {
    let mut t = target();
    t["ownership"] = json!("attached");
    AdapterRequest::Adopt {
        installation_id: "fixture".into(),
        revision: 2,
        transaction_id: "tx-1".into(),
        target: t,
    }
}
fn recover_request() -> AdapterRequest {
    AdapterRequest::Recover {
        installation_id: "fixture".into(),
        revision: 7,
        transaction_id: "recorded-tx".into(),
    }
}
fn recover_adoption_request() -> AdapterRequest {
    AdapterRequest::RecoverAdoption {
        installation_id: "fixture".into(),
        revision: 3,
        transaction_id: "tx-1".into(),
    }
}

fn hello() -> Value {
    avec(&[
        ("kind", json!("hello")),
        ("version", json!("1.0.0")),
        ("bundleId", json!("dev.pacer.desktop")),
        ("arch", json!("aarch64")),
    ])
}
fn prepared() -> Value {
    avec(&[
        ("kind", json!("prepared")),
        ("reservationId", json!("tx-1")),
        ("journalSha256", json!(B64)),
    ])
}
fn authorized() -> Value {
    avec(&[
        ("kind", json!("authorized")),
        ("reservationId", json!("tx-1")),
        ("journalSha256", json!(B64)),
    ])
}
fn checked() -> Value {
    avec(&[("kind", json!("checked")), ("candidate", candidate())])
}
fn downloaded(partial: bool, cand: Value) -> Value {
    avec(&[
        ("kind", json!("downloaded")),
        ("candidate", cand),
        ("downloadedBytes", json!(if partial { 9 } else { 10 })),
        ("totalBytes", json!(10)),
    ])
}
fn outcome(kind: &str) -> Value {
    avec(&[("kind", json!("outcome")), ("outcome", json!(kind))])
}

/// Shared state observable by the test while the command task runs.
#[derive(Clone, Default)]
struct Shared {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    command: Arc<Mutex<Option<Value>>>,
    aborts: Arc<AtomicUsize>,
}

/// A scripted `VerifiedPipe`. Reads come from an unbounded channel the
/// test feeds; `stall` makes reads never resolve (for deadline tests);
/// `send_fail_on` fails the n-th write (1-based).
struct Node {
    recv: mpsc::UnboundedReceiver<std::io::Result<Option<Vec<u8>>>>,
    shared: Shared,
    send_fail_on: Option<usize>,
    stall: bool,
}

impl VerifiedPipe for Node {
    fn identity(&self) -> (&str, &str, &str) {
        IDENTITY
    }
    fn send(
        &mut self,
        frame: &[u8],
    ) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + '_>> {
        let fail = self.send_fail_on == Some(self.shared.sent.lock().unwrap().len() + 1);
        if fail {
            return Box::pin(async { Err(std::io::Error::other("private write error")) });
        }
        let value = decode_frame(frame);
        {
            let mut sent = self.shared.sent.lock().unwrap();
            if sent.is_empty() {
                *self.shared.command.lock().unwrap() = Some(value);
            }
            sent.push(frame.to_vec());
        }
        Box::pin(async { Ok(()) })
    }
    fn recv(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Option<Vec<u8>>>> + Send + '_>> {
        if self.stall {
            return Box::pin(async {
                std::future::pending::<std::io::Result<Option<Vec<u8>>>>().await
            });
        }
        Box::pin(async move { self.recv.recv().await.unwrap_or(Ok(None)) })
    }
    fn abort(&mut self) {
        self.shared.aborts.fetch_add(1, Ordering::SeqCst);
    }
}

/// Drives `run_adapter_command` on a separate task so the test can read
/// the built command (random commandId/nonce) before feeding frames.
struct Harness {
    handle: Arc<Mutex<Option<tokio::task::JoinHandle<Result<AdapterOutcome, AdapterError>>>>>,
    sender: mpsc::UnboundedSender<std::io::Result<Option<Vec<u8>>>>,
    shared: Shared,
}

impl Harness {
    fn start(request: AdapterRequest) -> Self {
        Self::start_opts(request, Duration::from_secs(30), None, false)
    }
    fn start_opts(
        request: AdapterRequest,
        deadline: Duration,
        send_fail_on: Option<usize>,
        stall: bool,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<std::io::Result<Option<Vec<u8>>>>();
        let shared = Shared::default();
        let mut node = Node {
            recv: rx,
            shared: shared.clone(),
            send_fail_on,
            stall,
        };
        let handle = tokio::spawn(async move {
            run_adapter_command(&mut node as &mut dyn VerifiedPipe, &request, deadline).await
        });
        Harness {
            handle: Arc::new(Mutex::new(Some(handle))),
            sender: tx,
            shared,
        }
    }

    async fn command(&self) -> Value {
        loop {
            if let Some(c) = self.shared.command.lock().unwrap().clone() {
                return c;
            }
            tokio::task::yield_now().await;
        }
    }
    fn push(&self, value: Value) {
        let bytes = encode_frame(&value).expect("encode");
        let _ = self.sender.send(Ok(Some(bytes)));
    }
    fn raw(&self, bytes: &[u8]) {
        let _ = self.sender.send(Ok(Some(bytes.to_vec())));
    }
    fn end(&self) {
        let _ = self.sender.send(Ok(None));
    }
    fn fault(&self) {
        let _ = self.sender.send(Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "pipe reset",
        )));
    }
    fn aborts(&self) -> usize {
        self.shared.aborts.load(Ordering::SeqCst)
    }
    fn writes(&self) -> Vec<Value> {
        self.shared
            .sent
            .lock()
            .unwrap()
            .iter()
            .map(|b| decode_frame(b))
            .collect()
    }
    async fn wait_sent(&self, n: usize) {
        loop {
            if self.shared.sent.lock().unwrap().len() >= n {
                return;
            }
            tokio::task::yield_now().await;
        }
    }
    async fn join(&self) -> Result<AdapterOutcome, AdapterError> {
        let handle = self.handle.lock().unwrap().take().expect("join once");
        handle.await.expect("adapter task panicked")
    }
}

// ---- frame codec -----------------------------------------------------------

#[test]
fn frames_support_split_headers_bodies_and_coalesced_messages_and_reject_truncated() {
    let a = encode_frame(&json!({ "a": "hello \u{1f30d}" })).unwrap();
    let b = encode_frame(&json!({ "b": 2 })).unwrap();
    let all: Vec<u8> = a.iter().chain(b.iter()).copied().collect();

    let mut decoder = FrameDecoder::new();
    let mut values = Vec::new();
    for byte in all {
        // Split into single bytes, including inside headers and bodies.
        values.extend(decoder.push(&[byte]).unwrap());
    }
    decoder.finish().unwrap();
    assert_eq!(
        values,
        vec![json!({ "a": "hello \u{1f30d}" }), json!({ "b": 2 })]
    );

    // Truncated body: finish must reject.
    let mut partial = FrameDecoder::new();
    partial.push(&a[..a.len() - 1]).unwrap();
    assert!(partial.finish().is_err());

    // Zero declared length.
    assert!(FrameDecoder::new().push(&[0, 0, 0, 0]).is_err());
    // Declared length larger than the encoded payload.
    assert!(FrameDecoder::new().push(&[0, 4, 0, 1]).is_err());
    // A single byte beyond the declared header claims a giant frame.
    assert!(FrameDecoder::new().push(&[0, 0, 0, 1, 255]).is_err());
}

#[test]
fn encode_frame_prefixes_a_compacted_length_and_is_bounded() {
    let bytes = encode_frame(&json!({ "command": "check" })).unwrap();
    assert_eq!(bytes.len(), 4 + bytes[4..].len());
    assert_eq!(FrameDecoder::new().push(&bytes).unwrap().len(), 1);

    // A payload larger than the cap must be rejected.
    let big = json!({ "blob": Value::String("x".repeat(MAX_FRAME_BYTES + 1)) });
    assert!(encode_frame(&big).is_err());
}

/// Fuzz-style property: however a transport stream is split into byte
/// chunks, `FrameDecoder` yields exactly the same frames as decoding the
/// whole stream at once. Splits fall anywhere, including inside a frame
/// header, inside a UTF-8 body, and at hard frame boundaries. A single
/// deterministic PRNG drives the splits so the property is reproducible.
#[test]
fn any_random_byte_split_decodes_to_the_same_frames() {
    // xorshift64: small, deterministic, no extra dependency.
    let next = |state: &mut u64| {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    };

    for seed in 0u32..256 {
        // Re-seed deterministically per iteration.
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15 ^ u64::from(seed);
        let mut rnd = || next(&mut state);

        // Build a message batch of a few random frames (bounded sizes).
        let frames: Vec<Value> = (0..(1 + (rnd() % 4)) as usize)
            .map(|i| {
                json!({ "seq": i, "payload": Value::String("x".repeat(1 + (rnd() as usize % 48))) })
            })
            .collect();
        let bytes: Vec<u8> = frames
            .iter()
            .flat_map(|f| encode_frame(f).unwrap())
            .collect();

        let expected: Vec<Value> = FrameDecoder::new().push(&bytes).unwrap();

        // Split the stream at random byte boundaries.
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        let mut at = 0usize;
        while at < bytes.len() {
            let take = 1 + (rnd() as usize % 7);
            let take = take.min(bytes.len() - at);
            chunks.push(bytes[at..at + take].to_vec());
            at += take;
        }

        let mut decoder = FrameDecoder::new();
        let mut got = Vec::new();
        for chunk in &chunks {
            got.extend(decoder.push(chunk).unwrap());
        }
        decoder.finish().unwrap();
        assert_eq!(
            got, expected,
            "seed {seed}: split decode diverged from whole-stream decode"
        );
    }
}

// ---- shared wire fixture ---------------------------------------------------

#[test]
fn shared_wire_fixture_parses_and_rejects_unknown_variants_and_extra_authority() {
    let fixture = wire();
    for command in fixture["commands"].as_array().unwrap() {
        parse_adapter_command(command).unwrap();
    }
    for frame in fixture["frames"].as_array().unwrap() {
        parse_adapter_frame(frame).unwrap();
    }
    for continuation in fixture["continuations"].as_array().unwrap() {
        parse_install_authorization(continuation).unwrap();
    }
    let first = &fixture["commands"][0];
    let mut unknown = first.clone();
    unknown["command"] = json!("execute-shell");
    assert!(parse_adapter_command(&unknown).is_err());
    let mut extra = first.clone();
    extra["executable"] = json!("/tmp/untrusted");
    assert!(parse_adapter_command(&extra).is_err());
    let mut bad_schema = fixture["frames"][0].clone();
    bad_schema["schema"] = json!(2);
    assert!(parse_adapter_frame(&bad_schema).is_err());
    for entry in fixture["rejectedCommands"].as_array().unwrap() {
        assert!(
            parse_adapter_command(&entry["command"]).is_err(),
            "reject {}",
            entry["case"]
        );
    }
}

#[test]
fn check_accepts_a_missing_channel_as_stable() {
    let fixture = wire();
    for entry in fixture["acceptedChecks"].as_array().unwrap() {
        parse_adapter_command(&entry["command"]).unwrap();
    }
}

// ---- run adapter command ---------------------------------------------------

#[tokio::test]
async fn check_binds_the_verified_helper_and_returns_only_after_clean_eof() {
    let h = Harness::start(check_request());
    let command = h.command().await;
    assert_eq!(command["nonce"].as_str().unwrap().len(), 64);
    assert!(!command["commandId"].as_str().unwrap().is_empty());

    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, checked()));
    h.end();

    let outcome = h.join().await.unwrap();
    assert_eq!(outcome.frame["kind"], json!("checked"));
    assert_eq!(outcome.handoff, HandoffState::None);
    assert_eq!(h.aborts(), 0);
}

#[tokio::test]
async fn check_with_nightly_channel_builds_a_channel_field() {
    let request = AdapterRequest::Check {
        installation_id: "fixture".into(),
        revision: 2,
        channel: Some(Channel::Nightly),
    };
    let h = Harness::start(request);
    let command = h.command().await;
    assert_eq!(command["channel"], json!("nightly"));
    h.end();
    // No frames: clean EOF before any terminal is a closed failure.
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Closed);
    assert_eq!(h.aborts(), 1);
}

#[tokio::test]
async fn invalid_binding_version_sequence_and_order_fail_without_leaking() {
    let changes: Vec<(&str, Value)> = vec![
        ("nonce", json!(B64)),
        ("commandId", json!("wrong-command")),
        ("installationId", json!("another")),
        ("revision", json!(3)),
        ("transactionId", json!("foreign")),
        ("version", json!("9.0.0")),
        ("sequence", json!(1)),
    ];
    for (field, val) in changes {
        let h = Harness::start(check_request());
        let command = h.command().await;
        let mut frame = bind(&command, 0, hello());
        frame[field] = val;
        h.push(frame);
        let err = h.join().await.unwrap_err();
        assert_eq!(err.reason, AdapterFailure::Protocol, "change {field}");
        assert_eq!(h.aborts(), 1, "change {field}");
    }

    // An out-of-enum error code fails the strict frame schema (Protocol)
    // and never leaks the payload into the surfaced message.
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(
        &command,
        1,
        avec(&[
            ("kind", json!("error")),
            ("code", json!("secret-token-should-not-leak")),
        ]),
    ));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert!(!format!("{err}").contains("secret-token"));
    assert_eq!(h.aborts(), 1);

    // A bound, correctly sequenced, well-formed error after hello is the
    // helper refusing the operation: a remote failure with no leak.
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(
        &command,
        1,
        avec(&[("kind", json!("error")), ("code", json!("verification"))]),
    ));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Remote);
    assert!(!format!("{err}").contains("verification"));
}

#[tokio::test]
async fn download_progress_is_monotonic_and_completion_must_match_every_field() {
    // Valid path.
    let h = Harness::start(download_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(
        &command,
        1,
        avec(&[
            ("kind", json!("progress")),
            ("downloadedBytes", json!(5)),
            ("totalBytes", json!(10)),
        ]),
    ));
    h.push(bind(&command, 2, downloaded(false, candidate())));
    h.end();
    let outcome = h.join().await.unwrap();
    assert_eq!(outcome.frame["kind"], json!("downloaded"));

    let mut swapped = candidate();
    swapped["signature"] = json!("swapped");
    let bad_frames: Vec<Value> = vec![
        avec(&[
            ("kind", json!("progress")),
            ("downloadedBytes", json!(4)),
            ("totalBytes", json!(10)),
        ]),
        avec(&[
            ("kind", json!("progress")),
            ("downloadedBytes", json!(11)),
            ("totalBytes", json!(10)),
        ]),
        avec(&[
            ("kind", json!("progress")),
            ("downloadedBytes", json!(6)),
            ("totalBytes", json!(12)),
        ]),
        downloaded(false, swapped),
        downloaded(true, candidate()),
    ];
    for extra in bad_frames {
        let h = Harness::start(download_request());
        let command = h.command().await;
        h.push(bind(&command, 0, hello()));
        h.push(bind(
            &command,
            1,
            avec(&[
                ("kind", json!("progress")),
                ("downloadedBytes", json!(5)),
                ("totalBytes", json!(10)),
            ]),
        ));
        h.push(bind(&command, 2, extra));
        h.end();
        let err = h.join().await.unwrap_err();
        assert_eq!(err.reason, AdapterFailure::Protocol);
    }
}

#[tokio::test]
async fn install_requires_preparation_authorization_and_matching_acknowledgment() {
    let h = Harness::start(install_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, prepared()));
    // The continuation write is synchronous on `prepared` and must be sent
    // before the helper can end the phase.
    h.wait_sent(2).await;
    let writes = h.writes();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[1]["kind"], json!("authorize-install"));
    assert_eq!(writes[1]["commandId"], command["commandId"]);
    assert_eq!(writes[1]["nonce"], command["nonce"]);
    assert_eq!(writes[1]["reservationId"], json!("tx-1"));
    assert_eq!(writes[1]["journalSha256"], json!(B64));

    h.push(bind(&command, 2, authorized()));
    h.push(bind(&command, 3, outcome("committed")));
    h.end();
    let outcome = h.join().await.unwrap();
    assert_eq!(outcome.frame["kind"], json!("outcome"));
    assert_eq!(outcome.frame["outcome"], json!("committed"));
    assert_eq!(outcome.handoff, HandoffState::Acknowledged);
    assert_eq!(h.aborts(), 0);
}

#[tokio::test]
async fn terminal_extras_early_exit_and_deadlines_are_failures() {
    // Extra terminal frame after the first is rejected.
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, checked()));
    h.push(bind(&command, 2, checked()));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert_eq!(err.rejection.as_ref().unwrap().check, "terminal");

    // Early clean EOF before a terminal is closed.
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.end();
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Closed);
    assert_eq!(h.aborts(), 1);
}

#[tokio::test]
async fn zero_deadline_is_invalid() {
    let (_, rx) = mpsc::unbounded_channel::<std::io::Result<Option<Vec<u8>>>>();
    let mut node = Node {
        recv: rx,
        shared: Shared::default(),
        send_fail_on: None,
        stall: false,
    };
    let err = run_adapter_command(
        &mut node as &mut dyn VerifiedPipe,
        &check_request(),
        Duration::ZERO,
    )
    .await
    .unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
}

#[tokio::test]
async fn stalled_pipe_times_out_with_abort_before_handoff() {
    let h = Harness::start_opts(check_request(), Duration::from_millis(1), None, true);
    // Fair chance the deadline fires before or after the command is sent;
    // either way it is a timeout with no handoff.
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Timeout);
    assert_eq!(err.handoff, HandoffState::None);
    assert_eq!(h.aborts(), 1);
}

#[tokio::test]
async fn recovery_preserves_the_helper_with_uncertain_handoff_and_no_abort() {
    let h = Harness::start(recover_request());
    let command = h.command().await;
    // Recovery carries no candidate or target: exactly 7 envelope keys.
    assert_eq!(h.writes()[0].as_object().unwrap().len(), 7);
    h.push(bind(&command, 0, hello()));
    h.end();
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Closed);
    assert_eq!(err.handoff, HandoffState::Uncertain);
    assert_eq!(h.aborts(), 0);

    // Recovery accepts a journal-verified outcome without reauthorization.
    let h = Harness::start(recover_adoption_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, outcome("restored")));
    h.end();
    let outcome = h.join().await.unwrap();
    assert_eq!(outcome.frame["outcome"], json!("restored"));
    assert_eq!(h.writes().len(), 1);
}

#[tokio::test]
async fn adopt_waits_for_durable_continuation_and_separate_recovery() {
    let h = Harness::start(adopt_request());
    let command = h.command().await;
    // Adopt is candidate-free and attached-only.
    assert!(command.get("candidate").is_none());
    assert_eq!(command["target"]["ownership"], json!("attached"));
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, prepared()));
    h.wait_sent(2).await;
    assert_eq!(h.writes()[1]["kind"], json!("authorize-install"));
    h.push(bind(&command, 2, authorized()));
    h.push(bind(&command, 3, outcome("committed")));
    h.end();
    let outcome = h.join().await.unwrap();
    assert_eq!(outcome.frame["outcome"], json!("committed"));
}

#[tokio::test]
async fn authorization_write_failure_is_uncertain_even_before_native_acknowledgment() {
    // The continuation is write #2; failing it must be closed + uncertain.
    let h = Harness::start_opts(install_request(), Duration::from_secs(30), Some(2), false);
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, prepared()));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Closed);
    assert_eq!(err.handoff, HandoffState::Uncertain);
    assert_eq!(h.aborts(), 0);
}

#[tokio::test]
async fn helper_cannot_acknowledge_a_different_prepared_journal() {
    let h = Harness::start(install_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, prepared()));
    let mut bad = authorized();
    bad["journalSha256"] = json!("d".repeat(64));
    h.push(bind(&command, 2, bad));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert_eq!(err.handoff, HandoffState::Uncertain);
    assert_eq!(h.aborts(), 0);
}

#[tokio::test]
async fn second_hello_is_an_order_rejection() {
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.push(bind(&command, 1, hello()));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert_eq!(err.rejection.as_ref().unwrap().check, "order");
}

#[tokio::test]
async fn independent_commands_use_different_nonces() {
    let a = Harness::start(check_request());
    let b = Harness::start(check_request());
    let ca = a.command().await;
    let cb = b.command().await;
    assert_ne!(ca["commandId"], cb["commandId"]);
    assert_ne!(ca["nonce"], cb["nonce"]);
    // A command fed the other's hello is a binding failure.
    a.push(bind(&cb, 0, hello()));
    let err = a.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    b.end();
    b.join().await.unwrap_err();
}

#[tokio::test]
async fn pipe_that_fails_mid_read_is_closed_while_a_malformed_frame_is_protocol() {
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, hello()));
    h.fault();
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Closed);
    assert_eq!(h.aborts(), 1);

    let h = Harness::start(check_request());
    h.command().await;
    h.raw(&[0, 0, 0, 0]);
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert_eq!(err.rejection.as_ref().unwrap().check, "frame");
}

#[tokio::test]
async fn protocol_rejections_record_the_failing_predicate_without_frame_payloads() {
    // checked as the first frame is a "hello" violation (schema-valid but
    // not hello) and the candidate must not appear in the message.
    let h = Harness::start(check_request());
    let command = h.command().await;
    h.push(bind(&command, 0, checked()));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    let detail = format!("{err}");
    let r = err.rejection.unwrap();
    assert_eq!(r.check, "hello");
    assert_eq!(r.sequence, Some(0));
    assert!(!detail.contains("release"));

    // Version mismatch → identity.
    let h = Harness::start(check_request());
    let command = h.command().await;
    let mut hf = hello();
    hf["version"] = json!("9.0.0");
    h.push(bind(&command, 0, hf));
    let err = h.join().await.unwrap_err();
    assert_eq!(err.rejection.unwrap().check, "identity");
}

#[tokio::test]
async fn oversize_frames_are_rejected_with_the_protocol_message() {
    let h = Harness::start(check_request());
    h.command().await;
    h.raw(&0u32.to_be_bytes());
    let err = h.join().await.unwrap_err();
    assert_eq!(err.reason, AdapterFailure::Protocol);
    assert_eq!(
        format!("{err}"),
        "Desktop update adapter protocol was rejected"
    );
}
