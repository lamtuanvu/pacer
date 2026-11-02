#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect,
    HostOperationResource, ProviderSnapshot, parse_manifest,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
struct Effect {
    snapshot: ProviderSnapshot,
    mode: &'static str,
    calls: usize,
    retired: usize,
}
impl CapabilityEffect for Effect {
    fn native_host_sessions(&self) -> bool {
        true
    }
    fn provider_snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
        Some(self.snapshot.clone())
    }
    async fn retire(&mut self) -> Result<(), BrokerError> {
        self.retired += 1;
        if self.mode == "cleanup-failure" {
            return Err(BrokerError::Effect("discard failed".into()));
        }
        Ok(())
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        if method == "capability.hosts.open" {
            return Ok(json!({"ok":true}));
        }
        assert_eq!(method, "capability.hosts.fetch");
        assert_eq!(params["script"], "BUNDLE_OUT");
        assert_eq!(
            params["args"],
            json!(["owned-worktree", "owned-base", "owned-branch"])
        );
        self.calls += 1;
        match self.mode {
            "nested" => return Err(BrokerError::Effect("nested cancellation".into())),
            "late-nested" | "late-validation" | "cleanup-failure" => {
                // A busy provider can finish after the absolute cutoff before
                // the executor polls the timer. Neither success nor a nested
                // cancellation may win over the broker's expired deadline.
                std::thread::sleep(Duration::from_millis(35));
                if self.mode == "late-nested" {
                    return Err(BrokerError::Effect("nested cancellation".into()));
                }
            }
            "drift" => self.snapshot.provider_generation = "retired".into(),
            _ => {}
        }
        Ok(json!({"ok":true}))
    }
}
fn fixture(mode: &'static str) -> (CapabilityBroker, Effect) {
    let snapshot = ProviderSnapshot {
        alias: "box".into(),
        host_fingerprint: "host".into(),
        caller_generation: "caller".into(),
        provider_generation: "provider".into(),
        provider_process: 7,
    };
    let resource = HostOperationResource {
        alias: "box".into(),
        host_fingerprint: "host".into(),
        script: "BUNDLE_OUT".into(),
        args: vec![
            "owned-worktree".into(),
            "owned-base".into(),
            "owned-branch".into(),
        ],
        timeout_ms: 20,
        max_bytes: 32,
    };
    let authority = CallAuthority::new(
        CallResources {
            hosts: vec![resource],
            ..Default::default()
        },
        ["hosts".into()],
        Instant::now() + Duration::from_secs(5),
    );
    let manifest=parse_manifest(json!({"id":"fixture","version":"1.0.0","publisher":"fixture","host":">=1.7.0","capabilities":[{"name":"hosts"}]})).unwrap();
    (
        CapabilityBroker::new(manifest, authority, vec![]).with_hosts([snapshot.clone()]),
        Effect {
            snapshot,
            mode,
            calls: 0,
            retired: 0,
        },
    )
}
#[tokio::test]
async fn persisted_fetch_is_one_use_and_cannot_accept_provider_arguments_from_rpc() {
    let (mut b, mut e) = fixture("ok");
    let opened = b
        .handle("capability.hosts.open", json!({"alias":"box"}), &mut e)
        .await
        .unwrap();
    let p = json!({"session":opened["session"],"timeoutMs":20,"maxBytes":32});
    let mut forged = p.clone();
    forged["args"] = json!(["unowned"]);
    assert!(
        b.handle("capability.hosts.fetch", forged, &mut e)
            .await
            .is_err()
    );
    assert_eq!(e.calls, 0);
    assert_eq!(
        b.handle("capability.hosts.fetch", p.clone(), &mut e)
            .await
            .unwrap(),
        json!({"ok":true})
    );
    assert!(b.handle("capability.hosts.fetch", p, &mut e).await.is_err());
    assert_eq!(e.calls, 1);
    b.revoke_owned(&mut e).await.unwrap();
    assert_eq!(e.retired, 1);
}
#[tokio::test]
async fn deadline_precedence_provider_retirement_and_cleanup_failures_remain_visible() {
    for mode in [
        "nested",
        "late-nested",
        "late-validation",
        "cleanup-failure",
        "drift",
    ] {
        let (mut b, mut e) = fixture(mode);
        let opened = b
            .handle("capability.hosts.open", json!({"alias":"box"}), &mut e)
            .await
            .unwrap();
        let result = b
            .handle(
                "capability.hosts.fetch",
                json!({"session":opened["session"],"timeoutMs":20,"maxBytes":32}),
                &mut e,
            )
            .await;
        match mode {
            "nested" => {
                assert!(
                    matches!(result,Err(BrokerError::Effect(ref s)) if s=="nested cancellation")
                );
                assert_eq!(e.retired, 0);
            }
            "cleanup-failure" => {
                assert!(matches!(result,Err(BrokerError::Effect(ref s)) if s=="discard failed"));
                assert_eq!(e.retired, 1);
                assert!(
                    matches!(b.revoke_owned(&mut e).await, Err(BrokerError::Effect(ref s)) if s == "discard failed")
                );
                assert_eq!(e.retired, 1);
            }
            "drift" => {
                assert!(matches!(result, Err(BrokerError::HostLease(_))));
                assert_eq!(e.retired, 1);
            }
            _ => {
                assert!(
                    matches!(result, Err(BrokerError::Timeout)),
                    "{mode}: {result:?}"
                );
                assert_eq!(e.retired, 1);
            }
        }
    }
}
