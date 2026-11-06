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
| `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Native HTTP (P4d-3…P4d-6) | X3 `MutationOperations` over Core private IPC. Flag-off: `/_internal/plugins` prepare/`call`/`stop`/`changed`/`publish`/`log` with TS child spawn. Flag-on (`PACER_NATIVE_PLUGIN_HOST=1`): serve `ProcessOwner` starts/supervises children; Core supplies sealed `spawn_spec` + hello bookkeeping (`ready`) and refuses local spawn when `PACER_HOST_SOCKET` is set; private `call` is retired on that path. **P4d-6** installs a hello-sealed `PluginCapabilitySession` so the owner answers `capability.log` / `capability.config.get` (and native fs/process/http when call-scoped resources are attached in library/tests). **Default serve stays flag-off** until Core issues call-scoped resources for executors, observation/hosts/orca brokers, and CT-11 land; `PACER_NATIVE_PLUGIN_HOST=0` is the documented escape for the future default-on flip (`serve_starts_reverse_bridge_by_default`). Bridge adds `_host.plugin.spawn` / `stop`. Stdio keeps mutations in TypeScript. Nesting fallback replays only reads. `PACER_FORWARD_OPS` remains the op escape hatch. |
| `plugin.install` | Native HTTP (P4d-4) | Retired Orca install refusal registered on the HTTP service registry (X3 parity). Stdio remains TypeScript. |
| `strategy.list`, `strategy.show` | Native (P2-B) | `src/api/ops.ts` remains the reference and forward fallback via `PACER_FORWARD_OPS`; reads reuse `pacer-config` `list_strategy_reads` / `show_strategy`. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.prune`, `task.restore` | Native (P3-D) | Shared `TaskStore` retention helpers; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and `autoCleanTask` side effects. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.get`, `task.list` | Forwarded | Library now has `api_task_page` / `select_task_list` / `task_list_page` (per-task labels, visible `needs_input`, ActiveCounts). Native registration still waits on a SessionProbe/alive bridge for list and full `taskDetail` (git summary, cost, retry options, timeline, tokens, work/managedSkip) for get. |
| `delegation.pause`, `delegation.resume` | Native (P5) | `pacer-engine::pause` writes `state/pause.json`, publishes the `pause` event, appends activity, then publishes the `delegation` config area. No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `mode.release` | Native (P5) | Clears `state/mode-hold.json` via `pacer-engine::mode_hold` and publishes the `mode` config area. |
| `mode.hold` | Native (P5, selective) | Explicit `until` is native. Omitting `until` selectively forwards to TypeScript so `computeStatus` can default to the planner reset window (P5b). |
| `limits.report` | Native (P5) | Resolves the runner through `pacer-config`, marks `exhausted.json` + evidence via `pacer-engine::exhausted` (manual). No publish. |
| `limits.check`, `limits.refresh` | Forwarded (P5b) | Need the usage broker / plugin readings. Library stubs: `pacer_engine::status::{compose_status, limits_rows_from_status, default_mode_hold_until}` accept injected parts only. |
| `routing.status`, `routing.route` | Forwarded (P5b) | Need live readings, remote eligibility and optional classifier. Bridge stubs: `compose_status` / `rank_route` assemble once a supplier injects provider rows (P5a pure rank/eligibility/pace already in `pacer-engine`). |
| `routing.get` | Native (P5b) | Pure strategy routing document read via `pacer-config::config_writes::get_routing` (rules + available executor ids). No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.request_review` | Native (P6) | Store-only handoff note via `pacer-lifecycle::request_review` + read-model `api_tasks` projection. No runner, plugin, messaging or supervision. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.delegate`, `task.retry`, `task.retry_all`, `task.answer` | Forwarded (P6b/P6c) | Need `_run` spawn, drain launch, policy/project admission effects and executor-session guard. |
| `task.stop`, `task.ask` | Forwarded (P6b/P6c) | Need executor/provider stop grants, live-worker release, agent-session checks and (for ask) messaging insert. |
| `task.wait` | Forwarded (P6b/P6c) | Poll loop still drains the queue, supervises the runner and waits on agent sessions/checks. |
| `task.review` | Forwarded (P6c) | Accept/reject need agent-session/check gates and labels; `send_back`/`retry` need delegate/`_run`. |
| `task.retry_options` | Forwarded (P5b/P6) | Needs routing/policy ranking over live readings (same broker gap as `routing.route`). |

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

P4c registered four HTTP reads through
`pacer_plugin_ops::public::PublicRegistry`: `plugin.list`, `plugin.doctor`,
`plugin.ui.list` and `plugin.settings.get`. **P4d-3** adds the X3 mutation set
on the HTTP service registry (not on `PublicRegistry`): enable/disable/remove,
settings.set, ui.render/action/visibility. There is no public
`plugin.get`, archive inspection or publisher-trust read operation to register.
Handlers require an authoritative process runtime; without it, every plugin
operation forwards. The HTTP service supplies its supervised Core's single
process owner through the generation-authenticated `/_internal/plugins` channel.
The public listener rejects that channel. Rust owns the mutation/UI document
cache; Core still owns child processes. `PACER_FORWARD_OPS` can
force each native plugin op back to TypeScript. Stdio keeps all plugin operations in
TypeScript; no second plugin process owner is created. Native JSON envelopes are
bounded before recursive value handling. HTTP bodies, pre-effect private prepare responses or
settings records beyond 512 levels forward **reads** to TS; settings
files are left intact. Mutation nesting failures do not replay. Oversized aggregate prepare snapshots also forward reads before
any diagnostic call; successful diagnostic payloads are discarded because TS
ignores them. No operation is replayed after a diagnostic RPC. The bound is not a public JSON/schema rejection.

## P4d path scaffolding (X1 / X1b / X1c / P4d-1 … P4d-6)

`pacer-plugin-runtime` names the process-owner gate and the private
`PACER_HOST_SOCKET` / `$PACER_HOME/run/host.sock` contract. X1b lets a native
test-token `ProcessOwner` spawn/track live `PluginProcess` children and mirror
`Registry` shadow states in library form. X1c adds a dark Unix reverse-bridge
accept loop (0700/0600, peer-uid auth, stub `_host.plugin.call` /
`_host.plugin.find`). **P4d-1** wires serve so an explicit flag
(`PACER_NATIVE_PLUGIN_HOST=1` and/or `PACER_HOST_BRIDGE=1`) claims a native
`ProcessOwner`, starts the reverse bridge, and sets `PACER_HOST_SOCKET` on the
Core child; shutdown unlinks the socket. **P4d-2** attaches that owner to the
bridge so flag-on `_host.plugin.call` / `find` hit live children; unbound /
flag-off bridges keep stubs. **P4d-3** registers X3 mutation ops as Native HTTP
through an expanded `/_internal/plugins`. **P4d-4** moves flag-on child spawn
onto that ProcessOwner (native HTTP call/stop + bridge `spawn`/`stop`),
registers `plugin.install` refuse on HTTP, and has Core refuse local spawn when
`PACER_HOST_SOCKET` is set so one plugin id cannot have two live owners.
**P4d-5** lands the `PACER_NATIVE_PLUGIN_HOST=0` escape semantics and retires
private `call` on the flag-on path, but **keeps default serve TypeScript-owned**
(`serve_starts_reverse_bridge_by_default = false`). **P4d-6** wires
`PluginCapabilitySession` on the flag-on `ProcessOwner`: hello-sealed
`capability.log` / `capability.config.get`, with `pacer-plugin-host` native
fs/process/http modules reusable when `CallResources` are attached (proven in
library tests). Default stays off because Core does not yet issue call-scoped
resources for executor plugins, observation/hosts/orca brokers are unfinished,
and CT-11 live cutover is still open. Flipping that const plus live evidence is
the remaining default-on slice. Stdio native plugin ops and further
`/_internal/plugins` deletion remain later. See inventories under `.work/reviews/`.

### Per-scope plugin process owner (P4d-1 … P4d-6)

| Scope | Owner today | Notes |
| --- | --- | --- |
| Service (`pacer serve`) | TypeScript Core (default); Rust `ProcessOwner` when flag on | Flag-on: ProcessOwner starts/supervises children for native HTTP plugin RPC and bridge spawn/call/find/stop; answers hello-sealed `capability.log`/`config.get` (P4d-6); Core seals spawn_spec and refuses local spawn; private `call` retired. Default stays off; `=0` escape ready for default-on. |
| Stdio (`pacer-core api --stdio`) | TypeScript | Unchanged (P8) |
| CLI one-shots | TypeScript | Unchanged |
| `_run` runners | TypeScript | Unchanged (P6b) |

## X3 / P4d-3 / P4d-4 / P4d-5 mutation status and remaining deferred work

- **P4d-3 Native HTTP (via Core IPC):** `plugin.enable` / `disable` / `remove`,
  `plugin.settings.set`, `plugin.ui.render` / `action` / `visibility`. Library
  fixtures remain: `plugin-strategy-byte-parity.json`,
  `plugin-public-parity.json`, `plugin-operation-number-parity.json`.
- **P4d-4 Native HTTP:** `plugin.install` (retired refuse). Flag-on ProcessOwner
  child spawn for native plugin RPC + bridge `spawn`/`stop`.
- **P4d-5:** `PACER_NATIVE_PLUGIN_HOST=0` escape parsing; private `call` retired
  when `PACER_HOST_SOCKET` is set; default remains off. Flag-on surface is
  prepare/spawn_spec/ready/stop/changed/publish/log.
- **P4d-6:** hello-sealed `PluginCapabilitySession` on flag-on ProcessOwner;
  `capability.log` / `capability.config.get`; native fs/process/http modules
  reusable with issued `CallResources` (library proof). Default remains off
  (call-scoped Core resources + observation/hosts/orca + CT-11).
- **P4d-1 landed (flag-gated):** serve can claim `ProcessOwner` + reverse bridge
  + `PACER_HOST_SOCKET`. Default remains TS child ownership.
- **P4d-2 landed (flag-gated):** live `_host.plugin.call` / `find` against
  serve-owned children.
- **Blocked on later P4d:** flipping `serve_starts_reverse_bridge_by_default`,
  deleting remaining `/_internal/plugins` kinds (still needed for
  prepare/spawn_spec/ready/changed/publish/log), stdio native plugin ops,
  Core-issued call-scoped capability resources, observation/hosts/orca on the
  native owner, and CT-11 live evidence.
- **Still deferred:** Rust signed archive inspection/extraction and publisher
  trust (crypto dependency tree). TypeScript archive/publisher remain.

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
| `task.*` | 13 | P3/P6 | e.g. `task.answer`, `task.ask`, `task.attach` (+10 more); `request_review` native above |
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
| `machine.*` | 3 | P8 | e.g. `machine.get`, `machine.rotate`, `machine.set` |
| `repo.*` | 3 | P2 | Registry/git probe remain Forwarded; URL `repo_key` in `pacer-config::host` |
| `api.*` | 2 | P8 | e.g. `api.describe`, `api.list` |
| `attention.*` | 2 | P6 | e.g. `attention.dismiss`, `attention.snooze` |
| `issue.*` | 2 | P8 | e.g. `issue.import`, `issue.search` |
| `onboarding.*` | 2 | P9 | e.g. `onboarding.skip`, `onboarding.try` |
| `setup.*` | 2 | P9 | e.g. `setup.check`, `setup.init` |
| `update.*` | 2 | P9 | e.g. `update.apply`, `update.check` |
| `doctor.*` | 1 | P9 | e.g. `doctor.run` |
| `files.*` | 1 | P8 | e.g. `files.search` |
| `insights.*` | 1 | P5 | e.g. `insights.summary` |
| `snapshot.*` | 1 | P8 | e.g. `snapshot.get` |
| `tree.*` | 1 | P5/P6 | e.g. `tree.status` |
| `version.*` | 1 | P9 | e.g. `version.get` |

Total unregistered (not in the detailed table): **181**.
Total still not native (v3 − native set): **195**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
