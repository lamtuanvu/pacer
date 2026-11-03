# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Forwarded | Rust `pacer_config::settings::get_settings` owns the pure key/source read model. Terminal availability, machine guard/slot use and planner candidates are injected host fields; public routing remains in TypeScript. |
| `config.set` | Forwarded | Rust `pacer_config::settings::set_setting` ports all 16 pure keys, including whole-strategy validation, normalization, errors, byte-preserving edits, diff and undo. Publication and public routing stay in TypeScript. |
| `host.account.add` | Forwarded | SSH account configuration and host adapter dependencies remain in TypeScript. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.list`, `plugin.doctor`, `plugin.ui.list`, `plugin.settings.get` | Native HTTP | Rust owns read models and surface checks; grants come from the authoritative TS snapshot. Core supplies generation-bound authoritative process snapshots and read RPC over authenticated private IPC. Stdio and forced-forward requests retain the TS reference. |
| `plugin.install`, `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Forwarded | All mutations, including the retired install response, remain in TypeScript. Future cutovers must establish mutation parity and live evidence before registration. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and cleanup. The P3-B publisher from #553 is absent from this base. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list`, `task.prune`, `task.restore` | Forwarded | Queue/lifecycle and retention behavior belong to later cutovers. |

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C.

PR #585 adds the native `/v3/tasks/<id>/log?follow=1` SSE route. It retains a read-only SQLite connection, detects database replacement, and drains bounded output chunks before `done`. When a read needs a legacy JSON import, an older schema migration, or malformed-record semantics, it calls the existing TypeScript `task.log` fallback with the current byte offsets. That core read performs the shared durable import; no per-stream import cache or new Rust state writer is used. The same fallback applies after a stream connects. All `/v2` routes and `/v3/events` remain forwarded.

Like the TypeScript reference, follow mode resets the stderr byte offset to zero
when a task has no run record. If a later poll sees a restored run, its stderr
starts at byte zero. A missing stderr file on an existing run retains the offset.
The connected v3/v2 regression observes the missing-run poll before restoring it.
The independent TaskStore importer matrix uses separate Rust and TypeScript homes
and compares accepted/rejected records and the Rust database contents for every
numeric validation field (`rev`, `createdAt`, attempt `startedAt` and `endedAt`).

P4c registers exactly four HTTP reads through
`pacer_plugin_ops::public::PublicRegistry`: `plugin.list`, `plugin.doctor`,
`plugin.ui.list` and `plugin.settings.get`. There is no public
`plugin.get`, archive inspection or publisher-trust read operation to register.
The registry requires an authoritative process runtime; without it, every plugin
operation forwards. The HTTP service supplies its supervised Core's single
process owner through the generation-authenticated `/_internal/plugins` channel.
The public listener rejects that channel. UI rendering remains TypeScript-owned,
including document validation, caches and invalidation after mutations.
`PACER_FORWARD_OPS` can
force each native read back to TypeScript. Stdio keeps all plugin operations in
TypeScript; no second plugin process owner is created. Native JSON envelopes are
bounded before recursive value handling. HTTP bodies, pre-effect private prepare responses or
settings records beyond 512 levels forward the original read to TS; settings
files are left intact. Oversized aggregate prepare snapshots also forward before
any diagnostic call; successful diagnostic payloads are discarded because TS
ignores them. No operation is replayed after a diagnostic RPC. The bound is not a public JSON/schema rejection.

## Deferred P4c mutation and distribution work

- Enable, disable and remove, including strategy edits, process stop/reset and
  publication, remain TypeScript operations. The new Rust strategy mutation
  implementation and its shared YAML-editor changes have been removed from this
  slice; the shared editor is unchanged from main.
- UI rendering, actions, visibility and settings saves remain TypeScript operations.
  The new unserved Rust UI validation/cache and settings mutation helpers and their
  sole-use fixtures/tests have been removed with this narrowing.
- Rust signed archive inspection, verification/extraction and publisher trust are
  deferred and removed from this PR, along with their new dependency tree and
  distribution-only fixtures. TypeScript archive and publisher implementations
  and their established tests remain. The recorded unserved-library CT-11
  exception does not waive RUST-7, and is not used to accept archive parity gaps.
- The next mutation/distribution slice must cover the reviewed block/flow/anchor/
  CRLF strategy shapes, archive overflow/null/UTF-16 identity rules and all archive
  parser branches before registering a runtime caller. No waiver is claimed.

## Config library boundary

The earlier config-library slice registers no native config operation and changes no TypeScript config runtime code.
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
runtime from `pacer-plugin-runtime` (layer 5), which re-exports direct/remote run
and transfer owners from `pacer-plugin-execution` (layer 4). Pinned byte/process resources and
shared error/effect contracts live in `pacer-plugin-capabilities` (layer 3); host
registry/RPC admission is layer 6. Store2 is used below only for the existing
error conversion, with no TaskStore access. Facade imports retain type identity.
The runtime includes concrete Orca attempt
execution, fixed SSH transport, Git bundle inspection and task-owned transfer
publication. Its inputs come from the host; plugins still send bounded
task/attempt requests. This is a library-only slice: it adds no native operation,
changes no TypeScript runtime handler, and leaves the operation routes above
unchanged.

Run `cargo test -p pacer-plugin-capabilities -p pacer-plugin-execution -p pacer-plugin-host -p pacer-plugin-runtime -p pacer-plugin-wire -p pacer-js-json -p pacer-bun-glob -p pacer-store --locked` for native
effects and adversarial fixtures. The script freshness check is
`bun run test test/plugins-native-fixed-scripts.test.ts`. The earlier pre-P4c
front-door status and plugin-list smoke check exercised the authoritative
TypeScript path; it did not establish native executor or desktop integration.
The current plugin-list HTTP route is the native P4c read listed above. Report those unavailable
native surfaces as UNVERIFIED until cutover. See the runtime README for the
coverage seams and crate-size split boundary.

P4b slice 5 also composes native Orca preparation/account/MCP/launch policy and
stopped-lane/group cleanup. The lower-layer `pacer-plugin-wire` keeps bounded
payload staging and lossless UTF-16 JSON delivery below runtime ownership; use
the lossless broker path when connecting Orca RPC. Native registration of these
shadow effects remains absent, and the TS host remains authoritative. See
[ADR 0019](../decisions/0019-native-plugin-runtime-ownership.md).

Lossless task JSON is shared with the existing store rather than a second native
state format. Concrete tests cover clipped questions through settlement, SQLite
reopening and JSON write-through. The existing native `task.log` can read those
records; its live harness evidence is separate from unregistered shadow effects.

## M2 runtime ownership split

The Orca text-parity correction keeps the runner/account resolver, wait text,
parameter validation and exact default-folder record with their private attempt
owner. That checkpoint measured `pacer-plugin-runtime` at 8,043 LOC; integrating
direct-task exact edits and lease validation measured 8,136. The subsequent Orca
task-write migration measured 8,231. With the journal transaction correction,
the integrated runtime measured **8,290 LOC**, above the CRATE-1 warning.
The scheduled **Orca attempt/session ownership versus direct/remote run and
transfer ownership** split is done: `pacer-plugin-execution` measures 3,765 LOC
(layer 4), runtime 4,534 (layer 5), host 4,972 (layer 6) and capabilities 4,298.
Moved files keep their bytes; tests stay at the runtime/host facades. The
12,000-line hard limit is unchanged.
See [ADR 0019](../decisions/0019-native-plugin-runtime-ownership.md).

These shadow paths remain unserved. Native client validation stays UNVERIFIED
under the scoped library exception until cutover. Scalar parameter length parity
does not close the separate raw-surrogate request-carrier gap, and these text
changes do not certify journal, process-liveness or recovery parity.
