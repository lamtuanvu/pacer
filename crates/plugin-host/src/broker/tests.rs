#![allow(clippy::unwrap_used)]
use super::*;
use crate::{CallResources, CommandResource, ReadResource, parse_manifest};
use std::time::{Duration, Instant};

fn http_broker(scopes: &[&str], hosts: &[&str], origins: &[&str]) -> CapabilityBroker {
    let manifest = parse_manifest(
        json!({"id":"fx-http","version":"1.0.0","publisher":"fixture","host":">=1.2.0",
        "capabilities":[{"name":"net.http","scopes":scopes}]}),
    )
    .unwrap();
    let http = if origins.is_empty() {
        json!({"hosts":hosts})
    } else {
        json!({"hosts":hosts,"origins":origins})
    };
    let resources: CallResources = serde_json::from_value(json!({"http":http})).unwrap();
    let authority = CallAuthority::new(
        resources,
        ["net.http".into()],
        Instant::now() + Duration::from_secs(2),
    );
    CapabilityBroker::new(manifest, authority, vec![])
}

#[tokio::test]
async fn http_requires_issued_origin_and_exact_host_admission() {
    let mut b = http_broker(
        &["example.test"],
        &["example.test"],
        &["https://example.test"],
    );
    let mut e = Echo { calls: 0 };
    for url in [
        "http://example.test/",
        "https://example.test:444/",
        "https://example.test@other.test/",
        "https://example.test.evil/",
        "https://example.test/redirect",
    ] {
        let denied = !url.contains("redirect");
        let result = b
            .handle(
                "capability.net.http",
                json!({"url":url,"method":"GET","timeoutMs":1000}),
                &mut e,
            )
            .await;
        if denied {
            assert!(result.is_err(), "{url}");
        } else {
            assert!(result.is_ok(), "{url}");
        }
    }
    assert!(b.handle("capability.net.http", json!({"url":"https://other.test/","method":"GET","timeoutMs":1000,"headers":{"Host":"example.test"}}), &mut e).await.is_err());
    assert!(
        b.handle(
            "capability.net.http",
            json!({"url":"https://example.test:443/","method":"GET","timeoutMs":1000}),
            &mut e
        )
        .await
        .is_ok()
    );
    assert_eq!(e.calls, 2);
}

#[tokio::test]
async fn http_request_bounds_precede_effect_and_limit_its_deadline() {
    let mut b = http_broker(
        &["example.test"],
        &["example.test"],
        &["https://example.test"],
    );
    let mut e = Echo { calls: 0 };
    for params in [
        json!({"url":"https://example.test/","method":"TRACE","timeoutMs":1000}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":0}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":120001}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":1.5}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"extra":true}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"authorization":{"secretRef":"bad ref"}}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"headers":{"bad header":"value"}}),
        json!({"url":"https://example.test/","method":"GET","timeoutMs":1000,"headers":{"X-Test":"ok\r\nHost: evil.test"}}),
    ] {
        assert!(
            b.handle("capability.net.http", params, &mut e)
                .await
                .is_err()
        );
    }
    assert_eq!(e.calls, 0);
    struct Slow;
    impl CapabilityEffect for Slow {
        async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok(json!({"ok":true}))
        }
    }
    assert!(matches!(
        b.handle(
            "capability.net.http",
            json!({"url":"https://example.test/","method":"GET","timeoutMs":1}),
            &mut Slow
        )
        .await,
        Err(BrokerError::Timeout)
    ));
    assert!(b.authority().active().is_ok());
}

#[tokio::test]
async fn http_wildcards_follow_ts_subdomain_and_explicit_grant_rules() {
    let mut b = http_broker(&["*.example.test"], &["*.example.test"], &[]);
    let mut e = Echo { calls: 0 };
    for url in [
        "https://example.test/",
        "https://badexample.test/",
        "https://a.example.test.evil/",
    ] {
        assert!(
            b.handle(
                "capability.net.http",
                json!({"url":url,"method":"GET","timeoutMs":1000}),
                &mut e
            )
            .await
            .is_err()
        );
    }
    let result = b
        .handle(
            "capability.net.http",
            json!({"url":"https://a.example.test/","method":"GET","timeoutMs":1000}),
            &mut e,
        )
        .await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(e.calls, 1);
    let mut wildcard = http_broker(&["*"], &["*"], &[]);
    assert!(
        wildcard
            .handle(
                "capability.net.http",
                json!({"url":"https://other.test/","method":"GET","timeoutMs":1000}),
                &mut e
            )
            .await
            .is_err()
    );
    let mut wildcard = http_broker(&["*"], &["*"], &[]).with_explicit_http_wildcard_grant(true);
    assert!(
        wildcard
            .handle(
                "capability.net.http",
                json!({"url":"https://other.test/","method":"GET","timeoutMs":1000}),
                &mut e
            )
            .await
            .is_ok()
    );
}

struct Echo {
    calls: usize,
}
impl CapabilityEffect for Echo {
    async fn call(&mut self, _method: &str, params: Value) -> Result<Value, BrokerError> {
        self.calls += 1;
        Ok(params)
    }
}

#[tokio::test]
async fn list_requires_issued_directory_and_rejects_adversarial_globs() {
    let manifest = parse_manifest(json!({"id":"fx-list","version":"1.0.0","publisher":"fixture",
        "host":">=1.10.0","capabilities":[{"name":"fs.read","scopes":["/tmp/logs/rollout-*.jsonl"]}]})).unwrap();
    let resources: CallResources = serde_json::from_value(json!({"reads":[
        {"path":"/tmp/logs","kind":"codex-logs"}]}))
    .unwrap();
    let authority = CallAuthority::new(
        resources,
        ["fs.read".into()],
        Instant::now() + Duration::from_secs(2),
    );
    let mut broker = CapabilityBroker::new(manifest, authority, vec![]);
    let mut effect = Echo { calls: 0 };
    for (dir, pattern, limit) in [
        ("/tmp/logs/../logs", "rollout-*.jsonl", json!(100)),
        ("/tmp/other", "rollout-*.jsonl", json!(100)),
        ("/tmp/logs", "../secret", json!(100)),
        ("/tmp/logs", "sub/./file", json!(100)),
        ("/tmp/logs", "/etc/passwd", json!(100)),
        ("/tmp/logs", "rollout-*.jsonl", json!(0)),
        ("/tmp/logs", "rollout-*.jsonl", json!(1001)),
    ] {
        assert!(
            broker
                .handle(
                    "capability.fs.list",
                    json!({"dir":dir,"glob":pattern,"limit":limit}),
                    &mut effect
                )
                .await
                .is_err()
        );
    }
    assert_eq!(effect.calls, 0);
    assert!(
        broker
            .handle(
                "capability.fs.list",
                json!({"dir":"/tmp/logs",
        "glob":"rollout-*.jsonl","limit":100}),
                &mut effect
            )
            .await
            .is_ok()
    );
    assert_eq!(effect.calls, 1);
}

#[tokio::test]
async fn native_listing_is_admitted_and_never_calls_the_effect() {
    let root = std::env::temp_dir().join(format!("pacer-broker-list-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("rollout-one.jsonl"), "one").unwrap();
    std::fs::write(root.join("auth.json"), "private").unwrap();
    let scope = format!("{}/rollout-*.jsonl", root.display());
    let manifest = parse_manifest(
        json!({"id":"fx-list","version":"1.0.0","publisher":"fixture",
        "host":">=1.10.0","capabilities":[{"name":"fs.read","scopes":[scope]}]}),
    )
    .unwrap();
    let resources: CallResources =
        serde_json::from_value(json!({"reads":[{"path":root,"kind":"codex-logs"}]})).unwrap();
    let reads = resources.reads.clone();
    let authority = CallAuthority::new(
        resources,
        ["fs.read".into()],
        Instant::now() + Duration::from_secs(5),
    );
    let mut broker = CapabilityBroker::new(manifest, authority, vec![])
        .with_native_read(&reads)
        .unwrap();
    let mut effect = Echo { calls: 0 };
    let result = broker
        .handle(
            "capability.fs.list",
            json!({"dir":root,"glob":"**/rollout-*.jsonl"}),
            &mut effect,
        )
        .await
        .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["files"][0]["path"],
        root.join("rollout-one.jsonl").to_str().unwrap()
    );
    assert_eq!(result["complete"], true);
    assert_eq!(effect.calls, 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn list_normalizes_valid_directory_and_rejects_unknown_fields() {
    let manifest = parse_manifest(json!({"id":"fx-list","version":"1.0.0","publisher":"fixture",
        "host":">=1.10.0","capabilities":[{"name":"fs.read","scopes":["/tmp/logs/rollout-*.jsonl"]}]})).unwrap();
    let resources: CallResources = serde_json::from_value(json!({"reads":[
        {"path":"/tmp/logs","kind":"codex-logs"}]}))
    .unwrap();
    let authority = CallAuthority::new(
        resources,
        ["fs.read".into()],
        Instant::now() + Duration::from_secs(2),
    );
    let mut broker = CapabilityBroker::new(manifest, authority, vec![]);
    let mut effect = Echo { calls: 0 };
    for dir in ["/tmp/logs/", "/tmp//logs"] {
        let value = broker
            .handle(
                "capability.fs.list",
                json!({"dir":dir,"glob":"rollout-*.jsonl"}),
                &mut effect,
            )
            .await
            .unwrap();
        assert_eq!(value["dir"], "/tmp/logs", "{dir}");
    }
    let calls = effect.calls;
    assert!(
        broker
            .handle(
                "capability.fs.list",
                json!({"dir":"/tmp/logs","glob":"rollout-*.jsonl","extra":true}),
                &mut effect
            )
            .await
            .is_err()
    );
    assert_eq!(effect.calls, calls);
}

#[tokio::test]
async fn broker_rejects_unknown_fields_for_other_effect_requests() {
    let mut broker = broker(2000);
    let mut effect = Echo { calls: 0 };
    for (method, mut params) in [
        ("capability.fs.read", json!({"path":"/tmp/issued"})),
        (
            "capability.fs.write",
            json!({"path":"/tmp/issued","text":"ok"}),
        ),
        (
            "capability.process.spawn",
            json!({"argv":["echo","ok"],"timeoutMs":1000}),
        ),
    ] {
        params["extra"] = json!(true);
        assert!(
            broker.handle(method, params, &mut effect).await.is_err(),
            "{method}"
        );
    }
    assert_eq!(effect.calls, 0);
    let value = broker
        .handle(
            "capability.identity.sign",
            json!({"purpose":"conformance","payload":"","extra":true}),
            &mut effect,
        )
        .await
        .unwrap();
    assert_eq!(value, json!({"purpose":"conformance","payload":""}));
}

#[test]
fn strict_broker_request_inventory_rejects_extra_fields() {
    let strict = [
        "capability.fs.list",
        "capability.fs.read",
        "capability.fs.stat",
        "capability.fs.readRange",
        "capability.fs.write",
        "capability.fs.mkdir",
        "capability.fs.remove",
        "capability.fs.beginWrite",
        "capability.fs.writeChunk",
        "capability.fs.commitWrite",
        "capability.fs.releaseWrite",
        "capability.process.spawn",
        "capability.net.http",
        "capability.net.http.body.begin",
        "capability.net.http.body.stageChunk",
        "capability.net.http.body.readChunk",
        "capability.net.http.body.release",
        "capability.secrets.check",
        "capability.worktree.createOrReuse",
        "capability.worktree.inspect",
        "capability.worktree.resolveBase",
        "capability.hosts.open",
        "capability.hosts.run",
        "capability.hosts.close",
    ];
    for method in strict {
        let object = json!({"extra":true});
        assert!(
            validate_request_fields(method, object.as_object().unwrap()).is_err(),
            "{method}"
        );
    }
    for method in ["capability.identity.sign", "capability.secrets.resolve"] {
        let object = json!({"extra":true});
        assert!(
            validate_request_fields(method, object.as_object().unwrap()).is_ok(),
            "{method}"
        );
    }
}
fn broker(ms: u64) -> CapabilityBroker {
    let manifest = parse_manifest(
        json!({"id":"fx-broker","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
        "capabilities":[{"name":"fs.read","scopes":["/tmp/issued"]},
            {"name":"process.spawn","scopes":["echo"]},
            {"name":"identity.sign","scopes":["conformance"]},
            {"name":"fs.write","scopes":["/tmp/issued"]}]}),
    )
    .unwrap();
    let resources = CallResources {
        reads: vec![ReadResource {
            path: "/tmp/issued".into(),
            kind: "file".into(),
        }],
        commands: vec![CommandResource {
            argv: vec!["echo".into(), "ok".into()],
            timeout_ms: 1000,
            stdin: None,
            cwd: None,
            env: Default::default(),
        }],
        writes: vec![crate::WriteResource {
            path: "/tmp/issued".into(),
            kind: "file".into(),
            operations: vec!["write".into()],
        }],
        ..Default::default()
    };
    let authority = CallAuthority::new(
        resources,
        [
            "fs.read".into(),
            "process.spawn".into(),
            "identity.sign".into(),
            "fs.write".into(),
        ],
        Instant::now() + Duration::from_millis(ms),
    );
    CapabilityBroker::new(manifest, authority, vec!["fileWriteChunks".into()])
}
#[tokio::test]
async fn denies_adversarial_paths_and_commands_before_effect() {
    let mut b = broker(1000);
    let mut e = Echo { calls: 0 };
    assert!(
        b.handle(
            "capability.fs.read",
            json!({"path":"/tmp/../tmp/issued"}),
            &mut e
        )
        .await
        .is_err()
    );
    assert!(
        b.handle("capability.fs.read", json!({"path":"/tmp/other"}), &mut e)
            .await
            .is_err()
    );
    assert!(
        b.handle(
            "capability.process.spawn",
            json!({"argv":["echo","changed"],"timeoutMs":1000}),
            &mut e
        )
        .await
        .is_err()
    );
    assert!(
        b.handle(
            "capability.process.spawn",
            json!({"argv":["echo","ok"],"timeoutMs":1001}),
            &mut e
        )
        .await
        .is_err()
    );
    assert_eq!(e.calls, 0);
    assert!(
        b.handle("capability.fs.read", json!({"path":"/tmp/issued"}), &mut e)
            .await
            .is_ok()
    );
    assert_eq!(e.calls, 1);
}
#[tokio::test]
async fn expiry_and_canonical_signing_precede_effect() {
    let mut b = broker(1);
    let mut e = Echo { calls: 0 };
    assert!(
        b.handle(
            "capability.identity.sign",
            json!({"purpose":"other","payload":"YQ=="}),
            &mut e
        )
        .await
        .is_err()
    );
    assert!(
        b.handle(
            "capability.identity.sign",
            json!({"purpose":"conformance","payload":"YQ="}),
            &mut e
        )
        .await
        .is_err()
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(
        b.handle("capability.fs.read", json!({"path":"/tmp/issued"}), &mut e)
            .await
            .is_err()
    );
    assert_eq!(e.calls, 0);
}
#[tokio::test]
async fn deadline_revokes_in_flight_effect() {
    struct Slow;
    impl CapabilityEffect for Slow {
        async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(json!({"ok":true}))
        }
    }
    let mut b = broker(5);
    assert!(matches!(
        b.handle(
            "capability.fs.read",
            json!({"path":"/tmp/issued"}),
            &mut Slow
        )
        .await,
        Err(BrokerError::Timeout)
    ));
    assert!(matches!(
        b.authority().active(),
        Err(AuthorityError::Expired)
    ));
}
#[tokio::test]
async fn file_transfer_rejects_cross_handle_and_incomplete_commit() {
    let mut b = broker(1000);
    let mut e = Echo { calls: 0 };
    let h = b
        .handle(
            "capability.fs.beginWrite",
            json!({"path":"/tmp/issued","bytes":3,"mode":384}),
            &mut e,
        )
        .await
        .unwrap();
    let handle = h["handle"].as_str().unwrap();
    assert!(
        b.handle(
            "capability.fs.writeChunk",
            json!({"handle":"foreign","offset":0,"base64":"YWJj"}),
            &mut e
        )
        .await
        .is_err()
    );
    assert!(
        b.handle(
            "capability.fs.commitWrite",
            json!({"handle":handle}),
            &mut e
        )
        .await
        .is_err()
    );
    assert!(
        b.handle(
            "capability.fs.writeChunk",
            json!({"handle":handle,"offset":0,"base64":"YWJj"}),
            &mut e
        )
        .await
        .is_ok()
    );
    let committed = b
        .handle(
            "capability.fs.commitWrite",
            json!({"handle":handle}),
            &mut e,
        )
        .await
        .unwrap();
    assert_eq!(
        committed,
        json!({"path":"/tmp/issued","text":"abc","mode":384})
    );
    assert_eq!(e.calls, 1);
}

#[tokio::test]
async fn write_modes_are_0600_only_before_effect() {
    let mut b = broker(1000);
    let mut e = Echo { calls: 0 };
    for mode in [json!(0), json!(420), json!("384"), json!(-1)] {
        assert!(
            b.handle(
                "capability.fs.write",
                json!({"path":"/tmp/issued","text":"x","mode":mode}),
                &mut e
            )
            .await
            .is_err()
        );
        assert!(
            b.handle(
                "capability.fs.beginWrite",
                json!({"path":"/tmp/issued","bytes":1,"mode":mode}),
                &mut e
            )
            .await
            .is_err()
        );
    }
    assert_eq!(e.calls, 0);
}
#[tokio::test]
async fn http_upload_is_owner_local_and_requires_captured_host() {
    let manifest = parse_manifest(
        json!({"id":"fx-http","version":"1.0.0","publisher":"fixture","host":">=1.2.0",
        "capabilities":[{"name":"net.http","scopes":["example.test"]}]}),
    )
    .unwrap();
    let resources: CallResources =
        serde_json::from_value(json!({"http":{"hosts":["example.test"]}})).unwrap();
    let authority = CallAuthority::new(
        resources,
        ["net.http".into()],
        Instant::now() + Duration::from_secs(1),
    );
    let mut b = CapabilityBroker::new(manifest, authority, vec!["httpBodyChunks".into()]);
    let mut e = Echo { calls: 0 };
    let handle = b
        .handle("capability.net.http.body.begin", json!({"bytes":3}), &mut e)
        .await
        .unwrap()["handle"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(b.handle("capability.net.http",json!({"url":"https://other.test/","method":"POST","timeoutMs":1000,"body":{"handle":handle}}),&mut e).await.is_err());
    assert_eq!(e.calls, 0);
    assert!(
        b.handle(
            "capability.net.http.body.stageChunk",
            json!({"handle":handle,"offset":0,"base64":"YWJj"}),
            &mut e
        )
        .await
        .is_ok()
    );
    let value=b.handle("capability.net.http",json!({"url":"https://example.test/","method":"POST","timeoutMs":1000,"body":{"handle":handle}}),&mut e).await.unwrap();
    assert_eq!(value["body"], "abc");
    assert_eq!(e.calls, 1);
}

#[tokio::test]
async fn native_exact_file_read_does_not_invoke_adapter() {
    let root = std::env::temp_dir().join(format!("pacer-broker-read-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("usage.json");
    std::fs::write(&path, "usage").unwrap();
    let path = path.to_str().unwrap().to_string();
    let manifest = parse_manifest(
        json!({"id":"fx-read","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
        "capabilities":[{"name":"fs.read","scopes":[path]}]}),
    )
    .unwrap();
    let resources = CallResources {
        reads: vec![ReadResource {
            path: path.clone(),
            kind: "file".into(),
        }],
        ..Default::default()
    };
    let authority = CallAuthority::new(
        resources.clone(),
        ["fs.read".into()],
        Instant::now() + Duration::from_secs(1),
    );
    let mut broker = CapabilityBroker::new(manifest, authority, vec![])
        .with_native_read(&resources.reads)
        .unwrap();
    let mut echo = Echo { calls: 0 };
    assert_eq!(
        broker
            .handle("capability.fs.read", json!({"path":path}), &mut echo)
            .await
            .unwrap()["text"],
        "usage"
    );
    assert_eq!(echo.calls, 0);
    std::fs::remove_dir_all(root).unwrap();
}
