#![allow(clippy::unwrap_used)]
//! The door's own plugin calls on a local owner run as one sealed call: Core's
//! spawn spec and call authority, a call-scoped session under Core's
//! owning-call seal, `ready` on Core's
//! state, levelled `capability.log` lines, and admission against a stop.

use super::*;
use pacer_plugin_runtime::{ProcessOwner, SpawnSpec, start_lane};
use std::{
    fs,
    sync::atomic::{AtomicUsize, Ordering::SeqCst},
    time::{Duration, Instant},
};

/// Records each host request's method in `$RECORD`. `diagnostic.ping` modes:
/// `log` sends a `capability.log` warn line, `tasks` lists tasks with the
/// call's `_meta`, `read` reads `path` and then answers after `ms`, `hold`
/// answers after `ms`. Every reply echoes `_meta`.
const PLUGIN: &str = r#"const fs=require('fs');const rec=process.env.RECORD;if(process.env.STUBBORN)process.on('SIGTERM',()=>{});
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));const waits=new Map();let next=1000;
const ask=(method,params,meta)=>new Promise(res=>{const id=next++;waits.set(id,res);send({id,method,params,...(meta?{_meta:meta}:{})});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function handle(m){if(rec)fs.appendFileSync(rec,m.method+'\n');
 if(m.method==='plugin.hello'){await sleep(Number(process.env.HELLO_DELAY||0));return send({id:m.id,result:{ok:true,protocol:'1.10.0',id:'fx',version:'1.0.0',contributes:['diagnostic'],features:['policyObservations']}});}
 const p=m.params||{};const out={ok:true};
 if(p.mode==='log'){const r=await ask('capability.log',{level:'warn',message:'from door'},m._meta);out.logged=r.result?.ok===true;}
 if(p.mode==='tasks'){const r=await ask('capability.tasks.list',{},m._meta);out.tasks=r.result?.tasks??null;out.error=r.error?.message??null;}
 if(p.mode==='read'){const r=await ask('capability.fs.read',{path:p.path},m._meta);out.read=r.result?.text??null;out.error=r.error?.message??null;}
 if(p.mode==='hold'||p.mode==='read')await sleep(p.ms||0);
 out.meta=m._meta??null;send({id:m.id,result:out});}
const r=Bun.stdin.stream().getReader();let b='';
for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);
 for(let i=b.indexOf('\n');i>=0;i=b.indexOf('\n')){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
  if(m.method)handle(m);else if(waits.has(m.id)){const res=waits.get(m.id);waits.delete(m.id);res(m);}}}
"#;

/// Core's side of the private channel: records each request, answers
/// `spawn_spec` with the plugin's current state and `call_authority` with the
/// sealed authority; `ready` makes the plugin ready unless `refuse_ready`
/// still has refusals left.
struct FakeCore {
    spawn: Value,
    authority: Value,
    state: Mutex<(String, Vec<Value>)>,
    refuse_ready: AtomicUsize,
}

impl FakeCore {
    fn requests(&self, kind: &str) -> Vec<Value> {
        let state = self.state.lock().unwrap();
        state
            .1
            .iter()
            .filter(|r| r["kind"] == kind)
            .cloned()
            .collect()
    }
}

impl CoreIpc for FakeCore {
    fn exchange(&self, body: String) -> Exchange<'_> {
        Box::pin(async move {
            let body: Value = serde_json::from_str(&body).unwrap();
            let mut state = self.state.lock().unwrap();
            state.1.push(body.clone());
            let value = match body["kind"].as_str() {
                Some("spawn_spec") => {
                    let mut spawn = self.spawn.clone();
                    spawn["state"] = json!(state.0);
                    spawn
                }
                Some("call_authority") => self.authority.clone(),
                Some("observation_read") => json!({"tasks": [{"id": "t1"}]}),
                Some("ready")
                    if self
                        .refuse_ready
                        .try_update(SeqCst, SeqCst, |left| left.checked_sub(1))
                        .is_ok() =>
                {
                    return Err(pacer_plugin_ops::ipc::Failure::Unavailable);
                }
                Some("ready") => {
                    state.0 = "ready".into();
                    Value::Null
                }
                _ => Value::Null,
            };
            Ok(serde_json::to_vec(&json!({"value": value, "entries": []})).unwrap())
        })
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    core: Arc<FakeCore>,
    owner: SharedOwner,
}

impl Fixture {
    /// `env` adds to the child's environment; `authority` extends the sealed authority.
    fn new(env: &[(&str, &str)], authority: Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("plugin.js");
        fs::write(&script, PLUGIN).unwrap();
        let mut vars = std::env::vars()
            .map(|(key, value)| (key, json!(value)))
            .collect::<serde_json::Map<_, _>>();
        vars.insert(
            "RECORD".into(),
            json!(dir.path().join("record").to_str().unwrap()),
        );
        for (key, value) in env {
            vars.insert((*key).into(), json!(value));
        }
        let grants = json!(["log", "tasks.read", "fs.read"]);
        let readable = dir.path().join("door-only.txt");
        let spawn = json!({
            "argv": ["bun", script.to_str().unwrap()],
            "cwd": dir.path().to_str().unwrap(),
            "env": vars,
            "hello": {
                "protocol": "1.10.0", "pacer": "0.2.0", "config": {}, "grants": grants,
                "features": ["policyObservations"],
                "manifest": {
                    "id": "fx", "version": "1.0.0", "publisher": "fixture", "host": ">=1.10.0",
                    "capabilities": [
                        {"name": "log"},
                        {"name": "tasks.read"},
                        {"name": "fs.read", "scopes": [readable.to_str().unwrap()]},
                    ],
                    "contributes": {"diagnostic": {}},
                },
            },
        });
        // Core seals `owning` for any call it issues resources to.
        let mut sealed = json!({
            "resources": {"reads": [{"path": readable.to_str().unwrap(), "kind": "file"}]},
            "grants": grants,
            "ttlMs": 30_000,
            "owning": true,
        });
        if let (Some(sealed), Some(extra)) = (sealed.as_object_mut(), authority.as_object()) {
            sealed.extend(extra.clone());
        }
        Self {
            dir,
            core: Arc::new(FakeCore {
                spawn,
                authority: sealed,
                state: Mutex::new(("idle".into(), Vec::new())),
                refuse_ready: AtomicUsize::new(0),
            }),
            owner: Arc::new(tokio::sync::Mutex::new(ProcessOwner::native_for_tests())),
        }
    }

    fn door(&self) -> Owner {
        Owner {
            ipc: self.core.clone(),
            entries: vec![],
            resets: HashSet::new(),
            logs: vec![],
            rpc: ProcessRpc::Local(self.owner.clone()),
        }
    }

    fn spec(&self) -> SpawnSpec {
        let spawn = &self.core.spawn;
        SpawnSpec {
            argv: serde_json::from_value(spawn["argv"].clone()).unwrap(),
            cwd: self.dir.path().to_path_buf(),
            env: serde_json::from_value(spawn["env"].clone()).unwrap(),
        }
    }

    /// The methods the child received, in order.
    fn received(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("record"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    async fn ping(&self, params: Value) -> Result<Value, CoreError> {
        self.door()
            .call_native("fx", "diagnostic.ping", params)
            .await
    }

    async fn stop(&self) {
        let _ = self.owner.lock().await.terminate("fx").await;
    }
}

async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn count(items: &[String], method: &str) -> usize {
    items.iter().filter(|item| *item == method).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsealed_call_never_reads_with_a_door_calls_authority() {
    let fx = Fixture::new(&[], json!({}));
    let path = fx.dir.path().join("door-only.txt");
    fs::write(&path, "door-only").unwrap();
    let read = json!({"mode": "read", "path": path.to_str().unwrap(), "ms": 400});
    let call = {
        let door = fx.door();
        let read = read.clone();
        tokio::spawn(async move {
            let mut door = door;
            door.call_native("fx", "diagnostic.ping", read).await
        })
    };
    until("the held call", || {
        fx.received().contains(&"diagnostic.ping".into()) || call.is_finished()
    })
    .await;
    assert!(!call.is_finished(), "{:?}", call.await.unwrap());
    // The unsealed `_host.plugin.call` takes its lane and session this way.
    let (lane, session) = fx.owner.lock().await.lane_for_call("fx").unwrap();
    assert!(
        session.is_none(),
        "the door call's session leaked to the owner"
    );
    let door = call.await.unwrap().unwrap();
    assert_eq!(door["read"], "door-only", "{door}");
    let unsealed = lane
        .call(
            session,
            "diagnostic.ping",
            read,
            Duration::from_secs(10),
            None,
        )
        .await
        .unwrap();
    assert_eq!(unsealed["read"], Value::Null, "{unsealed}");
    assert_eq!(
        unsealed["error"],
        "capability is not granted: capability.fs.read"
    );
    let (_, session) = fx.owner.lock().await.lane_for_call("fx").unwrap();
    assert!(
        session.is_none(),
        "an idle session was installed after the call"
    );
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_door_call_answers_scoped_capabilities_only_inside_an_owning_call() {
    let read_on = |authority: Value| async move {
        let fx = Fixture::new(&[], authority);
        let path = fx.dir.path().join("door-only.txt");
        fs::write(&path, "door-only").unwrap();
        let reply = fx
            .ping(json!({"mode": "read", "path": path.to_str().unwrap()}))
            .await
            .unwrap();
        fx.stop().await;
        reply
    };
    // A ping with nothing issued: Core seals no owning call, as TypeScript's `needsAuthority`.
    let outside = read_on(json!({"resources": {}, "owning": false})).await;
    assert_eq!(outside["read"], Value::Null, "{outside}");
    assert_eq!(
        outside["error"],
        "scoped capability requires an active owning call"
    );
    // A plugin that declares `hosts` gets an owning call with nothing issued.
    let owning = read_on(json!({"resources": {}, "owning": true})).await;
    assert_eq!(owning["read"], Value::Null, "{owning}");
    assert_eq!(
        owning["error"],
        "capability is not granted to the owning call: read path was not issued"
    );
    let issued = read_on(json!({})).await;
    assert_eq!(issued["read"], "door-only", "{issued}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_first_door_calls_send_one_hello_and_one_ready() {
    let fx = Fixture::new(&[("HELLO_DELAY", "300")], json!({}));
    let (first, second) = tokio::join!(fx.ping(json!({})), fx.ping(json!({})));
    first.unwrap();
    second.unwrap();
    assert_eq!(count(&fx.received(), "plugin.hello"), 1);
    assert_eq!(count(&fx.received(), "diagnostic.ping"), 2);
    let ready = fx.core.requests("ready");
    assert_eq!(ready.len(), 1, "{ready:?}");
    assert_eq!(
        ready[0],
        json!({"kind": "ready", "id": "fx", "protocol": "1.10.0", "served": ["diagnostic"]})
    );
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_door_call_reports_a_child_another_core_readied() {
    let fx = Fixture::new(&[], json!({}));
    let far = Instant::now() + Duration::from_secs(10);
    start_lane(&fx.owner, "fx", &fx.spec(), None, far, None)
        .await
        .unwrap();
    // An attached connection's Core helloed this child over the bridge.
    let hello = json!({"protocol": "1.10.0", "served": ["diagnostic"], "features": []});
    fx.owner.lock().await.mark_ready_with("fx", hello);
    fx.ping(json!({})).await.unwrap();
    assert_eq!(count(&fx.received(), "plugin.hello"), 0);
    assert_eq!(fx.core.requests("ready").len(), 1);
    // Core now lists it ready: later calls stay quiet.
    fx.ping(json!({})).await.unwrap();
    assert_eq!(fx.core.requests("ready").len(), 1);
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ready_report_core_refused_is_sent_by_the_next_door_call() {
    let fx = Fixture::new(&[], json!({}));
    fx.core.refuse_ready.store(1, SeqCst);
    fx.ping(json!({})).await.unwrap_err();
    assert_eq!(fx.core.requests("ready").len(), 1);
    fx.ping(json!({})).await.unwrap();
    assert_eq!(count(&fx.received(), "plugin.hello"), 1);
    assert_eq!(fx.core.requests("ready").len(), 2);
    fx.ping(json!({})).await.unwrap();
    assert_eq!(fx.core.requests("ready").len(), 2);
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_scoped_log_line_reaches_core_with_its_level() {
    let fx = Fixture::new(&[], json!({}));
    let reply = fx.ping(json!({"mode": "log"})).await.unwrap();
    assert_eq!(reply["logged"], true);
    assert_eq!(
        fx.core.requests("log"),
        vec![json!({"kind": "log", "id": "fx", "level": "warn", "message": "from door"})]
    );
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sealed_observation_token_reads_tasks_through_the_doors_core() {
    let home = tempfile::tempdir().unwrap();
    let pacer_home = home.path().join(".pacer");
    fs::create_dir_all(&pacer_home).unwrap();
    let token = "obs-call-token-fixture";
    let generation = "a".repeat(64);
    let fx = Fixture::new(
        &[],
        json!({"observation": {
            "callToken": token,
            "bootstrap": true,
            "generation": generation,
            "readContext": {
                "home": home.path().to_str().unwrap(),
                "pacerHome": pacer_home.to_str().unwrap(),
                "now": 1.0,
            },
        }}),
    );
    // Without the door's Core, the owner has nowhere to read tasks from.
    let reply = fx.ping(json!({"mode": "tasks"})).await.unwrap();
    assert_eq!(reply["meta"], json!({"capabilityCall": token}));
    assert_eq!(reply["tasks"], Value::Null, "{reply}");
    assert!(fx.core.requests("observation_read").is_empty());

    let (sink, requests) = tokio::sync::mpsc::unbounded_channel();
    fx.owner.lock().await.set_door_sink(sink);
    let ipc: Arc<dyn CoreIpc> = fx.core.clone();
    tokio::spawn(deliver_door_requests(requests, move || {
        let ipc = ipc.clone();
        async move { Some((ipc, String::new())) }
    }));
    let reply = fx.ping(json!({"mode": "tasks"})).await.unwrap();
    assert_eq!(reply["tasks"], json!([{"id": "t1"}]), "{reply}");
    assert_eq!(
        fx.core.requests("observation_read"),
        vec![
            json!({"kind": "observation_read", "id": "fx", "generation": generation,
            "method": "capability.tasks.list", "params": {}})
        ]
    );
    fx.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_plugin_is_refused_with_the_enable_hint() {
    let fx = Fixture::new(&[], json!({}));
    let crashing = SpawnSpec {
        argv: vec!["bun".into(), "-e".into(), "process.exit(3)".into()],
        ..fx.spec()
    };
    for _ in 0..3 {
        let far = Instant::now() + Duration::from_secs(10);
        let lane = start_lane(&fx.owner, "fx", &crashing, None, far, None)
            .await
            .unwrap();
        lane.wait_settled(Duration::from_secs(5)).await;
    }
    let refused = fx.ping(json!({})).await.unwrap_err();
    assert!(
        matches!(refused.code, Code::PluginUnavailable),
        "{refused:?}"
    );
    assert_eq!(
        refused.hint.as_deref(),
        Some("Enable the plugin through the pacer service.")
    );
    assert!(fx.received().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_door_call_queued_behind_a_stop_never_reaches_the_child() {
    let fx = Fixture::new(&[("STUBBORN", "1")], json!({}));
    fx.ping(json!({})).await.unwrap();
    let lane = fx.owner.lock().await.lane("fx").unwrap();
    let turn = lane.gate().write().await;
    let queued = {
        let door = fx.door();
        tokio::spawn(async move {
            let mut door = door;
            door.call_native("fx", "diagnostic.ping", json!({})).await
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let stopping = {
        let lane = lane.clone();
        tokio::spawn(async move { lane.process().terminate().await })
    };
    until("the stop", || lane.process().is_stopping()).await;
    // The stubborn child outlives SIGTERM for the grace, so a write would be answered.
    assert!(lane.process().is_alive());
    drop(turn);
    let refused = queued.await.unwrap().unwrap_err();
    assert!(
        matches!(refused.code, Code::PluginUnavailable),
        "{refused:?}"
    );
    assert_eq!(refused.message, "the plugin is stopping");
    assert_eq!(count(&fx.received(), "diagnostic.ping"), 1);
    let _ = stopping.await;
}
