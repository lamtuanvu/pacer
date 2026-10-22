#![allow(clippy::unwrap_used)]
use pacer_plugin::{Manifest, Plugin, PluginError};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn manifest() -> Manifest {
    Manifest(
        json!({"id":"fx","version":"1.0.0","publisher":"t","host":"^1","contributes":{"diagnostic":{}}}),
    )
}
fn hello() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"plugin.hello","params":{"protocol":pacer_plugin_protocol::VERSION,"pacer":"0","manifest":manifest().0,"config":{},"grants":[]}})
}

struct Pipe {
    tx: tokio::io::DuplexStream,
    rx: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
}
impl Pipe {
    async fn send(&mut self, v: Value) {
        self.tx
            .write_all(format!("{v}\n").as_bytes())
            .await
            .unwrap();
    }
    async fn next(&mut self) -> Value {
        let l = tokio::time::timeout(Duration::from_secs(3), self.rx.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(&l).unwrap()
    }
}
fn start(p: Plugin) -> (Pipe, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (host_w, plugin_r) = tokio::io::duplex(1 << 16);
    let (plugin_w, host_r) = tokio::io::duplex(1 << 16);
    let task = tokio::spawn(p.serve(BufReader::new(plugin_r), plugin_w));
    (
        Pipe {
            tx: host_w,
            rx: BufReader::new(host_r).lines(),
        },
        task,
    )
}

#[tokio::test]
async fn handshake_ping_errors_and_unknown_methods() {
    let p = Plugin::new(manifest()).handle("usage.read", |_p, _c| async {
        Err(PluginError::new("invalid_input", "no account"))
    });
    let (mut io, task) = start(p);
    io.send(json!({"jsonrpc":"2.0","id":2,"method":"diagnostic.ping","params":{}}))
        .await;
    assert_eq!(io.next().await["error"]["data"]["code"], "plugin_refused");
    io.send(hello()).await;
    let h = io.next().await;
    assert_eq!(
        h["result"],
        json!({"protocol":pacer_plugin_protocol::VERSION,"id":"fx","version":"1.0.0","contributes":["diagnostic"]})
    );
    io.send(json!({"jsonrpc":"2.0","id":3,"method":"diagnostic.ping","params":{}}))
        .await;
    assert_eq!(io.next().await["result"]["ok"], true);
    io.send(json!({"jsonrpc":"2.0","id":4,"method":"usage.read","params":{}}))
        .await;
    let e = io.next().await;
    assert_eq!(
        (
            e["error"]["code"].as_i64(),
            e["error"]["message"].as_str(),
            e["error"]["data"]["code"].as_str()
        ),
        (Some(-32000), Some("no account"), Some("invalid_input"))
    );
    io.send(json!({"jsonrpc":"2.0","id":5,"method":"nope","params":{}}))
        .await;
    assert_eq!(io.next().await["error"]["code"], -32601);
    drop(io);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn capability_calls_and_cancel() {
    let p = Plugin::new(manifest()).handle("diagnostic.ping", |_p, c| async move {
        let cfg = c.host.config().await?;
        tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = c.cancel.cancelled() => {} }
        Ok(json!({"ok": true, "uptimeS": 0, "cfg": cfg, "cancelled": c.cancel.is_cancelled()}))
    });
    let (mut io, task) = start(p);
    io.send(hello()).await;
    io.next().await;
    io.send(json!({"jsonrpc":"2.0","id":2,"method":"diagnostic.ping","params":{}}))
        .await;
    let req = io.next().await;
    assert_eq!(
        (req["method"].as_str(), req["id"].as_str()),
        (Some("capability.config.get"), Some("p1"))
    );
    io.send(json!({"jsonrpc":"2.0","id":"p1","result":{"config":{"region":"eu"}}}))
        .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    io.send(json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":2}}))
        .await;
    let r = io.next().await;
    assert_eq!(r["result"]["cfg"], json!({"region":"eu"}));
    assert_eq!(r["result"]["cancelled"], true);
    drop(io);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn progress_and_eof_fail_pending_calls() {
    let p = Plugin::new(manifest()).handle("executor.run", |_p, c| async move {
        c.progress.send(json!({"stage":"start"}));
        let err = c
            .host
            .call("capability.tasks.read", json!({}))
            .await
            .unwrap_err();
        Ok(json!({"code": err.code}))
    });
    let (mut io, task) = start(p);
    io.send(hello()).await;
    io.next().await;
    io.send(json!({"jsonrpc":"2.0","id":7,"method":"executor.run","params":{}}))
        .await;
    let prog = io.next().await;
    assert_eq!(
        (prog["method"].as_str(), prog["params"]["id"].as_i64()),
        (Some("$/progress"), Some(7))
    );
    let _call = io.next().await; // capability.tasks.read
    drop(io.tx); // EOF: pending call fails, handler settles, serve returns
    task.await.unwrap().unwrap();
}
