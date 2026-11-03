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
#[tokio::test]
async fn failed_open_settlement_still_disposes_fetched_ticket() {
    use pacer_plugin_host::{BundleSpec, BundleTicket, NativeBundle};
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    #[derive(Default)]
    struct Counts {
        opens: usize,
        settles: usize,
        closed: Vec<String>,
    }
    struct FetchProvider {
        snapshot: ProviderSnapshot,
        bundle: NativeBundle,
        counts: Arc<Mutex<Counts>>,
    }
    impl HostProvider for FetchProvider {
        fn snapshot(&self, _: &str) -> Option<ProviderSnapshot> {
            Some(self.snapshot.clone())
        }
        async fn invoke(&mut self, m: &str, p: Value) -> Result<Value, BrokerError> {
            let mut counts = self.counts.lock().unwrap();
            match m {
                "hostRunner.open" => {
                    counts.opens += 1;
                    if counts.opens > 1 {
                        return Err(BrokerError::Effect("boom".into()));
                    }
                    Ok(json!({"session":"provider-private-session"}))
                }
                "hostRunner.close" => {
                    counts.closed.push(p["session"].as_str().unwrap().into());
                    Ok(json!({"ok":true}))
                }
                _ => Ok(json!({"code":0,"stdout":"ok","stderr":"","timedOut":false})),
            }
        }
        async fn retire_pending(&mut self) -> Result<(), BrokerError> {
            self.counts.lock().unwrap().settles += 1;
            Err(BrokerError::Effect("settle failed".into()))
        }
        async fn fetch(&mut self, p: Value) -> Result<BundleTicket, BrokerError> {
            assert_eq!(p["session"], "provider-private-session");
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
    fn settle_failed<T>(result: Result<T, BrokerError>) -> bool {
        matches!(result, Err(BrokerError::Effect(m)) if m == "settle failed")
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
        let counts = Arc::new(Mutex::new(Counts::default()));
        let mut native = NativeHosts::new(
            FetchProvider {
                snapshot: snapshot.clone(),
                bundle,
                counts: counts.clone(),
            },
            [snapshot],
        );
        native
            .call(
                "capability.hosts.open",
                json!({"alias":"host","session":"s1"}),
            )
            .await
            .unwrap();
        assert_eq!(native.call("capability.hosts.fetch",json!({"session":"s1","script":"BUNDLE_OUT","args":["worktree","base","branch"],"timeoutMs":1000,"maxBytes":32})).await.unwrap(),json!({"ok":true}));
        let stage = fs::read_dir(root.join("transfers"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let artifact = stage.join("out.bundle");
        if corrupt_stage {
            fs::rename(&artifact, stage.join("original.bundle")).unwrap();
            fs::write(&artifact, b"replacement owned by somebody else").unwrap();
        }
        let failed = native
            .call(
                "capability.hosts.open",
                json!({"alias":"host","session":"s2"}),
            )
            .await;
        assert!(matches!(failed, Err(BrokerError::Effect(m)) if m == "boom"));
        assert_eq!(counts.lock().unwrap().settles, 1);
        assert!(settle_failed(native.call("capability.hosts.run",json!({"session":"s1","script":"PROBE","args":[],"timeoutMs":1000,"maxBytes":32})).await));
        assert!(counts.lock().unwrap().closed.is_empty());
        assert!(settle_failed(native.revoke().await));
        if corrupt_stage {
            assert_eq!(
                fs::read(&artifact).unwrap(),
                b"replacement owned by somebody else"
            );
        } else {
            assert!(!stage.exists());
        }
        assert!(native.claim_fetch().is_err());
        let counts = counts.lock().unwrap();
        assert_eq!(counts.closed, ["provider-private-session"]);
        assert_eq!((counts.opens, counts.settles), (2, 1));
        drop(counts);
        drop(native);
        fs::remove_dir_all(root).unwrap();
    }
}
