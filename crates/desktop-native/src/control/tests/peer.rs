//! Peer transport tests, transcribed from `LocalNativePeer`
//! (`src/update/desktop/native-socket.ts`) and `verifyPeer`
//! (`native-os.ts`): the kernel peer token is read from `LOCAL_PEERTOKEN`,
//! frames round-trip through the shared codec, and close/EOF are handled.
#![allow(clippy::unwrap_used)]
use super::super::peer::Peer;
use pacer_desktop_update::adapter::{FrameDecoder, encode_frame};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};

/// The peer pid field offset in the 32-byte local peer record (native-os.ts
/// reads `getUint32(20, true)` as the pid and `getUint32(4, true)` as uid).
const PID_OFFSET: usize = 20;

/// A peer on a real bound listener's accepted side, with the connecting
/// client kept open for I/O. Returns (client, peer, dir) where `dir` must
/// stay alive. The accepted endpoint's `LOCAL_PEERTOKEN` then reports the
/// connecting client's (same-process) identity.
async fn named_pair() -> (UnixStream, Arc<Peer>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let client = UnixStream::connect(&path).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let peer = Peer::new(server).unwrap();
    (client, peer, dir)
}

#[tokio::test]
async fn audit_token_reports_same_process_pid() {
    let (mut client, peer, _dir) = named_pair().await;
    // Send one frame so the peer's read side is exercised against the kernel.
    let sent = json!({"schema": 1, "kind": "heartbeat", "sessionId": "s", "sequence": 1});
    client
        .write_all(&encode_frame(&sent).unwrap())
        .await
        .unwrap();
    let frames = peer_read_with_timeout(&peer).await;
    assert_eq!(frames, vec![sent]);

    // The audit token must be present and carry the connecting peer's pid.
    let token = peer
        .audit_token()
        .unwrap_or_else(|| panic!("LOCAL_PEERTOKEN must be readable on an accepted native socket"));
    assert_eq!(token.len(), 32);
    let pid_le = u32::from_le_bytes([
        token[PID_OFFSET],
        token[PID_OFFSET + 1],
        token[PID_OFFSET + 2],
        token[PID_OFFSET + 3],
    ]);
    assert_eq!(
        pid_le,
        std::process::id(),
        "LOCAL_PEERTOKEN must carry the same-process pid"
    );
    peer.close().await;
}

#[tokio::test]
async fn frames_round_trip_and_closed_peer_closes() {
    let (mut client, peer, _dir) = named_pair().await;
    // Send several frames in one write; they must be decoded back.
    let frames: Vec<Value> = (1..=5)
        .map(|i| json!({"schema": 1, "kind": "heartbeat", "sessionId": "s", "sequence": i}))
        .collect();
    let mut bytes = Vec::new();
    for frame in &frames {
        bytes.extend_from_slice(&encode_frame(frame).unwrap());
    }
    client.write_all(&bytes).await.unwrap();
    assert_eq!(peer_read_with_timeout(&peer).await, frames);

    // Closing the peer makes it dead and further reads return EOF.
    peer.close().await;
    assert!(peer.is_dead());
}

#[tokio::test]
async fn peer_write_refuses_after_close() {
    let (_client, peer, _dir) = named_pair().await;
    peer.close().await;
    // Sending after close must fail.
    let result = tokio::time::timeout(Duration::from_secs(1), peer.send(json!({"x": 1}))).await;
    assert!(result.is_err() || result.unwrap().is_err());
}

#[tokio::test]
async fn dropping_client_surfaces_eof() {
    let (client, peer, _dir) = named_pair().await;
    // Dropping the connecting client must surface EOF to the peer's read,
    // not hang the wait-for-readable path.
    drop(client);
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match peer.read_frames().await {
                Ok(Some(frames)) if !frames.is_empty() => break,
                Ok(Some(_)) => continue,
                Ok(None) => return, // clean EOF
                Err(_) => return,
            }
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "peer read must surface EOF after the client drops"
    );
    // close is idempotent.
    peer.close().await;
    peer.close().await;
}

async fn peer_read_with_timeout(peer: &Arc<Peer>) -> Vec<Value> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match tokio::time::timeout(Duration::from_millis(50), peer.read_frames()).await {
            Ok(Ok(Some(frames))) if !frames.is_empty() => return frames,
            Ok(Ok(Some(_))) => {}
            Ok(Ok(None)) => return Vec::new(),
            Ok(Err(_)) => return Vec::new(),
            Err(_) => {}
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no frames arrived within the timeout"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// The FrameDecoder is exercised by the update adapter; ensure it is linked
// here so the shared wire format is locked to this crate's dependency.
#[allow(dead_code)]
fn _wire_format_is_shared() {
    let _ = encode_frame;
    let _: fn() -> FrameDecoder = FrameDecoder::new;
}
