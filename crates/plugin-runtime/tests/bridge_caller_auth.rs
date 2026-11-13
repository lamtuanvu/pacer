#![allow(clippy::unwrap_used)]
//! Only Core may call the plugin owner (#918, ADR 0027): a same-user process
//! without the owner's per-start credential is refused on every frame, cannot
//! start, stop or replace a lane a sealed call then uses, and never sees a
//! request from Core when it poses as the owner.

use pacer_plugin_runtime::{
    AUTH_DEADLINE, AttachError, AuthError, HOST_KEY_NAME, HOST_SOCKET_KEY_ENV, METHOD_AUTH,
    METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN, METHOD_PLUGIN_STOP,
    NativeHostSession, OwnerKey, PeerAuth, ReverseBridge, authenticate, stop_on_owner,
};
use serde_json::{Value, json};
use std::{
    env, fs, io,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

fn temp_home() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::Builder::new()
        .prefix("pba-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}

/// Answers hello and reports which spec started it and its pid.
const WHO_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:'pacer-assistant',version:'1.0.0',contributes:['diagnostic']}});else if(m.method==='diagnostic.ping')send({id:m.id,result:{who:process.argv.at(-1),pid:process.pid}});}}"#;

fn spec(who: &str, home: &Path) -> Value {
    json!({
        "argv":["bun", "-e", WHO_CHILD, who],
        "cwd":home.display().to_string(),
        "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
    })
}

/// A complete Core-sealed call: authenticated, the owner would run it.
fn sealed(rpc: u64, home: &Path) -> Value {
    let mut spawn = spec("core", home);
    spawn["hello"] = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"pacer-assistant","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[],"contributes":{"diagnostic":{}}
        },
        "config":{},"grants":[],"features":[]
    });
    json!({
        "jsonrpc":"2.0","id":rpc,"method":METHOD_PLUGIN_CALL,
        "params":{
            "id":"pacer-assistant","method":"diagnostic.ping","params":{},"deadlineMs":10000,
            "spawn":spawn,
            "authority":{
                "resources":{"reads":[],"writes":[],"commands":[],"hosts":[]},
                "grants":[],"ttlMs":10000
            },
            "scopeRoots":{"home":home.display().to_string(),"pacerHome":home.display().to_string(),"accountHome":null}
        }
    })
}

/// Every frame kind a caller could open with: each bridge method, sealed and
/// unsealed, an unknown method, the private auth method used out of turn, a
/// Core reply to a forwarded request, and a line that is not JSON.
fn frames(home: &Path) -> Vec<Vec<u8>> {
    let mut lines: Vec<Value> = vec![
        sealed(1, home),
        json!({"jsonrpc":"2.0","id":2,"method":METHOD_PLUGIN_CALL,
            "params":{"id":"pacer-assistant","method":"diagnostic.ping","params":{}}}),
        json!({"jsonrpc":"2.0","id":3,"method":METHOD_PLUGIN_FIND,"params":{"id":"pacer-assistant"}}),
        json!({"jsonrpc":"2.0","id":4,"method":METHOD_PLUGIN_STOP,"params":{"id":"pacer-assistant"}}),
        json!({"jsonrpc":"2.0","id":6,"method":"_host.plugin.missing","params":{}}),
        json!({"jsonrpc":"2.0","method":METHOD_AUTH,"params":{"proof":"00".repeat(32)}}),
        json!({"jsonrpc":"2.0","id":"core-1","result":{}}),
    ];
    let mut spawn = spec("impostor", home);
    spawn["id"] = json!("pacer-assistant");
    lines.push(json!({"jsonrpc":"2.0","id":5,"method":METHOD_PLUGIN_SPAWN,"params":spawn}));
    let mut bytes: Vec<Vec<u8>> = lines
        .iter()
        .map(|line| {
            let mut bytes = serde_json::to_vec(line).unwrap();
            bytes.push(b'\n');
            bytes
        })
        .collect();
    bytes.push(b"not json\n".to_vec());
    bytes
}

/// Every line the owner sends until it closes the connection.
async fn exchange_raw(socket: &Path, frame: &[u8]) -> Vec<Value> {
    let mut stream = BufReader::new(UnixStream::connect(socket).await.unwrap());
    // The owner may refuse and close before reading a large frame to its end.
    let _ = stream.get_mut().write_all(frame).await;
    lines_until_close(&mut stream).await
}

async fn assert_refuses_every_frame(socket: &Path, home: &Path) {
    for frame in frames(home) {
        let replies = exchange_raw(socket, &frame).await;
        let text = String::from_utf8_lossy(&frame);
        assert_eq!(replies.len(), 1, "{text} -> {replies:?}");
        assert_eq!(replies[0]["error"]["code"], -32001, "{text} -> {replies:?}");
        assert_eq!(replies[0]["error"]["message"], "unauthorized");
    }
}

async fn call(socket: &Path, key: &OwnerKey, frame: &Value) -> Value {
    let mut stream = BufReader::new(UnixStream::connect(socket).await.unwrap());
    authenticate(&mut stream, key).await.unwrap();
    let mut bytes = serde_json::to_vec(frame).unwrap();
    bytes.push(b'\n');
    stream.get_mut().write_all(&bytes).await.unwrap();
    let mut line = Vec::new();
    stream.read_until(b'\n', &mut line).await.unwrap();
    serde_json::from_slice(&line).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_peer_without_the_credential_is_refused_on_every_frame_of_serve_and_connection_sockets() {
    let home = temp_home();
    let (serve, _) = NativeHostSession::start(home.path()).unwrap();
    let (connection, _) = NativeHostSession::start_connection(home.path(), [9; 6]).unwrap();
    for session in [&serve, &connection] {
        assert_refuses_every_frame(session.socket_path(), home.path()).await;
        // Nothing a refused frame asked for happened.
        assert!(
            session
                .owner()
                .lock()
                .await
                .find_plugin("pacer-assistant")
                .is_none()
        );
    }
    // A probe that only connects, as doctor does, is not an error.
    drop(UnixStream::connect(serve.socket_path()).await.unwrap());
    connection.shutdown_connection().await;
    serve.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_peer_cannot_prestart_stop_or_replace_the_lane_a_sealed_call_uses() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let socket = session.socket_path().to_path_buf();
    let key = session.key().clone();

    // Before Core's first call, a peer tries to start the lane from its own spec.
    let mut spawn = spec("impostor", home.path());
    spawn["id"] = json!("pacer-assistant");
    let frame = json!({"jsonrpc":"2.0","id":5,"method":METHOD_PLUGIN_SPAWN,"params":spawn});
    let mut bytes = serde_json::to_vec(&frame).unwrap();
    bytes.push(b'\n');
    assert_eq!(
        exchange_raw(&socket, &bytes).await[0]["error"]["code"],
        -32001
    );
    // Nor may a caller holding the credential: spawn is retired.
    assert_eq!(call(&socket, &key, &frame).await["error"]["code"], -32601);
    assert!(
        session
            .owner()
            .lock()
            .await
            .find_plugin("pacer-assistant")
            .is_none()
    );

    let first = call(&socket, &key, &sealed(10, home.path())).await;
    assert_eq!(first["result"]["value"]["who"], "core", "{first}");
    let pid = first["result"]["value"]["pid"].clone();

    // The peer cannot stop the lane so that its own spec starts next.
    let stop = json!({"jsonrpc":"2.0","id":6,"method":METHOD_PLUGIN_STOP,"params":{"id":"pacer-assistant"}});
    let mut bytes = serde_json::to_vec(&stop).unwrap();
    bytes.push(b'\n');
    assert_eq!(
        exchange_raw(&socket, &bytes).await[0]["error"]["code"],
        -32001
    );
    // Nor call it outside Core's seal.
    let unsealed = json!({"jsonrpc":"2.0","id":7,"method":METHOD_PLUGIN_CALL,
        "params":{"id":"pacer-assistant","method":"diagnostic.ping","params":{}}});
    let refused = call(&socket, &key, &unsealed).await;
    assert_eq!(refused["error"]["code"], -32602, "{refused}");

    let second = call(&socket, &key, &sealed(11, home.path())).await;
    assert_eq!(second["result"]["value"]["who"], "core", "{second}");
    assert_eq!(
        second["result"]["value"]["pid"], pid,
        "the same lane serves Core"
    );
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn core_sends_nothing_to_an_owner_that_cannot_prove_the_key() {
    let home = temp_home();
    let socket = home.path().join("fake.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let impostor = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut challenge = String::new();
        stream.read_line(&mut challenge).await.unwrap();
        let challenge: Value = serde_json::from_str(&challenge).unwrap();
        assert_eq!(challenge["method"], METHOD_AUTH);
        // The impostor answers in form, but cannot compute the proof.
        let reply = json!({"jsonrpc":"2.0","id":challenge["id"],
            "result":{"nonce":"11".repeat(32),"proof":"22".repeat(32)}});
        let mut bytes = serde_json::to_vec(&reply).unwrap();
        bytes.push(b'\n');
        stream.get_mut().write_all(&bytes).await.unwrap();
        let mut rest = String::new();
        stream.read_line(&mut rest).await.unwrap();
        rest
    });
    let mut stream = BufReader::new(UnixStream::connect(&socket).await.unwrap());
    let key = OwnerKey::generate().unwrap();
    assert!(matches!(
        authenticate(&mut stream, &key).await,
        Err(AuthError::Unproven)
    ));
    drop(stream);
    assert_eq!(impostor.await.unwrap(), "", "no proof and no request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_proof_is_refused_and_the_connection_closed() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let mut stream = BufReader::new(UnixStream::connect(session.socket_path()).await.unwrap());
    let challenge = json!({"jsonrpc":"2.0","id":"auth","method":METHOD_AUTH,"params":{"nonce":"33".repeat(32)}});
    let mut bytes = serde_json::to_vec(&challenge).unwrap();
    bytes.push(b'\n');
    stream.get_mut().write_all(&bytes).await.unwrap();
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert!(reply["result"]["proof"].is_string(), "{reply}");
    // A peer that cannot compute Core's proof answers with anything and a call.
    let answer = json!({"jsonrpc":"2.0","method":METHOD_AUTH,"params":{"proof":"44".repeat(32)}});
    let mut bytes = serde_json::to_vec(&answer).unwrap();
    bytes.push(b'\n');
    bytes.extend(serde_json::to_vec(&sealed(1, home.path())).unwrap());
    bytes.push(b'\n');
    let _ = stream.get_mut().write_all(&bytes).await;
    assert_refused(
        &lines_until_close(&mut stream).await,
        "wrong proof and a call",
    );
    assert!(
        session
            .owner()
            .lock()
            .await
            .find_plugin("pacer-assistant")
            .is_none()
    );
    session.shutdown().await;
}

/// Every line the owner sends on `stream` until it closes the connection.
/// Linux reports a close that left our bytes unread as a reset instead of EOF,
/// but only after every line the owner sent before closing.
async fn lines_until_close(stream: &mut BufReader<UnixStream>) -> Vec<Value> {
    let mut lines = Vec::new();
    loop {
        let mut line = Vec::new();
        // The owner closes a refused connection well before this timeout.
        let read =
            tokio::time::timeout(Duration::from_secs(15), stream.read_until(b'\n', &mut line))
                .await
                .unwrap();
        match read {
            Ok(0) => return lines,
            Ok(_) => lines.push(serde_json::from_slice(&line).unwrap()),
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => return lines,
            Err(error) => panic!("reading the owner's replies: {error}"),
        }
    }
}

async fn send(stream: &mut BufReader<UnixStream>, frame: &Value) {
    let mut bytes = serde_json::to_vec(frame).unwrap();
    bytes.push(b'\n');
    let _ = stream.get_mut().write_all(&bytes).await;
}

fn assert_refused(replies: &[Value], what: &str) {
    assert_eq!(replies.len(), 1, "{what}: {replies:?}");
    assert_eq!(replies[0]["error"]["code"], -32001, "{what}: {replies:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_or_stalled_peer_is_refused_at_the_handshake_deadline() {
    assert_eq!(AUTH_DEADLINE, Duration::from_secs(10));
    let home = temp_home();
    let deadline = Duration::from_millis(400);
    let bridge = ReverseBridge::bind_at(
        home.path(),
        "host.sock",
        PeerAuth::same_uid(OwnerKey::generate().unwrap()),
    )
    .unwrap()
    .with_auth_deadline(deadline)
    .spawn();
    for partial in [&b""[..], &br#"{"jsonrpc":"2.0","id":"auth""#[..]] {
        let started = Instant::now();
        let mut stream = BufReader::new(UnixStream::connect(bridge.path()).await.unwrap());
        stream.get_mut().write_all(partial).await.unwrap();
        let replies = lines_until_close(&mut stream).await;
        let waited = started.elapsed();
        assert_refused(&replies, &String::from_utf8_lossy(partial));
        assert!(
            waited >= deadline,
            "refused before the deadline: {waited:?}"
        );
    }
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_auth_line_over_4_kib_is_refused() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let mut stream = BufReader::new(UnixStream::connect(session.socket_path()).await.unwrap());
    let challenge = json!({"jsonrpc":"2.0","id":"auth","method":METHOD_AUTH,
        "params":{"nonce":"ab".repeat(32),"pad":"x".repeat(5000)}});
    send(&mut stream, &challenge).await;
    assert_refused(&lines_until_close(&mut stream).await, "5 KB challenge");
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reflected_owner_proof_or_a_malformed_nonce_is_refused() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let socket = session.socket_path();
    // The owner proves itself for any nonce; its proof sent back as Core's is not Core's.
    let mut stream = BufReader::new(UnixStream::connect(socket).await.unwrap());
    let challenge = json!({"jsonrpc":"2.0","id":"auth","method":METHOD_AUTH,"params":{"nonce":"cd".repeat(32)}});
    send(&mut stream, &challenge).await;
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    let owner_proof = serde_json::from_str::<Value>(&line).unwrap()["result"]["proof"].clone();
    assert!(owner_proof.is_string(), "{line}");
    send(
        &mut stream,
        &json!({"jsonrpc":"2.0","method":METHOD_AUTH,"params":{"proof":owner_proof}}),
    )
    .await;
    assert_refused(&lines_until_close(&mut stream).await, "reflected proof");

    // A nonce that is not 64 lowercase hex gets no owner proof.
    for nonce in [String::new(), "CD".into(), "CD".repeat(32), "zz".repeat(32)] {
        let mut stream = BufReader::new(UnixStream::connect(socket).await.unwrap());
        send(
            &mut stream,
            &json!({"jsonrpc":"2.0","id":"auth","method":METHOD_AUTH,"params":{"nonce":nonce}}),
        )
        .await;
        assert_refused(&lines_until_close(&mut stream).await, &nonce);
    }

    // Once authenticated, `_host.auth` is an unknown method, never a second handshake.
    let mut stream = BufReader::new(UnixStream::connect(socket).await.unwrap());
    authenticate(&mut stream, session.key()).await.unwrap();
    send(&mut stream, &challenge).await;
    line.clear();
    stream.read_line(&mut line).await.unwrap();
    let again: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(again["error"]["code"], -32601, "{again}");
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serve_publishes_a_private_key_per_start_and_a_connection_none() {
    let home = temp_home();
    let run = home.path().join("run");
    let (first, core_env) = NativeHostSession::start(home.path()).unwrap();
    // The env pairs every child may see carry only the socket.
    assert!(core_env.iter().all(|(name, _)| name != HOST_SOCKET_KEY_ENV));
    let file = run.join(HOST_KEY_NAME);
    let meta = fs::symlink_metadata(&file).unwrap();
    assert!(meta.is_file());
    assert_eq!(meta.mode() & 0o777, 0o600);
    let text = fs::read_to_string(&file).unwrap();
    assert_eq!(text.trim(), first.key().to_hex());
    assert!(!format!("{:?}", first.key()).contains(&first.key().to_hex()));
    let first_key = first.key().clone();
    first.shutdown().await;
    assert!(!file.exists(), "shutdown removes its key");

    let (second, _) = NativeHostSession::start(home.path()).unwrap();
    assert_ne!(second.key(), &first_key, "every start rotates the key");
    assert_eq!(
        fs::read_to_string(&file).unwrap().trim(),
        second.key().to_hex()
    );
    // The old key no longer opens the bridge.
    let mut stream = BufReader::new(UnixStream::connect(second.socket_path()).await.unwrap());
    assert!(matches!(
        authenticate(&mut stream, &first_key).await,
        Err(AuthError::Unproven)
    ));
    // A door attached before the restart rejects the new owner and says why.
    let stale = stop_on_owner(second.socket_path(), &first_key, "fx")
        .await
        .unwrap_err();
    assert!(matches!(stale, AttachError::Unproven), "{stale:?}");
    assert!(
        stale.hint().contains("restarted, reconnect")
            && stale.hint().contains("not this connection's plugin owner"),
        "{}",
        stale.hint()
    );
    second.shutdown().await;

    let (connection, _) = NativeHostSession::start_connection(home.path(), [3; 6]).unwrap();
    let names: Vec<_> = fs::read_dir(&run)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(
        names.iter().all(|name| name.ends_with(".sock")),
        "a connection's key never touches disk: {names:?}"
    );
    connection.shutdown_connection().await;
}
