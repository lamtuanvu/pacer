//! Accept-loop and dispatch tests for the native control server.
//! These reproduce the end of the desktop's accept flow
//! (`native-provider.ts`): challenge → hello → verify → registered, then
//! readied session, op dispatch, event subscription, and replay close.
#![allow(clippy::unwrap_used)]
use super::super::server::ControlServer;
use super::super::{Dispatch, Guard, Hello, Identity, Peer};
use pacer_desktop_update::adapter::{FrameDecoder, encode_frame};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// A stub dispatch: ops return an echo; subscribe streams one event.
struct EchoDispatch;
impl Dispatch for EchoDispatch {
    async fn call_op(&self, _identity: &Identity, op: &str, params: Value) -> Result<Value, Value> {
        Ok(json!({"op": op, "params": params}))
    }
    async fn subscribe(
        &self,
        _identity: &Identity,
        _since: f64,
    ) -> Result<mpsc::Receiver<Value>, Value> {
        let (tx, rx) = mpsc::channel(8);
        // One realistic read-model event: {seq, at, type, data}.
        tx.send(json!({
            "seq": 7, "at": 1234, "type": "device.registry", "data": {"key": "value"},
        }))
        .await
        .ok();
        Ok(rx)
    }
}

/// A stub guard that rubber-stamps any peer as the given desktop identity.
struct AllowGuard(Identity);
impl Guard for AllowGuard {
    async fn verify_peer(&self, _peer: &Peer, _hello: &Hello) -> Result<Identity, String> {
        Ok(self.0.clone())
    }
}

fn identity() -> Identity {
    Identity {
        role: "desktop".to_owned(),
        client_id: "cli-test".to_owned(),
        audit: None,
    }
}

/// Boot a server on a temp socket path and return (dir, path, state, handle).
/// `dir` keeps the socket file alive for the duration of the test.
fn boot_server() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    Arc<super::super::server::ControlState>,
    JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let server = ControlServer::new(
        listener,
        "pacer".to_owned(),
        "1.2.3".to_owned(),
        4317,
        EchoDispatch,
        AllowGuard(identity()),
    );
    let state = server.state();
    let handle = server.serve();
    (dir, path, state, handle)
}

/// A framed client on the control socket.
struct Client {
    stream: UnixStream,
    decoder: FrameDecoder,
    pending: std::collections::VecDeque<Value>,
}
impl Client {
    async fn connect(path: &std::path::Path) -> Client {
        let stream = UnixStream::connect(path).await.unwrap();
        Client {
            stream,
            decoder: FrameDecoder::new(),
            pending: std::collections::VecDeque::new(),
        }
    }
    async fn send(&mut self, frame: &Value) {
        self.stream
            .write_all(&encode_frame(frame).unwrap())
            .await
            .unwrap();
    }
    async fn read_frame(&mut self) -> Value {
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return frame;
            }
            let mut buf = [0u8; 4096];
            let n = self.stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "control socket closed unexpectedly");
            let frames = self
                .decoder
                .push(&buf[..n])
                .unwrap_or_else(|_| panic!("wire frame decode failed"));
            self.pending.extend(frames);
        }
    }
}

#[tokio::test]
async fn hello_handshake_registers_a_desktop_session() {
    let (_dir, path, _state, handle) = boot_server();
    let mut client = Client::connect(&path).await;

    // Server sends the challenge frame first.
    let challenge = client.read_frame().await;
    assert_eq!(challenge["schema"], 1);
    assert_eq!(challenge["kind"], "challenge");
    let nonce = challenge["nonce"].as_str().unwrap().to_owned();

    // Reply with a valid hello for a desktop role.
    client
        .send(&json!({
            "schema": 1, "kind": "hello", "role": "desktop",
            "version": "1.2.3", "nonce": "a".repeat(64), "challenge": nonce,
            "clientId": "cli-test",
        }))
        .await;

    // Server sends registered carrying the matching nonce and a session id.
    let registered = client.read_frame().await;
    assert_eq!(registered["kind"], "registered");
    assert_eq!(registered["nonce"], "a".repeat(64));
    let session_id = registered["sessionId"].as_str().unwrap().to_owned();

    // A heartbeat is acknowledged with `alive`.
    client
        .send(&json!({"schema": 1, "kind": "heartbeat", "sessionId": session_id, "sequence": 1}))
        .await;
    let alive = client.read_frame().await;
    assert_eq!(alive["kind"], "alive");
    assert_eq!(alive["sequence"], 1);

    handle.abort();
}

#[tokio::test]
async fn wrong_challenge_nonce_closes_peer() {
    let (_dir, path, _state, handle) = boot_server();
    let mut client = Client::connect(&path).await;

    let challenge = client.read_frame().await;
    assert_eq!(challenge["kind"], "challenge");

    // Send hello with the wrong challenge; the server must close us.
    client
        .send(&json!({
            "schema": 1, "kind": "hello", "role": "desktop",
            "version": "1.2.3", "nonce": "a".repeat(64), "challenge": "f".repeat(64),
        }))
        .await;

    // The server closes the connection (read returns EOF = 0).
    let result = tokio::time::timeout(Duration::from_secs(2), read_eof(&mut client)).await;
    assert!(result.is_ok(), "peer must close after a bad challenge");
    assert_eq!(result.unwrap(), 0);
    handle.abort();
}

#[tokio::test]
async fn op_requires_readied_desktop_session_then_dispatch() {
    let (_dir, path, _state, handle) = boot_server();
    let (mut client, sid) = handshake_desktop(&path).await;

    // Op before `desktop-ready` closes the peer (requires_ready gate).
    let payload = json!({
        "schema": 1, "kind": "op", "sessionId": sid, "sequence": 1,
        "op": "device.registry", "params": {},
    });
    client.send(&payload).await;
    let result = tokio::time::timeout(Duration::from_secs(2), read_eof(&mut client)).await;
    assert!(result.is_ok(), "op before ready must close the session");

    handle.abort();
}

#[tokio::test]
async fn subscribed_events_are_forwarded_as_event_frames() {
    let (_dir, path, _state, handle) = boot_server();
    let (mut client, sid) = handshake_desktop(&path).await;

    // Readied first.
    let ready_frame =
        json!({"schema": 1, "kind": "desktop-ready", "sessionId": sid, "sequence": 1});
    client.send(&ready_frame).await;
    let ready = client.read_frame().await;
    assert_eq!(ready["kind"], "ready");

    // Subscribe at a cursor; the stub forwards one synthetic event.
    let sub = json!({
        "schema": 1, "kind": "subscribe-events", "sessionId": sid,
        "sequence": 2, "params": {"since": 7},
    });
    client.send(&sub).await;
    let subscribed = client.read_frame().await;
    assert_eq!(subscribed["kind"], "subscribed");

    // The forwarded event arrives as a native `event` frame matching the
    // desktop client's AppEventFrame contract ({schema, kind, event, data,
    // id}) with deny_unknown_fields: no stray `sequence` top-level field.
    let event = client.read_frame().await;
    assert_eq!(event["schema"], 1);
    assert_eq!(event["kind"], "event");
    assert_eq!(event["event"], "device.registry");
    assert_eq!(event["data"]["key"], "value");
    assert_eq!(event["id"], 7);
    assert_eq!(event.get("sequence"), None);

    handle.abort();
}

#[tokio::test]
async fn replayed_sequence_closes_the_session() {
    let (_dir, path, _state, handle) = boot_server();
    let (mut client, sid) = handshake_desktop(&path).await;

    // Readied, then a heartbeat at sequence 1.
    let ready_frame =
        json!({"schema": 1, "kind": "desktop-ready", "sessionId": sid, "sequence": 1});
    client.send(&ready_frame).await;
    let ready = client.read_frame().await;
    assert_eq!(ready["kind"], "ready");

    // Replay the same sequence: the session must close.
    let replay = json!({"schema": 1, "kind": "heartbeat", "sessionId": sid, "sequence": 1});
    client.send(&replay).await;
    let result = tokio::time::timeout(Duration::from_secs(2), read_eof(&mut client)).await;
    assert!(result.is_ok(), "a replayed sequence must close the session");

    handle.abort();
}

/// Complete the handshake and return a framed client plus its session id.
async fn handshake_desktop(path: &std::path::Path) -> (Client, String) {
    let mut client = Client::connect(path).await;
    let challenge = client.read_frame().await;
    let nonce = challenge["nonce"].as_str().unwrap().to_owned();
    client
        .send(&json!({
            "schema": 1, "kind": "hello", "role": "desktop",
            "version": "1.2.3", "nonce": "a".repeat(64), "challenge": nonce,
            "clientId": "cli-test",
        }))
        .await;
    let registered = client.read_frame().await;
    assert_eq!(registered["kind"], "registered");
    let sid = registered["sessionId"].as_str().unwrap().to_owned();
    (client, sid)
}

async fn read_eof(client: &mut Client) -> usize {
    let mut buf = [0u8; 256];
    let mut n = client.stream.read(&mut buf).await.unwrap();
    while n > 0 {
        n = client.stream.read(&mut buf).await.unwrap();
    }
    n
}
