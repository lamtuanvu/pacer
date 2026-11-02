# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.install` | Native | Retired operation: exact `not_allowed` response; TypeScript remains the forced-forward and `/v2` fallback. |
| `plugin.list`, `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.doctor` | Native HTTP | Rust handles public operations and persistence; Core supplies generation-bound process snapshots, RPC, stop and event publication over authenticated private IPC. Stdio and forced-forward requests retain the TS reference. |
| `plugin.ui.list`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.get`, `plugin.settings.set` | Native HTTP | Rust owns surface checks, document validation/cache/rate limits and settings CAS. The same Core plugin process owner serves RPC; TS remains the fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and cleanup. The P3-B publisher from #553 is absent from this base. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list`, `task.prune`, `task.restore` | Forwarded | Queue/lifecycle and retention behavior belong to later cutovers. |

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. This slice does not move the `/v3/tasks/<id>/log?follow=1` SSE route or any `/v2` route.

P4c provides the complete plugin operation table in
`pacer_plugin_host::public::PublicRegistry`, plus settings/config persistence,
closed UI documents, archive verification and publisher trust. The registry takes
an explicit authoritative process runtime; without it, process-owning operations
select TypeScript fallback. The HTTP service supplies that adapter through its
supervised Core's authenticated `/_internal/plugins` channel. The public listener
rejects all private routes. Requests pin a Core generation and never retry
mutations after an uncertain IPC outcome. The native UI cache follows Core
invalidation and is discarded when Core restarts. Stdio retains its existing TS
process owner and forwards these eleven operations; `plugin.install` is native
on both transports. `PACER_FORWARD_OPS` can force any HTTP operation back to
TypeScript. The registry never creates a second plugin host.

Archive inspection/signature verification/extraction and publisher trust are
native library implementations. They have no new public operation (`plugin.install`
remains retired) and no runtime caller in this cutover. Their shared-fixture parity
is library evidence, with live behavior UNVERIFIED under the unserved-library
exception in `.project/decisions.md`.
