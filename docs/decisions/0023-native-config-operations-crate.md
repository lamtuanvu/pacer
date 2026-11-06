# ADR 0023 — Native configuration operations crate

Status: proposed; the maintainer chose the design and accepts it by merging the PR.

`pacer-server` grew to 21,622 hand-written lines as M2 ported operations, past
the CRATE-1 hard limit. About 12,700 of those lines are native operation
handlers under `crates/server/src/native/`, and they split along two domain
seams: configuration and host metadata, and tasks and dispatch.

`pacer-config-ops` (`crates/config-ops`) is an unpublished layer-7 domain crate
with a target budget of 5,000 lines and no heavy dependencies. It owns the
native handlers for `strategy.*`, `routing.get`/`routing.set`, `runner.*`,
`notifications.*`, `config.get`/`config.set`, `host.*` reads and mutations,
`repo.*`, `machine.*` (with the identity store), `project.messaging.*`,
`discovery.set`/`discovery.respond`, `onboarding.skip`, `setup.check` and
`files.search`, plus the shared zod-compatible parameter errors
(`params::{invalid, object, type_name}`) that other handler crates import. It
depends only on `pacer-foundation`, `pacer-config`, `pacer-store` and
`pacer-lifecycle`. It never depends on `pacer-server`, axum, hyper or transport
code. Handlers that need Core bridge data take it as `OpFuture` parameters or
plain values.

`pacer-server` keeps the `NativeOp` registry and `call_native` dispatch, the
bridge (`*_sync`) modules, the HTTP, stdio and MCP transports, and the
registry metadata operations (`version.get`, `api.list`, `api.describe`).
Those operations read the server's op catalog and build version, so they stay with the
registry. Public paths such as `pacer_server::native::call_native` and the
helpers used by the server examples are unchanged; the server re-exports them.

This is a move with no behavior change: operation names, registry order,
forwarding decisions, error text and wire output are identical. A second crate,
`pacer-task-ops`, will take the task, dispatch, messaging, status/engine and
assistant handlers in a later PR. PR evidence records exact sizes and CRATE-9
clean and incremental build timings.
