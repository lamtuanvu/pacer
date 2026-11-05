#![allow(clippy::unwrap_used)]
//! Dark reverse-bridge accept loop: modes, auth boundary, fixture dial.
//! Does not activate serve or flip claim_native_supervision.

use pacer_plugin_runtime::{
    BridgeError, HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, OwnerError, PeerAuth,
    ProcessOwner, ReverseBridge, bridge_methods_are_private,
    serve_starts_reverse_bridge_by_default,
};
use serde_json::{Value, json};
use std::{
    env, fs,
    net::TcpStream,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
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
fn default_serve_stays_dark() {
    assert!(!serve_starts_reverse_bridge_by_default());
    assert!(
        env::var_os(HOST_SOCKET_ENV).is_none(),
        "test process must not inherit PACER_HOST_SOCKET"
    );
    let owner = ProcessOwner::typescript();
    assert_eq!(
        owner.claim_native_supervision(),
        Err(OwnerError::TypeScriptOwnsHost)
    );
    let native = ProcessOwner::native_for_tests();
    assert_eq!(
        native.claim_native_supervision(),
        Err(OwnerError::NativeNotActivated)
    );
}

#[test]
fn dark_core_env_requires_explicit_enable_flag() {
    let home = temp_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    assert!(matches!(
        bridge.dark_core_env_if(None),
        Err(BridgeError::DarkWiringDisabled)
    ));
    assert!(matches!(
        bridge.dark_core_env_if(Some("0")),
        Err(BridgeError::DarkWiringDisabled)
    ));
    let pairs = bridge.dark_core_env_if(Some("1")).unwrap();
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].0, HOST_SOCKET_ENV);
    assert_eq!(pairs[0].1, bridge.path().display().to_string());
    // Library helper returns pairs; it must not mutate process env.
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
}

#[test]
fn binds_0700_run_dir_and_0600_socket_without_setting_env() {
    let home = temp_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
    let run = home.path().join("run");
    let meta = fs::symlink_metadata(&run).unwrap();
    assert_eq!(meta.mode() & 0o777, 0o700);
    assert!(bridge.path().exists());
    assert!(env::var_os(HOST_SOCKET_ENV).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixture_dial_plugin_call_and_find_stubs() {
    let home = temp_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    let path = bridge.path().to_path_buf();
    let handle = bridge.spawn();
    tokio::task::yield_now().await;

    let call = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":1,"method":METHOD_PLUGIN_CALL,"params":{"id":"fx"}}),
    )
    .await;
    assert_eq!(call["result"]["activated"], false);
    assert_eq!(
        call["result"]["reason"],
        "native-plugin-ownership-not-activated"
    );

    let find = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":2,"method":METHOD_PLUGIN_FIND,"params":{"id":"fx"}}),
    )
    .await;
    assert_eq!(find["result"]["found"], false);

    let unknown = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":3,"method":"_host.plugin.missing","params":{}}),
    )
    .await;
    assert_eq!(unknown["error"]["code"], -32601);

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denies_untrusted_caller() {
    let home = temp_home();
    let bridge =
        ReverseBridge::bind_with_auth(home.path(), PeerAuth::deny_all_for_tests()).unwrap();
    let path = bridge.path().to_path_buf();
    let handle = bridge.spawn();
    tokio::task::yield_now().await;

    let stream = UnixStream::connect(&path).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).await.unwrap();
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    let value: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(value["error"]["code"], -32001);
    assert_eq!(value["error"]["message"], "unauthorized");

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_tcp_cannot_reach_host_plugin_methods() {
    let home = temp_home();
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    let unix_path: PathBuf = bridge.path().to_path_buf();
    let handle = bridge.spawn();
    tokio::task::yield_now().await;

    assert!(bridge_methods_are_private(&[
        "plugin.list",
        "plugin.doctor",
        "hello",
        "version.get",
        "config.get",
    ]));
    assert!(!bridge_methods_are_private(&[METHOD_PLUGIN_CALL]));
    assert!(!bridge_methods_are_private(&[METHOD_PLUGIN_FIND]));

    assert!(unix_path.starts_with(home.path()));
    assert!(
        unix_path
            .file_name()
            .is_some_and(|name| name == "host.sock")
    );
    let tcp =
        TcpStream::connect_timeout(&"127.0.0.1:1".parse().unwrap(), Duration::from_millis(50));
    assert!(
        tcp.is_err(),
        "ephemeral TCP must not be the reverse-bridge transport"
    );

    handle.shutdown().await;
}

#[test]
fn replaces_stale_socket_file() {
    let home = temp_home();
    let path = {
        let stale = ReverseBridge::bind(home.path()).unwrap();
        let stale_path = stale.path().to_path_buf();
        drop(stale);
        assert!(stale_path.exists());
        stale_path
    };
    let bridge = ReverseBridge::bind(home.path()).unwrap();
    assert_eq!(bridge.path(), path);
    assert_eq!(bridge.socket_mode().unwrap(), 0o600);
}
