# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and cleanup. The P3-B publisher from #553 is absent from this base. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list`, `task.prune`, `task.restore` | Forwarded | Queue/lifecycle and retention behavior belong to later cutovers. |

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. This slice does not move the `/v3/tasks/<id>/log?follow=1` SSE route or any `/v2` route.

## P4b shadow capability effects

`pacer-plugin-host` retains registry/RPC admission and re-exports the capability
runtime from `pacer-plugin-runtime`. The runtime includes concrete Orca attempt
execution, fixed SSH transport, Git bundle inspection and task-owned transfer
publication. Its inputs come from the host; plugins still send bounded
task/attempt requests. This is a library-only slice: it adds no native operation,
changes no TypeScript runtime handler, and leaves the operation routes above
unchanged.

Run `cargo test -p pacer-plugin-host -p pacer-plugin-runtime -p pacer-plugin-wire -p pacer-js-json -p pacer-bun-glob -p pacer-store --locked` for native
effects and adversarial fixtures. The script freshness check is
`bun run test test/plugins-native-fixed-scripts.test.ts`. A live front-door status
and plugin-list smoke check exercises the authoritative TypeScript path; it does
not establish native executor or desktop integration. Report those unavailable
native surfaces as UNVERIFIED until cutover. See the runtime README for the
coverage seams and crate-size split boundary.

P4b slice 5 also composes native Orca preparation/account/MCP/launch policy and
stopped-lane/group cleanup. The lower-layer `pacer-plugin-wire` keeps bounded
payload staging and lossless UTF-16 JSON delivery below runtime ownership; use
the lossless broker path when connecting Orca RPC. Native registration remains
absent, and the TS host remains authoritative. See
[ADR 0019](../decisions/0019-native-plugin-runtime-ownership.md).

Lossless task JSON is shared with the existing store rather than a second native
state format. Concrete tests cover clipped questions through settlement, SQLite
reopening and JSON write-through. The existing native `task.log` can read those
records; its live harness evidence is separate from unregistered shadow effects.
