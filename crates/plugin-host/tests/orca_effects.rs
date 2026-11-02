#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, CapabilityEffect, NativeOrca, OrcaAttemptResource, OrcaSessionOwner,
};
use pacer_store::TaskStore;
use serde_json::{Value, json};
struct Session {
    calls: usize,
}
impl OrcaSessionOwner for Session {
    fn session_id(&self) -> &str {
        "host-only-session"
    }
    fn task_id(&self) -> &str {
        "t-20261102-125719-c5fb"
    }
    fn attempt(&self) -> u64 {
        1
    }
    fn executor(&self) -> &str {
        "fx-executor"
    }
    async fn invoke(&mut self, method: &str, _params: Value) -> Result<Value, BrokerError> {
        self.calls += 1;
        Ok(json!({"method":method}))
    }
}
#[tokio::test]
async fn native_orca_calls_only_the_exact_host_owned_attempt_and_refuses_changed_task() {
    let root = std::env::temp_dir().join(format!("pacer-orca-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let id = "t-20261102-125719-c5fb";
    let mut store = TaskStore::open(&root).unwrap();
    store.insert(&json!({"id":id,"rev":1,"createdAt":1,"state":"running","attempts":[],"brief":{"repo":"/synthetic"}}),1.0).unwrap();
    let grant = OrcaAttemptResource {
        task_id: id.into(),
        attempt: 1,
        provider_id: "pacer-exec-orca".into(),
        executor: "fx-executor".into(),
        session: "host-only-session".into(),
    };
    let mut native =
        NativeOrca::new(&root, "pacer-exec-orca", grant, Session { calls: 0 }).unwrap();
    assert!(
        native
            .call(
                "capability.orca.prepare",
                json!({"taskId":"t-foreign","attempt":1})
            )
            .await
            .is_err()
    );
    for (method, params) in [
        (
            "capability.orca.prepare",
            json!({"taskId":id,"attempt":1,"extra":true}),
        ),
        (
            "capability.orca.abandon",
            json!({"taskId":id,"attempt":1,"reason":""}),
        ),
        (
            "capability.orca.settle",
            json!({"taskId":id,"attempt":1,"settled":"true"}),
        ),
        ("capability.orca.finish", json!({"taskId":id,"attempt":1})),
    ] {
        assert!(
            native.call(method, params).await.is_err(),
            "{method} accepted invalid parameters"
        );
    }
    assert!(
        native
            .call(
                "capability.orca.abandon",
                json!({"taskId":id,"attempt":1,"reason":"😀".repeat(2049)})
            )
            .await
            .is_err()
    );
    assert_eq!(
        native
            .call(
                "capability.orca.abandon",
                json!({"taskId":id,"attempt":1,"reason":"😀".repeat(2048)})
            )
            .await
            .unwrap()["method"],
        "abandon"
    );
    assert_eq!(native.call("capability.orca.finish", json!({"taskId":id,"attempt":1,"code":0,"timedOut":false,"settled":true,"summary":"","keepAlive":false})).await.unwrap()["method"], "finish");
    assert_eq!(
        native
            .call("capability.orca.prepare", json!({"taskId":id,"attempt":1}))
            .await
            .unwrap()["method"],
        "prepare"
    );
    let task = store.read(id).unwrap().unwrap();
    store
        .update(id, task["rev"].as_i64().unwrap(), 2.0, |t| {
            t["attempts"] = json!([{"startedAt":1,"endedAt":2}])
        })
        .unwrap();
    assert!(
        native
            .call("capability.orca.start", json!({"taskId":id,"attempt":1}))
            .await
            .is_err()
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn native_status_filters_inherited_attestations_and_parses_keepalives() {
    use std::{
        collections::HashMap,
        fs,
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };
    let root = std::env::temp_dir().join(format!("pacer-orca-status-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let child = root.join("orca");
    fs::write(&child,"#!/usr/bin/env python3\nimport os,json\nassert 'ORCA_AGENT_SESSION_ID' not in os.environ\nassert 'NAMED_SESSION' not in os.environ\nassert 'ORCA_SESSION_TEST' not in os.environ\nprint(' {\"_keepalive\":1}')\nprint(json.dumps({'ok':True,'result':{'runtime':{'state':'ready','reachable':True}}}))\n").unwrap();
    fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
    let mut status = pacer_plugin_host::NativeOrcaStatus::prepare(
        child.to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("ORCA_AGENT_SESSION_ID".into(), "foreign".into()),
            ("ORCA_AGENT_SESSION_ID_ENV".into(), "NAMED_SESSION".into()),
            ("NAMED_SESSION".into(), "foreign".into()),
            ("ORCA_SESSION_TEST".into(), "foreign".into()),
        ]),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        status
            .call("capability.orca.status", json!({}))
            .await
            .unwrap(),
        json!({"ready":true})
    );
    fs::remove_dir_all(root).unwrap();
}
