# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and cleanup. The P3-B publisher from #553 is absent from this base. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list`, `task.prune`, `task.restore` | Forwarded | Queue/lifecycle and retention behavior belong to later cutovers. |

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. This slice does not move the `/v3/tasks/<id>/log?follow=1` SSE route or any `/v2` route.

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.
