#![allow(clippy::unwrap_used)]
//! Flag-on NativeHostSession: socket appears, same-uid peer auth, live call/find
//! against owned fixture children, clean shutdown.
//! Flag-off stays dark (no socket, no PACER_HOST_SOCKET).
//! Wrong-uid denial remains covered by reverse_bridge::denies_untrusted_caller.
//! Stub (no-owner) call/find stay in reverse_bridge::fixture_dial_plugin_call_and_find_stubs.

use pacer_plugin_runtime::{
    HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN,
    METHOD_PLUGIN_STOP, NativeHostSession, SpawnSpec, native_plugin_host_enabled,
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

fn peer(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: env::current_dir().unwrap(),
        env: env::vars().collect(),
    }
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
    assert!(serve_starts_reverse_bridge_by_default());
    assert!(native_plugin_host_enabled(None, None));
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
    assert!(
        session
            .owner()
            .lock()
            .await
            .claim_native_supervision()
            .is_ok()
    );

    let socket = session.socket_path().to_path_buf();
    assert!(socket.exists());
    let meta = fs::symlink_metadata(&socket).unwrap();
    assert_eq!(meta.mode() & 0o777, 0o600);
    let run = home.path().join("run");
    assert_eq!(fs::symlink_metadata(&run).unwrap().mode() & 0o777, 0o700);

    tokio::task::yield_now().await;
    // Live dispatch with no children: missing id is invalid params (not the stub).
    let call = dial_json(
        &socket,
        json!({"jsonrpc":"2.0","id":1,"method":METHOD_PLUGIN_CALL,"params":{}}),
    )
    .await;
    assert_eq!(call["id"], 1);
    assert_eq!(call["error"]["code"], -32602);

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
    let find = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":7,"method":METHOD_PLUGIN_FIND,"params":{"id":"missing"}}),
    )
    .await;
    assert_eq!(find["id"], 7);
    assert!(find.get("error").is_none(), "{find}");
    assert_eq!(find["result"]["found"], false);
    assert_eq!(find["result"]["id"], "missing");
    // Stub reason must not appear once the owner is live.
    assert!(find["result"].get("reason").is_none());
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_call_and_find_against_fixture_under_owner() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();

    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true,echo:m.params||{}}}));}}"#;
    {
        let mut owner = session.owner().lock().await;
        owner.spawn("fx-bridge", &peer(script)).unwrap();
        assert_eq!(owner.tracked_ids(), vec!["fx-bridge".to_string()]);
    }

    tokio::task::yield_now().await;

    let find = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":10,"method":METHOD_PLUGIN_FIND,"params":{"id":"fx-bridge"}}),
    )
    .await;
    assert_eq!(find["result"]["found"], true);
    assert_eq!(find["result"]["id"], "fx-bridge");
    let pid = find["result"]["pid"].as_u64();
    assert!(pid.is_some(), "{find}");
    assert_ne!(pid.unwrap(), u64::from(std::process::id()));

    let missing = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":11,"method":METHOD_PLUGIN_FIND,"params":{"id":"absent"}}),
    )
    .await;
    assert_eq!(missing["result"]["found"], false);

    let call = dial_json(
        &path,
        json!({
            "jsonrpc":"2.0",
            "id":12,
            "method":METHOD_PLUGIN_CALL,
            "params":{"id":"fx-bridge","method":"probe","params":{"n":1},"deadlineMs":5000}
        }),
    )
    .await;
    assert!(call.get("error").is_none(), "{call}");
    assert_eq!(call["result"]["ok"], true);
    assert_eq!(call["result"]["echo"]["n"], 1);

    let unknown = dial_json(
        &path,
        json!({
            "jsonrpc":"2.0",
            "id":13,
            "method":METHOD_PLUGIN_CALL,
            "params":{"id":"absent","method":"probe","params":{}}
        }),
    )
    .await;
    assert_eq!(unknown["error"]["code"], -32002);

    {
        let mut owner = session.owner().lock().await;
        owner.terminate("fx-bridge").await.unwrap();
    }
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bridge_spawn_and_stop_under_owner() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true}}));}}"#;
    let peer = peer(script);
    tokio::task::yield_now().await;

    let spawn_params = json!({
        "id":"fx-spawn",
        "argv":peer.argv,
        "cwd":peer.cwd.display().to_string(),
        "env":peer.env,
    });
    let spawned = dial_json(
        &path,
        json!({
            "jsonrpc":"2.0",
            "id":20,
            "method":METHOD_PLUGIN_SPAWN,
            "params":spawn_params,
        }),
    )
    .await;
    assert!(spawned.get("error").is_none(), "{spawned}");
    assert_eq!(spawned["result"]["created"], true);
    assert_eq!(spawned["result"]["id"], "fx-spawn");
    assert!(spawned["result"]["pid"].as_u64().is_some());

    let again = dial_json(
        &path,
        json!({
            "jsonrpc":"2.0",
            "id":21,
            "method":METHOD_PLUGIN_SPAWN,
            "params":{
                "id":"fx-spawn",
                "argv":peer.argv,
                "cwd":peer.cwd.display().to_string(),
                "env":peer.env,
            }
        }),
    )
    .await;
    assert_eq!(again["result"]["created"], false);
    assert_eq!(again["result"]["pid"], spawned["result"]["pid"]);

    let call = dial_json(
        &path,
        json!({
            "jsonrpc":"2.0",
            "id":22,
            "method":METHOD_PLUGIN_CALL,
            "params":{"id":"fx-spawn","method":"probe","params":{}}
        }),
    )
    .await;
    assert!(call.get("error").is_none(), "{call}");
    assert_eq!(call["result"]["ok"], true);

    let stopped = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":23,"method":METHOD_PLUGIN_STOP,"params":{"id":"fx-spawn"}}),
    )
    .await;
    assert_eq!(stopped["result"]["stopped"], true);

    let missing = dial_json(
        &path,
        json!({"jsonrpc":"2.0","id":24,"method":METHOD_PLUGIN_STOP,"params":{"id":"fx-spawn"}}),
    )
    .await;
    assert_eq!(missing["result"]["stopped"], false);

    session.shutdown().await;
}
