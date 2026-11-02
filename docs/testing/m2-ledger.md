# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Forwarded | Rust `pacer_config::settings::get_settings` owns the pure key/source read model. Terminal availability, machine guard/slot use and planner candidates are injected host fields; public routing remains in TypeScript. |
| `config.set` | Forwarded | Rust `pacer_config::settings::set_setting` ports all 16 pure keys, including whole-strategy validation, normalization, errors, byte-preserving edits, diff and undo. Publication and public routing stay in TypeScript. |
| `host.account.add` | Forwarded | SSH account configuration and host adapter dependencies remain in TypeScript. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
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
