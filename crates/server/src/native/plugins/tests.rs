#![allow(clippy::unwrap_used)]
//! A door with a local owner relays its own plugin calls through Core, as an
//! attached stdio connection does: Core seals the call to the owner with the
//! method's deadline and answers its Core-run capabilities; the door starts,
//! hellos and authorizes nothing itself.

use super::*;
use pacer_plugin_runtime::ProcessOwner;

/// Core's side of the private channel: records each request and answers it
/// with `reply` (an envelope without `entries`).
struct FakeCore {
    reply: Value,
    requests: Mutex<Vec<Value>>,
}

impl FakeCore {
    fn new(reply: Value) -> Arc<Self> {
        Arc::new(Self {
            reply,
            requests: Mutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl CoreIpc for FakeCore {
    fn exchange(&self, body: String) -> Exchange<'_> {
        Box::pin(async move {
            self.requests
                .lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap());
            let mut reply = self.reply.clone();
            reply["entries"] = json!([]);
            Ok(serde_json::to_vec(&reply).unwrap())
        })
    }
}

fn door(core: &Arc<FakeCore>, rpc: ProcessRpc) -> Owner {
    Owner {
        ipc: core.clone(),
        entries: vec![],
        resets: HashSet::new(),
        logs: vec![],
        rpc,
    }
}

fn local() -> (SharedOwner, ProcessRpc) {
    let owner: SharedOwner = Arc::new(tokio::sync::Mutex::new(ProcessOwner::native_for_tests()));
    (owner.clone(), ProcessRpc::Local(owner))
}

#[tokio::test]
async fn a_local_door_relays_each_plugin_call_through_core() {
    let core = FakeCore::new(json!({"value": {"document": {"type": "text", "text": "hi"}}}));
    let (owner, rpc) = local();
    let mut door = door(&core, rpc);
    for method in [
        "diagnostic.ping",
        "ui.render",
        "ui.action",
        "ui.settings.validate",
    ] {
        let value = door
            .call_native("fx", method, json!({"surface": "status"}))
            .await
            .unwrap();
        assert_eq!(value, json!({"document": {"type": "text", "text": "hi"}}));
    }
    // One `relay` per call and nothing else: no spawn spec, authority, `ready` or log.
    let sent = core.requests();
    assert_eq!(
        sent,
        [
            "diagnostic.ping",
            "ui.render",
            "ui.action",
            "ui.settings.validate"
        ]
        .map(
            |method| json!({"kind": "relay", "id": "fx", "method": method,
            "params": {"surface": "status"}})
        )
    );
    // Core's sealed call starts the child on the owner; the door starts none.
    assert!(owner.lock().await.find_plugin("fx").is_none());
}

#[tokio::test]
async fn a_relayed_calls_error_keeps_cores_code_message_and_hint() {
    let core = FakeCore::new(json!({"error": {
        "code": "plugin_unavailable",
        "message": "plugin fx is failing",
        "hint": "Enable the plugin through the pacer service.",
    }}));
    let (_owner, rpc) = local();
    let refused = door(&core, rpc)
        .call_native("fx", "diagnostic.ping", json!({}))
        .await
        .unwrap_err();
    assert!(
        matches!(refused.code, Code::PluginUnavailable),
        "{refused:?}"
    );
    assert_eq!(refused.message, "plugin fx is failing");
    assert_eq!(
        refused.hint.as_deref(),
        Some("Enable the plugin through the pacer service.")
    );
    assert_eq!(
        core.requests(),
        [json!({"kind": "relay", "id": "fx", "method": "diagnostic.ping", "params": {}})]
    );
}

#[tokio::test]
async fn the_owners_observation_reads_go_to_the_doors_core() {
    let core = FakeCore::new(json!({"value": {"tasks": [{"id": "t1"}]}}));
    let (sink, requests) = tokio::sync::mpsc::unbounded_channel();
    let ipc: Arc<dyn CoreIpc> = core.clone();
    tokio::spawn(deliver_door_requests(requests, move || {
        let ipc = ipc.clone();
        async move { Some((ipc, String::new())) }
    }));
    let body = json!({"kind": "observation_read", "id": "fx", "generation": "a".repeat(64),
        "method": "capability.tasks.list", "params": {}});
    let (reply, answered) = tokio::sync::oneshot::channel();
    sink.send(DoorRequest {
        body: body.clone(),
        reply,
    })
    .unwrap();
    assert_eq!(
        answered.await.unwrap(),
        Ok(json!({"tasks": [{"id": "t1"}]}))
    );
    assert_eq!(core.requests(), [body]);

    // Without a Core link the owner is refused, never answered locally.
    let (sink, requests) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(deliver_door_requests(requests, || async { None }));
    let (reply, answered) = tokio::sync::oneshot::channel();
    sink.send(DoorRequest {
        body: json!({}),
        reply,
    })
    .unwrap();
    assert_eq!(
        answered.await.unwrap(),
        Err(DoorRefusal {
            code: "unavailable".into(),
            message: "plugin process owner is unavailable".into(),
        })
    );
}

#[tokio::test]
async fn the_native_host_off_door_still_sends_cores_private_call() {
    let core = FakeCore::new(json!({"value": null}));
    door(&core, ProcessRpc::Core)
        .call_native("fx", "diagnostic.ping", json!({}))
        .await
        .unwrap();
    assert_eq!(
        core.requests(),
        [json!({"kind": "call", "id": "fx", "method": "diagnostic.ping", "params": {}})]
    );
}
