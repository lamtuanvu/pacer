#![allow(clippy::unwrap_used)]
//! Flag-on NativeHostSession: socket appears, same-uid peer auth, live call/find
//! against owned fixture children, clean shutdown.
//! Flag-off stays dark (no socket, no PACER_HOST_SOCKET).
//! Wrong-uid denial remains covered by reverse_bridge::denies_untrusted_caller.
//! Stub (no-owner) call/find stay in reverse_bridge::fixture_dial_plugin_call_and_find_stubs.

use pacer_plugin_runtime::{
    HOST_SOCKET_ENV, METHOD_PLUGIN_CALL, METHOD_PLUGIN_FIND, METHOD_PLUGIN_SPAWN,
    METHOD_PLUGIN_STOP, NativeHostSession, OwnerError, SpawnSpec, StartFailure, TERMINATE_GRACE,
    native_plugin_host_enabled, serve_starts_reverse_bridge_by_default, start_lane,
};
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

// The bridge requires a private home; temp dirs follow the process umask.
fn temp_home() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_children_while_a_caller_holds_the_owner() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let owner = session.owner().clone();
    let stubborn = peer(
        r"process.on('SIGTERM',()=>{});const r=Bun.stdin.stream().getReader();let t='';for(;;){const {value,done}=await r.read();if(done)break;t+=new TextDecoder().decode(value);for(let i=t.indexOf('\n');i>=0;i=t.indexOf('\n')){const m=JSON.parse(t.slice(0,i));t=t.slice(i+1);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));}}",
    );
    owner.lock().await.spawn("fx", &stubborn).unwrap();
    let lane = owner.lock().await.lane("fx").unwrap();
    // Answering proves the SIGTERM handler is installed.
    lane.process()
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    let socket = session.socket_path().to_path_buf();
    // A plugin call in flight may hold the owner for its whole deadline.
    let held = owner.clone().lock_owned().await;
    let stopping = tokio::spawn(session.shutdown());
    for _ in 0..50 {
        if lane.process().is_stopping() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        lane.process().is_stopping(),
        "no SIGTERM while the owner was held"
    );
    drop(held);
    // The child outlives SIGTERM during the grace, but no call starts on it.
    assert!(lane.process().is_alive());
    let refused = start_lane(
        &owner,
        "fx",
        &stubborn,
        None,
        Instant::now() + Duration::from_secs(5),
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(StartFailure::Owner(OwnerError::Closing))),
        "{:?}",
        refused.err()
    );
    let stopped = tokio::time::timeout(TERMINATE_GRACE + Duration::from_secs(2), stopping).await;
    assert!(
        stopped.is_ok_and(|joined| joined.is_ok()),
        "shutdown outlived the grace"
    );
    assert_eq!(
        lane.process().exit_reason().as_deref(),
        Some("exited on SIGKILL")
    );
    assert!(!socket.exists());
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
async fn sealed_call_starts_hellos_and_authorizes_under_owner() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let account = temp_home();
    let account_home = account.path().canonicalize().unwrap();
    let note = account_home.join("note.txt");
    fs::write(&note, "from-account-home").unwrap();
    let note = note.to_str().unwrap().to_owned();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("plugin.js");
    fs::write(
        &script,
        r#"const r=Bun.stdin.stream().getReader();let b='',pending,hellos=0;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello'){hellos++;send({id:m.id,result:{ok:true,protocol:'1.10.0',id:'fx-sealed',version:'1.0.0',contributes:['diagnostic']}});}else if(m.method==='diagnostic.ping'){pending=m.id;send({id:7,method:'capability.fs.read',params:{path:m.params.path}});}else if(m.id===7){send({id:pending,result:typeof m.result?.text==='string'?{ok:true,text:m.result.text,hellos}:{ok:false,hellos}});}else if(m.method==='fail.me'){send({id:m.id,error:{code:-32000,message:'bad input',data:{code:'invalid_input',hint:'fix it'}}});}}}"#,
    )
    .unwrap();
    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-sealed","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"fs.read","scopes":["${ACCOUNT_HOME}/**"]}],
            "contributes":{"diagnostic":{}}
        },
        "config":{},"grants":["fs.read"],"features":[]
    });
    let request = |rpc: u64, account_home: Value| {
        json!({
            "jsonrpc":"2.0",
            "id":rpc,
            "method":METHOD_PLUGIN_CALL,
            "params":{
                "id":"fx-sealed",
                "method":"diagnostic.ping",
                "params":{"path":note},
                "deadlineMs":5000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap()],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":hello,
                },
                "authority":{
                    "resources":{"reads":[{"path":note,"kind":"file"}],"writes":[],"commands":[],"hosts":[]},
                    "grants":["fs.read"],
                    "ttlMs":10000
                },
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":account_home}
            }
        })
    };
    tokio::task::yield_now().await;

    let first = dial_json(&path, request(30, json!(account_home))).await;
    assert!(first.get("error").is_none(), "{first}");
    assert_eq!(
        first["result"]["value"],
        json!({"ok": true, "text": "from-account-home", "hellos": 1})
    );
    assert_eq!(first["result"]["hello"]["protocol"], "1.10.0");
    assert_eq!(first["result"]["hello"]["served"], json!(["diagnostic"]));
    let pid = session.owner().lock().await.find_plugin("fx-sealed");
    assert!(pid.is_some());

    let second = dial_json(&path, request(31, json!(account_home))).await;
    assert!(second.get("error").is_none(), "{second}");
    assert_eq!(second["result"]["value"]["hellos"], 1, "hello runs once");
    assert_eq!(
        second["result"]["hello"], first["result"]["hello"],
        "every reply restores readiness"
    );
    assert_eq!(session.owner().lock().await.find_plugin("fx-sealed"), pid);

    // The child's own error code, message and hint survive the bridge.
    let mut failing = request(35, json!(account_home));
    failing["params"]["method"] = json!("fail.me");
    let failing = dial_json(&path, failing).await;
    assert_eq!(failing["error"]["message"], "bad input", "{failing}");
    assert_eq!(failing["error"]["data"]["code"], "invalid_input");
    assert_eq!(failing["error"]["data"]["hint"], "fix it");
    assert_eq!(
        failing["error"]["data"]["origin"], "plugin",
        "a relayed child error is tagged as the plugin's"
    );

    // The deadline starts at receipt and covers the wait for the owner.
    let mut late = request(36, json!(account_home));
    late["params"]["deadlineMs"] = json!(200);
    let held = session.owner().lock().await;
    let waited = tokio::spawn({
        let path = path.clone();
        async move { dial_json(&path, late).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        waited.is_finished(),
        "the reply must not wait for the owner"
    );
    drop(held);
    let late = waited.await.unwrap();
    assert_eq!(late["error"]["data"]["code"], "plugin_timeout", "{late}");
    assert!(
        late["error"]["data"].get("origin").is_none(),
        "an owner-enforced deadline is pacer's own failure: {late}"
    );

    // A caller that hangs up cancels its call and releases the owner.
    let mut hang = request(38, json!(account_home));
    hang["params"]["method"] = json!("hang.forever");
    {
        let mut stream = UnixStream::connect(&path).await.unwrap();
        let mut bytes = serde_json::to_vec(&hang).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let started = std::time::Instant::now();
    let after = dial_json(&path, request(39, json!(account_home))).await;
    assert!(after.get("error").is_none(), "{after}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a hung-up call kept the owner"
    );

    // Orca and hosts handlers lock the owner, so the bridge refuses them.
    let mut hosts = request(37, json!(account_home));
    hosts["params"]["authority"]["resources"]["hosts"] = json!([{
        "alias":"box","hostFingerprint":"fp","script":"probe","args":[],"timeoutMs":1000,"maxBytes":10
    }]);
    let hosts = dial_json(&path, hosts).await;
    assert_eq!(
        hosts["error"]["data"]["code"], "plugin_unavailable",
        "{hosts}"
    );

    // `${ACCOUNT_HOME}` scopes need the call's account home.
    let unscoped = dial_json(&path, request(32, Value::Null)).await;
    assert_eq!(unscoped["result"]["value"]["ok"], false, "{unscoped}");

    let mut bad = request(33, Value::Null);
    bad["params"]["spawn"]["argv"] = json!([]);
    let bad = dial_json(&path, bad).await;
    assert_eq!(bad["error"]["code"], -32602);

    let mut refused = request(34, Value::Null);
    refused["params"]["id"] = json!("fx-refused");
    refused["params"]["spawn"]["hello"] = json!({"protocol":"1.10.0"});
    let refused = dial_json(&path, refused).await;
    assert_eq!(refused["error"]["code"], -32002);
    assert_eq!(refused["error"]["data"]["code"], "plugin_refused");

    {
        let mut owner = session.owner().lock().await;
        owner.terminate("fx-sealed").await.unwrap();
        owner.terminate("fx-refused").await.unwrap();
    }
    session.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sealed_calls_overlap_across_plugins_and_within_a_reentrant_plugin() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let account = temp_home();
    let account_home = account.path().canonicalize().unwrap();
    let file = |name: &str| {
        let path = account_home.join(name);
        fs::write(&path, name).unwrap();
        path.to_str().unwrap().to_owned()
    };
    let (a, b) = (file("a.txt"), file("b.txt"));
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("plugin.js");
    // `slow` reads its path through the host, echoing the call's `_meta`, then
    // answers after `ms`.
    fs::write(
        &script,
        r#"const r=Bun.stdin.stream().getReader();let b='',hellos=0;const pending={};const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello'){hellos++;send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic']}});}else if(m.method==='slow'){pending['r'+m.id]=m;send({id:'r'+m.id,method:'capability.fs.read',params:{path:m.params.path},...(m._meta?{_meta:m._meta}:{})});}else if(typeof m.id==='string'&&pending[m.id]){const p=pending[m.id];delete pending[m.id];setTimeout(()=>send({id:p.id,result:{text:m.result?.text??null,denied:m.error?.data?.code??null,token:p._meta?.capabilityCall??null,hellos}}),p.params.ms);}}}"#,
    )
    .unwrap();
    let request_for = |plugin: &str, reentrant: bool, read: &str, ms: u64| {
        let hello = json!({
            "protocol":"1.10.0","pacer":"0.2.0",
            "manifest":{
                "id":plugin,"version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                "capabilities":[{"name":"fs.read","scopes":["${ACCOUNT_HOME}/**"]}],
                "contributes":{"diagnostic":{}},"reentrant":reentrant
            },
            "config":{},"grants":["fs.read"],"features":[]
        });
        json!({
            "jsonrpc":"2.0","id":1,"method":METHOD_PLUGIN_CALL,
            "params":{
                "id":plugin,"method":"slow","params":{"path":read,"ms":ms},"deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap()],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":hello,
                },
                "authority":{
                    "resources":{"reads":[{"path":read,"kind":"file"}],"writes":[],"commands":[],"hosts":[]},
                    "grants":["fs.read"],"ttlMs":10000
                },
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":account_home}
            }
        })
    };
    let call = |plugin: &str, reentrant: bool, read: &str, ms: u64| {
        let request = request_for(plugin, reentrant, read, ms);
        let path = path.clone();
        async move {
            let started = std::time::Instant::now();
            let reply = dial_json(&path, request).await;
            (reply, started.elapsed())
        }
    };
    tokio::task::yield_now().await;

    // A reentrant plugin's calls overlap on one child; each call's capability
    // requests reach its own session, which allows only its own file.
    let started = std::time::Instant::now();
    let ((first, _), (second, _)) = tokio::join!(
        call("fx-shared", true, &a, 1000),
        call("fx-shared", true, &b, 1000)
    );
    let together = started.elapsed();
    for (reply, text) in [(&first, "a.txt"), (&second, "b.txt")] {
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(reply["result"]["value"]["text"], text, "{reply}");
        assert_eq!(reply["result"]["value"]["hellos"], 1, "hello runs once");
        assert!(reply["result"]["value"]["token"].is_string(), "{reply}");
    }
    assert_ne!(
        first["result"]["value"]["token"],
        second["result"]["value"]["token"]
    );
    assert!(
        together < Duration::from_millis(1800),
        "reentrant calls ran one at a time: {together:?}"
    );

    // Any other plugin still answers one call at a time, without a token.
    let started = std::time::Instant::now();
    let ((first, _), (second, _)) = tokio::join!(
        call("fx-single", false, &a, 600),
        call("fx-single", false, &b, 600)
    );
    let serialized = started.elapsed();
    for (reply, text) in [(&first, "a.txt"), (&second, "b.txt")] {
        assert_eq!(reply["result"]["value"]["text"], text, "{reply}");
        assert_eq!(reply["result"]["value"]["token"], Value::Null, "{reply}");
        assert_eq!(reply["result"]["value"]["hellos"], 1, "hello runs once");
    }
    assert!(
        serialized >= Duration::from_millis(1150),
        "non-reentrant calls overlapped: {serialized:?}"
    );

    // A slow call to one plugin does not hold calls to another.
    let ((slow, _), (fast, fast_took)) = tokio::join!(call("fx-single", false, &a, 2000), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        call("fx-shared", true, &b, 0).await
    });
    assert_eq!(slow["result"]["value"]["text"], "a.txt", "{slow}");
    assert_eq!(fast["result"]["value"]["text"], "b.txt", "{fast}");
    assert!(
        fast_took < Duration::from_millis(1200),
        "a call waited for another plugin: {fast_took:?}"
    );

    // The deadline covers the wait for a busy non-reentrant plugin.
    let mut late = request_for("fx-single", false, &a, 0);
    late["params"]["deadlineMs"] = json!(300);
    let (_, (late, late_took)) = tokio::join!(call("fx-single", false, &a, 1500), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = std::time::Instant::now();
        (dial_json(&path, late).await, started.elapsed())
    });
    assert_eq!(late["error"]["data"]["code"], "plugin_timeout", "{late}");
    assert!(late_took < Duration::from_millis(1200), "{late_took:?}");

    {
        let mut owner = session.owner().lock().await;
        owner.terminate("fx-shared").await.unwrap();
        owner.terminate("fx-single").await.unwrap();
    }
    session.shutdown().await;
}

/// Dial one call; answer every owner-forwarded request with `answer` until the final reply.
async fn dial_with_core(
    path: &Path,
    request: Value,
    answer: impl Fn(&Value) -> Value,
) -> (Value, Vec<Value>) {
    let mut stream = UnixStream::connect(path).await.unwrap();
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut forwarded = Vec::new();
    loop {
        let mut line = Vec::new();
        reader.read_until(b'\n', &mut line).await.unwrap();
        let frame: Value = serde_json::from_slice(&line).unwrap();
        if frame.get("method").is_none() {
            return (frame, forwarded);
        }
        let mut body = answer(&frame);
        body["jsonrpc"] = json!("2.0");
        body["id"] = frame["id"].clone();
        let mut reply = serde_json::to_vec(&body).unwrap();
        reply.push(b'\n');
        reader.get_mut().write_all(&reply).await.unwrap();
        forwarded.push(frame);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_call_runs_codex_live_and_forwards_usage_state_to_core() {
    use std::os::unix::fs::PermissionsExt;
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let account = temp_home();
    let account_home = account.path().canonicalize().unwrap();
    let tools = temp_home();
    let tool = |name: &str, body: &str| {
        let file = tools.path().canonicalize().unwrap().join(name);
        fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        file.display().to_string()
    };
    let codex = tool(
        "codex",
        r#"read a; read b; read c; printf '{"id":2,"result":{"home":"%s","secret":"%s"}}\n' "$CODEX_HOME" "$FX_SECRET""#,
    );
    let fx_env = tool(
        "fx-env",
        r#"printf '%s|%s|%s' "$HOME" "$LANG" "$FX_SECRET""#,
    );
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("plugin.js");
    fs::write(
        &script,
        r#"const r=Bun.stdin.stream().getReader();let b='',pending,out={};const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:'fx-usage',version:'1.0.0',contributes:['usage']}});else if(m.method==='usage.read'){pending=m.id;send({id:7,method:'capability.usage.state.begin',params:{store:'codex-cursors'}});}else if(m.id===7){out.state=m.result??m.error;send({id:11,method:'capability.usage.state.stageChunk',params:{lease:'lease-1',offset:0,base64:'e30='}});}else if(m.id===11){out.staged=m.result??m.error;send({id:12,method:'capability.usage.state.commit',params:{lease:'lease-1'}});}else if(m.id===12){out.commit=m.result??m.error;send({id:8,method:'capability.process.spawn',params:{argv:['codex','-s','read-only','-a','never','app-server'],timeoutMs:5000}});}else if(m.id===8){out.live=m.result??m.error;send({id:9,method:'capability.process.spawn',params:{argv:['fx-env'],timeoutMs:5000}});}else if(m.id===9){out.env=m.result??m.error;send({id:10,method:'capability.fs.stat',params:{path:'/fixture/account/auth.json'}});}else if(m.id===10){out.stat=m.result??m.error;send({id:pending,result:out});}}}"#,
    )
    .unwrap();
    let hello = json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-usage","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[{"name":"process.spawn","scopes":["codex","fx-env"]},{"name":"usage.state"},{"name":"fs.read","scopes":["/fixture/**"]}],
            "contributes":{"usage":{"providers":["codex"]}}
        },
        "config":{},"grants":["process.spawn","usage.state","fs.read"],"features":[]
    });
    let codex_env = json!({"PATH": env::var("PATH").unwrap(), "CODEX_HOME": account_home});
    let sealed = json!([
        "capability.usage.state.begin",
        "capability.usage.state.stageChunk",
        "capability.usage.state.commit",
        "capability.fs.stat"
    ]);
    let request = |rpc: u64, account_home: Value, core_methods: Value| {
        json!({
            "jsonrpc":"2.0",
            "id":rpc,
            "method":METHOD_PLUGIN_CALL,
            "params":{
                "id":"fx-usage",
                "method":"usage.read",
                "params":{},
                "deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap()],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":hello,
                },
                "authority":{
                    "resources":{"reads":[],"writes":[],"hosts":[],"commands":[
                        {"argv":[codex,"-s","read-only","-a","never","app-server"],"timeoutMs":10000,"mode":"codex-live","env":codex_env},
                        {"argv":[fx_env],"timeoutMs":10000}
                    ]},
                    "grants":["process.spawn","usage.state","fs.read"],
                    "ttlMs":10000
                },
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":account_home},
                "processEnv":{"HOME":"/fixture/home","LANG":"C","FX_SECRET":"leak"},
                "coreMethods":core_methods
            }
        })
    };
    tokio::task::yield_now().await;

    let (reply, forwarded) = dial_with_core(
        &path,
        request(40, json!(account_home), sealed.clone()),
        |frame| match frame["method"].as_str() {
            Some("capability.fs.stat") => json!({"result":{"info":null,"missing":true}}),
            Some("capability.usage.state.stageChunk") => json!({"result":{"bytes":2}}),
            Some("capability.usage.state.commit") => json!({"result":{"saved":true}}),
            _ => json!({"result":{"lease":"lease-1","bytes":2,"version":4,"dirty":false}}),
        },
    )
    .await;
    assert!(reply.get("error").is_none(), "{reply}");
    let methods: Vec<_> = forwarded
        .iter()
        .map(|frame| frame["method"].clone())
        .collect();
    assert_eq!(
        methods,
        [
            json!("capability.usage.state.begin"),
            json!("capability.usage.state.stageChunk"),
            json!("capability.usage.state.commit"),
            json!("capability.fs.stat")
        ],
        "{forwarded:?}"
    );
    assert_eq!(forwarded[0]["params"], json!({"store":"codex-cursors"}));
    assert_eq!(
        forwarded[1]["params"],
        json!({"lease":"lease-1","offset":0,"base64":"e30="})
    );
    let value = &reply["result"]["value"];
    assert_eq!(value["state"]["lease"], "lease-1", "{value}");
    assert_eq!(value["staged"]["bytes"], 2, "{value}");
    assert_eq!(value["commit"]["saved"], true, "{value}");
    assert_eq!(value["stat"]["missing"], true, "{value}");
    let live: Value =
        serde_json::from_str(value["live"]["stdout"].as_str().unwrap().trim()).unwrap();
    assert_eq!(live["result"]["home"], json!(account_home), "{value}");
    assert_eq!(live["result"]["secret"], "", "issued env only");
    assert_eq!(value["env"]["stdout"], "/fixture/home|C|", "{value}");

    // Core's error reaches the plugin unchanged.
    let (refused, _) =
        dial_with_core(&path, request(41, json!(account_home), sealed.clone()), |_| {
            json!({"error":{"code":-32000,"message":"usage state store is not authorized","data":{"code":"capability_denied"}}})
        })
        .await;
    assert_eq!(
        refused["result"]["value"]["state"]["data"]["code"], "capability_denied",
        "{refused}"
    );

    // Without Core-sealed methods nothing is forwarded: usage state is refused
    // and file reads stay with the native broker, which has no issued reads.
    let (local, forwarded) = dial_with_core(
        &path,
        request(43, json!(account_home), Value::Null),
        |_| json!({"result":{}}),
    )
    .await;
    assert!(forwarded.is_empty(), "{forwarded:?}");
    let value = &local["result"]["value"];
    assert_eq!(
        value["state"]["data"]["code"], "capability_denied",
        "{local}"
    );
    assert_eq!(
        value["stat"]["data"]["code"], "capability_denied",
        "{local}"
    );

    // Core may only seal methods the owner knows how to forward.
    let (invalid, forwarded) = dial_with_core(
        &path,
        request(44, json!(account_home), json!(["capability.process.spawn"])),
        |_| json!({"result":{}}),
    )
    .await;
    assert!(forwarded.is_empty(), "{forwarded:?}");
    assert!(invalid["error"].is_object(), "{invalid}");

    // A Codex live command needs the call's account home as CODEX_HOME.
    let (unbound, _) = dial_with_core(
        &path,
        request(42, Value::Null, sealed.clone()),
        |_| json!({"result":{}}),
    )
    .await;
    assert_eq!(
        unbound["error"]["data"]["code"], "plugin_refused",
        "{unbound}"
    );

    session
        .owner()
        .lock()
        .await
        .terminate("fx-usage")
        .await
        .unwrap();
    session.shutdown().await;
}

/// Orca provider child: `executor.run` asks for `capability.orca.prepare` then a
/// plain file write; `executor.stop` asks for `capability.orca.stop`. Each call
/// returns what it was answered.
const ORCA_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='',call,out={};const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));const ids={taskId:'t-1',attempt:1};for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:'pacer-exec-orca',version:'1.0.0',contributes:['executor']}});else if(m.method==='executor.run'){call=m.id;out={};send({id:'prepare',method:'capability.orca.prepare',params:ids});}else if(m.id==='prepare'){out.prepare=m.result??m.error;send({id:'write',method:'capability.fs.write',params:{path:'/fixture/out.txt',text:'x'}});}else if(m.id==='write'){out.write=m.result??m.error;send({id:call,result:out});}else if(m.method==='executor.stop'){call=m.id;send({id:'stop',method:'capability.orca.stop',params:ids});}else if(m.id==='stop'){send({id:call,result:{stop:m.result??m.error}});}}}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_orca_attempt_live_and_writes_are_answered_by_core() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("plugin.js");
    fs::write(&script, ORCA_CHILD).unwrap();
    let orca_methods = json!([
        "capability.orca.status",
        "capability.orca.liveAnswer",
        "capability.orca.prepare",
        "capability.orca.place",
        "capability.orca.terminal",
        "capability.orca.abandon",
        "capability.orca.start",
        "capability.orca.lookup",
        "capability.orca.adopt",
        "capability.orca.unstarted",
        "capability.orca.wait",
        "capability.orca.settle",
        "capability.orca.finish",
        "capability.orca.stop",
        "capability.orca.sessionState"
    ]);
    let attempt = json!({"taskId":"t-1","attempt":1,"providerId":"pacer-exec-orca","executor":"codex","session":"host-only-session"});
    let live = json!({"taskId":"t-1","attempt":1,"providerId":"pacer-exec-orca","worker":"ctx_1","terminal":"term_1","action":"stop"});
    let request = |rpc: u64, method: &str, orca: Value, grants: Value, core_methods: Value| {
        let mut resources = json!({"reads":[],"writes":[],"hosts":[],"commands":[]});
        for (key, value) in orca.as_object().unwrap() {
            resources[key] = value.clone();
        }
        json!({
            "jsonrpc":"2.0",
            "id":rpc,
            "method":METHOD_PLUGIN_CALL,
            "params":{
                "id":"pacer-exec-orca",
                "method":method,
                "params":{},
                "deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap()],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":{
                        "protocol":"1.10.0","pacer":"0.2.0",
                        "manifest":{
                            "id":"pacer-exec-orca","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                            "capabilities":[{"name":"orca","scopes":["task-owned"]},{"name":"fs.write","scopes":["/fixture/**"]}],
                            "contributes":{"executor":{"backends":["orca"]}},"reentrant":true
                        },
                        "config":{},"grants":["orca","fs.write"],"features":[]
                    },
                },
                "authority":{
                    "resources":resources,
                    "grants":grants,
                    "ttlMs":10000,
                    "orcaContext":{"home":home.path().display().to_string()}
                },
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
                "coreMethods":core_methods
            }
        })
    };
    let mut sealed = orca_methods.as_array().unwrap().clone();
    sealed.extend([
        json!("capability.fs.write"),
        json!("capability.fs.mkdir"),
        json!("capability.fs.remove"),
    ]);
    let sealed = Value::Array(sealed);
    tokio::task::yield_now().await;

    // Core holds the attempt session: every Orca effect and the issued write go back to it.
    let (reply, forwarded) = dial_with_core(
        &path,
        request(
            60,
            "executor.run",
            json!({"orcaAttempt":attempt}),
            json!(["orca", "fs.write"]),
            sealed.clone(),
        ),
        |frame| json!({"result":{"answered":frame["method"]}}),
    )
    .await;
    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(
        reply["result"]["value"],
        json!({"prepare":{"answered":"capability.orca.prepare"},"write":{"answered":"capability.fs.write"}})
    );
    let methods: Vec<_> = forwarded
        .iter()
        .map(|frame| frame["method"].clone())
        .collect();
    assert_eq!(
        methods,
        [
            json!("capability.orca.prepare"),
            json!("capability.fs.write")
        ]
    );
    assert_eq!(forwarded[0]["params"], json!({"taskId":"t-1","attempt":1}));

    // Live control is answered by Core the same way.
    let (stopped, forwarded) = dial_with_core(
        &path,
        request(
            61,
            "executor.stop",
            json!({"orcaLive":live}),
            json!(["orca", "fs.write"]),
            orca_methods.clone(),
        ),
        |_| json!({"result":{"code":0,"killed":true}}),
    )
    .await;
    assert_eq!(
        stopped["result"]["value"],
        json!({"stop":{"code":0,"killed":true}}),
        "{stopped}"
    );
    assert_eq!(forwarded.len(), 1);

    // Unless Core seals the Orca methods, an Orca grant re-enters the owner and is refused before the child runs.
    for (rpc, orca) in [
        (62, json!({"orcaAttempt":attempt})),
        (63, json!({"orcaLive":live})),
    ] {
        let (refused, forwarded) = dial_with_core(
            &path,
            request(
                rpc,
                "executor.run",
                orca,
                json!(["orca", "fs.write"]),
                json!(["capability.fs.write"]),
            ),
            |_| json!({"result":{}}),
        )
        .await;
        assert!(forwarded.is_empty(), "{forwarded:?}");
        assert_eq!(
            refused["error"]["data"]["code"], "plugin_unavailable",
            "{refused}"
        );
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("re-enter the process owner"),
            "{refused}"
        );
    }

    // A forwarded write or Orca effect still needs the call's grant.
    let (ungranted, forwarded) = dial_with_core(
        &path,
        request(
            64,
            "executor.run",
            json!({"orcaAttempt":attempt}),
            json!(["orca"]),
            sealed.clone(),
        ),
        |_| json!({"result":{}}),
    )
    .await;
    assert_eq!(forwarded.len(), 1, "{forwarded:?}");
    assert_eq!(
        ungranted["result"]["value"]["write"]["data"]["code"], "capability_denied",
        "{ungranted}"
    );

    session
        .owner()
        .lock()
        .await
        .terminate("pacer-exec-orca")
        .await
        .unwrap();
    session.shutdown().await;
}

/// Planner child: `planner.install` asks Core to run a pinned command, read its
/// output and the prior record, then returns what Core answered (or fails after
/// the command when `params.fail`); `planner.uninstall` reads the prior only.
/// `argv[2] == "1"` negotiates `plannerInstallTransactions` in its hello.
const PLANNER_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='',call,out={};const negotiate=process.argv[2]==='1';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));const ask=(id,method,params)=>send({id,method,params});for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['planner'],features:negotiate?['chunkedResults','plannerInstallTransactions']:['chunkedResults']}});else if(m.method==='planner.install'){call=m;out={};ask('run','capability.planner.run',{argv:['fx-cmd','forward'],undo:['fx-cmd','undo'],timeoutMs:1000});}else if(m.method==='planner.uninstall'){call=m;out={};ask('prior','capability.planner.readPriorRange',{handle:'h-1',offset:0,length:2});}else if(m.id==='run'){out.run=m.result??m.error;if(call.params.fail)send({id:call.id,error:{code:-32000,message:'planner child exited',data:{code:'plugin_unavailable'}}});else ask('chunk','capability.process.outputChunk',{handle:'o-1',offset:0,length:4});}else if(m.id==='chunk'){out.chunk=m.result??m.error;ask('prior','capability.planner.readPriorRange',{handle:'h-1',offset:0,length:2});}else if(m.id==='prior'){out.prior=m.result??m.error;send({id:call.id,result:{schema:1,...out}});}}}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_planner_transaction_forwards_commands_to_core_after_negotiation() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("planner.js");
    fs::write(&script, PLANNER_CHILD).unwrap();
    let planner_methods = json!([
        "capability.fs.read",
        "capability.planner.run",
        "capability.process.outputChunk",
        "capability.planner.readPriorRange"
    ]);
    let request = |rpc: u64,
                   id: &str,
                   method: &str,
                   params: Value,
                   core_methods: Value,
                   required: Value| {
        json!({
            "jsonrpc":"2.0","id":rpc,"method":METHOD_PLUGIN_CALL,
            "params":{
                "id":id,"method":method,"params":params,"deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap(), if id == "fx-planner" { "1" } else { "0" }],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":{
                        "protocol":"1.10.0","pacer":"0.2.0",
                        "manifest":{
                            "id":id,"version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                            "capabilities":[{"name":"fs.read","scopes":["/fixture/**"]},{"name":"fs.write","scopes":["/fixture/**"]},{"name":"process.spawn","scopes":["fx-cmd"]}],
                            "contributes":{"planner":{}}
                        },
                        "config":{},"grants":["fs.read","fs.write","process.spawn"],
                        "features":["chunkedResults","plannerInstallTransactions"]
                    },
                },
                "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":["fs.read","fs.write","process.spawn"],"ttlMs":10000},
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
                "coreMethods":core_methods,
                "requireFeatures":required
            }
        })
    };
    let core = |frame: &Value| match frame["method"].as_str() {
        Some("capability.planner.run") => {
            json!({"result":{"code":0,"output":{"stdout":"o-1","stderr":"o-2"}}})
        }
        Some("capability.process.outputChunk") => json!({"result":{"base64":"b2s="}}),
        _ => json!({"result":{"base64":"e30="}}),
    };
    let methods = |forwarded: &[Value]| -> Vec<Value> {
        forwarded
            .iter()
            .map(|frame| frame["method"].clone())
            .collect()
    };
    let required = json!(["plannerInstallTransactions"]);
    tokio::task::yield_now().await;

    // Install: Core runs the pinned command and serves its output and the prior record.
    let (installed, forwarded) = dial_with_core(
        &path,
        request(
            50,
            "fx-planner",
            "planner.install",
            json!({}),
            planner_methods.clone(),
            required.clone(),
        ),
        core,
    )
    .await;
    assert!(installed.get("error").is_none(), "{installed}");
    assert_eq!(
        methods(&forwarded),
        [
            json!("capability.planner.run"),
            json!("capability.process.outputChunk"),
            json!("capability.planner.readPriorRange")
        ]
    );
    assert_eq!(
        forwarded[0]["params"],
        json!({"argv":["fx-cmd","forward"],"undo":["fx-cmd","undo"],"timeoutMs":1000})
    );
    let value = &installed["result"]["value"];
    assert_eq!(value["run"]["code"], 0, "{value}");
    assert_eq!(value["chunk"]["base64"], "b2s=", "{value}");
    assert_eq!(value["prior"]["base64"], "e30=", "{value}");
    assert_eq!(
        installed["result"]["hello"]["features"],
        json!(["chunkedResults", "plannerInstallTransactions"]),
        "{installed}"
    );

    // Uninstall on the readied child reuses the recorded negotiation.
    let (removed, forwarded) = dial_with_core(
        &path,
        request(
            51,
            "fx-planner",
            "planner.uninstall",
            json!({}),
            planner_methods.clone(),
            required.clone(),
        ),
        core,
    )
    .await;
    assert!(removed.get("error").is_none(), "{removed}");
    assert_eq!(
        methods(&forwarded),
        [json!("capability.planner.readPriorRange")]
    );
    assert_eq!(removed["result"]["value"]["prior"]["base64"], "e30=");

    // A child that fails after an admitted command reaches Core with its error,
    // after Core saw the command it must compensate.
    let (failed, forwarded) = dial_with_core(
        &path,
        request(
            52,
            "fx-planner",
            "planner.install",
            json!({"fail":true}),
            planner_methods.clone(),
            required.clone(),
        ),
        core,
    )
    .await;
    assert_eq!(
        failed["error"]["data"]["code"], "plugin_unavailable",
        "{failed}"
    );
    assert_eq!(failed["error"]["message"], "planner child exited");
    assert_eq!(methods(&forwarded), [json!("capability.planner.run")]);

    // Without Core-sealed planner methods the native broker has no planner effect.
    let (unsealed, forwarded) = dial_with_core(
        &path,
        request(
            53,
            "fx-planner",
            "planner.install",
            json!({}),
            Value::Null,
            required.clone(),
        ),
        core,
    )
    .await;
    assert!(forwarded.is_empty(), "{forwarded:?}");
    let value = &unsealed["result"]["value"];
    for refused in ["run", "chunk", "prior"] {
        assert_eq!(value[refused]["code"], -32000, "{value}");
    }

    // A child that did not negotiate planner transactions never receives the method.
    let (refused, forwarded) = dial_with_core(
        &path,
        request(
            54,
            "fx-planner-old",
            "planner.install",
            json!({}),
            planner_methods.clone(),
            required.clone(),
        ),
        core,
    )
    .await;
    assert!(forwarded.is_empty(), "{forwarded:?}");
    assert_eq!(
        refused["error"]["data"]["code"], "capability_denied",
        "{refused}"
    );
    assert_eq!(
        refused["error"]["message"],
        "planner.install requires the negotiated plannerInstallTransactions feature"
    );

    // Core may only require features the owner knows.
    let (invalid, forwarded) = dial_with_core(
        &path,
        request(
            55,
            "fx-planner",
            "planner.install",
            json!({}),
            planner_methods.clone(),
            json!(["madeUp"]),
        ),
        core,
    )
    .await;
    assert!(forwarded.is_empty(), "{forwarded:?}");
    assert_eq!(invalid["error"]["message"], "invalid requireFeatures");

    {
        let mut owner = session.owner().lock().await;
        owner.terminate("fx-planner").await.unwrap();
        owner.terminate("fx-planner-old").await.unwrap();
    }
    session.shutdown().await;
}

/// Planner child that returns a result of `params.size` bytes: below/at the
/// 768 KiB chunk boundary it replies in one frame; above it sends `$/resultChunk`
/// pieces (≤ 256 KiB) to Core, waiting for each `{ bytes }` ack, then a
/// `_chunkedResult` completion, exactly like the SDK. `argv[2] == "1"`
/// negotiates the planner transactions and chunked result features.
const CHUNKED_CHILD: &str = r#"try{const r=Bun.stdin.stream().getReader();let b='',call,payload,off=0;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));function sendChunk(){const part=payload.subarray(off,off+262144);send({id:'chunk',method:'$/resultChunk',params:{request:call.id,offset:off,base64:part.toString('base64')}});}for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['planner'],features:['chunkedResults','plannerInstallTransactions']}});else if(m.method==='planner.install'){call=m;const size=m.params.size??(600*1024);payload=Buffer.from(JSON.stringify({schema:1,pad:'x'.repeat(size)}),'utf8');off=0;if(payload.length>768*1024)sendChunk();else send({id:call.id,result:JSON.parse(payload.toString('utf8'))});}else if(m.id==='chunk'){const staged=m.result?.bytes??0;if(staged>=payload.length)send({id:call.id,result:{_chunkedResult:{bytes:payload.length}}});else{off=staged;sendChunk();}}else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true}});}}}catch(e){try{process.stderr.write(String(e&&e.stack||e));}catch{}}"#;

/// N3: a planner install or uninstall result over 768 KiB must survive the
/// bridge. The child switches to `$/resultChunk` pieces (as the SDK does) and
/// the owner forwards them to Core; a result at or below the limit still comes
/// back in one frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_planner_result_is_forwarded_below_at_and_above_the_chunk_limit() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("chunked.js");
    fs::write(&script, CHUNKED_CHILD).unwrap();
    let core_methods = json!([
        "capability.planner.run",
        "capability.process.outputChunk",
        "capability.planner.readPriorRange",
        "$/resultChunk"
    ]);
    let request = |rpc: u64, size: Value| {
        json!({
            "jsonrpc":"2.0","id":rpc,"method":METHOD_PLUGIN_CALL,
            "params":{
                "id":"fx-chunk","method":"planner.install","params":{"size":size},"deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap(), "1"],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":{
                        "protocol":"1.10.0","pacer":"0.2.0",
                        "manifest":{
                            "id":"fx-chunk","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                            "capabilities":[{"name":"fs.read","scopes":["/fixture/**"]},{"name":"process.spawn","scopes":["fx-cmd"]}],
                            "contributes":{"planner":{}}
                        },
                        "config":{},"grants":["fs.read","process.spawn"],
                        "features":["chunkedResults","plannerInstallTransactions"]
                    },
                },
                "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":["fs.read","process.spawn"],"ttlMs":10000},
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
                "coreMethods":core_methods.clone(),
                "requireFeatures":["plannerInstallTransactions"]
            }
        })
    };
    let core = |frame: &Value| {
        if frame["method"] == "$/resultChunk" {
            let offset = frame["params"]["offset"].as_u64().unwrap_or(0);
            json!({"result": {"bytes": offset + 262144}})
        } else {
            json!({"result": {}})
        }
    };
    tokio::task::yield_now().await;

    // Below the limit: one complete frame, nothing forwarded to Core.
    let (below, forwarded) = dial_with_core(&path, request(61, json!(600 * 1024)), core).await;
    assert!(below.get("error").is_none(), "{below}");
    assert_eq!(below["result"]["value"]["schema"], 1, "{below}");
    assert!(forwarded.is_empty(), "{forwarded:?}");

    // At the limit: the serialised result edges just over 768 KiB, so the child
    // switches to `$/resultChunk` and it must be forwarded and assemble.
    let (at, forwarded) = dial_with_core(&path, request(62, json!(768 * 1024)), core).await;
    assert!(at.get("error").is_none(), "{at}");
    assert!(
        forwarded
            .iter()
            .any(|frame| frame["method"] == "$/resultChunk"),
        "{forwarded:?}"
    );
    assert!(
        at["result"]["value"]["_chunkedResult"]["bytes"]
            .as_u64()
            .is_some(),
        "{at}"
    );
    assert_eq!(
        at["result"]["value"]["_chunkedResult"]["bytes"]
            .as_u64()
            .unwrap(),
        serde_json::to_string(&json!({"schema":1,"pad":"x".repeat(768*1024)}))
            .unwrap()
            .len() as u64,
        "{at}"
    );

    // Above the limit: several chunked pieces, all forwarded, final completion.
    let (above, forwarded) = dial_with_core(&path, request(63, json!(1300 * 1024)), core).await;
    assert!(above.get("error").is_none(), "{above}");
    let chunked_methods: Vec<Value> = forwarded
        .iter()
        .filter(|frame| frame["method"] == "$/resultChunk")
        .map(|frame| frame["method"].clone())
        .collect();
    assert!(!chunked_methods.is_empty(), "{forwarded:?}");
    assert!(
        above["result"]["value"]["_chunkedResult"]["bytes"]
            .as_u64()
            .is_some(),
        "{above}"
    );

    // A refused first chunk is terminal even if the child falls back to a plain
    // result, or waits forever after receiving the error.
    for (index, mode) in ["plain", "wait"].iter().enumerate() {
        let source = CHUNKED_CHILD.replace(
            "else if(m.id==='chunk'){",
            &format!(
                "else if(m.id==='chunk'){{if(m.error){{{}continue;}}",
                if *mode == "plain" {
                    "send({id:call.id,result:{schema:1}});"
                } else {
                    ""
                }
            ),
        );
        fs::write(&script, source).unwrap();
        // Restart so each fixture uses the updated source.
        session
            .owner()
            .lock()
            .await
            .terminate("fx-chunk")
            .await
            .unwrap();
        let (refused, forwarded) = dial_with_core(
            &path,
            request(80 + index as u64, json!(768 * 1024)),
            |_| json!({"error":{"code":-32000,"message":"malformed result chunk","data":{"code":"invalid_input"}}}),
        ).await;
        assert!(
            refused["error"]["data"].get("origin").is_none(),
            "{refused}"
        );
        assert_eq!(forwarded.len(), 1, "{forwarded:?}");
        assert_eq!(
            refused["error"]["data"]["code"], "invalid_input",
            "{refused}"
        );
    }

    // A stale request id or unsolicited token must not fail the active call.
    for stale in [
        "send({id:'stale',method:'$/resultChunk',params:{request:call.id-1,offset:0,base64:'e30='}});",
        "send({id:'stale',method:'$/resultChunk',_meta:{capabilityCall:'stale'},params:{request:call.id,offset:0,base64:'e30='}});",
    ] {
        let source =
            CHUNKED_CHILD.replace("call=m;const size=", &format!("call=m;{stale}const size="));
        fs::write(&script, source).unwrap();
        session
            .owner()
            .lock()
            .await
            .terminate("fx-chunk")
            .await
            .unwrap();
        let (current, forwarded) =
            dial_with_core(&path, request(81, json!(600 * 1024)), core).await;
        assert!(current.get("error").is_none(), "{current}");
        assert!(forwarded.is_empty(), "{forwarded:?}");
    }

    let source = CHUNKED_CHILD.replace(
        "else if(m.id==='chunk'){",
        "else if(m.id==='chunk'){send({id:call.id,result:{schema:1}});continue;",
    );
    fs::write(&script, source).unwrap();
    session
        .owner()
        .lock()
        .await
        .terminate("fx-chunk")
        .await
        .unwrap();
    let (plain, forwarded) = dial_with_core(&path, request(82, json!(768 * 1024)), core).await;
    assert_eq!(forwarded.len(), 1, "{forwarded:?}");
    assert_eq!(plain["error"]["data"]["code"], "plugin_refused", "{plain}");
    assert!(plain["error"]["data"].get("origin").is_none(), "{plain}");

    session
        .owner()
        .lock()
        .await
        .terminate("fx-chunk")
        .await
        .unwrap();
    session.shutdown().await;
}

/// N4: a child that is `ready` but has no recorded hello summary (the server
/// path marks readiness without one) must fail closed when a call requires a
/// negotiated feature — the bridge must not let such a lane silently pass the
/// gate — and otherwise report `hello: null`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_call_ready_without_a_summary_is_fail_closed_under_require_features() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("simple.js");
    fs::write(
        &script,
        r#"const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic'],features:['chunkedResults']}});else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true}});}}"#,
    )
    .unwrap();
    let request = |rpc: u64, required: Value| {
        json!({
            "jsonrpc":"2.0","id":rpc,"method":METHOD_PLUGIN_CALL,
            "params":{
                "id":"fx-ready","method":"diagnostic.ping","params":{},"deadlineMs":10000,
                "spawn":{
                    "argv":["bun", script.to_str().unwrap()],
                    "cwd":plugin_dir.path().display().to_string(),
                    "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                    "hello":{
                        "protocol":"1.10.0","pacer":"0.2.0",
                        "manifest":{
                            "id":"fx-ready","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                            "contributes":{"diagnostic":{}}
                        },
                        "config":{},"grants":[],"features":["chunkedResults"]
                    },
                },
                "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":[],"ttlMs":10000},
                "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
                "coreMethods":Value::Null,
                "requireFeatures":required
            }
        })
    };
    tokio::task::yield_now().await;

    // First call readies the child and records a summary (with `chunkedResults`).
    let first = dial_json(&path, request(70, Value::Null)).await;
    assert!(first.get("error").is_none(), "{first}");
    assert_eq!(
        first["result"]["hello"]["features"],
        json!(["chunkedResults"]),
        "{first}"
    );

    // Forget the recorded summary: the lane stays `ready` but has no hello.
    session.owner().lock().await.mark_ready("fx-ready");

    // A call that requires `chunkedResults` is now fail-closed: with no recorded
    // negotiation it cannot prove the feature, even though the child would.
    let refused = dial_json(&path, request(71, json!(["chunkedResults"]))).await;
    assert_eq!(
        refused["error"]["data"]["code"], "capability_denied",
        "{refused}"
    );
    assert_eq!(
        refused["error"]["message"],
        "diagnostic.ping requires the negotiated chunkedResults feature",
        "{refused}"
    );

    // Without a required feature the call proceeds, reporting `hello: null`.
    let second = dial_json(&path, request(72, Value::Null)).await;
    assert!(second.get("error").is_none(), "{second}");
    assert_eq!(second["result"]["value"]["ok"], true, "{second}");
    assert_eq!(second["result"]["hello"], Value::Null, "{second}");

    session
        .owner()
        .lock()
        .await
        .terminate("fx-ready")
        .await
        .unwrap();
    session.shutdown().await;
}

/// Hello-phase child: before answering `plugin.hello`, it asks for a Core-sealed
/// `capability.planner.run` and `capability.fs.read` the same way an admitted
/// planner command or Core-issued log read would. It then negotiates
/// `plannerInstallTransactions` and answers `planner.install` normally, carrying
/// the hello-phase attempts' outcomes in the final value so the test can see them.
const HELLO_FORWARD_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='',hello,earlyRun,earlyRead,call,out={};const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));const ask=(id,method,params)=>send({id,method,params});for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello'){hello=m;ask('earlyRun','capability.planner.run',{argv:['fx-cmd','forward'],undo:['fx-cmd','undo'],timeoutMs:1000});ask('earlyRead','capability.fs.read',{path:'/fixture/log'});}else if(m.id==='earlyRun'){earlyRun=m.result??m.error;if(earlyRead)send({id:hello.id,result:{protocol:'1.10.0',id:hello.params.manifest.id,version:'1.0.0',contributes:['planner'],features:['chunkedResults','plannerInstallTransactions']}});}else if(m.id==='earlyRead'){earlyRead=m.result??m.error;if(earlyRun)send({id:hello.id,result:{protocol:'1.10.0',id:hello.params.manifest.id,version:'1.0.0',contributes:['planner'],features:['chunkedResults','plannerInstallTransactions']}});}else if(m.method==='planner.install'){call=m;out={};ask('run','capability.planner.run',{argv:['fx-cmd','forward'],undo:['fx-cmd','undo'],timeoutMs:1000});}else if(m.id==='run'){out.run=m.result??m.error;send({id:call.id,result:{schema:1,earlyRun,earlyRead,...out}});}}}"#;

/// N1: a child that tries to use Core forwarding while it answers `plugin.hello`, before
/// Core knows whether the feature gate will pass, must get nothing run. Binding Core
/// forwarding only after the hello and the `requireFeatures` gate (`bridge_call.rs`)
/// closes that window: the hello-phase request is answered locally (refused) and never
/// reaches Core, while the same method after the gate passes forwards normally.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_call_never_forwards_during_hello_before_the_feature_gate() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("hello-forward.js");
    fs::write(&script, HELLO_FORWARD_CHILD).unwrap();
    let planner_methods = json!([
        "capability.fs.read",
        "capability.planner.run",
        "capability.process.outputChunk",
        "capability.planner.readPriorRange"
    ]);
    let request = json!({
        "jsonrpc":"2.0","id":60,"method":METHOD_PLUGIN_CALL,
        "params":{
            "id":"fx-hello-forward","method":"planner.install","params":{},"deadlineMs":10000,
            "spawn":{
                "argv":["bun", script.to_str().unwrap()],
                "cwd":plugin_dir.path().display().to_string(),
                "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                "hello":{
                    "protocol":"1.10.0","pacer":"0.2.0",
                    "manifest":{
                        "id":"fx-hello-forward","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                        "capabilities":[{"name":"fs.read","scopes":["/fixture/**"]},{"name":"fs.write","scopes":["/fixture/**"]},{"name":"process.spawn","scopes":["fx-cmd"]}],
                        "contributes":{"planner":{}}
                    },
                    "config":{},"grants":["fs.read","fs.write","process.spawn"],
                    "features":["chunkedResults","plannerInstallTransactions"]
                },
            },
            "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":["fs.read","fs.write","process.spawn"],"ttlMs":10000},
            "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
            "coreMethods":planner_methods,
            "requireFeatures":["plannerInstallTransactions"]
        }
    });
    let core = |frame: &Value| match frame["method"].as_str() {
        Some("capability.planner.run") => {
            json!({"result":{"code":0,"output":{"stdout":"o-1","stderr":"o-2"}}})
        }
        Some("capability.process.outputChunk") => json!({"result":{"base64":"b2s="}}),
        _ => json!({"result":{"base64":"e30="}}),
    };
    tokio::task::yield_now().await;

    let (installed, forwarded) = dial_with_core(&path, request, core).await;
    assert!(installed.get("error").is_none(), "{installed}");
    // Only the post-gate `planner.install` forward reached Core; the hello-phase
    // attempts never appeared on the wire.
    assert_eq!(
        forwarded
            .iter()
            .map(|frame| frame["method"].clone())
            .collect::<Vec<_>>(),
        [json!("capability.planner.run")]
    );
    let value = &installed["result"]["value"];
    // The hello-phase attempts were refused locally (`capability_denied`, R1), not
    // run by Core or answered by the native broker, so neither a pinned command
    // nor a log read was served during the hello.
    for attempt in ["earlyRun", "earlyRead"] {
        assert_eq!(value[attempt]["code"], -32000, "{value}");
        assert_eq!(
            value[attempt]["data"]["code"], "capability_denied",
            "{value}"
        );
    }
    assert_eq!(value["run"]["code"], 0, "{value}");

    session
        .owner()
        .lock()
        .await
        .terminate("fx-hello-forward")
        .await
        .unwrap();
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

/// Child that negotiates `chunkedResults` but whose call did not seal
/// `$/resultChunk` (Core seals it only for usage.read and planner effects),
/// then sends a chunk and records the answer it got.
const UNSEALED_CHUNK_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='',call;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['diagnostic'],features:['chunkedResults']}});else if(m.method==='diagnostic.ping'){call=m;send({id:'ck',method:'$/resultChunk',params:{request:m.id,offset:0,base64:'e30='}});}else if(m.id==='ck')send({id:call.id,result:{ok:true,chunkErr:m.error??null}});}}"#;

/// F1 case 1: a diagnostic call with Core sealed (some fs-read methods) but
/// `$/resultChunk` unsealed must refuse a chunk locally instead of relaying it,
/// so a read-only call keeps flag-off's plain single-frame limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_call_refuses_result_chunk_when_core_did_not_seal_it() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("unsealed-chunk.js");
    fs::write(&script, UNSEALED_CHUNK_CHILD).unwrap();
    let request = json!({
        "jsonrpc":"2.0","id":1,"method":METHOD_PLUGIN_CALL,
        "params":{
            "id":"fx-unsealed","method":"diagnostic.ping","params":{},"deadlineMs":10000,
            "spawn":{
                "argv":["bun", script.to_str().unwrap()],
                "cwd":plugin_dir.path().display().to_string(),
                "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                "hello":{
                    "protocol":"1.10.0","pacer":"0.2.0",
                    "manifest":{
                        "id":"fx-unsealed","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                        "capabilities":[{"name":"fs.read","scopes":["/fixture/**"]}],
                        "contributes":{"diagnostic":{}}
                    },
                    "config":{},"grants":["fs.read"],"features":[]
                },
            },
            "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":["fs.read"],"ttlMs":10000},
            "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
            "coreMethods":["capability.fs.read"]
        }
    });
    tokio::task::yield_now().await;

    let (reply, forwarded) = dial_with_core(&path, request, |_| json!({"result":{}})).await;
    assert!(reply.get("error").is_some(), "{reply}");
    assert!(reply["error"]["data"].get("origin").is_none(), "{reply}");
    assert!(
        !forwarded
            .iter()
            .any(|frame| frame["method"] == "$/resultChunk"),
        "a chunk on an unsealed call must not be relayed to Core: {forwarded:?}"
    );
    assert_eq!(
        reply["error"]["data"]["code"], "capability_denied",
        "{reply}"
    );

    session
        .owner()
        .lock()
        .await
        .terminate("fx-unsealed")
        .await
        .unwrap();
    session.shutdown().await;
}

/// Child that negotiates `plannerInstallTransactions` but **not**
/// `chunkedResults`, then sends a chunk on `planner.install` and records the
/// answer it got.
const UNNEGOTIATED_CHUNK_CHILD: &str = r#"const r=Bun.stdin.stream().getReader();let b='',call;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:'1.10.0',id:m.params.manifest.id,version:'1.0.0',contributes:['planner'],features:['plannerInstallTransactions']}});else if(m.method==='planner.install'){call=m;send({id:'ck',method:'$/resultChunk',params:{request:m.id,offset:0,base64:'e30='}});}else if(m.id==='ck')send({id:call.id,result:{schema:1,chunkErr:m.error??null}});}}"#;

/// F1 case 2: Core sealed `$/resultChunk` for this planner effect, but the
/// child never negotiated `chunkedResults`. The owner must refuse the relay so
/// the child cannot chunk without having negotiated the feature.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_call_refuses_result_chunk_when_chunked_results_not_negotiated() {
    let home = temp_home();
    let (session, _) = NativeHostSession::start(home.path()).unwrap();
    let path = session.socket_path().to_path_buf();
    let plugin_dir = temp_home();
    let script = plugin_dir.path().join("unnegotiated-chunk.js");
    fs::write(&script, UNNEGOTIATED_CHUNK_CHILD).unwrap();
    let request = json!({
        "jsonrpc":"2.0","id":2,"method":METHOD_PLUGIN_CALL,
        "params":{
            "id":"fx-unneg","method":"planner.install","params":{},"deadlineMs":10000,
            "spawn":{
                "argv":["bun", script.to_str().unwrap()],
                "cwd":plugin_dir.path().display().to_string(),
                "env":env::vars().collect::<std::collections::HashMap<_, _>>(),
                "hello":{
                    "protocol":"1.10.0","pacer":"0.2.0",
                    "manifest":{
                        "id":"fx-unneg","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                        "capabilities":[{"name":"fs.read","scopes":["/fixture/**"]},{"name":"process.spawn","scopes":["fx-cmd"]}],
                        "contributes":{"planner":{}}
                    },
                    "config":{},"grants":["fs.read","process.spawn"],
                    "features":["chunkedResults","plannerInstallTransactions"]
                },
            },
            "authority":{"resources":{"reads":[],"writes":[],"hosts":[],"commands":[]},"grants":["fs.read","process.spawn"],"ttlMs":10000},
            "scopeRoots":{"home":home.path().display().to_string(),"pacerHome":home.path().display().to_string(),"accountHome":null},
            "coreMethods":[
                "capability.planner.run",
                "capability.process.outputChunk",
                "capability.planner.readPriorRange",
                "$/resultChunk"
            ],
            "requireFeatures":["plannerInstallTransactions"]
        }
    });
    tokio::task::yield_now().await;

    let (reply, forwarded) = dial_with_core(&path, request, |_| json!({"result":{}})).await;
    assert!(reply.get("error").is_some(), "{reply}");
    assert!(reply["error"]["data"].get("origin").is_none(), "{reply}");
    assert!(
        !forwarded
            .iter()
            .any(|frame| frame["method"] == "$/resultChunk"),
        "a chunk from a child that did not negotiate chunkedResults must not be relayed: {forwarded:?}"
    );
    assert_eq!(
        reply["error"]["data"]["code"], "capability_denied",
        "{reply}"
    );

    session
        .owner()
        .lock()
        .await
        .terminate("fx-unneg")
        .await
        .unwrap();
    session.shutdown().await;
}
