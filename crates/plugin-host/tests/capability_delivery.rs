#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{
    BrokerError, CallAuthority, CallResources, CapabilityBroker, CapabilityEffect, parse_manifest,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
struct Effect {
    calls: usize,
    reply: Value,
}
impl CapabilityEffect for Effect {
    async fn call(&mut self, _: &str, _: Value) -> Result<Value, BrokerError> {
        self.calls += 1;
        Ok(self.reply.clone())
    }
}
fn broker(cap: &str, scope: &str, resources: Value) -> CapabilityBroker {
    let manifest=parse_manifest(json!({"id":"fixture","version":"1.0.0","publisher":"fixture","host":">=1.6.0","capabilities":[{"name":cap,"scopes":[scope]}]})).unwrap();
    let resources: CallResources = serde_json::from_value(resources).unwrap();
    CapabilityBroker::new(
        manifest,
        CallAuthority::new(
            resources,
            [cap.into()],
            Instant::now() + Duration::from_secs(30),
        ),
        vec!["fileWriteChunks".into(), "httpBodyChunks".into()],
    )
}
#[tokio::test]
async fn undeliverable_descriptors_do_not_reserve_slots_or_advance_chunks() {
    let mut b = broker(
        "fs.write",
        "/owned/**",
        json!({"writes":[{"path":"/owned/file","kind":"file","operations":["write"]}]}),
    );
    let mut e = Effect {
        calls: 0,
        reply: json!({"ok":true}),
    };
    assert!(
        b.handle_deliverable(
            "capability.fs.beginWrite",
            json!({"path":"/owned/file","bytes":1}),
            &mut e,
            |_| false
        )
        .await
        .is_err()
    );
    let begin = b
        .handle(
            "capability.fs.beginWrite",
            json!({"path":"/owned/file","bytes":1}),
            &mut e,
        )
        .await
        .unwrap();
    let handle = begin["handle"].as_str().unwrap();
    assert!(
        b.handle_deliverable(
            "capability.fs.writeChunk",
            json!({"handle":handle,"offset":0,"base64":"YQ=="}),
            &mut e,
            |_| false
        )
        .await
        .is_err()
    );
    assert_eq!(
        b.handle(
            "capability.fs.writeChunk",
            json!({"handle":handle,"offset":0,"base64":"YQ=="}),
            &mut e
        )
        .await
        .unwrap(),
        json!({"bytes":1})
    );
    b.handle(
        "capability.fs.commitWrite",
        json!({"handle":handle}),
        &mut e,
    )
    .await
    .unwrap();
    assert_eq!(e.calls, 1);
}
#[tokio::test]
async fn oversized_http_descriptor_does_not_leave_a_response_handle() {
    let mut b = broker(
        "net.http",
        "fixture.test",
        json!({"http":{"hosts":["fixture.test"],"origins":["https://fixture.test"]}}),
    );
    let mut e = Effect {
        calls: 0,
        reply: json!({"status":200,"headers":{},"body":"a".repeat(1100000)}),
    };
    let p = json!({"url":"https://fixture.test","method":"GET","timeoutMs":1000});
    assert!(
        b.handle_deliverable("capability.net.http", p.clone(), &mut e, |_| false)
            .await
            .is_err()
    );
    let result = b.handle("capability.net.http", p, &mut e).await.unwrap();
    let h = result["body"]["handle"].as_str().unwrap();
    assert!(
        b.handle_deliverable(
            "capability.net.http.body.readChunk",
            json!({"handle":h,"offset":0,"length":4}),
            &mut e,
            |_| false
        )
        .await
        .is_err()
    );
    assert_eq!(
        b.handle(
            "capability.net.http.body.readChunk",
            json!({"handle":h,"offset":0,"length":4}),
            &mut e
        )
        .await
        .unwrap()["base64"],
        "YWFhYQ=="
    );
}
