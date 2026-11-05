# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Forwarded | Rust `pacer_config::settings::get_settings` owns the pure key/source read model. Host-field bridge helpers (`compose_host_fields` / `host_fields_from_parts`) accept filtered terminal choices, machine guard/slots and planner candidates without probing; public routing stays TypeScript until a reviewed native supplier wires those injections (A5). |
| `config.set` | Native (P2-E) | Pure keys use `pacer_config::settings::set_setting` plus the P3-B publisher. `planner` and `execution.backend` selectively forward to TypeScript for install/uninstall and backend readiness. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.account.add` | Forwarded | SSH account configuration and host adapter dependencies remain in TypeScript. |
| `host.add`, `host.set`, `host.remove`, `host.repo.map` | Forwarded (P2-D) | `pacer-config::host` owns YAML identity/edits and refusal parity. Public ops stay forwarded until native callers also cover endpoint sync (`applyEdit`), config publication, and `host.set` activity side effects. Plugin-owned SSH execution is out of scope. |
| `host.list`, `host.get`, `host.suggest` | Forwarded (P2-D) | Need running-task/job/reachability state, check caches, or `~/.ssh` alias reads that the config library does not own. |
| `host.check`, `host.clean`, `host.terminal`, `host.repo.setup` | Forwarded (P2-D) | Plugin-owned SSH execution, clone/identity/cleanup grants and jobs remain in TypeScript. |
| `runner.settings.get`, `runner.settings.save` | Native (P2-D) | Native callers use `pacer-config::executor_settings` under the shared `executor-settings` lock; saves publish the `runners` area via the P3-B publisher (matching TS `mutation(..., "runners", ...)`). No endpoint-plugin sync (unlike `runner.set` / `remove`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.add`, `repo.list`, `repo.remove` | Forwarded (P2-D) | Registry/path-probe/git identity and branch reads stay in TypeScript; only `repo_key` URL canonicalization is in the Rust host library. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.list`, `plugin.doctor`, `plugin.ui.list`, `plugin.settings.get` | Native HTTP | Rust owns read models and surface checks; grants come from the authoritative TS snapshot. Core supplies generation-bound authoritative process snapshots and read RPC over authenticated private IPC. Stdio and forced-forward requests retain the TS reference. |
| `plugin.install`, `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Forwarded | All mutations, including the retired install response, remain in TypeScript. Future cutovers must establish mutation parity and live evidence before registration. |
| `strategy.list`, `strategy.show` | Native (P2-B) | `src/api/ops.ts` remains the reference and forward fallback via `PACER_FORWARD_OPS`; reads reuse `pacer-config` `list_strategy_reads` / `show_strategy`. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.prune`, `task.restore` | Native (P3-D) | Shared `TaskStore` retention helpers; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and `autoCleanTask` side effects. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list` | Forwarded | Library now has `api_task_page` / `select_task_list` / `task_list_page` (per-task labels, visible `needs_input`, ActiveCounts). Native registration still waits on a SessionProbe/alive bridge for list and full `taskDetail` (git summary, cost, retry options, timeline, tokens, work/managedSkip) for get. |

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. Native `task.prune` / `task.restore` use the same `TaskStore` retention helpers as the TypeScript reference, including strategy `taskRetentionDays` (default 14) and the cross-runtime retention lock.

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

## P4d path scaffolding (X1 / X1b / X1c)

`pacer-plugin-runtime` names the process-owner gate and the private
`PACER_HOST_SOCKET` / `$PACER_HOME/run/host.sock` contract. X1b lets a native
test-token `ProcessOwner` spawn/track live `PluginProcess` children and mirror
`Registry` shadow states in library form. X1c adds a dark Unix reverse-bridge
accept loop (0700/0600, peer-uid auth, stub `_host.plugin.call` /
`_host.plugin.find`) behind explicit `PACER_HOST_BRIDGE=1` for Core env export;
default serve still omits the env and does not start the listener. Production
serve still leaves children with TypeScript (`/_internal/plugins`). Serve-side
native ownership, mutation registration and CT-11 cutover remain later slices
(X3 / P4d). See the X1 / X1b / X1c inventories under `.work/reviews/`.

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

`config.set` is registered native for the 16 pure keys. The TypeScript handler
remains the reference and `PACER_FORWARD_OPS` / selective-forward fallback.
`config.get` stays forwarded: library bridge helpers compose filtered terminal
choices, machine guard/slots and planner candidates from host-injected samples
(no sysctl/PATH/task-store probing in `pacer-config`). Native registration waits
for a reviewed supplier that feeds those injections at the op boundary. Files are
replaced through the existing private atomic strategy writer (0600 files, 0700
directories); native pure-key writes publish exactly one config change after success.

The complete pure setter allow-list is `execution.auto_clean`,
`task_retention_days`, `execution.local_max_tasks`,
`execution.local_memory_pressure_limit`, `execution.local_load_limit`,
`execution.launch_mode`, `pacing.order`, `pacing.policy`,
`pacing.planner_reserve`, `pacing.planner_reserve_headroom`,
`pacing.planner_probe`, `pacing.accounts`, `pacing.fill_threshold`, `update_check`,
`terminal.app` and `terminal.open`. The read model includes all 18 keys.

| Retained dependency | Forwarding boundary |
| --- | --- |
| Planner install/uninstall and rollback | All `planner` writes, including skip, selectively forward from the native registry to TypeScript `config.set`. The Rust file-effect helper refuses this key if reached directly. |
| Backend readiness and override hints | All `execution.backend` writes selectively forward to TypeScript. Rust reads reproduce `PACER_BACKEND` precedence; the setter refuses the key if reached directly. |
| Terminal availability | TypeScript filters detected terminal choices. Rust `filter_terminal_choices` / catalogue helpers accept the detected set without probing. Blocks native `config.get` until the server supplies detections. |
| Machine guard and current task slots | TypeScript samples pressure/load and slot use. Rust `machine_host_fields` accepts injected signals + `used` (no sysctl). Blocks native `config.get` until the server supplies samples. |
| Planner candidates | TypeScript discovers compatible planner accounts. Rust accepts the candidate list as a host field. Blocks native `config.get` until the server supplies candidates. |
| App/link `terminal.open` presets | Cookie-authenticated HTTP sets `PACER_TERMINAL_PRESETS_ONLY=1` on the request context so native pure-key writes match TypeScript `terminalPresetsOnly`. |
| `host.account.add` | The full operation, host adapter dependencies and SSH account-folder configuration remain in TypeScript. |
| Host YAML edits (`host.add` / `set` / `remove` / `repo.map`) | Library parity lives in `pacer-config::host`; ops stay forwarded for endpoint sync, publication and activity. |
| `runner.settings.*` | Native: library CAS + `executor-settings` lock + `runners` publication. Endpoint sync is not required for these ops. |
| `repo.*` registry | Path probe, git identity and branch listing stay in TypeScript; Rust owns URL `repo_key` only. |

`test/config-settings-parity.test.ts` regenerates and verifies the shared
`test/fixtures/config-settings/settings.json` corpus from the TypeScript reference.
Use `UPDATE_CONFIG_SETTINGS=1 bun run test test/config-settings-parity.test.ts` only
when intentionally refreshing that reference. Rust integration tests verify the
same results, errors/hints, previous values, sources, diff/undo and exact YAML
bytes, plus the existing shared ECMAScript whitespace/order corpus. The number
formatter uses `ryu-js` to preserve ECMAScript number spelling and IEEE-754 rounding;
terminal limits count UTF-16 code units. Native `config.set` pure-key cutover
evidence belongs with the fixed `native-config` live fixture and targeted parity tests.

## Unregistered public ops (Forwarded by default)

Pinned against `stdio_hello.json` v3 (`224` ops). The Rust registry lists
native names in the detailed table above; every other public op remains TypeScript-owned
until a cutover PR registers it and updates this ledger. Rows already named in
the table above are omitted here. Owner streams follow
`docs/specs/2026-10-20-rust-host-migration-design.md` §2 and the 2026-11-01
reconcile plans. Counts are op prefixes, not reviewable PR slices.

| Prefix | Count | Owner stream | Notes |
| --- | ---: | --- | --- |
| `dispatch.*` | 23 | P5/P6 | e.g. `dispatch.analytics`, `dispatch.answer`, `dispatch.child` (+20 more) |
| `desktop.*` | 17 | P8/P9 | e.g. `desktop.capture.claim`, `desktop.capture.complete`, `desktop.capture.register` (+14 more) |
| `session.*` | 14 | P7 | e.g. `session.agent.create`, `session.agent.end`, `session.agent.get` (+11 more) |
| `task.*` | 14 | P3/P6 | e.g. `task.answer`, `task.ask`, `task.attach` (+11 more) |
| `assistant.*` | 12 | P7/P8 | e.g. `assistant.ask`, `assistant.cancel`, `assistant.candidates` (+9 more) |
| `host.*` | 11 | P2 | YAML edits library-ready (`host` module); SSH/plugin ops stay forwarded (P2-D) |
| `account.*` | 9 | P7/P9 | e.g. `account.add`, `account.adopt`, `account.edit` (+6 more) |
| `client.*` | 9 | P6 | e.g. `client.control.claim`, `client.control.complete`, `client.control.enroll` (+6 more) |
| `msg.*` | 8 | P6 | e.g. `msg.close`, `msg.confirm`, `msg.inbox` (+5 more) |
| `project.*` | 7 | P2 | e.g. `project.messaging.get`, `project.messaging.remove`, `project.messaging.set` (+4 more) |
| `runner.*` | 5 | P2 | `add`/`block`/`unblock`/`check`/`list` stay TS (`set`/`reorder`/`remove`/`settings.*` native above) |
| `discovery.*` | 5 | P8 | e.g. `discovery.list`, `discovery.network.get`, `discovery.network.set` (+2 more) |
| `agent.*` | 4 | P9 | e.g. `agent.connect`, `agent.detect`, `agent.disconnect` (+1 more) |
| `service.*` | 4 | P9 | e.g. `service.handover`, `service.install`, `service.status` (+1 more) |
| `strategy.*` | 4 | P2 | e.g. `strategy.build`, `strategy.list`, `strategy.preview` (+1 more) |
| `terminal.*` | 4 | P7 | e.g. `terminal.close`, `terminal.create`, `terminal.list` (+1 more) |
| `executor.*` | 3 | P6 | e.g. `executor.setup.candidates`, `executor.setup.connect`, `executor.setup.models` |
| `job.*` | 3 | P6 | e.g. `job.cancel`, `job.get`, `job.list` |
| `limits.*` | 3 | P5 | e.g. `limits.check`, `limits.refresh`, `limits.report` |
| `machine.*` | 3 | P8 | e.g. `machine.get`, `machine.rotate`, `machine.set` |
| `repo.*` | 3 | P2 | Registry/git probe remain Forwarded; URL `repo_key` in `pacer-config::host` |
| `routing.*` | 3 | P2 | e.g. `routing.get`, `routing.route`, `routing.status` |
| `api.*` | 2 | P8 | e.g. `api.describe`, `api.list` |
| `attention.*` | 2 | P6 | e.g. `attention.dismiss`, `attention.snooze` |
| `delegation.*` | 2 | P5 | e.g. `delegation.pause`, `delegation.resume` |
| `issue.*` | 2 | P8 | e.g. `issue.import`, `issue.search` |
| `mode.*` | 2 | P5 | e.g. `mode.hold`, `mode.release` |
| `onboarding.*` | 2 | P9 | e.g. `onboarding.skip`, `onboarding.try` |
| `setup.*` | 2 | P9 | e.g. `setup.check`, `setup.init` |
| `update.*` | 2 | P9 | e.g. `update.apply`, `update.check` |
| `doctor.*` | 1 | P9 | e.g. `doctor.run` |
| `files.*` | 1 | P8 | e.g. `files.search` |
| `insights.*` | 1 | P5 | e.g. `insights.summary` |
| `snapshot.*` | 1 | P8 | e.g. `snapshot.get` |
| `tree.*` | 1 | P5/P6 | e.g. `tree.status` |
| `version.*` | 1 | P9 | e.g. `version.get` |

Total unregistered (not in the detailed table): **192**.
Total still not native (v3 − native set): **209**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
