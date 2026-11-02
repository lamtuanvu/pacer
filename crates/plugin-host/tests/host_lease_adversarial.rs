#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    AuthorityError, BrokerError, CallAuthority, CallResources, CapabilityEffect, HostLeaseBroker,
    HostLeaseError, HostOperationResource, HostProvider, NativeHosts, ProviderSnapshot,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
fn snapshot() -> ProviderSnapshot {
    ProviderSnapshot {
        alias: "box".into(),
        host_fingerprint: "host-1".into(),
        caller_generation: "caller-1".into(),
        provider_generation: "provider-1".into(),
        provider_process: 1,
    }
}
fn authority() -> CallAuthority {
    CallAuthority::new(
        CallResources::default(),
        ["hosts".into()],
        Instant::now() + Duration::from_secs(10),
    )
}
fn operation() -> HostOperationResource {
    HostOperationResource {
        alias: "box".into(),
        host_fingerprint: "host-1".into(),
        script: "PROBE".into(),
        args: vec![],
        timeout_ms: 1000,
        max_bytes: 65536,
    }
}
#[test]
fn every_snapshot_dimension_retires_the_opaque_handle_before_effect() {
    for key in 0..5 {
        let original = snapshot();
        let mut changed = original.clone();
        match key {
            0 => changed.alias = "other".into(),
            1 => changed.host_fingerprint = "other".into(),
            2 => changed.caller_generation = "other".into(),
            3 => changed.provider_generation = "other".into(),
            _ => changed.provider_process = 2,
        }
        let mut leases = HostLeaseBroker::new([original.clone()]);
        let mut a = authority();
        let handle = leases.open(&a, "box").unwrap();
        assert!(matches!(
            leases.run(&mut a, &handle, &changed, &operation()),
            Err(HostLeaseError::Changed)
        ));
        assert!(matches!(
            leases.run(&mut a, &handle, &original, &operation()),
            Err(HostLeaseError::Retired)
        ));
    }
}
#[test]
fn four_concurrent_leases_sixty_four_issued_and_revocation() {
    let mut leases = HostLeaseBroker::new([snapshot()]);
    let mut a = authority();
    let handles = (0..4)
        .map(|_| leases.open(&a, "box").unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(
        leases.open(&a, "box"),
        Err(HostLeaseError::Capacity)
    ));
    for h in handles {
        leases.close(&h).unwrap();
    }
    for _ in 4..64 {
        let h = leases.open(&a, "box").unwrap();
        leases.close(&h).unwrap();
    }
    assert!(matches!(
        leases.open(&a, "box"),
        Err(HostLeaseError::Capacity)
    ));
    a.revoke();
    assert!(matches!(
        leases.open(&a, "box"),
        Err(HostLeaseError::Authority(AuthorityError::Expired))
    ));
}
struct Provider {
    state: Arc<Mutex<ProviderSnapshot>>,
    closed: Arc<AtomicUsize>,
    reply: Value,
    drift: Option<&'static str>,
}
impl HostProvider for Provider {
    fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
        Some(self.state.lock().unwrap().clone())
    }
    async fn invoke(&mut self, m: &str, _: Value) -> Result<Value, BrokerError> {
        if m == "hostRunner.close" {
            self.closed.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"ok":true}));
        }
        if self.drift == Some(m) {
            self.state.lock().unwrap().provider_generation = "changed".into();
        }
        if m == "hostRunner.open" {
            Ok(json!({"session":"private-provider-session"}))
        } else {
            Ok(self.reply.clone())
        }
    }
}
fn native(reply: Value, drift: Option<&'static str>) -> (NativeHosts<Provider>, Arc<AtomicUsize>) {
    let state = Arc::new(Mutex::new(snapshot()));
    let closed = Arc::new(AtomicUsize::new(0));
    (
        NativeHosts::new(
            Provider {
                state,
                closed: closed.clone(),
                reply,
                drift,
            },
            [snapshot()],
        ),
        closed,
    )
}
#[tokio::test]
async fn malformed_or_oversized_reply_retires_lease_and_closes_exact_provider() {
    for reply in [
        json!({"code":0,"stdout":"1234","stderr":"5678","timedOut":false}),
        json!({"code":0,"stdout":"ok","stderr":"","timedOut":"no"}),
        json!({"code":256,"stdout":"ok","stderr":"","timedOut":false}),
        json!({"code":0,"stdout":null,"stderr":"","timedOut":false}),
    ] {
        let (mut n, closed) = native(reply, None);
        n.call(
            "capability.hosts.open",
            json!({"alias":"box","session":"broker-session"}),
        )
        .await
        .unwrap();
        assert!(n.call("capability.hosts.run",json!({"session":"broker-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":4})).await.is_err());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert!(
            n.call("capability.hosts.run", json!({"session":"broker-session"}))
                .await
                .is_err()
        );
    }
}
#[tokio::test]
async fn generation_edit_during_open_or_run_never_publishes_a_stale_result() {
    for method in ["hostRunner.open", "hostRunner.run"] {
        let (mut n, closed) = native(
            json!({"code":0,"stdout":"ok","stderr":"","timedOut":false}),
            Some(method),
        );
        let opened = n
            .call(
                "capability.hosts.open",
                json!({"alias":"box","session":"broker-session"}),
            )
            .await;
        if method.ends_with("open") {
            assert!(opened.is_err());
        } else {
            opened.unwrap();
            assert!(n.call("capability.hosts.run",json!({"session":"broker-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":4})).await.is_err());
        }
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn cancelled_open_cannot_certify_unknown_provider_effects_as_cleaned() {
    struct Pending;
    impl HostProvider for Pending {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(snapshot())
        }
        async fn invoke(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
            std::future::pending().await
        }
    }
    let snap = snapshot();
    let mut native = NativeHosts::new(Pending, [snap]);
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(5),
            native.call(
                "capability.hosts.open",
                json!({"alias":"box","session":"broker-session"})
            )
        )
        .await
        .is_err()
    );
    assert!(native.revoke().await.is_err());
    assert!(native.revoke().await.is_err());
}

#[tokio::test]
async fn cancelled_open_awaits_provider_owned_cleanup_before_certifying_retirement() {
    use std::sync::atomic::AtomicBool;
    struct Pending {
        opened: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
    }
    impl HostProvider for Pending {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(snapshot())
        }
        async fn invoke(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
            self.opened.store(true, Ordering::SeqCst);
            std::future::pending().await
        }
        async fn retire_pending(&mut self) -> Result<(), BrokerError> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    let opened = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let mut native = NativeHosts::new(
        Pending {
            opened: opened.clone(),
            closed: closed.clone(),
        },
        [snapshot()],
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(5),
            native.call(
                "capability.hosts.open",
                json!({"alias":"box","session":"broker-session"})
            )
        )
        .await
        .is_err()
    );
    assert!(opened.load(Ordering::SeqCst));
    assert!(!closed.load(Ordering::SeqCst));
    native.revoke().await.unwrap();
    assert!(closed.load(Ordering::SeqCst));
}
#[tokio::test]
async fn cancelled_close_retains_exact_session_for_owned_retirement() {
    struct Closing {
        calls: Arc<AtomicUsize>,
    }
    impl HostProvider for Closing {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(snapshot())
        }
        async fn invoke(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
            if m == "hostRunner.open" {
                return Ok(json!({"session":"provider-session-1234"}));
            }
            assert_eq!(p["session"], "provider-session-1234");
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                std::future::pending::<()>().await;
            }
            Ok(json!({}))
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let mut native = NativeHosts::new(
        Closing {
            calls: calls.clone(),
        },
        [snapshot()],
    );
    native
        .call(
            "capability.hosts.open",
            json!({"alias":"box","session":"broker-session"}),
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(5),
            native.call(
                "capability.hosts.close",
                json!({"session":"broker-session"})
            )
        )
        .await
        .is_err()
    );
    native.revoke().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
