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

// The bridge narrows the process-wide umask while binding; reset the mode a parallel bind may have stripped.
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
