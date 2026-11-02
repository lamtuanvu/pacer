#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect, ReadResource,
    parse_manifest,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
#[test]
fn call_snapshots_resources_and_grants_and_never_renews_its_deadline() {
    let mut resources = CallResources {
        reads: vec![ReadResource {
            path: "/account-a".into(),
            kind: "codex-logs".into(),
        }],
        ..Default::default()
    };
    let mut grants = vec!["fs.read".into()];
    let mut a = CallAuthority::new(
        resources.clone(),
        grants.clone(),
        Instant::now() + Duration::from_secs(10),
    );
    resources.reads[0].path = "/account-b".into();
    grants.push("process.spawn".into());
    assert!(a.read_directory("/account-a").is_ok());
    assert!(a.read_directory("/account-b").is_err());
    assert!(a.granted("process.spawn").is_err());
    assert!(a.granted("fs.read").is_ok());
    a.revoke();
    assert!(a.active().is_err());
    let b = CallAuthority::new(resources, grants, Instant::now() + Duration::from_secs(10));
    assert!(b.active().is_ok());
    let expired = CallAuthority::new(
        CallResources::default(),
        Vec::<String>::new(),
        Instant::now() - Duration::from_millis(1),
    );
    assert!(expired.active().is_err());
    assert!(expired.active().is_err());
}
struct Cleanup {
    notify: Arc<tokio::sync::Notify>,
    entered: Arc<tokio::sync::Notify>,
    calls: Arc<AtomicUsize>,
}
impl CapabilityEffect for Cleanup {
    async fn call(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
        Ok(json!({}))
    }
    async fn retire(&mut self) -> Result<(), BrokerError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.notify.notified().await;
        Err(BrokerError::Effect("fixture cleanup uncertainty".into()))
    }
}
#[tokio::test]
async fn owned_revocation_waits_cleanup_and_repeated_revoke_preserves_the_same_failure() {
    let manifest=parse_manifest(json!({"id":"fixture","version":"1.0.0","publisher":"fixture","host":">=1.10.0","capabilities":[]})).unwrap();
    let mut broker = CapabilityBroker::new(
        manifest,
        CallAuthority::new(
            CallResources::default(),
            Vec::<String>::new(),
            Instant::now() + Duration::from_secs(10),
        ),
        vec![],
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    let mut effect = Cleanup {
        calls: calls.clone(),
        notify: notify.clone(),
        entered: entered.clone(),
    };
    {
        let revoked = broker.revoke_owned(&mut effect);
        tokio::pin!(revoked);
        tokio::select! {result=&mut revoked=>panic!("returned before cleanup: {result:?}"),_=entered.notified()=>{}}
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut revoked)
                .await
                .is_err()
        );
        notify.notify_one();
        assert!(revoked.await.is_err());
    }
    assert!(broker.authority().active().is_err());
    assert!(broker.revoke_owned(&mut effect).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn issued_log_root_reads_only_rollouts_and_root_stat_is_metadata_only() {
    let home = std::env::temp_dir().join(format!("pacer-root-broker-{}", uuid::Uuid::new_v4()));
    let logs = home.join("logs");
    std::fs::create_dir_all(logs.join("nested")).unwrap();
    let file = logs.join("nested/rollout-owned.jsonl");
    std::fs::write(&file, "aλz").unwrap();
    std::fs::write(logs.join("auth.json"), "private").unwrap();
    let resource = ReadResource {
        path: logs.to_string_lossy().into_owned(),
        kind: "codex-logs".into(),
    };
    let manifest=parse_manifest(json!({"id":"fixture","version":"1.0.0","publisher":"fixture","host":">=1.10.0","capabilities":[{"name":"fs.read","scopes":[format!("{}/**",logs.display())]}]})).unwrap();
    let mut broker = CapabilityBroker::new(
        manifest,
        CallAuthority::new(
            CallResources {
                reads: vec![resource.clone()],
                ..Default::default()
            },
            ["fs.read".into()],
            Instant::now() + Duration::from_secs(10),
        ),
        vec![],
    )
    .with_native_read(std::slice::from_ref(&resource))
    .unwrap();
    struct Never;
    impl CapabilityEffect for Never {
        async fn call(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
            panic!("native root read reached an external effect")
        }
    }
    let mut never = Never;
    let root_stat = broker
        .handle(
            "capability.fs.stat",
            json!({"path":format!("{}///",logs.display())}),
            &mut never,
        )
        .await
        .unwrap();
    assert!(root_stat["info"]["inode"].is_number());
    assert!(root_stat.get("text").is_none());
    assert!(
        broker
            .handle("capability.fs.read", json!({"path":logs}), &mut never)
            .await
            .is_err()
    );
    assert_eq!(
        broker
            .handle("capability.fs.read", json!({"path":file}), &mut never)
            .await
            .unwrap()["text"],
        "aλz"
    );
    let stat = broker
        .handle("capability.fs.stat", json!({"path":file}), &mut never)
        .await
        .unwrap();
    assert_eq!(
        broker
            .handle(
                "capability.fs.readRange",
                json!({"path":file,"offset":1,"length":1,"expected":stat["info"]}),
                &mut never
            )
            .await
            .unwrap()["base64"],
        "zg=="
    );
    assert!(
        broker
            .handle(
                "capability.fs.read",
                json!({"path":logs.join("auth.json")}),
                &mut never
            )
            .await
            .is_err()
    );
    std::fs::rename(&logs, home.join("held")).unwrap();
    std::fs::create_dir_all(logs.join("nested")).unwrap();
    std::fs::write(&file, "foreign").unwrap();
    broker = broker
        .with_native_read(std::slice::from_ref(&resource))
        .unwrap();
    assert!(
        broker
            .handle("capability.fs.read", json!({"path":file}), &mut never)
            .await
            .is_err()
    );
    broker.revoke();
    assert!(
        broker
            .handle("capability.fs.read", json!({"path":file}), &mut never)
            .await
            .is_err()
    );
    std::fs::remove_dir_all(home).unwrap();
}
