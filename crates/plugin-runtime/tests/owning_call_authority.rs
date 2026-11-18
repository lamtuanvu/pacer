#![allow(clippy::unwrap_used)]
//! A native capability session answers scoped capabilities only inside the
//! owning call Core sealed, like the TypeScript host's `answerCapability`.

use pacer_plugin_runtime::{
    PluginCapabilitySession, call_resources_from_value, core_capability, session_for_call,
    session_from_hello,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
use tempfile::TempDir;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/owning-call-methods.json"
    ))
    .unwrap()
}

fn hello(capability: &str, scopes: &[&str]) -> Value {
    let declared = if scopes.is_empty() {
        json!({"name":capability})
    } else {
        json!({"name":capability,"scopes":scopes})
    };
    json!({
        "protocol":"1.10.0","pacer":"0.2.0",
        "manifest":{
            "id":"fx-owning","version":"1.0.0","publisher":"fixture","host":">=1.10.0",
            "capabilities":[declared],
            "contributes":{"diagnostic":{}}
        },
        "config":{},"grants":[capability],"features":[]
    })
}

fn issued(hello: &Value, resources: Value, authority: Value) -> PluginCapabilitySession {
    let capability = hello["grants"][0].as_str().unwrap().to_owned();
    let mut session = session_for_call(
        hello,
        call_resources_from_value(&resources).unwrap(),
        Some(vec![capability]),
        Duration::from_secs(10),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    session.seal_call_authority(&authority);
    session
}

async fn answer(
    session: &mut PluginCapabilitySession,
    method: &str,
    params: Value,
) -> Result<Value, Value> {
    tokio::time::timeout(Duration::from_secs(5), session.answer(method, params, None))
        .await
        .unwrap_or_else(|_| panic!("{method} did not answer"))
}

/// Counts every connection a capability makes to it.
fn listener() -> (String, Arc<AtomicUsize>) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/", socket.local_addr().unwrap().port());
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = hits.clone();
    thread::spawn(move || {
        for mut stream in socket.incoming().flatten() {
            seen.fetch_add(1, Ordering::SeqCst);
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        }
    });
    (url, hits)
}

fn scopes_for(capability: &str) -> &'static [&'static str] {
    match capability {
        "fs.read" | "fs.write" => &["/tmp/fx-owning/**"],
        "process.spawn" => &["/bin/echo"],
        "net.http" => &["127.0.0.1"],
        _ => &[],
    }
}

#[tokio::test]
async fn every_scoped_method_outside_an_owning_call_is_refused_with_the_typescript_text() {
    let fixture = fixture();
    let refusal = fixture["refusal"].as_str().unwrap();
    for (method, capability) in fixture["scoped"].as_object().unwrap() {
        let capability = capability.as_str().unwrap();
        let hello = hello(capability, scopes_for(capability));
        let mut session = session_from_hello(&hello, Duration::from_secs(10)).unwrap();
        let error = answer(&mut session, method, json!({})).await.unwrap_err();
        assert_eq!(error["message"], refusal, "{method}");
        assert_eq!(error["data"]["code"], "capability_denied", "{method}");

        let mut owning = issued(&hello, json!({}), json!({"owning": true}));
        if let Err(error) = answer(&mut owning, method, json!({})).await {
            assert_ne!(error["message"], refusal, "{method} inside an owning call");
        }

        let mut undeclared =
            session_from_hello(&self::hello("log", &[]), Duration::from_secs(10)).unwrap();
        let error = answer(&mut undeclared, method, json!({}))
            .await
            .unwrap_err();
        assert_ne!(
            error["message"], refusal,
            "undeclared {method} is refused first"
        );
    }
    for (method, capability) in fixture["unscoped"].as_object().unwrap() {
        let hello = hello(capability.as_str().unwrap(), &[]);
        let mut session = session_from_hello(&hello, Duration::from_secs(10)).unwrap();
        if let Err(error) = answer(&mut session, method, json!({})).await {
            assert_ne!(error["message"], refusal, "{method} needs no owning call");
        }
    }
}

#[tokio::test]
async fn an_exact_read_path_is_refused_without_an_owning_call_or_its_issued_read() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("note.txt");
    fs::write(&file, "exact-path-secret").unwrap();
    let path = file.to_str().unwrap();
    let hello = hello("fs.read", &[path]);

    let mut outside = session_from_hello(&hello, Duration::from_secs(10)).unwrap();
    let error = answer(&mut outside, "capability.fs.read", json!({"path":path}))
        .await
        .unwrap_err();
    assert_eq!(error["message"], fixture()["refusal"]);
    assert_eq!(error["data"]["code"], "capability_denied");

    let mut empty = issued(&hello, json!({}), json!({"owning": true}));
    let error = answer(&mut empty, "capability.fs.read", json!({"path":path}))
        .await
        .unwrap_err();
    assert_eq!(error["data"]["code"], "capability_denied");
    assert_ne!(error["message"], fixture()["refusal"]);
    assert!(!error.to_string().contains("exact-path-secret"));

    let mut read = issued(
        &hello,
        json!({"reads":[{"path":path,"kind":"file"}]}),
        json!({"owning": true}),
    );
    let text = answer(&mut read, "capability.fs.read", json!({"path":path}))
        .await
        .unwrap();
    assert_eq!(text["text"], "exact-path-secret");
}

#[tokio::test]
async fn a_declared_http_host_gets_no_request_without_an_owning_call_or_its_issued_host() {
    let (url, hits) = listener();
    let hello = hello("net.http", &["127.0.0.1"]);
    let request = json!({"url":url,"method":"GET","timeoutMs":2000});

    let mut outside = session_from_hello(&hello, Duration::from_secs(10)).unwrap();
    let error = answer(&mut outside, "capability.net.http", request.clone())
        .await
        .unwrap_err();
    assert_eq!(error["message"], fixture()["refusal"]);
    assert_eq!(error["data"]["code"], "capability_denied");

    let mut empty = issued(&hello, json!({}), json!({"owning": true}));
    let error = answer(&mut empty, "capability.net.http", request.clone())
        .await
        .unwrap_err();
    assert_eq!(error["data"]["code"], "capability_denied");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "no listener hits without an issued host"
    );

    let mut http = issued(
        &hello,
        json!({"http":{"hosts":["127.0.0.1"]}}),
        json!({"owning": true}),
    );
    answer(&mut http, "capability.net.http", request)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_declared_wildcard_host_needs_the_sealed_explicit_grant() {
    let (url, hits) = listener();
    let hello = hello("net.http", &["*"]);
    let request = json!({"url":url,"method":"GET","timeoutMs":2000});
    let resources = json!({"http":{"hosts":["*"]}});

    for authority in [
        json!({"owning": true}),
        json!({"owning": true, "explicitWildcardGrant": "true"}),
    ] {
        let mut session = issued(&hello, resources.clone(), authority);
        let error = answer(&mut session, "capability.net.http", request.clone())
            .await
            .unwrap_err();
        assert_eq!(error["data"]["code"], "capability_denied");
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    let mut granted = issued(
        &hello,
        resources,
        json!({"owning": true, "explicitWildcardGrant": true}),
    );
    answer(&mut granted, "capability.net.http", request)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_undeclared_signature_request_reaches_core_so_core_audits_its_refusal() {
    let mut session = issued(&hello("log", &[]), json!({}), json!({}));
    let (core, mut requests) = tokio::sync::mpsc::channel::<pacer_plugin_runtime::CoreRequest>(4);
    let sealed = ["capability.identity.sign", "capability.secrets.resolve"]
        .map(String::from)
        .into();
    session.bind_core(core, sealed, false);
    let denied = json!({"code":-32000,"message":"plugin fx-owning did not declare identity.sign","data":{"code":"capability_denied"}});
    let answered = denied.clone();
    let core_side = tokio::spawn(async move {
        let mut forwarded = Vec::new();
        while let Some((method, _, reply)) = requests.recv().await {
            forwarded.push(method);
            let _ = reply.send(Err(answered.clone()));
        }
        forwarded
    });
    let sign = json!({"purpose":"greeting","payload":"aGVsbG8="});
    let signed = answer(&mut session, "capability.identity.sign", sign)
        .await
        .unwrap_err();
    assert_eq!(signed, denied);
    let resolve = json!({"ref":"endpoint:lab"});
    let resolved = answer(&mut session, "capability.secrets.resolve", resolve)
        .await
        .unwrap_err();
    assert_eq!(
        resolved["message"],
        "plugin did not declare secrets.resolve"
    );
    drop(session);
    assert_eq!(core_side.await.unwrap(), ["capability.identity.sign"]);
}

#[tokio::test]
async fn detached_stop_inspection_and_remote_stop_reach_core_only_when_sealed() {
    for (method, capability) in [
        ("capability.process.stopRun", "process.spawn"),
        ("capability.process.inspectRun", "process.spawn"),
        ("capability.hosts.stopOwned", "hosts"),
    ] {
        assert_eq!(core_capability(method), Some(capability), "{method}");
        let hello = hello(capability, scopes_for(capability));
        let mut params = json!({"taskId":"t-20260101-000000-abcd","attempt":1});
        if method != "capability.process.inspectRun" {
            params["graceMs"] = json!(3000);
        }
        // Core keeps the one-use grant and answers with its flag-off broker.
        let refused = json!({"code":-32000,"message":"not issued for this call","data":{"code":"capability_denied"}});
        for sealed in [true, false] {
            let mut session = issued(&hello, json!({}), json!({"owning": true}));
            let (core, mut requests) =
                tokio::sync::mpsc::channel::<pacer_plugin_runtime::CoreRequest>(4);
            let methods = if sealed {
                [method.to_owned()].into()
            } else {
                Default::default()
            };
            session.bind_core(core, methods, false);
            let answered = refused.clone();
            let core_side = tokio::spawn(async move {
                let mut forwarded = Vec::new();
                while let Some((method, _, reply)) = requests.recv().await {
                    forwarded.push(method);
                    let _ = reply.send(Err(answered.clone()));
                }
                forwarded
            });
            let error = answer(&mut session, method, params.clone())
                .await
                .unwrap_err();
            drop(session);
            let forwarded = core_side.await.unwrap();
            if sealed {
                assert_eq!(error, refused, "{method}");
                assert_eq!(forwarded, [method], "{method}");
            } else {
                assert!(forwarded.is_empty(), "unsealed {method} never reaches Core");
            }
        }
    }
}
