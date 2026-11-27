#![allow(clippy::unwrap_used)]
//! A fixture plugin asked to `assistant.reply` sends two door capabilities and
//! one Core capability. `call_with_door_capabilities` must route each to its own
//! channel, and refuse a method the plugin never declared.

use pacer_plugin_runtime::{
    CoreRequest, NativeHostSession, door_call::{DOOR_METHODS, call_with_door_capabilities},
};
use serde_json::{Value, json};
use std::{path::Path, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::mpsc;

/// The child answers `plugin.hello`, then on `assistant.reply` asks for both
/// door methods, `capability.identity.sign` (Core) and an undeclared method.
const CHILD: &str = r#"
const r=Bun.stdin.stream().getReader();let b='';
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));
const replies={};let remaining=4;let turn=null;
for(;;){
  const {value,done}=await r.read(); if(done) break;
  b+=new TextDecoder().decode(value);
  while(b.includes('\n')){
    const i=b.indexOf('\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
    if(m.method==='plugin.hello') send({id:m.id,result:{protocol:'1.10.0',id:'fx-door',version:'1.0.0',contributes:['diagnostic'],features:[]}});
    else if(m.method==='assistant.reply'){
      turn=m.id;
      send({id:7,method:'capability.assistant.tool',params:{name:'snapshot'}});
      send({id:8,method:'capability.secrets.resolve',params:{ref:'endpoint:ep'}});
      send({id:9,method:'capability.identity.sign',params:{purpose:'test',data:'abc'}});
      send({id:10,method:'capability.identity.encrypt',params:{}});
    } else if([7,8,9,10].includes(m.id)){
      replies[m.id]=m; remaining--;
      if(remaining===0) send({id:turn,result:{tool:replies[7],secret:replies[8],sign:replies[9],bad:replies[10]}});
    }
  }
}
"#;

fn sealed(home: &Path, script: &str) -> Value {
    let mut spawn = json!({
        "argv": ["bun", "-e", script],
        "cwd": home.display().to_string(),
        "env": {"PATH": std::env::var("PATH").unwrap_or_default()},
    });
    spawn["hello"] = json!({
        "protocol": "1.10.0", "pacer": "0.2.0",
        "manifest": {
            "id": "fx-door", "version": "1.0.0", "publisher": "fixture", "host": ">=1.11.0",
            "capabilities": [
                {"name": "assistant.tool"}, {"name": "secrets.resolve"}, {"name": "identity.sign"}
            ],
            "contributes": {"assistant": {"reply": true}}
        },
        "config": {},
        "grants": ["assistant.tool", "secrets.resolve", "identity.sign"],
        "features": []
    });
    json!({
        "spawn": spawn,
        "scopeRoots": {"home": home.display().to_string(), "pacerHome": home.display().to_string(), "accountHome": null},
        "coreMethods": ["capability.assistant.tool", "capability.secrets.resolve", "capability.identity.sign"],
        "authority": {
            "owning": true,
            "resources": {"reads": [], "writes": [], "commands": [], "hosts": []},
            "grants": ["assistant.tool", "secrets.resolve", "identity.sign"],
            "ttlMs": 10_000
        }
    })
}

fn drain(label: &'static str, seen: Arc<Mutex<Vec<String>>>) -> (mpsc::Sender<CoreRequest>, tokio::task::JoinHandle<()>) {
    let (send, mut receive) = mpsc::channel::<CoreRequest>(8);
    let task = tokio::spawn(async move {
        while let Some((method, _params, reply)) = receive.recv().await {
            seen.lock().unwrap().push(method.clone());
            let _ = reply.send(Ok(json!({"from": label, "method": method})));
        }
    });
    (send, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn door_methods_go_to_the_door_and_core_methods_go_to_core() {
    let home = tempfile::Builder::new().prefix("pdr-").tempdir_in(std::env::temp_dir()).unwrap();
    let (session, _core_env) = NativeHostSession::start(home.path()).unwrap();
    let owner = session.owner().clone();

    let door_seen = Arc::new(Mutex::new(Vec::new()));
    let core_seen = Arc::new(Mutex::new(Vec::new()));
    let (door, door_task) = drain("door", door_seen.clone());
    let (core, core_task) = drain("core", core_seen.clone());

    let sealed_data = sealed(home.path(), CHILD);
    let authority = sealed_data["authority"].clone();
    // The sealed spawn/roots travel in the call params for this fixture; the
    // method params themselves stay empty.
    let call_params = json!({
        "spawn": sealed_data["spawn"],
        "scopeRoots": sealed_data["scopeRoots"],
        "coreMethods": sealed_data["coreMethods"],
    });

    let result = call_with_door_capabilities(
        &owner, "fx-door", "assistant.reply", call_params, authority,
        &DOOR_METHODS, door, core, Duration::from_secs(15), None,
    ).await.unwrap();

    assert_eq!(result["tool"]["result"]["from"], json!("door"), "{result}");
    assert_eq!(result["tool"]["result"]["method"], json!("capability.assistant.tool"));
    assert_eq!(result["secret"]["result"]["from"], json!("door"), "{result}");
    assert_eq!(result["secret"]["result"]["method"], json!("capability.secrets.resolve"));
    assert_eq!(result["sign"]["result"]["from"], json!("core"), "{result}");
    assert_eq!(result["sign"]["result"]["method"], json!("capability.identity.sign"));
    let bad = result["bad"]["error"]["message"].as_str().unwrap_or_default();
    assert!(bad.contains("unknown host method"), "undeclared method must be refused: {bad}");

    let door_seen = door_seen.lock().unwrap().clone();
    let core_seen = core_seen.lock().unwrap().clone();
    assert_eq!(door_seen, vec!["capability.assistant.tool", "capability.secrets.resolve"]);
    assert_eq!(core_seen, vec!["capability.identity.sign"]);
    door_task.abort();
    core_task.abort();
    session.shutdown().await;
}
