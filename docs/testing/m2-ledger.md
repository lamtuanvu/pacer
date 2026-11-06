# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

**P7 replay gate (2026-11-06):** TypeScript `Screen` checkpoint roundtrip is **GO** on the synthetic vt100 corpus (`test/session-replay-gate.test.ts`). Native vt100 replay remains **NO-GO** (insert mode, SGR 9 strikeout, ZWJ width, disabled autowrap, and public-exporter scroll-region gaps). Keep session WebSocket and offline replay on the TypeScript host until a full native gate passes; `pacer-sessions` continues file/frame/control characterization only.

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
| `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Native HTTP (P4d-3…P4d-7) | X3 `MutationOperations` over Core private IPC. Escape (`PACER_NATIVE_PLUGIN_HOST=0`): `/_internal/plugins` prepare/`call`/`stop`/`changed`/`publish`/`log` with TS child spawn. **Default-on (P4d-13):** serve `ProcessOwner` starts/supervises children when flags are unset; Core supplies sealed `spawn_spec` + `call_authority` + hello bookkeeping (`ready`) and refuses local spawn when `PACER_HOST_SOCKET` is set; private `call` is retired on that path. **P4d-6/7** install a hello-sealed `PluginCapabilitySession` and bind Core-issued call-scoped `CallResources` so `capability.log` / `config.get` and fixture fs/process/http natives answer. Bridge adds `_host.plugin.spawn` / `stop`. Stdio keeps mutations in TypeScript. Nesting fallback replays only reads. `PACER_FORWARD_OPS` remains the op escape hatch. |
| `plugin.install` | Native HTTP (P4d-4) | Retired Orca install refusal registered on the HTTP service registry (X3 parity). Stdio remains TypeScript. |
| `strategy.list`, `strategy.show` | Native (P2-B) | `src/api/ops.ts` remains the reference and forward fallback via `PACER_FORWARD_OPS`; reads reuse `pacer-config` `list_strategy_reads` / `show_strategy`. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.prune`, `task.restore` | Native (P3-D) | Shared `TaskStore` retention helpers; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.dismiss` | Forwarded | Needs linked activity publication, task event and `autoCleanTask` side effects. |
| `task.diff` | Forwarded | Needs the full git argv, snapshot fallback and file tree parity fixture. |
| `task.list` | Native (P3) | Composed via `pacer_read_model::tasks::task_list_page` once Core supplies active sessions and runner liveness through `/_internal/session-probe-parts` (serve) or `_internal.session-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns session lifecycle and `pidAlive`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.get` | Native (P3, selective) | Composed via `pacer_read_model::task_detail` plus Core enrichment through `/_internal/task-read-parts` / `_internal.task-read.parts` (session probe, git diffstat/branch, tokens, retry options, dispatch `work` / `managedSkip`, agent-check acceptance gating, activity timeline tail). TypeScript still owns git, usage broker reads and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `delegation.pause`, `delegation.resume` | Native (P5) | `pacer-engine::pause` writes `state/pause.json`, publishes the `pause` event, appends activity, then publishes the `delegation` config area. No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `mode.release` | Native (P5) | Clears `state/mode-hold.json` via `pacer-engine::mode_hold` and publishes the `mode` config area. |
| `mode.hold` | Native (P5, selective) | Explicit `until` is native. Omitting `until` selectively forwards to TypeScript so `computeStatus` can default to the planner reset window (P5b). |
| `limits.report` | Native (P5) | Resolves the runner through `pacer-config`, marks `exhausted.json` + evidence via `pacer-engine::exhausted` (manual). No publish. |
| `limits.check` | Native (P5c) | Row projection via `pacer_engine::usage_broker::limits_check` once Core supplies `accounts` + `providers` through `/_internal/status-broker-parts` (serve) or `_internal.status-broker.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns `computeStatus` / plugin readings. `PACER_FORWARD_OPS` remains the escape hatch. |
| `limits.refresh` | Forwarded (P5b) | Needs live refresh coordinator and plugin calls beyond the P5c read-only broker bridge. |
| `routing.status` | Native (P5d) | Composed via `pacer_engine::usage_broker::routing_status` with the same P5c `accounts` + `providers` bridge (`/_internal/status-broker-parts` / `_internal.status-broker.parts`). TypeScript still owns live `computeStatus`. `calendarPace` defaults in Rust until the bridge carries planner profile hints. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.route` | Native (P5d, selective) | Broker-backed `usage_broker::routing_route` / `status::rank_route` when params omit `goal` and `repo`. Params with `goal` (classifier) or `repo` (project policy + remote eligibility) selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.get` | Native (P5b) | Pure strategy routing document read via `pacer-config::config_writes::get_routing` (rules + available executor ids). No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.request_review` | Native (P6) | Store-only handoff note via `pacer-lifecycle::request_review` + read-model `api_tasks` projection. No runner, plugin, messaging or supervision. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.delegate`, `task.retry`, `task.retry_all`, `task.answer` | Forwarded (P6d+) | P6b `run_spawn` pins the `_run` argv/env/log plan; P6c found no native registration with parity (policy, prepared admission, work grants, messaging turns, effectful spawn). |
| `task.stop`, `task.ask` | Forwarded (P6d+) | P6d library: `record_task_stop` owns store-only `taskStop` fields (incl. `stopPending` and remote-transfer refusal) without agent sessions, signals, live-worker release or host stop. Public op still needs those effectful sides and `expect_rev`/`stopWork` orchestration. |
| `task.wait` | Forwarded (P6d+) | P6d library: `task_wait_settled` mirrors the poll exit predicate only. Public op still drains the queue, supervises the runner and waits on agent sessions/checks. |
| `task.review` | Forwarded (P6d+) | P6c library: `record_review_verdict` owns accept/reject SQLite fields only. Public op still needs policy, agent-session gates, labels/activity, messaging `send_back`, retry/delegate/`_run`, and `autoCleanTask`. |
| `task.retry_options` | Forwarded (P5b/P6) | Needs routing/policy ranking over live readings (same broker gap as `routing.route`). |

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. Native `task.prune` / `task.restore` use the same `TaskStore` retention helpers as the TypeScript reference, including strategy `taskRetentionDays` (default 14) and the cross-runtime retention lock.

## P6b `_run` spawn seam (library)

`pacer-lifecycle::run_spawn` matches `selfCommand`, `runnerLogPath` and the
`launchTaskRunner` env pins in `src/tasks/api.ts`. The module performs no
filesystem or process I/O; production spawn stays in TypeScript (`spawnRunnerProcess`).
Queue drain in Rust already accepts a launch callback returning `Option<u32>`; P6b
documents that the callback must honor `RunSpawnPlan` (`validate_run_spawn_plan`)
before a future native supervisor performs effectful spawn. Cross-runtime coverage:
`test/run-spawn-parity.test.ts` and `cargo test -p pacer-lifecycle run_spawn`.

## P6c delegate lifecycle triage (library, no new native ops)

P6c evaluated `task.delegate`, `task.stop`, `task.answer`, `task.wait`,
`task.retry`/`task.retry_all`, and `task.review` for the largest safe native
registration. None met parity without the usage broker, plugin policy, messaging
turns, live-worker/supervision, or effectful `_run` spawn still owned by
TypeScript. The incremental library step is `pacer-lifecycle::record_review_verdict`
(store-only accept/reject fields aligned with `taskReview`) plus
`validate_run_spawn_plan` for drain launch hooks. Cross-runtime coverage:
`test/record-review-parity.test.ts` and `cargo test -p pacer-lifecycle record_review`.
Native registration for the forwarded ops remains a later slice (session probe,
spawn owner, policy bridge).

## P6d stop/wait triage (library, no new native ops)

P6d evaluated `task.stop` and `task.wait` for the largest safe native
registration. Neither met parity without agent-session gates, executor/provider
stop grants, live-worker release, remote host stop, process signals, queue drain,
supervision or `stopWork` tree orchestration still owned by TypeScript. The
incremental library step is `pacer-lifecycle::record_task_stop` (store-only
`taskStop` aligned with `{ signal: false }` and no agent-session branch) and
`task_wait_settled` (the `taskWait` poll exit predicate). Cross-runtime coverage:
`test/record-stop-parity.test.ts`, `test/task-wait-settled-parity.test.ts`, and
`cargo test -p pacer-lifecycle record_stop wait_settled`.

PR #585 adds the native `/v3/tasks/<id>/log?follow=1` SSE route. It retains a read-only SQLite connection, detects database replacement, and drains bounded output chunks before `done`. When a read needs a legacy JSON import, an older schema migration, or malformed-record semantics, it calls the existing TypeScript `task.log` fallback with the current byte offsets. That core read performs the shared durable import; no per-stream import cache or new Rust state writer is used. The same fallback applies after a stream connects. All other `/v2` routes remain forwarded.

**P8 (HTTP events):** native `/v2/events` and `/v3/events` SSE replay the shared link outbox through `pacer-read-model::events::SseCursor` (cursor validation, retention `reset`, v2/v3 conversion, task enrichment, 15 s keepalive). Stdio `subscribe` stays TypeScript. `PACER_FORWARD_OPS=http.events` or `*` forwards the route to the core reference. No second publisher.

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
private `call` on the flag-on path. **P4d-13** flips
`serve_starts_reverse_bridge_by_default = true` after P4d-8…P4d-12 attach
executor-class brokers on the flag-on `ProcessOwner`. **P4d-6/7** wire
`PluginCapabilitySession` on the flag-on `ProcessOwner`: hello-sealed
`capability.log` / `capability.config.get`, plus Core `call_authority` that
seals exact-path `fs.read` / exact-host `net.http` (and host-supplied
reads/commands/http) so native modules attach for fixture plugin calls.
CT-11 live cutover evidence for default-on serve remains tracked separately.
Stdio native plugin ops and further `/_internal/plugins` deletion remain later.
See inventories under `.work/reviews/`.

### Per-scope plugin process owner (P4d-1 … P4d-7)

| Scope | Owner today | Notes |
| --- | --- | --- |
| Service (`pacer serve`) | Rust `ProcessOwner` (default, P4d-13); TypeScript Core when `PACER_NATIVE_PLUGIN_HOST=0` | ProcessOwner starts/supervises children for native HTTP plugin RPC and bridge spawn/call/find/stop; answers hello-sealed `capability.log`/`config.get` and Core-sealed call-scoped fs/process/http (P4d-6/7); Core seals spawn_spec/`call_authority` and refuses local spawn; private `call` retired. `=0` / `false` / `no` escapes to TS child ownership. |
| Stdio (`pacer-core api --stdio`) | TypeScript | Unchanged (P8) |
| CLI one-shots | TypeScript | Unchanged |
| `_run` runners | TypeScript (effectful) | P6b: Rust `run_spawn` records the launch plan and `RunSpawnOwner::TypeScriptCore`; `AdmissionState::drain` launch hooks still call injected spawners. Native supervisor spawn is reserved (`RunSpawnOwner::NativeSupervisor`, post-P6c). |

## X3 / P4d-3 / P4d-4 / P4d-5 mutation status and remaining deferred work

- **P4d-3 Native HTTP (via Core IPC):** `plugin.enable` / `disable` / `remove`,
  `plugin.settings.set`, `plugin.ui.render` / `action` / `visibility`. Library
  fixtures remain: `plugin-strategy-byte-parity.json`,
  `plugin-public-parity.json`, `plugin-operation-number-parity.json`.
- **P4d-4 Native HTTP:** `plugin.install` (retired refuse). Flag-on ProcessOwner
  child spawn for native plugin RPC + bridge `spawn`/`stop`.
- **P4d-5:** `PACER_NATIVE_PLUGIN_HOST=0` escape parsing; private `call` retired
  when `PACER_HOST_SOCKET` is set; default remains off. Flag-on surface is
  prepare/spawn_spec/ready/stop/changed/publish/log (+ `call_authority` in P4d-7).
- **P4d-6:** hello-sealed `PluginCapabilitySession` on flag-on ProcessOwner;
  `capability.log` / `capability.config.get`; native fs/process/http modules
  reusable with issued `CallResources` (library proof).
- **P4d-7:** Core→Rust `call_authority` seals call-scoped `CallResources`;
  ProcessOwner binds natives for the call (fixture fs/process/http). Default
  remains off (executor-class resources + observation/hosts/orca + CT-11).
- **P4d-8:** Core `call_authority` seals observation bootstrap for
  `diagnostic.ping` / `policy.before` when `tasks.read` / `events.subscribe` are
  granted; ProcessOwner routes `capability.tasks.*` / `capability.events.subscribe`
  through `ObservationGeneration` (list proof; Core task projection bridge still
  open). Host `HostOperationResource` sealing validates exact issued ops.
- **P4d-9:** Core `call_authority` seals `hostSnapshots` when `hosts` resources
  are issued; flag-on ProcessOwner binds `with_hosts` + `NativeHosts` (library
  PROBE proof; live `hostRunner` bridge via ProcessOwner when snapshots present).
  Orca/worktree/executor-class resources and CT-11 remain open; default stays off.
- **P4d-10:** Core `call_authority` seals `orcaAttempt` / `orcaLive` and `orcaContext`
  when Orca resources are issued; flag-on `ProcessOwner` binds `NativeOrca` (library
  prepare proof; live `orca_bridge` private IPC when Core stashes an attempt bridge).
  Full executor.run on the native owner and CT-11 remain open; default stays off.
- **P4d-11:** Core `call_authority` seals `worktree` resources and `worktreeContext`
  when worktree is issued; flag-on `ProcessOwner` issues `NativeWorktree` (library
  `resolveBase` proof). `executorClaim` / process.run on the native owner and CT-11
  remained open; default stayed off.
- **P4d-12:** Core `call_authority` seals `executorClaim` and `executorContext`
  when a host-issued run claim is present; flag-on `ProcessOwner` binds `NativeRun`
  (library `claimRun` proof). Live Core `executor.run` stashing and full process.run
  lifecycle on the native owner remain open.
- **P4d-13:** `serve_starts_reverse_bridge_by_default = true`; unset env enables
  native plugin host on serve; `PACER_NATIVE_PLUGIN_HOST=0` escape covered by unit
  and front-door integration tests. CT-11 live evidence for the cutover remains open.
- **P4d-1 landed (flag-gated):** serve can claim `ProcessOwner` + reverse bridge
  + `PACER_HOST_SOCKET`.
- **P4d-2 landed (flag-gated):** live `_host.plugin.call` / `find` against
  serve-owned children.
- **Blocked on later P4d:** deleting remaining `/_internal/plugins` kinds (still
  needed for prepare/spawn_spec/call_authority/ready/changed/publish/log), stdio
  native plugin ops, live Core executor.run stashing, and CT-11 live evidence.
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
| `task.*` | 12 | P3/P6 | e.g. `task.answer`, `task.ask`, `task.attach` (+9 more); `list` and `request_review` native above |
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

Total unregistered (not in the detailed table): **180**.
Total still not native (v3 − native set): **194**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
