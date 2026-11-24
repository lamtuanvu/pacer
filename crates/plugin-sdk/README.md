# pacer-plugin

The Rust plugin SDK for pacer, implementing the `@pacer/plugin` wire contract.

Version 0.5 supports plugin protocol 1.x. SDK and protocol crate versions are independent of the pacer application version.

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

## Features

The SDK negotiates optional protocol features with the host on `plugin.hello`,
mirroring the feature gate in `@pacer/plugin`. Call `Plugin::features(...)` with
the feature names from `pacer_plugin::TS_SDK_FEATURES` (or a subset) to opt in:

```rust
use pacer_plugin::{TS_SDK_FEATURES, FEATURE_CHUNKED_RESULTS};

let plugin = Plugin::new(manifest)
    .features(TS_SDK_FEATURES)
    .handle("usage.read", |_params, ctx| async move {
        // Negotiated features read back through the request context.
        if ctx.negotiated(FEATURE_CHUNKED_RESULTS) {
            // ...
        }
        Ok(json!({}))
    });
```

The negotiated set is the plugin's requested features intersected with the
features the host offered and the minimum protocol version each feature requires.
`Ctx::negotiated(feature)` reports whether a feature is active for a call.
Features are echoed back in the `hello` response only when the plugin requested
them, so plugins that never call `.features(...)` keep the pre-negotiation
hello shape.

Chunked results are enabled automatically when `chunkedResults` is negotiated:
a `usage.read` result larger than 768 KiB is delivered as `$/resultChunk`
messages and reassembled by the host, so large results are not bounded by a
single JSON-RPC frame.

## Capability calls and cancellation

`ctx.host.call(method, params)` makes a capability call and returns the result.
The owning call's cancellation token is honoured:

- a call made after the owning call has been cancelled is refused before a
  round trip (`plugin_unavailable` "owning plugin call ended");
- a call that is pending when the owning call is cancelled is rejected with the
  same error;
- a call whose reply is in flight but unsent reports the plugin's result
  (matching the TypeScript SDK's scoped-abort behaviour).

`ctx.host.call_cleanup(method, params)` is the cleanup variant
(`cleanupCall`): it performs the call even when the owning call has been
cancelled, which lets a plugin tear down resources after cancellation.

`ctx.host.secrets_present(reference)` checks whether a secret reference
(`secrets:...`) is present (`capability.secrets.check`).

## HTTP capability

`ctx.host.http(request)` makes a `capability.net.http` call and returns an
`HttpResponse { status, headers, body }`. The request passes through as JSON
(`url`, `method`, `headers?`, `body?`, `timeoutMs`, `authorization?`), so
numbers keep their JSON form:

```rust
let resp = ctx.host.http(json!({
    "url": "https://example.com/status",
    "method": "GET",
    "timeoutMs": 5000,
})).await?;
let status = resp.status;
```

Like the TypeScript SDK, `Host::http` transparently stages and reads bodies
larger than a single JSON-RPC frame through `httpBodyChunks`:
- when the request or response exceeds one frame and `httpBodyChunks` was not
  negotiated, the call fails with `internal` "HTTP oversized request requires
  httpBodyChunks" / "invalid HTTP response body descriptor";
- a request `body` is limited to 4 MiB (UTF-8), and the decoded response
  body is also limited to 4 MiB;
- protocol handles are limited to 256 characters and chunk acknowledge/reply
  mismatches fail with the corresponding `internal` error.

`Host::http` serialises transactions so only one complete HTTP call runs at a
time per caller, matching the TypeScript `createHttp` latch. Cleanup (release
of any staged upload/download handle) is always performed, even after errors or
cancellation, and a cleanup failure cannot turn the call into a success.

## Error reasons

`PluginError` carries an optional `reason` (`with_reason`). The `reason` is
propagated to the host on the wire only for `capability_denied` with reason
`credential_reflection`; for every other combination it is dropped, matching
`@pacer/plugin`. The host maps a `capability_denied`/`credential_reflection`
reason back into the plugin as `PluginError.reason`. The testing `Harness`
simulates host-side errors with `HostError`
(`HostError::new(code, message).reason("credential_reflection")`); the SDK maps
a `HostError.reason` onto the handler's `PluginError` for the same
`capability_denied` + `credential_reflection` combination.

## JavaScript helpers

`pacer_plugin::js` ports the small text and number helpers the bundled
TypeScript entry points rely on, so Rust rewrites of those plugins behave
identically:

- `js::trim` — ECMAScript `trim` (WhiteSpace + LineTerminator, incl. U+FEFF);
- `js::utf16_len` / `js::slice_utf16` — UTF-16 code-unit counting and
  `String.prototype.slice`, mostly (`slice` splits a surrogate pair into
  `U+FFFD`, a documented, deliberate deviation);
- `js::number_string` — `Number.prototype.toString` (via `ryu-js`);
- `js::safe_integer` / `js::finite_number` — `Number.isSafeInteger` and
  `Number.isFinite` over JSON values;
- `js::base64` — strict (`encode`/`decode`) and lenient (`decode_lenient`,
  like `Buffer.from(s, "base64")`) base64.

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

The harness sends numeric request ids (as the bundled `process.ts` does) and
answers `$/resultChunk` itself unless the test registers its own handler. Use
`on_capability_async` to answer with an async future that returns
`Result<Value, HostError>`, and `call_unowned` to send a request with no
owning-call `_meta`. `raw_results()` returns replies exactly as received
(including `{_chunkedResult:{bytes}}`), while `call` always returns the
reassembled value; `hello_result()` exposes the raw `plugin.hello` reply. An
error response with only `code`/`message` maps to `HostError` so tests can also
use `on_capability` unchanged.

## Usage reader IO

With the Cargo `usage` feature (`--features pacer-plugin/usage`), the SDK
exposes `pacer_plugin::usage` (the port of `@pacer/plugin` `usage.ts`): the
`ReaderIo` host-adapter that quota readers use to read files, spawn providers
and own a usage-state lease without touching the ambient filesystem or process
state. Every read, stat, list, range, spawn and usage-state interaction is
mapped onto the fixed capability methods (`capability.fs.read`, …,
`capability.process.spawn`, `capability.usage.state.*`) in
`pacer_plugin::usage::reader_io`, matching `createUsageReaderIO` in the TS
SDK byte-for-byte:

```rust
use pacer_plugin::{
    Manifest, Plugin,
    usage::{ReaderIo, reader_io},
};
use serde_json::json;

let plugin = Plugin::new(Manifest(
    json!({"id":"u","version":"1.0.0","publisher":"t","host":"^1","contributes":{"usage":{}}}),
))
.handle("usage.read", |params, ctx| async move {
    let io = reader_io(&ctx.host);
    let Some((text, _mtime)) = io.read(params["path"].as_str().unwrap_or("")).await? else {
        return Ok(json!({"windows": [], "error": "missing"}));
    };
    Ok(json!({"windows": [], "text": text}))
});
```

`usage` brings the `ReaderIo` trait along with its `read`/`list`/`stat`/
`range`/`run`/`cached_fetch`/`cursors`, the `FileInfo`, `RunResult`,
`Cursor` and `CursorFiles` types, and `reader_io(&host)`. Bundled provider
readers (`plugins-rs/pacer-usage`) are built on it and share the same
capability contract, so a single set of host answers drives both the TypeScript
and the Rust readers to identical transcripts.

## Protocol reference

See [docs/plugin-protocol.md](../../docs/plugin-protocol.md) for the wire
protocol, manifest schema, extension points, capabilities and error codes.

For 0.2, agent-session/native identity types live in the independent publishable `pacer-plugin-agent-protocol` area. SDK consumers retain `pacer_plugin::types::AgentSession*` paths through its facade; direct 0.2protocol consumers import those types from the new crate. Generic lifecycle and CallMetadata remain in the root protocol crate. No wire fields/validation change and the immutable 0.1 release lane is unaffected. See [area decision](../../docs/decisions/0007-plugin-protocol-area-splits.md).

Observation/decision extension types likewise move to independent publishable `pacer-plugin-dispatch-protocol` 0.2; the SDK type facade preserves their names. No protocol area has a layer-0 peer dependency.

Assistant turn and assistant tool types (`assistant.reply`, `capability.assistant.tool`, protocol 1.11.0) live in independent publishable `pacer-plugin-assistant-protocol` 0.3, with the same `pacer_plugin::types` facade names. 0.3 adds the optional `endpoint.baseUrl` field on `assistant.reply` params.

Host-runner and host capability types live in independent publishable `pacer-plugin-hosts-protocol` 0.2, with the same `pacer_plugin::types` facade names. See [ADR 0009](../../docs/decisions/0009-plugin-hosts-protocol-area.md).

Executor and process capability types live in independent publishable `pacer-plugin-exec-protocol` 0.2. The `pacer_plugin::types` facade preserves their names; direct `pacer_plugin_protocol` imports of those types use the new area crate. See [ADR 0010](../../docs/decisions/0010-plugin-exec-protocol-area.md).
