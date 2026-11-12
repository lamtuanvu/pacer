#![allow(clippy::unwrap_used)]
use pacer_plugin_capabilities::{CapabilityBroker, CapabilityEffect, NativeHttp};
use pacer_plugin_host::{
    BrokerError, CallAuthority, CallResources, CredentialBindings, parse_manifest,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
struct RefuseFallback;
impl CapabilityEffect for RefuseFallback {
    async fn call(&mut self, _method: &str, _params: Value) -> Result<Value, BrokerError> {
        panic!("native effect reached fallback")
    }
}
#[tokio::test]
async fn broker_native_http_requires_exact_origin_but_not_a_separate_secret_resolution_grant() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let n = socket.read(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes[..n]).contains("synthetic-secret"));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let manifest=parse_manifest(json!({"id":"fx-native","version":"1.0.0","publisher":"fixture","host":">=1.2.0","capabilities":[{"name":"net.http","scopes":["127.0.0.1"]}]})).unwrap();
    let resources: CallResources =
        serde_json::from_value(json!({"http":{"hosts":["127.0.0.1"],"origins":[origin]}})).unwrap();
    let authority = CallAuthority::new(
        resources,
        ["net.http".into()],
        Instant::now() + Duration::from_secs(10),
    );
    let mut credentials = CredentialBindings::default();
    credentials
        .bind_value("env:TEST", Some("synthetic-secret".into()))
        .unwrap();
    let mut broker = CapabilityBroker::new(manifest, authority, vec![])
        .with_native_http(NativeHttp::new(credentials).unwrap());
    let request = json!({"url":format!("{origin}/"),"method":"GET","timeoutMs":3000,"authorization":{"secretRef":"env:TEST"}});
    assert_eq!(
        broker
            .handle("capability.net.http", request, &mut RefuseFallback)
            .await
            .unwrap()["body"],
        "ok"
    );
    server.await.unwrap();
    broker.revoke();
    assert!(
        broker
            .handle(
                "capability.net.http",
                json!({"url":format!("{origin}/"),"method":"GET","timeoutMs":3000}),
                &mut RefuseFallback
            )
            .await
            .is_err()
    );
}
