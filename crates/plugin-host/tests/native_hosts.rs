#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, CapabilityEffect, HostProvider, NativeHosts, ProviderSnapshot,
};
use serde_json::{Value, json};
struct Provider {
    snapshot: ProviderSnapshot,
    closed: usize,
}
impl HostProvider for Provider {
    fn snapshot(&self, _alias: &str) -> Option<ProviderSnapshot> {
        Some(self.snapshot.clone())
    }
    async fn invoke(&mut self, method: &str, params: Value) -> Result<Value, BrokerError> {
        match method {
            "hostRunner.open" => Ok(json!({"session":"private-provider-session"})),
            "hostRunner.run" => {
                assert_eq!(params["session"], "private-provider-session");
                Ok(json!({"code":0,"stdout":"ok","stderr":"","timedOut":false}))
            }
            "hostRunner.close" => {
                self.closed += 1;
                Ok(json!({"ok":true}))
            }
            _ => Err(BrokerError::Invalid("method")),
        }
    }
}
#[tokio::test]
async fn native_host_sessions_hide_provider_handles_and_pin_generations() {
    let snapshot = ProviderSnapshot {
        alias: "remote".into(),
        host_fingerprint: "host".into(),
        caller_generation: "caller".into(),
        provider_generation: "provider".into(),
        provider_process: 9,
    };
    let mut native = NativeHosts::new(
        Provider {
            snapshot: snapshot.clone(),
            closed: 0,
        },
        [snapshot],
    );
    assert!(
        native
            .call(
                "capability.hosts.open",
                json!({"alias":"remote","session":"opaque-broker-session"})
            )
            .await
            .is_ok()
    );
    let result=native.call("capability.hosts.run",json!({"session":"opaque-broker-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":1024})).await.unwrap();
    assert_eq!(result["stdout"], "ok");
    assert!(native.call("capability.hosts.run",json!({"session":"private-provider-session","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":1024})).await.is_err());
    native
        .call(
            "capability.hosts.close",
            json!({"session":"opaque-broker-session"}),
        )
        .await
        .unwrap();
    assert!(
        native
            .call(
                "capability.hosts.run",
                json!({"session":"opaque-broker-session"})
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn fetched_bundle_crosses_provider_boundary_only_as_private_one_use_ticket() {
    use pacer_plugin_host::{BundleSpec, BundleTicket, NativeBundle};
    use std::{
        collections::HashMap,
        fs,
        time::{Duration, Instant},
    };
    struct FetchProvider {
        snapshot: ProviderSnapshot,
        bundle: NativeBundle,
    }
    impl HostProvider for FetchProvider {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(self.snapshot.clone())
        }
        async fn invoke(&mut self, m: &str, _: Value) -> Result<Value, BrokerError> {
            match m {
                "hostRunner.open" => Ok(json!({"session":"provider-private-session"})),
                _ => Ok(json!({"ok":true})),
            }
        }
        async fn fetch(&mut self, p: Value) -> Result<BundleTicket, BrokerError> {
            assert_eq!(p["session"], "provider-private-session");
            assert_eq!(p["script"], "BUNDLE_OUT");
            let staged = self
                .bundle
                .stage(
                    &json!({"argv":["ssh","fixture"],"timeoutMs":1000,"maxBytes":32}),
                    Instant::now() + Duration::from_secs(3),
                )
                .await?;
            self.bundle.claim(staged["handle"].as_str().unwrap())
        }
    }
    for corrupt_stage in [false, true] {
        let root = std::env::temp_dir().join(format!("pacer-host-fetch-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let snapshot = ProviderSnapshot {
            alias: "host".into(),
            host_fingerprint: "configured".into(),
            caller_generation: "caller".into(),
            provider_generation: "provider".into(),
            provider_process: 7,
        };
        let bundle = NativeBundle::prepare(
            &root,
            BundleSpec {
                argv: vec!["ssh".into(), "fixture".into()],
                executable: "/usr/bin/printf".into(),
                env: HashMap::new(),
                timeout_ms: 1000,
                max_bytes: 32,
            },
        )
        .unwrap();
        let mut native = NativeHosts::new(
            FetchProvider {
                snapshot: snapshot.clone(),
                bundle,
            },
            [snapshot],
        );
        native
            .call(
                "capability.hosts.open",
                json!({"alias":"host","session":"opaque-caller-session"}),
            )
            .await
            .unwrap();
        assert_eq!(native.call("capability.hosts.fetch",json!({"session":"opaque-caller-session","script":"BUNDLE_OUT","args":["worktree","base","branch"],"timeoutMs":1000,"maxBytes":32})).await.unwrap(),json!({"ok":true}));
        if corrupt_stage {
            let stage = fs::read_dir(root.join("transfers"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let artifact = stage.join("out.bundle");
            fs::rename(&artifact, stage.join("original.bundle")).unwrap();
            fs::write(&artifact, b"replacement owned by somebody else").unwrap();
            assert!(native.revoke().await.is_err());
            assert_eq!(
                fs::read(&artifact).unwrap(),
                b"replacement owned by somebody else"
            );
            assert!(native.claim_fetch().is_err());
            drop(native);
            fs::remove_dir_all(root).unwrap();
            continue;
        }
        let mut ticket = native.claim_fetch().unwrap();
        assert_eq!(ticket.read().unwrap(), b"fixture");
        assert!(native.claim_fetch().is_err());
        drop(ticket);
        drop(native);
        fs::remove_dir_all(root).unwrap();
    }
}
