#![allow(clippy::unwrap_used)]
use super::*;

fn peer(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: std::env::current_dir().unwrap(),
        env: std::env::vars().collect(),
    }
}

#[tokio::test]
async fn child_parent_pid_and_cancel_frame() {
    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe'){console.log('malformed');console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ppid:process.ppid}}));}if(m.method==='$/cancel')console.log(JSON.stringify({jsonrpc:'2.0',id:99,result:{cancelled:m.params.id}}));}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let pid = child.pid().unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    assert_eq!(result["ppid"], std::process::id());
    assert_ne!(pid, std::process::id());
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn deadline_cancels_without_leaving_a_child() {
    let script = r#"const reader=Bun.stdin.stream().getReader();await reader.read();await new Promise(resolve=>setTimeout(resolve,10000));"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_millis(100), None)
        .await;
    assert!(matches!(result, Err(ProcessError::Timeout)));
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn deadline_covers_blocked_stdin_write() {
    let script = "await new Promise(resolve => setTimeout(resolve, 10000));";
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request(
            "probe",
            json!({"payload":"x".repeat(MAX_LINE_BYTES - 200)}),
            Duration::from_millis(100),
            None,
        )
        .await;
    assert!(matches!(result, Err(ProcessError::Timeout)));
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn plugin_to_host_request_receives_result_and_denial() {
    let script = r#"const reader=Bun.stdin.stream().getReader();let buf='',denied;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await reader.read();if(done)break;buf+=new TextDecoder().decode(value);while(buf.includes('\n')){let i=buf.indexOf('\n'),m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.method==='probe')send({id:7,method:'capability.log',params:{level:'info',message:'fixture'}});else if(m.id===7){if(m.result?.ok!==true)process.exit(2);send({id:8,method:'capability.fs.write',params:{}})}else if(m.id===8){denied=m.error?.data?.code;send({id:9,method:'mystery',params:{}})}else if(m.id===9){send({id:1,result:{denied,unknown:m.error?.code}})}}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request_with_handler(
            "probe",
            json!({}),
            Duration::from_secs(5),
            None,
            |method, _, _| async move {
                if method == "capability.log" {
                    Ok(json!({"ok":true}))
                } else if method.starts_with("capability.") {
                    Err(rpc_error(
                        "capability_denied",
                        format!("capability is not granted: {method}"),
                    ))
                } else {
                    Err(rpc_error(
                        "unknown_op",
                        format!("unknown host method: {method}"),
                    ))
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"denied":"capability_denied","unknown":-32601})
    );
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn default_handler_refuses_ungranted_and_unknown_methods() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='',denied;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe')send({id:7,method:'capability.log',params:{}});else if(m.id===7){denied=m.error;send({id:8,method:'unknown.method',params:{}})}else if(m.id===8)send({id:1,result:{denied,unknown:m.error}})}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    assert_eq!(result["denied"]["code"], -32000);
    assert_eq!(result["denied"]["data"]["code"], "capability_denied");
    assert_eq!(result["unknown"]["code"], -32601);
    assert_eq!(result["unknown"]["data"]["code"], "unknown_op");
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn owner_cancellation_sends_cancel_notification() {
    let receipt = std::env::temp_dir().join(format!("pacer-plugin-cancel-{}", std::process::id()));
    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const m=JSON.parse(text.slice(0,cut));text=text.slice(cut+1);if(m.method==='$/cancel')await Bun.write(process.env.PACER_CANCEL_RECEIPT,String(m.params.id));}}"#;
    let mut spec = peer(script);
    spec.env.insert(
        "PACER_CANCEL_RECEIPT".into(),
        receipt.to_string_lossy().into_owned(),
    );
    let child = PluginProcess::spawn(&spec).unwrap();
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let trigger = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        sender.send(true).unwrap();
    });
    let result = child
        .request("probe", json!({}), Duration::from_secs(5), Some(&receiver))
        .await;
    assert!(matches!(result, Err(ProcessError::Cancelled)));
    trigger.await.unwrap();
    let seen = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(&receipt) {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(seen, "1");
    child.terminate().await.unwrap();
    std::fs::remove_file(receipt).unwrap();
}

#[tokio::test]
async fn conformance_fixture_handshake_and_ping() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture = root.join("conformance/fixtures");
    let dir = root
        .join(".work/fixtures")
        .join(format!("p4a-serial-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("node_modules"), dir.join("node_modules")).ok();
    for (source, destination) in [
        ("serial/main.ts", "main.ts"),
        ("serial/fixture.json", "fixture.json"),
        ("serial/pacer-plugin.json", "pacer-plugin.json"),
        ("plugin.ts", "plugin.ts"),
    ] {
        std::fs::copy(fixture.join(source), dir.join(destination)).unwrap();
    }
    std::fs::write(dir.join("fixture.json"), r#"{"callCapability":"log"}"#).unwrap();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(dir.join("pacer-plugin.json")).unwrap()).unwrap();
    let mut spec = peer("");
    spec.argv = vec!["bun".into(), "main.ts".into()];
    spec.cwd = dir.clone();
    let child = PluginProcess::spawn(&spec).unwrap();
    let hello = child.request("plugin.hello", json!({"protocol":"1.10.0","pacer":"0.2.0","manifest":manifest,"config":{},"grants":[],"features":[]}), Duration::from_secs(5), None).await.unwrap();
    assert_eq!(hello["id"], "fx-serial");
    assert_eq!(hello["protocol"], "1.10.0");
    let ping = child
        .request_with_handler(
            "diagnostic.ping",
            json!({}),
            Duration::from_secs(5),
            None,
            |method, params, _| async move {
                assert_eq!(method, "capability.log");
                assert_eq!(params["message"], "hello from fixture");
                Ok(json!({"ok":true}))
            },
        )
        .await
        .unwrap();
    assert_eq!(ping["ok"], true);
    child.terminate().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn identity_fixture_uses_rust_capability_broker() {
    use pacer_plugin_capabilities::{CapabilityBroker, CapabilityEffect};
    use pacer_plugin_host::{BrokerError, CallAuthority, CallResources, parse_manifest};
    use std::sync::Arc;
    use tokio::sync::Mutex;
    struct Signed;
    impl CapabilityEffect for Signed {
        async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
            Ok(json!({"signature":"c2ln","machineId":"fixture-machine"}))
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = root.join("conformance/fixtures");
    let dir = root
        .join(".work/fixtures")
        .join(format!("p4b-identity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("node_modules"), dir.join("node_modules")).ok();
    for (from, to) in [
        ("identity-sign/main.ts", "main.ts"),
        ("identity-sign/fixture.json", "fixture.json"),
        ("identity-sign/pacer-plugin.json", "pacer-plugin.json"),
        ("plugin.ts", "plugin.ts"),
    ] {
        std::fs::copy(source.join(from), dir.join(to)).unwrap();
    }
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.join("pacer-plugin.json")).unwrap()).unwrap();
    let manifest = parse_manifest(raw.clone()).unwrap();
    let authority = CallAuthority::new(
        CallResources::default(),
        ["identity.sign".into()],
        tokio::time::Instant::now().into_std() + Duration::from_secs(5),
    );
    let broker = Arc::new(Mutex::new(CapabilityBroker::new(
        manifest,
        authority,
        vec![],
    )));
    let mut spec = peer("");
    spec.argv = vec!["bun".into(), "main.ts".into()];
    spec.cwd = dir.clone();
    let child = PluginProcess::spawn(&spec).unwrap();
    child.request("plugin.hello",json!({"protocol":"1.10.0","pacer":"0.2.0","manifest":raw,"config":{},"grants":[],"features":[]}),Duration::from_secs(5),None).await.unwrap();
    let value=child.request_with_handler("diagnostic.ping",json!({}),Duration::from_secs(5),None,move |method,params,_| {
        let broker=broker.clone();async move {
            broker.lock().await.handle(&method,params,&mut Signed).await
                .map_err(|error| json!({"code":-32000,"message":error.to_string(),"data":{"code":"capability_denied"}}))
        }
    }).await.unwrap();
    assert_eq!(value["ok"], true);
    let result: Value =
        serde_json::from_slice(&std::fs::read(dir.join("capability-result.json")).unwrap())
            .unwrap();
    assert_eq!(result["machineId"], "fixture-machine");
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn retained_read_owner_requests_and_events_work_after_parent_call_finishes() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='';for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){let i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='policy.before'){if(m._meta?.capabilityCall!=='issued')process.exit(3);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{verdict:'allow'}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:9,method:'capability.tasks.read',params:{id:'task'},_meta:{readOwner:'retained'}})),10);}else if(m.method==='$/event'){console.log(JSON.stringify({jsonrpc:'2.0',id:10,method:'capability.tasks.read',params:{id:m.params.type},_meta:{readOwner:'retained'}}));}}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request_with_metadata(
            "policy.before",
            json!({}),
            Some(json!({"capabilityCall":"issued"})),
            Duration::from_secs(3),
            None,
            |_, _, _| async { Err(json!({})) },
        )
        .await
        .unwrap();
    assert_eq!(result["verdict"], "allow");
    let mut seen = false;
    child
        .handle_idle_request(Duration::from_secs(3), |method, params, metadata| {
            assert_eq!(method, "capability.tasks.read");
            assert_eq!(params["id"], "task");
            assert_eq!(metadata.unwrap()["readOwner"], "retained");
            seen = true;
            async { Ok(json!({"task":{"id":"task","state":"done"}})) }
        })
        .await
        .unwrap();
    assert!(seen);
    child
        .notify_bounded(
            "$/event",
            json!({"type":"task"}),
            Duration::from_secs(1),
            || Ok(()),
        )
        .await
        .unwrap();
    child
        .handle_idle_request(Duration::from_secs(3), |_, p, _| {
            assert_eq!(p["id"], "task");
            async { Ok(json!({})) }
        })
        .await
        .unwrap();
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn overlapping_calls_get_their_own_capability_requests_by_token() {
    // Both probes are pending before either capability request is sent, and the
    // child asks in reverse order, so each answer proves token routing. An
    // untokened request while both are pending has no owner and is refused.
    let script = r#"const r=Bun.stdin.stream().getReader();let b='';const probes=[];const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let stray;for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe'){probes.push(m);if(probes.length===2){send({id:'stray',method:'capability.log',params:{}});for(const p of [...probes].reverse())send({id:'c'+p.id,method:'capability.log',params:{call:p.params.name},_meta:p._meta});send({id:'late',method:'capability.log',params:{},_meta:{capabilityCall:'gone'}});}}else if(m.id==='stray'||m.id==='late'){stray=stray??{};stray[m.id]=m.error?.data?.code;}else if(typeof m.id==='string'&&m.id.startsWith('c')){const p=probes.find(p=>'c'+p.id===m.id);setTimeout(()=>send({id:p.id,result:{asked:m.result.call,stray}}),20);}}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let call = |name: &'static str| {
        child.request_with_metadata(
            "probe",
            json!({"name": name}),
            Some(json!({"capabilityCall": format!("token-{name}")})),
            Duration::from_secs(5),
            None,
            move |method, params, metadata| async move {
                assert_eq!(method, "capability.log");
                assert_eq!(
                    metadata.unwrap()["capabilityCall"],
                    format!("token-{name}")
                );
                Ok(json!({"call": params["call"].as_str().map(|asked| format!("{asked} via {name}"))}))
            },
        )
    };
    let (first, second) = tokio::join!(call("a"), call("b"));
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first["asked"], "a via a");
    assert_eq!(second["asked"], "b via b");
    let stray = if first["stray"].is_object() {
        &first["stray"]
    } else {
        &second["stray"]
    };
    assert_eq!(stray["stray"], "capability_denied");
    assert_eq!(stray["late"], "capability_denied");
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn a_child_that_exits_mid_call_fails_the_call() {
    let script = r#"const r=Bun.stdin.stream().getReader();await r.read();process.exit(0);"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await;
    assert!(
        matches!(&result, Err(ProcessError::Unavailable(reason)) if reason == "stdout closed"),
        "{result:?}"
    );
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn a_request_flood_is_refused_past_the_call_bound() {
    // 40 requests at once: the handler is slow, so the call's queue fills and
    // the rest are refused at once; the call's own reply still arrives.
    let script = r#"const r=Bun.stdin.stream().getReader();let b='',probe,answered=0,refused=0;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe'){probe=m.id;for(let n=0;n<40;n++)send({id:'f'+n,method:'capability.log',params:{}});}else if(typeof m.id==='string'){if(m.error)refused++;else answered++;if(answered+refused===40)send({id:probe,result:{answered,refused}});}}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request_with_handler(
            "probe",
            json!({}),
            Duration::from_secs(10),
            None,
            |_, _, _| async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(json!({"ok": true}))
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result["answered"].as_u64().unwrap() + result["refused"].as_u64().unwrap(),
        40
    );
    assert!(result["refused"].as_u64().unwrap() > 0, "{result}");
    assert!(result["answered"].as_u64().unwrap() >= 16, "{result}");
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn a_call_that_times_out_leaves_the_child_usable() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='';for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='slow')setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'late'})),300);if(m.method==='probe')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'ok'}));}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    let slow = child.request("slow", json!({}), Duration::from_millis(50), None);
    assert!(matches!(slow.await, Err(ProcessError::Timeout)));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let probe = child
        .request("probe", json!({}), Duration::from_secs(5), None)
        .await
        .unwrap();
    assert_eq!(probe, "ok");
    child.terminate().await.unwrap();
    assert!(matches!(
        child
            .request("probe", json!({}), Duration::from_secs(1), None)
            .await,
        Err(ProcessError::Unavailable(_))
    ));
}

#[tokio::test]
async fn stderr_reaches_the_plugin_log_and_its_reader_stops_with_the_child() {
    let home = tempfile::tempdir().unwrap();
    let log = crate::plugin_log::PluginLog::new(home.path(), "fx-err").unwrap();
    let status = home.path().join("late-status");
    // The descendant inherits stderr, holds the pipe open after the child exits
    // and writes to it after the drain window: the line is not logged, and the
    // write succeeds, as under TypeScript.
    let late = format!("sleep 0.6; echo late >&2; echo $? > '{}'", status.display());
    let script = format!(
        r#"await Bun.write(Bun.stderr,"one\r\ntwo\n\nlast");Bun.spawn(["sh","-c",{late:?}],{{stdio:["ignore","ignore","inherit"]}}).unref();process.exit(0);"#
    );
    let child = PluginProcess::spawn_logged(&peer(&script), Some(log)).unwrap();
    let mut exit = child.exit_watch();
    tokio::time::timeout(Duration::from_secs(5), exit.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap();
    drop(child);
    let until = Instant::now() + Duration::from_secs(5);
    while !status.exists() && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&status).ok().as_deref(),
        Some("0\n"),
        "the descendant's late stderr write failed"
    );
    let text = std::fs::read_to_string(home.path().join("fx-err.log")).unwrap();
    let lines: Vec<_> = text
        .lines()
        .map(|line| line.split_once(' ').unwrap().1)
        .collect();
    assert_eq!(
        lines,
        ["[stderr] one", "[stderr] two", "[stderr] ", "[stderr] last"]
    );
}

/// A request sent while no call is pending waits for the idle handler, even
/// when a call starts first: the next call's session never answers it (D4).
#[tokio::test]
async fn untokened_request_between_calls_never_reaches_the_next_call() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='',idle,probe;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));const done=()=>{if(idle!==undefined&&probe!==undefined)send({id:probe,result:idle});};send({id:5,method:'capability.config.get',params:{}});for(;;){const {value,done:end}=await r.read();if(end)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe'){probe=m.id;done();}else if(m.id===5){idle=m.result??m.error;done();}}}"#;
    let child = Arc::new(PluginProcess::spawn(&peer(script)).unwrap());
    tokio::time::sleep(Duration::from_millis(500)).await;
    let call = tokio::spawn({
        let child = Arc::clone(&child);
        async move {
            child
                .request_with_handler(
                    "probe",
                    json!({}),
                    Duration::from_secs(5),
                    None,
                    |_, _, _| async { Ok(json!({"from":"call"})) },
                )
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    child.serve_idle(|_, _, _| async { Ok(json!({"from":"idle"})) });
    assert_eq!(call.await.unwrap().unwrap(), json!({"from":"idle"}));
    child.terminate().await.unwrap();
}

/// A read-owner request belongs to the plugin's observation generation, not
/// to the call pending when it arrives.
#[tokio::test]
async fn read_owner_request_during_a_call_reaches_the_idle_handler() {
    let script = r#"const r=Bun.stdin.stream().getReader();let b='',probe;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\n')){const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='probe'){probe=m.id;send({id:6,method:'capability.tasks.read',params:{id:'t'},_meta:{readOwner:'pro_fixture'}});}else if(m.id===6)send({id:probe,result:m.result??m.error});}}"#;
    let child = PluginProcess::spawn(&peer(script)).unwrap();
    child.serve_idle(|_, _, metadata| async move { Ok(json!({"from":"idle","meta":metadata})) });
    let result = child
        .request_with_handler(
            "probe",
            json!({}),
            Duration::from_secs(5),
            None,
            |_, _, _| async { Ok(json!({"from":"call"})) },
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"from":"idle","meta":{"readOwner":"pro_fixture"}})
    );
    child.terminate().await.unwrap();
}

/// `$/event` lines are written as `JSON.stringify` writes them.
#[tokio::test]
async fn bounded_notification_is_written_as_javascript_writes_it() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("lines");
    let script = format!(
        r#"const r=Bun.stdin.stream().getReader();const {{appendFileSync}}=require('node:fs');for(;;){{const {{value,done}}=await r.read();if(done)break;appendFileSync({path:?},value);}}"#,
        path = path.to_str().unwrap()
    );
    let child = PluginProcess::spawn(&peer(&script)).unwrap();
    let params: Value = serde_json::from_str(
        r#"{"type":"task","seq":3000000000005,"data":{"usd":1e21,"z":1,"a":0.1}}"#,
    )
    .unwrap();
    child
        .notify_bounded("$/event", params, Duration::from_secs(2), || Ok(()))
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::fs::read(&path).map_or(true, |bytes| !bytes.ends_with(b"\n")) {
        assert!(
            std::time::Instant::now() < deadline,
            "the line never arrived"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"jsonrpc\":\"2.0\",\"method\":\"$/event\",\"params\":{\"type\":\"task\",\"seq\":3000000000005,\"data\":{\"usd\":1e+21,\"z\":1,\"a\":0.1}}}\n"
    );
    child.terminate().await.unwrap();
}
