#![allow(clippy::unwrap_used)]
//! Flag-on NativeHostSession: socket appears, same-uid peer auth, clean shutdown.
//! Flag-off stays dark (no socket, no PACER_HOST_SOCKET).
//! Wrong-uid denial remains covered by reverse_bridge::denies_untrusted_caller.

use pacer_plugin_runtime::{
    HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, NativeHostSession, native_plugin_host_enabled,
    serve_starts_reverse_bridge_by_default,
};
use serde_json::{Value, json};
use std::{env, fs, os::unix::fs::MetadataExt, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

fn temp_home() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

async fn dial_json(path: &Path, request: Value) -> Value {
    let mut stream = UnixStream::connect(path).await.unwrap();
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).await.unwrap();
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    serde_json::from_slice(&line).unwrap()
}

#[test]
fn flag_off_leaves_default_serve_dark() {
    assert!(!serve_starts_reverse_bridge_by_default());
    assert!(!native_plugin_host_enabled(None, None));
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_on_session_binds_socket_exports_env_and_shuts_down() {
    let home = temp_home();
    let (session, core_env) = NativeHostSession::start(home.path()).unwrap();
    assert_eq!(core_env.len(), 1);
    assert_eq!(core_env[0].0, HOST_SOCKET_ENV);
    assert_eq!(core_env[0].1, session.socket_path().display().to_string());
    // Session returns pairs for the Core child; process env stays clean.
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
    assert!(session.owner().claim_native_supervision().is_ok());

    let socket = session.socket_path().to_path_buf();
    assert!(socket.exists());
    let meta = fs::symlink_metadata(&socket).unwrap();
    assert_eq!(meta.mode() & 0o777, 0o600);
    let run = home.path().join("run");
    assert_eq!(fs::symlink_metadata(&run).unwrap().mode() & 0o777, 0o700);

    tokio::task::yield_now().await;
    let call = dial_json(
        &socket,
        json!({"jsonrpc":"2.0","id":1,"method":METHOD_PLUGIN_CALL,"params":{}}),
    )
    .await;
    assert_eq!(call["id"], 1);
    assert!(call.get("result").is_some() || call.get("error").is_some());

    session.shutdown().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !socket.exists(),
        "shutdown must unlink host.sock for clean rollback"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_on_same_uid_peer_is_accepted() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    tokio::task::yield_now().await;
    let call = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":7,"method":METHOD_PLUGIN_CALL,"params":{}}),
    )
    .await;
    assert_eq!(call["id"], 7);
    assert!(call.get("error").is_none(), "{call}");
    assert_eq!(call["result"]["activated"], false);
    session.shutdown().await;
}
