#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Raw helper pipe tests (transcribed from the provider's
//! `createNativePipeFactory` command set and the helper wire-format
//! round-trip). The factory advertises exactly the command set the
//! desktop's adapters exercise (`desktop-update-native.test.ts` L1115), and
//! a `NativePipe` round-trips a length-prefixed frame through a real
//! spawned helper process on an in-process pipeline.
use super::super::pipes::{NativePipe, capabilities, helper_identity};
use pacer_desktop_update::adapter::{FrameDecoder, VerifiedPipe, encode_frame};
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

/// A minimal `pacer-update-helper`-like process that echoes any bytes it
/// receives back verbatim, so a frame written to stdin comes back on
/// stdout unchanged. `/bin/cat` is a real, stable binary (no script file
/// that could be deleted out from under it); its unqualified basename is
/// `cat`, so the identity must be reported via the explicit executable.
async fn spawn_echo_helper() -> NativePipe {
    const ECHO: &str = "/bin/cat";
    let child = Command::new(ECHO)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let identity = helper_identity(pid, Path::new(ECHO));
    NativePipe::new(identity, child).unwrap()
}

#[test]
fn capabilities_advertise_the_helper_command_set() {
    // The desktop's `createNativePipeFactory` adapters (`desktop-update-
    // native.test.ts` L1115) advertise exactly these six commands.
    let mut caps = capabilities();
    caps.sort();
    assert_eq!(
        caps,
        vec![
            "adopt",
            "check",
            "download",
            "install",
            "recover",
            "recover-adoption",
        ]
    );
}

#[test]
fn helper_identity_uses_pid_executable_role() {
    let (pid, executable, role) = helper_identity(7, Path::new("/app/pkg/pacer-update-helper"));
    assert_eq!(pid, "7");
    assert_eq!(executable, "/app/pkg/pacer-update-helper");
    assert_eq!(role, "helper");
}

#[tokio::test]
async fn native_pipe_round_trips_a_verified_frame() {
    let mut pipe = spawn_echo_helper().await;
    // The identity is reported as expected, never taken from the helper.
    assert_eq!(pipe.identity().2, "helper");

    let frame = json!({
        "schema": 1,
        "kind": "hello",
        "role": "helper",
        "version": "2.0",
        "nonce": "a".repeat(64),
        "challenge": "b".repeat(64),
    });
    let bytes = encode_frame(&frame).unwrap();

    // Write the frame and read it back through the echo helper.
    pipe.send(&bytes).await.unwrap();
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(2), pipe.recv())
        .await
        .expect("helper must reply")
        .unwrap()
        .expect("helper replied with a frame");
    assert_eq!(echoed, bytes);

    // The echoed bytes decode to the same frame.
    let mut decoder = FrameDecoder::new();
    let decoded = decoder.push(&echoed).unwrap();
    assert_eq!(decoded, vec![frame]);

    pipe.abort();
}
