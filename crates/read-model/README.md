# pacer-read-model

Plan 8 read-model library at workspace layer 7. It registers no native operations
and takes no HTTP, stdio, timer, plugin, or background-loop ownership.

`ReadModel::snapshot` reads the shared task SQLite database (including the store's
legacy JSON import), messages/liveness, discovery, pause/hold, repository and
legacy link state. Status and external probe results are explicit inputs:
`Probes.setup` is the deferred setup checklist; policy, machine signals, service
identity and desktop update readings belong to their existing owners. A cache
miss with `StatusInput::Cached` asks the caller for a fresh status rather than
starting a second status owner. Successful injected statuses refresh the cache;
failed/warming reads do not replace it. Holds and pauses are read each time.

Use `SnapshotResult::json`, `tasks::snapshot_document` and
`events::events_document` for wire bytes. Structured `Value` access is convenient
for normal Unicode, but cannot represent a JavaScript substring ending with a
lone UTF-16 surrogate. Wire documents retain those substrings separately without
using magic sentinel values in untrusted JSON. Number serialization follows JS
binary64 and `JSON.stringify`, including numeric-key order.

`events::SseCursor` implements cursor validation, polling, retention and protocol
resets, frames, cancellation and the 15-second heartbeat. Its transport owner
must send `CONNECTED`, schedule external-writer polling and heartbeat ticks, and
remove both schedules/subscriptions on cancellation. No listener is opened here.

The TypeScript driver compares Rust output byte for byte before checking the
unchanged #570 goldens. `rust-cases.json` stores portable input homes and complete
TS outputs for standalone `cargo test -p pacer-read-model --locked` replay. To
refresh the input capture, set `EXPORT_RUST_READ_MODEL=1` when running
`bun test test/read-model-parity.test.ts`; this does not update the TS goldens.
The probe example is a test adapter and is never installed.

## Session projection boundary

This crate covers the session *surface* used by the TS read model today: active
sessions (`state == "starting"` or no exit evidence), their per-task and
per-executor counts, and their folding into `machine.used`, `capacity`, task
`activeAgentSessions` and summary running/today counts. It accepts the owner's
`agentSessionsRevision` verbatim and never re-derives it; the reformat-block,
pump-debounce and persisted-message variants of the revision contract live in the
TS owner and are out of scope here.

Full session *projection* — the per-session detail rows, lifecycle timeline and
historical attempt views exposed by `src/api/events`' member methods — is
deferred: that path stays in TypeScript and is not mirrored in Rust. Only the
counts and revision the snapshot needs are translated.
