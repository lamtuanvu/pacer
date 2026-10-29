# pacer-plugin

The Rust plugin SDK for pacer, implementing the `@pacer/plugin` wire contract.

Version 0.1 supports plugin protocol 1.x. SDK and protocol crate versions are independent of the pacer application version.

## Install

Add the crate to your Rust plugin binary:

```
cargo add pacer-plugin
```

The crate is unpublished until pacer's M1 migration completes. Until then,
point Cargo at it by path, for example:

```
pacer-plugin = { path = "../plugin-sdk" }
```

Plugins need a `tokio` runtime (see the `serve` method) and a
`pacer-plugin.json` manifest next to the binary. See
[the plugin protocol](../../docs/plugin-protocol.md) for the wire contract and the
manifest schema.

## Usage

A plugin is a subprocess the host starts lazily. Register handlers that answer
extension points, then serve on stdio. Requests are newline-delimited JSON-RPC
2.0 on stdin/stdout, handled for you by `serve`/`serve_stdio`:

```rust
use pacer_plugin::{Manifest, Plugin, PluginError};
use serde_json::json;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let manifest = Manifest(json!({
        "id": "usage",
        "version": "0.1.0",
        "publisher": "example",
        "host": "^1",
        "contributes": { "usage": {} }
    }));

    let plugin = Plugin::new(manifest)
        .handle("usage.read", |_params, ctx| async move {
            let f = ctx.host.call("capability.fs.read", json!({"path": "$HOME/x"})).await?;
            Ok(json!({ "windows": [], "text": f["text"] }))
        })
        // diagnostic.ping is served automatically by the SDK.
        .handle("executor.run", |_params, ctx| async move {
            ctx.progress.send(json!({ "stage": "start" }));
            Ok(json!({ "ok": true }))
        });

    plugin.serve_stdio().await
}
```

A handler failing a call returns `Err(PluginError::new("code", "message"))`;
the host sees `{ code: -32000, data: { code, message } }`. `ctx.cancel`
(token) fires when the host cancels the call; `ctx.host` lets you make
capability calls (plugin → host); `ctx.progress` sends `$/progress`
notifications. For typed params/results, use `handle_typed` together with the
generated types and enable the `testing` feature.

## Manifest example

`pacer-plugin.json` next to the binary (or in the plugin folder under
`$PACER_HOME/plugins/<id>/`, where the folder name must equal `id`). The
`entry` is the binary the host starts; the `contributes` keys name the
extension points this plugin serves:

```json
{
  "id": "usage",
  "version": "0.1.0",
  "publisher": "example",
  "host": "^1",
  "entry": "<binary>",
  "contributes": { "usage": {} }
}
```

## Harness

With the `testing` feature enabled, `pacer_plugin::testing::Harness` drives a
plugin in-process against a fake host, so you can exercise handlers without
spawning a subprocess. It replies to `plugin.hello` with the grants you
declare, lets you answer capability calls by name, and records progress and
capability calls:

```rust
use pacer_plugin::{
    Manifest, Plugin,
    testing::{Harness, HelloSpec},
};
use serde_json::json;

#[tokio::test]
async fn usage_read_via_harness() {
    let plugin = Plugin::new(Manifest(
        json!({"id":"u","version":"1.0.0","publisher":"t","host":"^1","contributes":{"usage":{}}}),
    ))
    .handle("usage.read", |_params, ctx| async move {
        ctx.progress.send(json!({"step": 1}));
        let f = ctx.host.call("capability.fs.read", json!({"path": "$HOME/x"})).await?;
        Ok(json!({"windows": [], "text": f["text"]}))
    });

    let mut h = Harness::start(
        plugin,
        HelloSpec { grants: vec!["fs.read".into()], ..Default::default() },
    )
    .await;
    h.on_capability("capability.fs.read", |_| Ok(json!({"text": "hi"})));

    let r = h.call("usage.read", json!({"account": "a"})).await.unwrap();
    assert_eq!(r["text"], "hi");
    assert_eq!(h.progress(), vec![json!({"step": 1})]);
    assert_eq!(h.capability_calls()[0].0, "capability.fs.read");
    h.close().await;
}
```

A capability with no `on_capability` answer is denied with `capability_denied`.
`Harness.start` requires the `testing` feature (`--features pacer-plugin/testing`).

## Protocol reference

See [docs/plugin-protocol.md](../../docs/plugin-protocol.md) for the wire
protocol, manifest schema, extension points, capabilities and error codes.
