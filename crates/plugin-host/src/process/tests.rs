#![allow(clippy::unwrap_used)]
use super::*;

fn peer(script: &str) -> SpawnSpec {
    SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), script.into()],
        cwd: std::env::current_dir().unwrap(),
        env: std::env::vars().collect(),
    }
}

#[test]
fn wire_limit_counts_complete_utf8_frame() {
    assert_eq!(
        frame(json!({"jsonrpc":"2.0","id":1,"result":"界"}))
            .unwrap()
            .last(),
        Some(&b'\n')
    );
    assert!(matches!(
        frame(json!({"body":"a".repeat(MAX_LINE_BYTES)})),
        Err(ProcessError::TooLarge)
    ));
    assert!(matches!(parse_frame(b"{bad"), Err(ProcessError::Malformed)));
}

#[tokio::test]
async fn child_parent_pid_and_cancel_frame() {
    let script = r#"const reader=Bun.stdin.stream().getReader();let text='';for(;;){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);while(text.includes('\n')){const cut=text.indexOf('\n');const line=text.slice(0,cut);text=text.slice(cut+1);const m=JSON.parse(line);if(m.method==='probe'){console.log('malformed');console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ppid:process.ppid}}));}if(m.method==='$/cancel')console.log(JSON.stringify({jsonrpc:'2.0',id:99,result:{cancelled:m.params.id}}));}}"#;
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
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
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
    let result = child
        .request("probe", json!({}), Duration::from_millis(100), None)
        .await;
    assert!(matches!(result, Err(ProcessError::Timeout)));
    child.terminate().await.unwrap();
}

#[tokio::test]
async fn deadline_covers_blocked_stdin_write() {
    let script = "await new Promise(resolve => setTimeout(resolve, 10000));";
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
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
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
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
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
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
    let mut child = PluginProcess::spawn(&spec).unwrap();
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
    let mut child = PluginProcess::spawn(&spec).unwrap();
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
    use crate::{
        BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
        parse_manifest,
    };
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
    let mut child = PluginProcess::spawn(&spec).unwrap();
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
    let mut child = PluginProcess::spawn(&peer(script)).unwrap();
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
#[test]
fn frame_number_spellings_and_envelope_size_match_javascript() {
    assert_eq!(frame(json!({"n":1.0})).unwrap(), b"{\"n\":1}\n");
    assert_eq!(frame(json!({"n":-0.0})).unwrap(), b"{\"n\":0}\n");
}
