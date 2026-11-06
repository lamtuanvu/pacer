# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

**P7 replay gate (2026-11-06):** TypeScript `Screen` checkpoint roundtrip is **GO** on the synthetic vt100 corpus (`test/session-replay-gate.test.ts`). Native vt100 replay remains **NO-GO** (insert mode, SGR 9 strikeout, ZWJ width, disabled autowrap, and public-exporter scroll-region gaps). Keep session WebSocket and offline replay on the TypeScript host until a full native gate passes; `pacer-sessions` continues file/frame/control characterization only.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Native (P2) | Pure keys/sources via `pacer_config::settings::get_settings`; Core supplies filtered terminal choices, machine guard/slots and planner candidates through `/_internal/config-host-parts` (serve) or `_internal.config-host.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns terminal detection, slot sampling and planner discovery. `PACER_FORWARD_OPS` remains the escape hatch. |
| `config.set` | Native (P2-E) | Pure keys use `pacer_config::settings::set_setting` plus the P3-B publisher. `planner` and `execution.backend` selectively forward to TypeScript for install/uninstall and backend readiness. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.account.add` | Forwarded | SSH account configuration and host adapter dependencies remain in TypeScript. |
| `host.add`, `host.set`, `host.remove`, `host.repo.map` | Forwarded (P2-D) | `pacer-config::host` owns YAML identity/edits and refusal parity. Public ops stay forwarded until native callers also cover endpoint sync (`applyEdit`), config publication, and `host.set` activity side effects. Plugin-owned SSH execution is out of scope. |
| `host.suggest` | Native (P2-D) | `pacer-config::ssh_config` reads `~/.ssh` aliases (Includes, HostName, no shell execution) and filters configured host `ssh` targets from `load_strategy`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.list`, `host.get` | Native (P2-D) | `pacer-lifecycle::hosts::list` / `detail` compose summaries and detail rows once Core supplies reachability, check caches, jobs, runners, repos and tasks through `/_internal/host-read-parts` (serve) or `_internal.host-read.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns live task/job/reachability reads and read-model executors for `host.get`. `PACER_FORWARD_OPS` remains the escape hatch. |
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
| `task.dismiss` | Native (P3-D) | `pacer-lifecycle::dismiss_tasks` + P3-B activity/task publication; Core supplies `autoCleanTask` through `/_internal/task-auto-clean` / `_internal.task-auto-clean` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.diff` | Native (P3-D) | `pacer-lifecycle::task_diff` mirrors `src/tasks/diff.ts` git argv (`--literal-pathspecs`, merge-base, `-z` name-status/numstat, snapshot `diff.json` fallback, patch caps). Native serve/stdio runs git via `CommandGit`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. Path-probe `markPathUnreachable` stays TypeScript-only until a git-read bridge is needed on macOS serve. |
| `task.list` | Native (P3) | Composed via `pacer_read_model::tasks::task_list_page` once Core supplies active sessions and runner liveness through `/_internal/session-probe-parts` (serve) or `_internal.session-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns session lifecycle and `pidAlive`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.get` | Native (P3, selective) | Composed via `pacer_read_model::task_detail` plus Core enrichment through `/_internal/task-read-parts` / `_internal.task-read.parts` (session probe, git diffstat/branch, tokens, retry options, dispatch `work` / `managedSkip`, agent-check acceptance gating, activity timeline tail). TypeScript still owns git, usage broker reads and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `snapshot.get` | Native (P8) | Composed via `pacer_read_model::ReadModel::snapshot` once Core supplies setup, policy, machine guard samples, service row, desktop updates, pairing eligibility, session probe and live `computeStatus` through `/_internal/snapshot-probe-parts` / `_internal.snapshot-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns setup probes, plugin policy, discovery pairing, status warming and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `machine.get`, `machine.set`, `machine.rotate` | Native (P8) | Rust validates params and publishes the `machine` config area on mutations; identity load, keychain, rotation and entity events stay on Core through `/_internal/machine-bridge` / `_internal.machine.bridge` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `files.search` | Native (P8) | Rust validates query bounds; git listing and running-task attribution stay on Core through `/_internal/files-search` / `_internal.files.search` (stdio, sealed). `PACER_FORWARD_OPS` remains the escape hatch. |
| `setup.check` | Native (P9) | Rust validates empty params; service/link/status probes stay on Core through `/_internal/setup-check` / `_internal.setup.check` (stdio, sealed). Serve passes `snapshotProbe: false` like the HTTP op deps. `PACER_FORWARD_OPS` remains the escape hatch. |
| `onboarding.skip` | Native (P9) | Writes `onboarding/skipped` and publishes the `setup` config area via `pacer_store`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `doctor.run` | Forwarded (P9) | Setup/service/account/handler diagnostics and isolated Claude probes remain in TypeScript (`runDoctor`); not registered natively. |
| `version.get` | Native (P9) | Package and protocol metadata from `PACER_BUILD_VERSION` / workspace `package.json` and the frozen v3 protocol string. Login-service install/running status remains on `service.status`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `api.list`, `api.describe` | Native (P9) | Registry introspection from checked-in `op_catalog.json` (parity with TypeScript `opJsonSchemas()`). `api.list` filters match TS prefix/search semantics; `api.describe` returns captured JSON parameter schemas. `PACER_FORWARD_OPS` remains the escape hatch. |
| `delegation.pause`, `delegation.resume` | Native (P5) | `pacer-engine::pause` writes `state/pause.json`, publishes the `pause` event, appends activity, then publishes the `delegation` config area. No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `mode.release` | Native (P5) | Clears `state/mode-hold.json` via `pacer-engine::mode_hold` and publishes the `mode` config area. |
| `mode.hold` | Native (P5, selective) | Explicit `until` is native. Omitting `until` selectively forwards to TypeScript so `computeStatus` can default to the planner reset window (P5b). |
| `limits.report` | Native (P5) | Resolves the runner through `pacer-config`, marks `exhausted.json` + evidence via `pacer-engine::exhausted` (manual). No publish. |
| `limits.check` | Native (P5c) | Row projection via `pacer_engine::usage_broker::limits_check` once Core supplies `accounts` + `providers` through `/_internal/status-broker-parts` (serve) or `_internal.status-broker.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns `computeStatus` / plugin readings. `PACER_FORWARD_OPS` remains the escape hatch. |
| `limits.refresh` | Forwarded (P5b) | `refreshAccountUsage` / `refreshAllUsage` coordinator (`src/usage/refresh.ts`): per-account dedupe, 15-minute automatic throttle, outcome projection from prior/current readings. Effectful reads via `readAccountUsage(..., refresh: true)` and `readPluginUsage` (provider CLI, Ark CLI, passive Claude logs). Beyond P5c read-only status-broker injection; HTTP `usageRefreshDone` rebuilds cached status after manual refresh. Library: `pacer_engine::usage_refresh` mirrors capability/outcome rules only. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.status` | Native (P5d) | Composed via `pacer_engine::usage_broker::routing_status` with the same P5c `accounts` + `providers` bridge (`/_internal/status-broker-parts` / `_internal.status-broker.parts`). TypeScript still owns live `computeStatus`. `calendarPace` defaults in Rust until the bridge carries planner profile hints. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.route` | Native (P5d, selective) | Broker-backed `usage_broker::routing_route` / `status::rank_route` when params omit `goal` and `repo`. Params with `goal` (classifier) or `repo` (project policy + remote eligibility) selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.get` | Native (P5b) | Pure strategy routing document read via `pacer-config::config_writes::get_routing` (rules + available executor ids). No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.request_review` | Native (P6) | Store-only handoff note via `pacer-lifecycle::request_review` + read-model `api_tasks` projection. No runner, plugin, messaging or supervision. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.delegate`, `task.retry`, `task.retry_all`, `task.answer` | Forwarded (P6d+) | P6b `run_spawn` pins the `_run` argv/env/log plan; P6c found no native registration with parity (policy, prepared admission, work grants, messaging turns, effectful spawn). |
| `task.stop`, `task.ask` | Forwarded (P6d+) | P6d library: `record_task_stop` owns store-only `taskStop` fields (incl. `stopPending` and remote-transfer refusal) without agent sessions, signals, live-worker release or host stop. Public op still needs those effectful sides and `expect_rev`/`stopWork` orchestration. |
| `task.wait` | Forwarded (P6d+) | P6d library: `task_wait_settled` mirrors the poll exit predicate only. Public op still drains the queue, supervises the runner and waits on agent sessions/checks. |
| `task.review` | Forwarded (P6d+) | P6c library: `record_review_verdict` owns accept/reject SQLite fields only. Public op still needs policy, agent-session gates, labels/activity, messaging `send_back`, retry/delegate/`_run`, and `autoCleanTask`. |
| `task.retry_options` | Forwarded (P5b/P6) | Needs routing/policy ranking over live readings (same broker gap as `routing.route`). |
| `session.create` | Forwarded (P7) | Idempotent conversation start needs attachment draft claim, `prepareDelegate` admission, work grants and `launchTaskRunner` spawn. Library: `params`, `operations` (reference/summary), `plain`, file/frame/control goldens only. |
| `session.resume` | Forwarded (P7) | Needs live session probe, executor resume capability, prepared admission consume, queue mutation and runner spawn. Native vt100 replay gate remains **NO-GO**; session WebSocket stays TypeScript. |
| `session.end` | Forwarded (P7) | Needs `taskStop` orchestration, runner supervision and conversation activity publication beyond store-only fields. |
| `session.context` | Forwarded (P7) | Read model over task store, private attachment draft metadata and revision-scoped conversation fields. |
| `session.prepare` | Forwarded (P7) | Executor capability discovery, repo/workspace validation and plugin-backed preparation. |
| `session.draft.create` | Forwarded (P7) | Attachment store mutation with 24-hour expiry policy. |
| `session.file.read` | Forwarded (P7) | Secure workspace reader, attempt-scoped paths and revision conflicts; `file_reference` owns syntax only. |
| `session.attachment.prepare` | Forwarded (P7) | Running-session gate, attachment claim and agent-specific delivery preparation. |
| `session.agent.create` | Forwarded (P7) | Independent agent spawn inside an existing task workspace; needs plugin IPC, admission and native session identity. |
| `session.agent.list`, `session.agent.get` | Forwarded (P7) | Task-scoped agent session enumeration and attempt reads over live store and plugin state. |
| `session.agent.end`, `session.agent.retry`, `session.agent.resume` | Forwarded (P7) | Effectful agent-session lifecycle (stop, fresh attempt, resume) with `expect_rev` orchestration; no native registration while replay/WS gate is **NO-GO**. |
| `dispatch.config.get` | Forwarded (P5/P6) | Composes planner identity and effective dispatcher YAML (strategy override or built-in defaults) from `loadStrategy`; no native dispatch settings read yet. |
| `dispatch.enforcement`, `dispatch.enforcement.probe`, `dispatch.enforcement.consent`, `dispatch.enforcement.denied` | Forwarded (P5/P6) | Native subagent control certification: policy repo resolution, observation-backed diagnostics, quota-using probe jobs, consent ledger and strict-mode denial recording (`src/api/ops.ts`; unauthenticated POST for `denied` in `src/serve/http.ts`). Needs plugin jobs and executor-native control probes. |
| `dispatch.preview`, `dispatch.explain` | Forwarded (P5/P6) | Read-only ranking and ladder explanation over cached observations and the replaceable decision engine; needs live usage readings and `core.dispatch` / `explainDispatch` parity beyond P5d broker slices. |
| `dispatch.submit`, `dispatch.child` | Forwarded (P6) | Root and scoped child admission: work grants, queue mutation, delegation policy, prepared admission and `launchTaskRunner` spawn (`submitWork`, `delegateChild`). P6b `run_spawn` records plans only. |
| `dispatch.list`, `dispatch.tree`, `dispatch.events` | Forwarded (P6) | Work-store reads and timelines over managed roots (`listWork`, `scopedWorkTree`, `scopedWorkEvents`); no native work graph projection while session/task enrichment stays on TypeScript bridges. |
| `dispatch.wait` | Forwarded (P6) | Polls until a work item settles via `waitWork`; needs queue drain, runner supervision and the same orchestration gap as `task.wait` (P6d). |
| `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` | Forwarded (P6) | Managed-work lifecycle at `expect_rev`: review acceptance, lineage retry, executor Q&A resume and subtree stop (`reviewWork`, `retryWork`, `answerWork`, `stopWork`); overlaps P6c/P6d task op gaps (messaging turns, spawn, `stopWork` tree). |
| `dispatch.dependencies`, `dispatch.dependencies.waive` | Forwarded (P6) | Same-root dependency graph edits with revision checks (`setWorkDependencies`, `waiveWorkDependency`); store effects plus work-tree projection responses. |
| `dispatch.models`, `dispatch.refresh` | Forwarded (P5/P6) | Model inventory and observation refresh with backoff (`listDispatchModels`, `refreshObservations`); issues scoped plugin/executor observation calls. |
| `dispatch.analytics`, `dispatch.learning.reset` | Forwarded (P5/P6) | Derived learning aggregates and per-repo reset/exclude (`dispatchAnalytics`, `resetLearning`); reads and mutates learning state beyond native routing broker. |
| `msg.send` | Forwarded (P6) | Turn delivery: participant policy, project messaging rules, held-message guardrails and admitted-executor resume via `sendMessage` / `deliver` (delegate, route, `spawnRunner`). |
| `msg.inbox`, `msg.read`, `msg.wait` | Forwarded (P6) | Caller-scoped message store reads; `msg.wait` blocks with polling and marks returned messages read. Work-grant authorization in `core/work.ts`. |
| `msg.log` | Forwarded (P6) | Task thread read with tree visibility rules (`assertCanRead`, `store.thread`). |
| `msg.confirm` | Forwarded (P6) | Human-only release of policy-held messages then `deliver` with runner spawn. |
| `msg.close` | Forwarded (P6) | Sets `msgClosed`, parent/origin/human authorization and `autoCleanTask` worktree release; no review verdict. |
| `msg.policy` | Forwarded (P6) | Effective repository guardrails and hypothetical `checkSend` evaluation (`effectivePolicy`, project messaging config). |
| `desktop.capture.register`, `desktop.capture.targets`, `desktop.capture.request`, `desktop.capture.claim`, `desktop.capture.complete`, `desktop.capture.result` | Forwarded (P8/P9) | Desktop capture broker over connected authenticated desktop clients (`src/desktop/capture-broker.ts`, `src/api/ops-desktop.ts`): worker credential renewal, owned-window inventory, request/claim/complete lifecycle and PNG metadata reads. Bounded image upload stays on authenticated HTTP routes. |
| `desktop.update.status`, `desktop.update.check`, `desktop.update.download`, `desktop.update.restart`, `desktop.update.cancel`, `desktop.update.configure`, `desktop.update.adopt`, `desktop.update.adoptCancel` | Forwarded (P8/P9) | Verified desktop OTA and service-adoption runtime (`src/api/ops-desktop-update.ts`, `src/desktop/update/`): feed checks, signed download, restart reservation, adoption handoff and public status. Snapshot probe carries update rows only; effectful install/restart stays TypeScript. |
| `desktop.reconcile.status`, `desktop.reconcile.request`, `desktop.reconcile.cancel` | Forwarded (P8/P9) | Service reconciliation assessment and (future) native-proof request/cancel stubs (`src/api/ops-desktop-reconciliation.ts`); `request`/`cancel` remain unavailable until reconciliation is implemented. |
| `discovery.list`, `discovery.network.get` | Forwarded (P8) | LAN discovery state reads: radio availability, found machines (cap 100), per-network advertising rows and revision counters (`src/api/ops-discovery.ts`, `src/discovery/`). |
| `discovery.set`, `discovery.respond`, `discovery.network.set` | Forwarded (P8) | Machine-local discovery mutations with `expect_rev`, config publication and attention re-derivation; `respond` pair may hand over to a pairing plugin (`src/discovery/handover.ts`). Executor sessions refuse set/respond/network.set via caller policy. |
| `assistant.status`, `assistant.candidates` | Forwarded (P7/P8) | Availability, selected endpoint account, planner pacing refusal, daily limits/usage and candidate endpoint accounts with fixed read-tool summary (`src/api/ops-assistant.ts`, `src/assistant/service.ts`). Executor sessions get `not_allowed` via caller policy. |
| `assistant.settings.get`, `assistant.settings.set` | Forwarded (P7/P8) | Assistant SQLite settings (runner/account, limits, retention) with revision-guarded writes and config-area effects (`src/assistant/store.ts`, `saveSettings`). |
| `assistant.conversations`, `assistant.conversation`, `assistant.turn`, `assistant.delete` | Forwarded (P7/P8) | Conversation history pagination and turn reads; deletes drop text while retaining usage aggregates (`src/assistant/store.ts`). |
| `assistant.ask`, `assistant.cancel` | Forwarded (P7/P8) | Turn lifecycle: redacted read-tool loop, bundled `pacer-assistant` plugin `respond`, checkpointing and SSE answer stream at `/v3/assistant/turns/<turnId>/stream` (`src/assistant/service.ts`, `src/api/http.ts`). Proposed actions stay client-confirmed; nothing executes from the turn itself. |
| `assistant.card.record`, `assistant.card.refresh` | Forwarded (P7/P8) | Action-card outcome recording and task-revision refresh for proposed ops the app runs separately (`src/assistant/actions.ts`, `buildCard`). |
| `account.list` | Forwarded (P7/P9) | Account inventory with usage/sign-in commands and no emails (`src/core/accounts.ts`). |
| `account.signin` | Forwarded (P7/P9) | Opens provider login in a terminal/tmux/Orca target or returns the command; interactive account-add/init flows share the handler (`src/api/ops.ts`, `accounts.signin`). |
| `account.add`, `account.edit`, `account.adopt`, `account.remove` | Forwarded (P7/P9) | Strategy `accounts` mutations: Claude/Codex homes, managed endpoints and OpenCode adoption with endpoint-plugin sync, protected-path home deletion and runner references (`src/endpoints/`, `src/core/accounts.ts`). |
| `account.models`, `account.test` | Forwarded (P7/P9) | Supplied-key or stored-key model discovery and isolated endpoint test tasks in a temporary git repo (`endpoints.listModels`, `testEndpoint`). |
| `account.usage.check` | Forwarded (P5/P9) | Quota-consuming usage observation jobs per account (Claude consent gate), plugin/CLI reads and warmed status via `usageRefreshDone` (`src/core/account-usage-check.ts`, `src/usage/`). |
| `terminal.list`, `terminal.create`, `terminal.rename`, `terminal.close` | Forwarded (P7) | Built-in workspace terminal tabs: idempotent shell spawn, revision-guarded rename/close and live state reads (`src/api/ops-terminal.ts`, `src/terminal/workspace.ts`). Refused for executor sessions. |
| `agent.detect`, `agent.preview` | Forwarded (P9) | Agent CLI detection and integration preview/undo command before consent (`src/setup/`, `detectAgents`). |
| `agent.connect`, `agent.disconnect` | Forwarded (P9) | Consent-gated integration file writes and recorded undo disconnect under the `setup` config area (`setup.agentConnect`, `agentDisconnect`). |
| `service.install`, `service.status` | Forwarded (P9) | Login-item/service install with explicit consent and install/running/pid status probes (`src/setup/service.ts`). |
| `service.handover`, `service.work` | Forwarded (P9) | Post-upgrade runner handover wait and running-task/session version inventory for reopen prompts (`src/setup/service.ts`, owner-only handover). |
| `update.check`, `update.apply` | Forwarded (P9) | Release feed check (optional force) and shared `update.apply` job with download/verify/replace/refuse package-manager and source installs (`src/api/ops.ts`, update preflight). |

The fixed `bun run live native-config --id <id>` fixture compares all nine P2-C operations with `PACER_FORWARD_OPS=*` over stdio and HTTP. It requires a UI-seeded Rust test-ops sandbox, uses exclusive disposable homes, verifies native traces and persisted bytes, and reads config/strategy events through public SSE. All `/v2` operations and work-grant requests continue forwarding.

The native `activity.list` reads the TypeScript activity JSONL, and `task.log` reads the shared SQLite task record and output files. `task.log` opens the existing adapter, which may import or migrate the store as described in P3-C. Native `task.prune` / `task.restore` use the same `TaskStore` retention helpers as the TypeScript reference, including strategy `taskRetentionDays` (default 14) and the cross-runtime retention lock. Native `task.dismiss` persists `dismissed`, appends linked verdict activity, publishes a task outbox event, then runs the Core auto-clean bridge for the requested ids.

## P3-D task.diff (native + library)

`pacer-lifecycle::task_diff` owns progress-base/worktree selection, remote-running notes,
saved `diff.json` fallback, `-z` stat/name parsing and patch caps aligned with
`src/tasks/diff.ts`. The HTTP service and stdio proxy register native `task.diff`
and execute git with the same argv as the TypeScript reference (`CommandGit`).
Cross-runtime coverage: `test/task-diff-parity.test.ts`,
`test/fixtures/task-diff/file-tree-parity.json`, and
`cargo test -p pacer-lifecycle task_diff`.

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

## P2-D host read triage (library + native suggest)

P2-D evaluated `host.list`, `host.get` and `host.suggest` for the largest safe
native registration. `host.suggest` met parity without SSH execution: Rust reads
`~/.ssh/config` (Includes and HostName, depth/cycle bounded) and subtracts
configured host `ssh` targets from strategy YAML. `host.list` and `host.get`
registered with the host-read private bridge: Rust composes
`pacer-lifecycle::hosts::list` / `detail` over Core-injected snapshots while
TypeScript still supplies live task/job/reachability/check reads and read-model
executors for detail. SSH-exec host ops remain forwarded. Cross-runtime coverage:
`test/ssh-config-parity.test.ts`, `test/host-read-parity.test.ts`, and
`cargo test -p pacer-config ssh_config`.

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

## P7 session ops triage (library, no new native ops)

P7 evaluated all fourteen public `session.*` operations for native
registration. None met parity without attachment store effects, prepared
admission/work grants, runner spawn, live session WebSocket routes, offline
vt100 replay, plugin agent IPC or agent-session lifecycle still owned by
TypeScript. The incremental library steps are `pacer-sessions::params` (Zod-aligned
id/uuid/unicode-length/`expect_rev` bounds), existing `operations` reference and
summary helpers, `plain` stdout transcript streaming (#734), and file/frame/control
characterization goldens. Cross-runtime coverage: `test/session-params-parity.test.ts`,
`test/session-ops-parity.test.ts`, `test/session-replay-gate.test.ts`, and
`cargo test -p pacer-sessions`. Native registration for conversation and agent
session ops waits on a full native vt100 replay **GO**, a session host owner, and
the P6 spawn/policy bridges. Session WebSocket and `/v3/.../session` routes remain
forwarded; do not register them while the replay gate is **NO-GO**.

## P6e dispatch and messaging triage (ledger, no new native ops)

P6e evaluated all twenty-three public `dispatch.*` and eight `msg.*`
operations for native registration. None met parity without the managed work
graph (`src/dispatch/work.ts`, `src/core/work.ts`), observation refresh and
learning stores, enforcement probe jobs, usage-broker-backed preview/explain,
effectful `_run` spawn, messaging store turns, project policy, and
`deliver`/`autoCleanTask` side effects still owned by TypeScript. This slice
only expands the ledger with explicit Forwarded rows and residual owners; it
does not register native handlers. Native cutover waits on P6 spawn ownership,
P5 observation/broker bridges, and a messaging read model. v3-only `tree.status`
and `liveness.status` (`src/api/ops-msg.ts`) remain under the `tree.*` prefix
row until separately triaged.

## P7/P9 assistant, account, terminal, agent, service and update triage (ledger, no new native ops)

This slice evaluated all twelve public `assistant.*`, nine `account.*`, four
`terminal.*`, four `agent.*`, four `service.*`, and two `update.*` operations
for native registration. None met parity without the assistant plugin respond
path and read-tool whitelist, endpoint-plugin synchronization and key handling,
usage observation jobs, workspace terminal spawn/supervision, setup/service
install probes, agent integration file effects, or the shared update job pipeline
still owned by TypeScript. No operation is trivially pure read/write on static
config alone. This slice only expands the ledger with explicit Forwarded rows;
it does not register native handlers. Native cutover waits on plugin host
ownership, usage refresh bridges, and P9 setup/service owners.

## P5b usage refresh triage (library, no new native ops)

P5b evaluated `limits.refresh` for native registration after P5c registered
`limits.check` on read-only status-broker injection. Refresh cannot reuse that
bridge: the coordinator calls `readAccountUsage(..., refresh: true)`, which
issues provider CLI commands, Ark CLI reads, or passive Claude log ingestion
through `readPluginUsage` (`src/usage/index.ts`, `src/plugins/usage-broker.ts`).
Selective native registration (compare `mode.hold` without `until`) does not
apply because every supported account path needs effectful plugin or subprocess
I/O, evidence reconciliation and cache mutation beyond injected broker rows.
The incremental library step is `pacer_engine::usage_refresh` (`refresh_capability`,
`refresh_outcome`, `automatic_refresh_suppressed`) aligned with
`src/usage/adapter.ts` and `src/usage/refresh.ts`. Cross-runtime coverage:
`test/usage-refresh-parity.test.ts` and `cargo test -p pacer-engine usage_refresh`.
Native registration waits on a refresh bridge that can run plugin reads and
publish warmed status (same gap as `account.usage.check` and live
`computeStatus` warming).

## P8 desktop and discovery triage (ledger, no new native ops)

P8 evaluated all seventeen public `desktop.*` and five `discovery.*`
operations for native registration. None met parity without the desktop capture
broker, verified OTA/adoption runtime, LAN discovery radio/state files, pairing
hand-over plugins, client registry liveness, and config/attention publication
still owned by TypeScript (`src/desktop/`, `src/discovery/`, `src/api/ops-desktop*.ts`,
`src/api/ops-discovery.ts`). Snapshot and read-model probes may carry desktop
update rows and pairing eligibility summaries only. This slice expands the
ledger with explicit Forwarded rows; it does not register native handlers.

PR #585 adds the native `/v3/tasks/<id>/log?follow=1` SSE route. It retains a read-only SQLite connection, detects database replacement, and drains bounded output chunks before `done`. When a read needs a legacy JSON import, an older schema migration, or malformed-record semantics, it calls the existing TypeScript `task.log` fallback with the current byte offsets. That core read performs the shared durable import; no per-stream import cache or new Rust state writer is used. The same fallback applies after a stream connects. All other `/v2` routes remain forwarded.

**P8 (HTTP events):** native `/v2/events` and `/v3/events` SSE replay the shared link outbox through `pacer-read-model::events::SseCursor` (cursor validation, retention `reset`, v2/v3 conversion, task enrichment, 15 s keepalive). Stdio `subscribe` stays TypeScript. `PACER_FORWARD_OPS=http.events` or `*` forwards the route to the core reference. No second publisher.

**P8 (snapshot.get):** native stdio `snapshot.get` composes the v3 snapshot through `pacer-read-model::ReadModel::snapshot` with the snapshot-probe bridge (session revision/active, runner liveness, deferred setup checklist, policy summary, machine guard samples, service metadata, desktop update rows, pairing eligibility and status or warming failure). Cross-runtime coverage: `test/native-snapshot-get-parity.test.ts` and `cargo test -p pacer-server snapshot_get`.

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
`config.get` is native: `get_settings` owns the pure key/source map; host fields
arrive through the config-host private bridge (same sealing model as session-probe).
Library helpers (`compose_host_fields` / `host_fields_from_parts`) remain for
tests and callers that inject samples directly. Files are replaced through the
existing private atomic strategy writer (0600 files, 0700 directories); native
pure-key writes publish exactly one config change after success.

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
| Terminal availability | TypeScript filters detected terminal choices; native `config.get` reads the filtered list from the config-host bridge. Rust `filter_terminal_choices` / catalogue helpers accept the detected set without probing for library/tests. |
| Machine guard and current task slots | TypeScript samples pressure/load and slot use; native `config.get` reads the composed `machine` row from the bridge. Rust `machine_host_fields` accepts injected signals + `used` (no sysctl) for library/tests. |
| Planner candidates | TypeScript discovers compatible planner accounts; native `config.get` reads the list from the bridge. Rust accepts the candidate list as a host field for library/tests. |
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
| `task.*` | 12 | P3/P6 | e.g. `task.answer`, `task.ask`, `task.attach` (+9 more); `list` and `request_review` native above |
| `host.*` | 11 | P2 | YAML edits library-ready (`host` module); SSH/plugin ops stay forwarded (P2-D) |
| `client.*` | 9 | P6 | e.g. `client.control.claim`, `client.control.complete`, `client.control.enroll` (+6 more) |
| `project.*` | 7 | P2 | e.g. `project.messaging.get`, `project.messaging.remove`, `project.messaging.set` (+4 more) |
| `runner.*` | 5 | P2 | `add`/`block`/`unblock`/`check`/`list` stay TS (`set`/`reorder`/`remove`/`settings.*` native above) |
| `strategy.*` | 4 | P2 | e.g. `strategy.build`, `strategy.list`, `strategy.preview` (+1 more) |
| `executor.*` | 3 | P6 | e.g. `executor.setup.candidates`, `executor.setup.connect`, `executor.setup.models` |
| `job.*` | 3 | P6 | e.g. `job.cancel`, `job.get`, `job.list` |
| `machine.*` | 0 | P8 | native above |
| `repo.*` | 3 | P2 | Registry/git probe remain Forwarded; URL `repo_key` in `pacer-config::host` |
| `attention.*` | 2 | P6 | e.g. `attention.dismiss`, `attention.snooze` |
| `issue.*` | 2 | P8 | e.g. `issue.import`, `issue.search` |
| `onboarding.*` | 1 | P9 | `onboarding.try` stays forwarded |
| `setup.*` | 1 | P9 | `setup.init` stays forwarded |
| `doctor.*` | 1 | P9 | `doctor.run` forwarded (see table) |
| `files.*` | 0 | P8 | native above |
| `insights.*` | 1 | P5 | e.g. `insights.summary` |
| `tree.*` | 1 | P5/P6 | e.g. `tree.status` |

Total unregistered (not in the detailed table): **68**.
Total still not native (v3 − native set): **184**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
