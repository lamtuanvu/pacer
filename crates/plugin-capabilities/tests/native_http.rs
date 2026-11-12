#![allow(clippy::unwrap_used)]
use pacer_plugin_capabilities::NativeHttp;
use pacer_plugin_host::CredentialBindings;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn injects_bound_credentials_and_refuses_redirect_or_reflection() {
    for (status, body) in [
        (200, "accepted"),
        (302, "redirect"),
        (200, "synthetic-credential"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let count = socket.read(&mut bytes).await.unwrap();
            assert!(
                String::from_utf8_lossy(&bytes[..count])
                    .to_lowercase()
                    .contains("authorization: bearer synthetic-credential")
            );
            socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let mut credentials = CredentialBindings::default();
        credentials
            .bind_value("env:TEST", Some("synthetic-credential".into()))
            .unwrap();
        let mut http = NativeHttp::new(credentials).unwrap();
        let response=http.request(&json!({"url":format!("http://{address}/"),"method":"GET","timeoutMs":1000,"authorization":{"secretRef":"env:TEST"}})).await;
        if body == "accepted" {
            assert_eq!(response.unwrap()["body"], body);
        } else {
            assert!(response.is_err());
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn secret_checks_keep_empty_values_present_and_never_fall_back_to_environment() {
    let mut bindings = CredentialBindings::default();
    bindings
        .bind_value("env:SYNTHETIC", Some("".into()))
        .unwrap();
    assert!(bindings.present("env:SYNTHETIC").await.unwrap());
    assert!(bindings.present("env:HOME").await.is_err());
    assert!(bindings.bind_value("env:SYNTHETIC", None).is_err());
    assert!(bindings.bind_value("env:x/y", None).is_err());
    assert!(bindings.bind_value("endpoint/legacy-id", None).is_ok());
}
