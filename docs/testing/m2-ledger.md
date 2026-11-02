# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Forwarded | Rust `pacer_config::settings::get_settings` owns the pure key/source read model. Terminal availability, machine guard/slot use and planner candidates are injected host fields; public routing remains in TypeScript. |
| `config.set` | Forwarded | Rust `pacer_config::settings::set_setting` ports all 16 pure keys, including whole-strategy validation, normalization, errors, byte-preserving edits, diff and undo. Publication and public routing stay in TypeScript. |
| `host.account.add` | Forwarded | SSH account configuration and host adapter dependencies remain in TypeScript. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.install` | Native | Retired operation: exact `not_allowed` response; TypeScript remains the forced-forward and `/v2` fallback. |
| `plugin.list`, `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.doctor` | Native HTTP | Rust handles public operations and persistence; Core supplies generation-bound process snapshots, RPC, stop and event publication over authenticated private IPC. Stdio and forced-forward requests retain the TS reference. |
| `plugin.ui.list`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.get`, `plugin.settings.set` | Native HTTP | Rust owns surface checks, document validation/cache/rate limits and settings CAS. The same Core plugin process owner serves RPC; TS remains the fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and cleanup. The P3-B publisher from #553 is absent from this base. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list`, `task.prune`, `task.restore` | Forwarded | Queue/lifecycle and retention behavior belong to later cutovers. |

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C.

PR #585 adds the native `/v3/tasks/<id>/log?follow=1` SSE route. It retains a read-only SQLite connection, detects database replacement, and drains bounded output chunks before `done`. When a read needs a legacy JSON import, an older schema migration, or malformed-record semantics, it calls the existing TypeScript `task.log` fallback with the current byte offsets. That core read performs the shared durable import; no per-stream import cache or new Rust state writer is used. The same fallback applies after a stream connects. All `/v2` routes and `/v3/events` remain forwarded.

Like the TypeScript reference, follow mode resets the stderr byte offset to zero
when a task has no run record. If a later poll sees a restored run, its stderr
starts at byte zero. A missing stderr file on an existing run retains the offset.
The connected v3/v2 regression observes the missing-run poll before restoring it.
The independent TaskStore importer matrix uses separate Rust and TypeScript homes
and compares accepted/rejected records and the Rust database contents for every
numeric validation field (`rev`, `createdAt`, attempt `startedAt` and `endedAt`).

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

## Config library boundary

This slice registers no native operation and changes no TypeScript runtime code.
The TypeScript handlers remain the runtime reference and fallback. The Rust
settings functions operate on an explicitly supplied strategy path/name; the
service caller must serialize writers and publish exactly one config change after
successful mutation before any future native cutover. Files are replaced through
the existing private atomic strategy writer (0600 files, 0700 directories).

The complete pure setter allow-list is `execution.auto_clean`,
`task_retention_days`, `execution.local_max_tasks`,
`execution.local_memory_pressure_limit`, `execution.local_load_limit`,
`execution.launch_mode`, `pacing.order`, `pacing.policy`,
`pacing.planner_reserve`, `pacing.planner_reserve_headroom`,
`pacing.planner_probe`, `pacing.accounts`, `pacing.fill_threshold`, `update_check`,
`terminal.app` and `terminal.open`. The read model includes all 18 keys.

| Retained dependency | Forwarding boundary |
| --- | --- |
| Planner install/uninstall and rollback | All `planner` writes, including skip, remain on `config.set` in TypeScript. The Rust file-effect helper refuses this key. |
| Backend readiness and override hints | All `execution.backend` writes remain on `config.set` in TypeScript. Rust reads reproduce `PACER_BACKEND` precedence; the setter refuses the key. |
| Terminal availability | The TypeScript operation filters detected terminal choices; Rust accepts the resulting host fields without probing the machine. |
| Machine guard and current task slots | TypeScript computes live machine/slot data for `config.get`; Rust accepts the resulting host fields. |
| Planner candidates | TypeScript discovers compatible planner accounts for `config.get`; Rust accepts the resulting host fields. |
| `host.account.add` | The full operation, host adapter dependencies and SSH account-folder configuration remain in TypeScript. |

`test/config-settings-parity.test.ts` regenerates and verifies the shared
`test/fixtures/config-settings/settings.json` corpus from the TypeScript reference.
Use `UPDATE_CONFIG_SETTINGS=1 bun run test test/config-settings-parity.test.ts` only
when intentionally refreshing that reference. Rust integration tests verify the
same results, errors/hints, previous values, sources, diff/undo and exact YAML
bytes, plus the existing shared ECMAScript whitespace/order corpus. The number
formatter uses `ryu-js` to preserve ECMAScript number spelling and IEEE-754 rounding;
terminal limits count UTF-16 code units. No public surface switches to these helpers
in this slice, so native-operation CT-11 evidence belongs to the later cutover.
