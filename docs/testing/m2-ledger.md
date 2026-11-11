# M2 forwarded operation ledger

The Rust registry owns only the operations listed as native below. `PACER_FORWARD_OPS` can return any native operation to the TypeScript core. The TypeScript handlers remain the reference during M2.

**P7 replay gate (2026-11-06):** TypeScript `Screen` checkpoint roundtrip is **GO** on the synthetic vt100 corpus (`test/session-replay-gate.test.ts`). Native vt100 replay remains **NO-GO** (insert mode, SGR 9 strikeout, ZWJ width, disabled autowrap, and public-exporter scroll-region gaps). Keep session WebSocket and offline replay on the TypeScript host until a full native gate passes; `pacer-sessions` continues file/frame/control characterization only. Since 2026-11-09 the control characterization also mirrors the ADR 0023 delivery window (`deliver`/`granted`/`delivered`, quiet period, pending line, held input, `expired-unused`, `maxWindowMs`), checked against `test/fixtures/sessions/*-parity.json`; the TypeScript `ViewerHub` stays the runtime implementation.

| Operation | M2 P3-D route | Retained TypeScript caller or reason |
| --- | --- | --- |
| `config.get` | Native (P2) | Pure keys/sources via `pacer_config::settings::get_settings`; Core supplies filtered terminal choices, machine guard/slots and planner candidates through `/_internal/config-host-parts` (serve) or `_internal.config-host.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns terminal detection, slot sampling and planner discovery. `PACER_FORWARD_OPS` remains the escape hatch. |
| `config.set` | Native (P2-E) | Pure keys use `pacer_config::settings::set_setting` plus the P3-B publisher. `planner` and `execution.backend` selectively forward to TypeScript for install/uninstall and backend readiness. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.account.add` | Native (P2-D) | `pacer-config::host` maps `hosts.<alias>.accounts.<account>.home` and returns the login command (`account_login_command`); native callers retain endpoint sync and `hosts` publication. No SSH or host-adapter I/O. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.add`, `host.set`, `host.remove`, `host.repo.map` | Native (P2-D) | `pacer-config::host` owns YAML identity/edits and refusal parity. Native callers retain the private TypeScript endpoint-plugin synchronization bridge (`finishNativeConfigEdit`), publish the `hosts` area, and record `host.set` pause activity in Rust. `host.set` composes its summary via the host-read bridge after sync. Plugin-owned SSH execution stays forwarded. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.suggest` | Native (P2-D) | `pacer-config::ssh_config` reads `~/.ssh` aliases (Includes, HostName, no shell execution) and filters configured host `ssh` targets from `load_strategy`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.list`, `host.get` | Native (P2-D) | `pacer-lifecycle::hosts::list` / `detail` compose summaries and detail rows once Core supplies reachability, check caches, jobs, runners, repos and tasks through `/_internal/host-read-parts` (serve) or `_internal.host-read.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns live task/job/reachability reads and read-model executors for `host.get`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `host.check`, `host.clean`, `host.repo.setup` | Forwarded (remaining TypeScript-owned) | Each call needs a probe, clone, identity or transfer effect from Core, and Core has no host effects bridge yet (`/_internal/host-effects` / `_internal.host.effects` do not exist), so the ops are not registered natively and every front door forwards them to TypeScript over HTTP and stdio. The Rust check/clean/setup logic in `pacer-config-ops::host_check_clean_setup_ops` stays unregistered until that bridge exists. |
| `host.terminal` | Forwarded (P2-D) | Terminal open (`openInTerminal` / builtin registry) stays in TypeScript. Library: `pacer-lifecycle::hosts::terminal_ssh` owns SSH argv/title only; it does not open a session. |
| `runner.settings.get`, `runner.settings.save` | Native (P2-D) | Native callers use `pacer-config::executor_settings` under the shared `executor-settings` lock; saves publish the `runners` area via the P3-B publisher (matching TS `mutation(..., "runners", ...)`). No endpoint-plugin sync (unlike `runner.set` / `remove`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.list` | Native (M2, selective) | `pacer-repos` owns the `listRepos` read: `state/repos.json` and `repo-paths.json`, keys of active and recent tasks from the task store, stale filtering, the once-a-minute prune (under the shared `repos` lock) and two-second bounded branch reads. The path-reachability cache (`exists`, canonical path, `unreachable`) is a per-process stale-while-revalidate cache with the same semantics as `src/core/path-probe.ts`: Rust probes the filesystem itself in the background, so a cold Rust process reports what the TypeScript service reports on its first read. Registries the JavaScript reader treats differently (non-object JSON, serde-rejected text, entries without string `key`/absolute `path`/number `lastUsed`, integer-index keys, non-path aliases) selectively forward. No longer on the Core bridge. `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.add` | Native (M2, selective) | `pacer-repos` owns `addRepo` and `registerRepo`: the absolute-path and `rev-parse --show-toplevel` checks, git identity (`rev-parse --path-format=absolute --show-toplevel --git-common-dir`, `remote get-url origin`, `remote`, each bounded to two seconds), `repoKey` canonicalization through `pacer-config::host::repo_key`, the `canonicalAsync` path walk feeding the per-process path probe, and the registry write under the shared `repos` lock (`repos.json` entry stamped `lastUsed`, linked-checkout alias in `repo-paths.json`, `JSON.stringify` bytes). `repo.add` publishes nothing, as in TypeScript. Registries that `repo.list` forwards also forward `repo.add`. No longer on the Core bridge; the TypeScript `/_internal/repo-bridge` and `_internal.repo.bridge` endpoints are removed. `test/native-repo-add-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `repo.remove` | Native (P2-D, selective) | `pacer-config::repos::remove_repo` owns registry/alias file effects under the shared `repos` lock when the on-disk JSON matches the supported shape. Legacy or unusual registries selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `activity.list` | Native | `src/api/ops.ts` is the forward fallback; `src/core/task-detail.ts` reads the same activity log. |
| `plugin.list`, `plugin.doctor`, `plugin.ui.list`, `plugin.settings.get` | Native HTTP | Rust owns read models and surface checks; grants come from the authoritative TS snapshot. Core supplies generation-bound authoritative process snapshots and read RPC over authenticated private IPC. Stdio and forced-forward requests retain the TS reference. |
| `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.ui.render`, `plugin.ui.action`, `plugin.ui.visibility`, `plugin.settings.set` | Native HTTP (P4d-3…P4d-7) | X3 `MutationOperations` over Core private IPC. Flag-off: `/_internal/plugins` prepare/`call`/`stop`/`changed`/`publish`/`log` with TS child spawn. Flag-on (`PACER_NATIVE_PLUGIN_HOST=1`): serve `ProcessOwner` starts/supervises children; Core supplies sealed `spawn_spec` + `call_authority` + hello bookkeeping (`ready`) and refuses local spawn when `PACER_HOST_SOCKET` is set; private `call` is retired on that path. **P4d-6/7** install a hello-sealed `PluginCapabilitySession` and bind Core-issued call-scoped `CallResources` so `capability.log` / `config.get` and fixture fs/process/http natives answer. **Default serve stays flag-off** until TypeScript plugin consumers (usage refresh, doctor, setup.health, planners) reach the owner over the bridge, with CT-11 on the Rust front door; `PACER_NATIVE_PLUGIN_HOST=0` is the documented escape for the future default-on flip (`serve_starts_reverse_bridge_by_default`). Bridge adds `_host.plugin.spawn` / `stop`. Stdio keeps mutations in TypeScript. Nesting fallback replays only reads. `PACER_FORWARD_OPS` remains the op escape hatch. |
| `plugin.install` | Native HTTP (P4d-4) | Retired Orca install refusal registered on the HTTP service registry (X3 parity). Stdio remains TypeScript. |
| `strategy.list`, `strategy.show` | Native (P2-B) | `src/api/ops.ts` remains the reference and forward fallback via `PACER_FORWARD_OPS`; reads reuse `pacer-config` `list_strategy_reads` / `show_strategy`. |
| `strategy.use`, `strategy.save`, `strategy.remove` | Native (P2-C) | `src/api/ops.ts` remains the reference and forward fallback; native effects use `pacer-config` and the P3-B publisher. |
| `routing.set`, `runner.set`, `runner.reorder`, `runner.remove` | Native (P2-C) | Native document effects retain the private TypeScript endpoint-plugin synchronization bridge before publishing config changes. Host YAML mutations share the same bridge. `runner.set` with a string `model` selectively forwards to TypeScript first, because validating the model needs the provider's model listing (`availableModels`) that only TypeScript owns; all other `runner.set` inputs stay native. |
| `notifications.get`, `notifications.set` | Native (P2-C) | Native settings migration and writes; TypeScript remains the forward fallback. |
| `task.log` | Native | `src/api/ops.ts` is the forward fallback; `src/api/http.ts` uses it for follow mode SSE. |
| `task.prune`, `task.restore` | Native (P3-D) | Shared `TaskStore` retention helpers; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.dismiss` | Native (P3-D) | `pacer-lifecycle::dismiss_tasks` + P3-B activity/task publication; Core supplies `autoCleanTask` through `/_internal/task-auto-clean` / `_internal.task-auto-clean` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `task.diff` | Native (P3-D) | `pacer-lifecycle::task_diff` mirrors `src/tasks/diff.ts` git argv (`--literal-pathspecs`, merge-base, `-z` name-status/numstat, snapshot `diff.json` fallback, patch caps). Native serve/stdio runs git via `CommandGit`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. Path-probe `markPathUnreachable` stays TypeScript-only until a git-read bridge is needed on macOS serve. |
| `task.list` | Native (P3) | Composed via `pacer_read_model::tasks::task_list_page` once Core supplies active sessions and runner liveness through `/_internal/session-probe-parts` (serve) or `_internal.session-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns session lifecycle and `pidAlive`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.get` | Native (P3, selective) | Composed via `pacer_read_model::task_detail` plus Core enrichment through `/_internal/task-read-parts` / `_internal.task-read.parts` (session probe, git diffstat/branch, tokens, retry options, dispatch `work` / `managedSkip`, agent-check acceptance gating, activity timeline tail). TypeScript still owns git, usage broker reads and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `snapshot.get` | Native (P8) | Composed via `pacer_read_model::ReadModel::snapshot` once Core supplies setup, policy, machine guard samples, service row, desktop updates, pairing eligibility, session probe and live `computeStatus` through `/_internal/snapshot-probe-parts` / `_internal.snapshot-probe.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns setup probes, plugin policy, discovery pairing, status warming and session lifecycle. `PACER_FORWARD_OPS` remains the escape hatch. |
| `machine.get`, `machine.set`, `machine.rotate` | Native (P8) | Rust owns the identity store (`crates/server/src/native/machine_identity.rs`): load/create, clone detection, rename, crash-safe rotation and recovery, signature audit, the rotation activity line and `machine` entity event, and the `machine` config publication. It shares `identity/` files, Keychain items (via `security`), the install salt and the `identity` lock with `src/identity/`. No Core bridge. Cross-runtime coverage: `test/native-machine-parity.test.ts` and `cargo test -p pacer-server machine`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `files.search` | Native (P8) | `pacer-lifecycle::files_search` owns the whole operation with no Core bridge: zod-equivalent validation, the executor/work-grant refusal (`isExecutorSession` including Orca worktree names from the active strategy), the read-only registry listing with its own stale-while-revalidate path probe, bounded `git ls-files` / running-task `git diff --name-only` with the scrubbed git environment, 5 s listing caches, UTF-16 matching/ranking, and symlink-safe sizes. The path probe starts cold per process, so a missing repository reads as `error` until a probe has seen it, as on a fresh TypeScript core. When several running tasks change one path, `changedBy` follows task id order (TypeScript follows git completion order). `test/files-search-parity.test.ts` compares both runtimes byte for byte. `PACER_FORWARD_OPS` remains the escape hatch. |
| `setup.check` | Native (P9) | Rust validates empty params; service/link/status probes stay on Core through `/_internal/setup-check` / `_internal.setup.check` (stdio, sealed). Serve passes `snapshotProbe: false` like the HTTP op deps. `PACER_FORWARD_OPS` remains the escape hatch. M2 re-evaluation: converting it to Rust ownership needs cache-only `computeStatus` (in-process status cache and plugin readings), `policySummary` over plugin registry metadata and the service backend status, so it stays on the bridge. |
| `onboarding.skip` | Native (P9) | Writes `onboarding/skipped` and publishes the `setup` config area via `pacer_store`; TypeScript remains the forward fallback via `PACER_FORWARD_OPS`. |
| `doctor.run` | Forwarded (P9) | Setup/service/account/handler diagnostics and isolated Claude probes remain in TypeScript (`runDoctor`); not registered natively. M2 re-evaluation: the report needs the planner plugin's `planner.check`/`planner.plan` through the in-process plugin registry, in-process probes of the TypeScript build's Claude hook handlers (`probeClaudeHandlers`) and `computeStatus` over live plugin usage readers, so no input has a pure native path. |
| `version.get` | Native (P9) | Package and protocol metadata from `PACER_BUILD_VERSION` / workspace `package.json` and the frozen v3 protocol string. Login-service install/running status remains on `service.status`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `api.list`, `api.describe` | Native (P9) | Registry introspection from checked-in `op_catalog.json` (parity with TypeScript `opJsonSchemas()`). `api.list` filters match TS prefix/search semantics; `api.describe` returns captured JSON parameter schemas. `PACER_FORWARD_OPS` remains the escape hatch. |
| `delegation.pause`, `delegation.resume` | Native (P5) | `pacer-engine::pause` writes `state/pause.json`, publishes the `pause` event, appends activity, then publishes the `delegation` config area. No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `mode.release` | Native (P5) | Clears `state/mode-hold.json` via `pacer-engine::mode_hold` and publishes the `mode` config area. |
| `mode.hold` | Native (P5, selective) | Explicit `until` is native. Omitting `until` selectively forwards to TypeScript so `computeStatus` can default to the planner reset window (P5b). |
| `limits.report` | Native (P5) | Resolves the runner through `pacer-config`, marks `exhausted.json` + evidence via `pacer-engine::exhausted` (manual). No publish. |
| `limits.check` | Native (P5c) | Row projection via `pacer_engine::usage_broker::limits_check` once Core supplies `accounts` + `providers` through `/_internal/status-broker-parts` (serve) or `_internal.status-broker.parts` (stdio, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). TypeScript still owns `computeStatus` / plugin readings. `PACER_FORWARD_OPS` remains the escape hatch. |
| `limits.refresh` | Native (M2 service and agent, selective) | `pacer-config-ops::limits_refresh_ops` owns the enforcement refusal, the Zod `account` issue text, the `Unknown account` error with its hint and the reply for accounts without a refresh source (`usageRefreshCapability` is `unavailable`: reactive, unmetered and unknown usage), which `refreshAccountUsage` answers as `unsupported` before any usage read. With no `account`, rows follow `Object.keys` order (integer-index names first). Any account a provider command, Ark CLI or passive Claude log must read selectively forwards, because those reads run the usage plugins and the per-process pending and automatic-throttle maps; an unloadable strategy and `Object.prototype` names (`constructor`, `__proto__`, ...) also forward. Residual: a native reply does not call the HTTP `usageRefreshDone` status rebuild; nothing it reports changed usage. Parity: `test/native-agent-limits-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.status` | Native (P5d) | Composed via `pacer_engine::usage_broker::routing_status` with the same P5c `accounts` + `providers` bridge (`/_internal/status-broker-parts` / `_internal.status-broker.parts`). TypeScript still owns live `computeStatus`. `calendarPace` defaults in Rust until the bridge carries planner profile hints. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.route` | Native (P5d, selective) | Broker-backed `usage_broker::routing_route` / `status::rank_route` when params omit `goal` and `repo`. Params with `goal` (classifier) or `repo` (project policy + remote eligibility) selectively forward to TypeScript. A routed id without a configured runner is excluded as `not configured`, as in TypeScript `rankExecutors`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `routing.get` | Native (P5b) | Pure strategy routing document read via `pacer-config::config_writes::get_routing` (rules + available executor ids). No usage broker. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.request_review` | Native (P6) | Store-only handoff note via `pacer-lifecycle::request_review` + read-model `api_tasks` projection. No runner, plugin, messaging or supervision. `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.delegate`, `task.retry`, `task.retry_all`, `task.answer` | Forwarded (P6f+) | P6b/P6e-run `run_spawn` pins and guards the `_run` plan; P6c/P6d store-only slices; P6f adds `delegate_admission` / `prepare_delegate_admission` parity with `prepareDelegate` (amendment mapping, host snapshot, `PreparedAdmission`) without plugin policy, work grants, messaging or effectful spawn. |
| `task.stop` | Native (P6, selective) | Rust `record_task_stop` owns store CAS + task outbox publication; Core supplies runner liveness, signal/host stop, live-worker release and settle activity through `/_internal/task-stop-probe` / `/_internal/task-stop-effects` (stdio `_internal.task-stop.probe` / `.effects`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). Selectively forwards when the probe reports managed work or a live agent session / pending checks (same as TypeScript `stopWork` / agent-session gates). `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.ask` | Forwarded (P6d+) | P6d library only; public op still needs messaging and supervision beyond store fields. |
| `task.wait` | Native (P6, selective) | When `task_wait_settled` already holds (Core `taskWaitProbe`: terminal state without agent-session or pending-check holds), Rust returns the summarized task immediately via `summarize_api_task`. Active tasks forward for queue drain, runner supervision and agent waits (`/_internal/task-wait-probe`, stdio `_internal.task-wait.probe`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.review` | Native (P6, selective) | Rust `record_review_verdict` owns accept/reject store CAS + task outbox publication; Core supplies labels, verdict activity and `autoCleanTask` through `/_internal/task-review-probe` / `/_internal/task-review-effects` (stdio `_internal.task-review.probe` / `.effects`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`). Selectively forwards for `send_back`/`retry`, managed work, closed-mode policy plugins, and agent-session gates (same as TypeScript `review` / `taskReview`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `task.retry_options` | Native (P5d, selective) | `pacer_read_model::retry::retry_options` reproduces `optionsFor` in Rust. It ranks the task's routing rule with `status::rank_route`, builds executor rows with `capacity::executors_without_ctx`, drops the executor that ran and picks the row, ranking or fallback reason. Live `providers` come from the same P5c bridge (`/_internal/status-broker-parts` / `_internal.status-broker.parts`), fetched only after the task resolves. The op selectively forwards to TypeScript when `project-strategies.json` exists or cannot be read (project policy needs repo identity and the allowlist), when any runner has a `host` (remote eligibility probes), or when Rust cannot load the strategy. `PACER_FORWARD_OPS` remains the escape hatch. |
| `session.create` | Forwarded (P7) | Idempotent conversation start needs attachment draft claim, `prepareDelegate` admission, work grants and `launchTaskRunner` spawn. Library: `params`, `operations` (reference/summary), `plain`, file/frame/control goldens only. |
| `session.resume` | Forwarded (P7) | Needs live session probe, executor resume capability, prepared admission consume, queue mutation and runner spawn. Native vt100 replay gate remains **NO-GO**; session WebSocket stays TypeScript. |
| `session.end` | Forwarded (P7) | Needs `taskStop` orchestration, runner supervision and conversation activity publication beyond store-only fields. |
| `session.context` | Native (P7 session reads) | `pacer-task-ops::session_context_ops` reads the conversation task from `state/tasks.db` and its private attachment draft through `pacer_store::attachments` (`ctxWithId`, `requireConversation`, `requireDraft`, `listAttachments`): Zod issue text, the enforcement-identity refusal, the `unknown task` and conversation gates, the 24-hour expiry of unclaimed drafts at request time, ready attachments in SQLite row order, and the attachment table creation TypeScript performs on first read. No Core bridge: nothing in the result is live session state. Work-grant callers are forwarded like every op. A truthy non-string `sessionDraftId` reports `not_found`. TypeScript stores only UUID strings, so this matches unless a hand-written draft id equals the number's text, and for an object or array TypeScript raises a SQLite binding error instead. Parity: `test/native-session-context-parity.test.ts` and `cargo test -p pacer-task-ops session_context`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `session.prepare` | Forwarded (P7) | Executor capability discovery, repo/workspace validation and plugin-backed preparation. |
| `session.draft.create` | Forwarded (P7) | Attachment store mutation with 24-hour expiry policy. |
| `session.file.read` | Forwarded (P7) | Secure workspace reader, attempt-scoped paths and revision conflicts; `file_reference` owns syntax only. |
| `session.attachment.prepare` | Forwarded (P7) | Running-session gate, attachment claim and agent-specific delivery preparation. |
| `session.agent.create` | Forwarded (P7) | Independent agent spawn inside an existing task workspace; needs plugin IPC, admission and native session identity. |
| `session.agent.list`, `session.agent.get` | Forwarded (P7) | Task-scoped agent session enumeration and attempt reads over live store and plugin state. |
| `session.agent.end`, `session.agent.retry`, `session.agent.resume` | Forwarded (P7) | Effectful agent-session lifecycle (stop, fresh attempt, resume) with `expect_rev` orchestration; no native registration while replay/WS gate is **NO-GO**. |
| `dispatch.config.get` | Native (P6 dispatch reads) | `pacer-config` `load_strategy` supplies planner identity and the strategy `dispatch` block; `strategy::default_dispatch_config` is `dispatchConfigSchema.parse({})` for the built-in source. Missing or invalid strategies return the same `internal` errors as TypeScript (YAML syntax errors keep the Rust parser's wording, as in `strategy-write-parity`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.enforcement.consent` | Native (M2 dispatch planning, selective) | `pacer-dispatch-ops::planning_ops` owns `recordConsent`: Zod issue text, the executor and enforcement-identity refusals, then the read-modify-write of `state/certification-schedule.json` under the shared `certification-schedule` lock (10 s timeout, 30 s stale) and the private atomic writer. `readScheduleState` semantics carry over: a missing file or a non-object document is an empty schedule, `consent`/`attempts` default to `{}`, other keys are dropped, and the file is rewritten as `JSON.stringify` writes it (ECMAScript number spelling, integer-index keys first). A file Rust cannot rewrite byte for byte selectively forwards: unreadable, text `serde_json` rejects (lone surrogates, numbers beyond binary64), or a non-object `consent` that the object spread would coerce. Parity: `test/native-dispatch-planning-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.enforcement`, `dispatch.enforcement.probe`, `dispatch.enforcement.denied` | Forwarded (P5/P6) | Certification needs state only the TypeScript process has. `enforcementFingerprint` hashes `strictClaudeLaunch.toString()` (the compiled function's source text) with the package version, so Rust cannot tell a current certificate from a stale one, and `resolveEnforcementTarget` fills the in-process `checkedVersions` map that `dispatch.explain` and `strictReadiness` read later; a native `dispatch.enforcement` would leave that map empty in the service. `probe` starts a quota-using canary job (TypeScript job registry, agent spawn). `denied` is called by the guard with a `pet_` bearer, which the HTTP front door always hands to Core because only Core validates task grants, and its exclusion check needs the same fingerprint. |
| `dispatch.preview`, `dispatch.explain` | Forwarded (P5/P6) | Read-only ranking and ladder explanation over cached observations and the replaceable decision engine. Both read live state of the TypeScript service: the cache-only `computeStatus`, the in-process `checkedVersions` map (strict enforcement exclusions and `enforcement_unverified` uncertainty) and, for a plugin engine, `pluginRegistry.peek` and plugin `decide` calls. They also require `repo` (repository resolution, project policy and remote eligibility) and add ranking, slot accounting, ladder decisions, learned fit and decision hashes; `dispatch.explain` runs the classifier when `kind` is omitted. The inventory and observation reads they share with `dispatch.models` are native in `planning_ops`. |
| `dispatch.submit`, `dispatch.child` | Forwarded (P6) | Root and scoped child admission: work grants, queue mutation, delegation policy, prepared admission and `launchTaskRunner` spawn (`submitWork`, `delegateChild`). P6b `run_spawn` records plans only. |
| `dispatch.list`, `dispatch.tree`, `dispatch.events` | Native (P6 dispatch reads) | `pacer-lifecycle::work_reads` reads `work_*`, `attempt_usage` and task records from `state/tasks.db` (`listWork`, `scopedWorkTree`, `scopedWorkEvents`), including restart eligibility (runner PID probe, worktree, deadline, attempts, dependencies, stopped ancestors), token roll-ups, usage pools, wait totals and branch reads from worktree HEAD files. Handlers serve ungranted callers only: both front doors forward every op while `PACER_WORK_GRANT` is set, serve forwards task-grant bearers, and `PACER_ROLE=executor` / `PACER_ENFORCEMENT_TOKEN` refusals match `authorizeWorkOperation`. Records holding lone UTF-16 surrogates fail as `internal` natively (shared `serde_json` record parsing). `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.wait` | Forwarded (P6) | Polls until a work item settles via `waitWork`; needs queue drain, runner supervision and the same orchestration gap as `task.wait` (P6d). |
| `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` | Forwarded (P6) | Managed-work lifecycle at `expect_rev`: review acceptance, lineage retry, executor Q&A resume and subtree stop (`reviewWork`, `retryWork`, `answerWork`, `stopWork`); overlaps P6c/P6d task op gaps (messaging turns, spawn, `stopWork` tree). |
| `dispatch.dependencies`, `dispatch.dependencies.waive` | Native (P6 dispatch writes, selective) | `pacer-dispatch-ops::dependency_writes` owns `setWorkDependencies` and `waiveWorkDependency`: the same-root, self and cycle checks, the deduplicated `work_nodes.dependencies` write (clearing waivers) or the waiver upsert, the revision bump with its `work_task_changed` trigger, then the `dependencies.changed`/`dependencies.waived` event and the dependency-wait sync, all in one IMMEDIATE transaction under the task lock (`TaskStore::update_admitted_then`); the reply is the native `scopedWorkTree`. TypeScript publishes no event or activity for either op, so Rust publishes none. `waive` forwards only a reason whose `trim().slice(0, 2000)` cut would split a surrogate pair, which a Rust string cannot hold. Callers holding a work grant are forwarded like every dispatch op. A pipelined stdio session may answer that forwarded request after later native ones. |
| `dispatch.models` | Native (M2 dispatch planning) | `pacer-dispatch-ops::planning_ops` reads `work_observations` in `state/tasks.db` (`storedObservations`: newest 2,048 rows, `observationSchema` with strict objects, Zod defaults and schema key order, unexpired at request time) and the active strategy, then builds `buildModelInventory` (declared models with endpoint `connection.models` capabilities, executor defaults, opted-in discovery, observed capabilities and actual models in `observedAt` order) and the advertised list with its authorization flag. Executor and enforcement identities get `not_allowed`; work grants forward. Residual: an observation row holding a lone UTF-16 surrogate is dropped natively, because `serde_json` rejects the text. Parity: `test/native-dispatch-planning-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.refresh` | Native (M2 dispatch planning, selective) | Rust owns the caller refusals, Zod issue text, the `Unknown runner` error and the backoff reply (`work_refresh.retry_at` for the runner or `all` scope still in the future and no `force`). A refresh that would run selectively forwards to TypeScript: it calls `computeStatus` and the enabled observation plugins (`collectObservations`), then writes observations and the new backoff. An unloadable strategy also forwards. Parity: `test/native-dispatch-planning-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `dispatch.analytics`, `dispatch.learning.reset` | Native (M2 analytics reads) | `pacer-dispatch-ops::learning_ops` reads `work_reviews`, `work_learning_exclusions` and `work_learning_reset` in `state/tasks.db` (`dispatchAnalytics`): the provenance, exclusion and reset filters, the `JSON.stringify` group key in first-seen order, the stable sample-count sort and the Wilson interval in the same float operations. `minimumSamples` comes from `load_strategy`. `dispatch.learning.reset` runs the `resetLearning` IMMEDIATE transaction: the `expect_rev` check, `max(now, current + 0.001)` at millisecond clock resolution and the exclusion toggle. Executor and enforcement identities get `not_allowed`; work grants forward. Parity: `test/native-analytics-parity.test.ts`. |
| `msg.send` | Native (M2 message writes, selective) | `pacer-messaging-ops::msg_writes` owns `sendMessage` up to the turn: Zod params, the nudge, answer and empty-body (`trim`) refusals, caller resolution as `msg.inbox`, the request-id retry with its fingerprint (`byRequest`, `msg_request_mismatch`), `assertOpen` (closed node; cleaned worktree through `turnCapable` and `headlessTurnPath` over the strategy runners), `checkSend` (`policy::verdict` with UTF-8 bytes and its hints), the insert (`insertMessage`: millisecond `m-` ids and `createdAt`, `held` or `pending`), `recordAnswer` and its undo on the task record, question receipts and the non-human `entity` outbox event. Selective forward of effects only, through the private Core bridge (`/_internal/msg-effects` over HTTP, `_internal.msg.effects` sealed by the stdio sync key): `deliver` to a task recipient (project-policy admission, `beginTurn`, `spawnRunner`), and `notifyMessage` for a message to or from the human (`publishTaskMessages`). Non-task recipients are `pull` natively. Answers with a string `reply_to` forward before any native effects because Core owns live-session delivery and retry state; this also preserves stale-answer behavior. Work-grant, enforcement-token and Orca-worktree callers forward through `msg_stays_forwarded`. Residuals: a Core bridge failure during delivery returns `unavailable` after the message is stored. The recorded answer stays when the task record shows the turn was started or queued (`pendingTurn`, or state `queued` or `running`), since a lost bridge reply can follow either; otherwise the question reopens. A retry with the same `request_id` redelivers a still-pending message and otherwise reports it as a duplicate. Over stdio the bridge call runs in the request loop (as `task.review` and `task.stop` do), so later lines on that connection wait for delivery admission. A store without `work_nodes` reads as unmanaged where `getWork` would create the dispatch tables. Parity: `test/native-msg-writes-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `msg.inbox`, `msg.log` | Native (P6, selective) | `pacer_store::messages` reads the `messages` table and work/task parent links in `tasks.db` (`store.inbox`, `store.thread`); Rust resolves the caller participant as `callerParticipant` does (executor env or own-worktree cwd, app cookie, planner env, bearer plus valid `X-Pacer-Session`, `external:local`) and applies the `assertCanRead` root check for `msg.log`. Work-grant and enforcement-token callers, and Orca worktree cwds outside an executor session, selectively forward to TypeScript (`authorizeWorkOperation`, Orca workspace probe). `PACER_FORWARD_OPS` remains the escape hatch. |
| `msg.read` | Native (P6, selective) | Same caller resolution and forwards as `msg.inbox`; Rust marks receipts read in one immediate transaction (`store.markRead`, millisecond `read_at`). `human` callers selectively forward because TypeScript publishes task and attention events for read receipts (`publishTaskMessages`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `msg.wait` | Native (M2 message writes, selective) | Rust polls the persisted `messages` table every 500 ms until `timeout_s` (default 600, max 3000), applies the `reply_to` filter (the reply itself, or the recipient's later report, answer or question), marks the hits read with wall-clock millisecond receipts and returns the current rows. Over stdio the first check runs as the request arrives, as in TypeScript, and a blocking wait runs beside the request loop so later requests on the connection are answered; EOF drains open waits. A human caller (HTTP cookie or TUI session only) publishes its receipts through the Core bridge (`publishTaskMessages`). Same forwards as `msg.inbox`. Parity: `test/native-msg-writes-parity.test.ts`. |
| `msg.confirm` | Native (M2 message writes, selective) | Human-only (stdio callers are never human); Rust releases the held message (`confirmHeld`) and delivers it: `pull` natively for a non-task recipient, otherwise the selective `deliver` forward through the Core bridge as in `msg.send`. Parity: `test/native-msg-writes-parity.test.ts`. |
| `msg.close` | Native (M2 message writes, selective) | Rust checks parent, tree-origin or human authorization (`parentOf`, `rootOf` over `work_nodes` and task origins) and sets `msgClosed` on the task record (locked update, `rev` + 1); no review verdict. The best-effort `autoCleanTask` worktree release selectively forwards through the existing task auto-clean bridge (`/_internal/task-auto-clean`, `_internal.task-auto-clean`). Parity: `test/native-msg-writes-parity.test.ts`. |
| `msg.policy` | Native (P6, selective) | `pacer-messaging-ops::policy` computes `effectivePolicy` (the strategy messaging section via `pacer_config::strategy::load_strategy`, Zod defaults when the strategy is missing or invalid, rules normalized to schema key order; then the root task's `messaging` override, the repository's `project-messaging.json` entry, global rules and the default rules) and `checkSend` for a hypothetical send (relation, top position, rule matching including grants, repo and executor conditions, the per-minute cap over `messages`, and `confirm` holds), reporting refusals as `check: {decision: "deny", error}`. The op takes no repository path, so no repo resolution is forwarded. Work-grant and enforcement-token callers selectively forward (`authorizeWorkOperation`), as does an unreadable or invalid `project-messaging.json`, because its `projectError` carries Node and Zod details only the TypeScript reader produces. Accepted residual: a task-store failure during the check is an op-level `internal` error, as for the native message reads, where TypeScript reports `String(e)` inside `check`. Parity: `test/native-msg-policy-parity.test.ts`. `PACER_FORWARD_OPS` remains the escape hatch. |
| `desktop.capture.register`, `desktop.capture.targets`, `desktop.capture.request`, `desktop.capture.claim`, `desktop.capture.complete`, `desktop.capture.result` | Forwarded (P8/P9) | Desktop capture broker over connected authenticated desktop clients (`src/desktop/capture-broker.ts`, `src/api/ops-desktop.ts`): worker credential renewal, owned-window inventory, request/claim/complete lifecycle and PNG metadata reads. Bounded image upload stays on authenticated HTTP routes. `targets` reads the in-memory worker/window map of the running service process; nothing is persisted for Rust to read. |
| `desktop.update.status`, `desktop.update.check`, `desktop.update.download`, `desktop.update.restart`, `desktop.update.cancel`, `desktop.update.configure`, `desktop.update.adopt`, `desktop.update.adoptCancel` | Forwarded (P8/P9) | Verified desktop OTA and service-adoption runtime (`src/api/ops-desktop-update.ts`, `src/desktop/update/`): feed checks, signed download, restart reservation, adoption handoff and public status. Snapshot probe carries update rows only; effectful install/restart stays TypeScript. `status` reads the in-process desktop update runtime registered by the service (`desktopUpdateRuntime`), not a document Rust can own. |
| `desktop.reconcile.status`, `desktop.reconcile.request`, `desktop.reconcile.cancel` | Native (P8/P9 desktop reconcile) | Rust returns the fixed `assessReconciliation(undefined)` assessment for `status` and validates the strict `request`/`cancel` schemas with Zod issue text before returning `unavailable` (`src/api/ops-desktop-reconciliation.ts`). The executor upgrade refusal (`PACER_ROLE=executor` or an own task-worktree process directory) and the enforcement-token refusal precede params as in `parseOpParams`. `request`/`cancel` selectively forward when the process directory is an Orca task worktree, where TypeScript resolves the strategy provider. `PACER_FORWARD_OPS` remains the escape hatch. |
| `discovery.list`, `discovery.network.get` | Native (M2, selective) | `pacer-discovery-ops::network` ports `currentNetwork` (`src/discovery/network.ts`): the darwin `route`/`arp`/`ipconfig`/`networksetup` and Linux `ip`/`nmcli` probes bounded to three seconds, the `pacer-network/v2` key digest, and the per-process last-network fallback and 10-minute sighting memory for continuation. `pacer-discovery-ops::network_ops` owns the `readState` merge, the corrupt-file warning, network/alias lookup, the found-machine list (cap 100) and the radio availability clock (30 seconds since the last `/_internal/discovery/config` contact recorded by the Rust front door). The server composes the advertised machine name from `pacer-machine-identity`. State files TypeScript would trip over (non-object network entries, non-list aliases, found machines without numeric `lastSeen` or string `discoveryId`) or that do not parse as JSON selectively forward. Residual: Rust and TypeScript each keep their own sighting memory, so the first probe after a front-door restart cannot continue an entry a TypeScript probe saw. `PACER_FORWARD_OPS` remains the escape hatch. |
| `discovery.set`, `discovery.respond` | Native (P8 discovery writes, selective) | Rust owns the locked (`discovery` lock) read-modify-write of `discovery/state.json`: the `readState` merge and fail-closed corrupt documents, `networksRev` conflict, `rev`/`networksRev` bumps, `JSON.stringify(…, null, 2)` bytes through the private atomic writer, then the `discovery` config publication. `respond` handles `later` (wall-clock seconds plus 7 days), `ignore` and `mute-network`. `respond` `pair` (pairing plugin hand-over) and state files Rust cannot rewrite byte-for-byte (unreadable or unparsable text, non-integer or unsafe numbers, array-index or `__proto__` keys, non-object `networks`/`silenced`/`seen`, non-number revisions, odd found-machine or network entries) selectively forward to TypeScript. Executor refusal stays in the CLI caller policy, as for TypeScript API callers. `PACER_FORWARD_OPS` remains the escape hatch. |
| `discovery.network.set` | Native (M2, selective) | Same probe and state ownership as `discovery.network.get`: the locked (`discovery` lock) `networksRev` check, label/advertise update or new entry with a fresh base32 `discoveryId`, `JSON.stringify(…, null, 2)` bytes through the private atomic writer, then the `discovery` config publication and the `network.get` result. Forwards on the same state shapes as the reads. |
| `assistant.status`, `assistant.candidates` | Native (P7/P8 assistant reads, selective) | Rust reads the assistant settings in `state/tasks.db` (`pacer-store::assistant`) and the endpoint accounts in `strategy.yaml`. `candidates` lists endpoint accounts with a model and the fixed read-tool summary. `status` is native when it reports unavailable: not set up, endpoint account missing, or the daily turn limit reached at local midnight in the process time zone. Admissible status needs the planner pacing refusal (`checkAdmission`) and forwards, as do unreadable strategies, unusable stored settings and an unresolvable time zone. |
| `assistant.settings.get`, `assistant.settings.set` | Native (P7/P8 assistant reads, selective) | Rust owns the `assistant_settings` row: defaults, Zod `partial()` default filling, the endpoint check against the strategy and the revision-guarded `BEGIN IMMEDIATE` upsert (`src/assistant/store.ts`, `saveSettings`). Like TypeScript, writes publish no config event. Stored limits or retention that fail the schema, and `set` with an account when the strategy is unreadable, forward to TypeScript. |
| `assistant.conversations`, `assistant.conversation`, `assistant.turn`, `assistant.delete` | Native (P7/P8 assistant reads, selective) | Rust reads conversation pages and turns with usage, cards, citations and scope parsed in `JSON.parse` key order. `conversations` first enforces retention like TypeScript; deletes drop turn text, keep usage aggregates and run `wal_checkpoint(TRUNCATE)` (`src/assistant/store.ts`). `conversations` forwards when stored settings are unusable. |
| `assistant.ask`, `assistant.cancel` | Forwarded (P7/P8) | Turn lifecycle: redacted read-tool loop, bundled `pacer-assistant` plugin `respond`, checkpointing and SSE answer stream at `/v3/assistant/turns/<turnId>/stream` (`src/assistant/service.ts`, `src/api/http.ts`). `cancel` aborts the in-process live-turn map of the TypeScript service. Proposed actions stay client-confirmed; nothing executes from the turn itself. |
| `assistant.card.record`, `assistant.card.refresh` | Native (P7/P8 assistant reads, selective) | Rust rewrites the stored `cards` JSON in place, keeping key positions and `JSON.stringify` spelling (`src/assistant/actions.ts`). `refresh` reads the task revision from the task store; a task without a brief or title forwards because TypeScript `taskTitle` throws there. |
| `account.list` | Forwarded (P7/P9) | Account inventory with usage/sign-in commands and no emails (`src/core/accounts.ts`). Each row needs `readAccountUsage` (usage plugin and CLI readers behind a per-process cache), endpoint-plugin rows (`endpointRow`), Orca account reads and sign-in evidence, so it is not a pure store read. M2 re-evaluation: the usage-broker bridge carries reconciled `computeStatus` readings, not the per-account `readAccountUsage` reading each row reports, so no input has a native path without a new bridge. |
| `account.signin` | Forwarded (P7/P9) | Opens provider login in a terminal/tmux/Orca target or returns the command; interactive account-add/init flows share the handler (`src/api/ops.ts`, `accounts.signin`). |
| `account.remove` | Native (M2 accounts, selective) | `pacer-account-ops` owns `accounts.remove` (`src/core/accounts.ts`): legacy strategy migration, `unknown account` and `in use` refusals, the `deletionHome` checks (pacer-managed source, symlinked, root, protected and shared folders, including other accounts' Orca and pacer homes), the `accounts` mapping removal in one validated strategy edit, evidence retirement (`state/evidence/<identity>.json` under the `evidence-<identity>` lock, the SHA-256 identity of `accountEvidenceScope` with ICU-collated host rows) and the home deletion. The `accounts` config publication and the endpoint-plugin sync follow as for `runner.set`. Malformed params, prototype-key names and strategy files TypeScript reports in its own parser's words forward. Residual: the endpoint-plugin sync runs after the evidence retirement and home deletion, where TypeScript synced right after the strategy edit. |
| `account.add`, `account.edit`, `account.adopt` | Native (M2 accounts, selective) | Managed endpoints (`src/core/endpoints.ts` `save`): `account.add` with `kind: endpoint` and `test: false`, `account.edit` and `account.adopt` without `test: true`, all without a `key` param. Rust owns the name, usage and key-source checks, the connection, budget, quota source, OpenCode runner models and the `opencode#<name>` runner and default route in one validated strategy edit, the `endpoints/state.json` reset (private atomic write), `adoptEndpoint`'s read of the external provider's `baseURL` and model ids from `~/.config/opencode/opencode.json` (never `options.apiKey`), and the reply row with key presence (`env:`, `file`, and `security find-generic-password` without `-w` for `keychain`; no key is read). Errors are redacted as `redactEndpointMessage` does. Claude, Codex, Orca and `source: opencode` adds (their reply embeds the plugin usage row of `account.list`), key writes, test tasks, malformed params, prototype-key names, an unloadable strategy, an unreadable or non-JSON `state.json`, and external provider files with non-object `models` or prototype-key providers forward. Residual: the endpoint-plugin sync runs after the endpoint state write and keychain presence check, where TypeScript synced right after the strategy edit. |
| `account.models`, `account.test` | Native (M2 accounts, selective) | `pacer-account-ops` refuses natively when the named account is not a configured endpoint, when `account.models` has no base URL, and when an `env:` or `file` key source has no key (unset variable, missing or empty key file). Model discovery (supplied or stored key, including every `keychain` source) and the endpoint test task in a temporary git repo forward. |
| `account.usage.check` | Native (M2 accounts, selective) | `pacer-account-ops` refuses natively with `accountUsageCapability`'s outcomes: unknown accounts, unmetered accounts, accounts whose usage cannot be refreshed (`pacer_engine::usage_refresh::refresh_capability`), and Claude quota probes without consent. Starting the usage job (probe or refresh through plugin/CLI readers and `usageRefreshDone`) forwards. |
| `terminal.list`, `terminal.create`, `terminal.rename`, `terminal.close` | Forwarded (P7) | Built-in workspace terminal tabs: idempotent shell spawn, revision-guarded rename/close and live state reads (`src/api/ops-terminal.ts`, `src/terminal/workspace.ts`). Refused for executor sessions. |
| `agent.detect` | Native (M2 service and agent, selective) | `pacer-install` owns the host half of `detectAgents`: the Zod `host` issue text, the enforcement refusal, the `AGENT_BINS` probe on the service `PATH` and the hour-long `cache/agent-detect-<sha256>.json` read keyed by `JSON.stringify([binaries, PATH, host])`; a fresh entry is answered natively. A miss, an expired or future entry, an entry without `rows`, or a relative process `PATH` entry selectively forwards, because interpreting the agent CLIs is the planner plugin's `planner.detect` capability (ARCH-12) in the TypeScript plugin host, which also writes the cache. Residual: if the entry disappears between the forward decision and the handler, the reply is `unavailable` with a retry hint. Parity: `test/native-agent-limits-parity.test.ts`. |
| `agent.preview` | Forwarded (P9) | Integration preview and undo command before consent. The preview is the planner plugin's `planner.preview` capability, which has no host fallback (ARCH-12), so it stays with the TypeScript plugin host. |
| `agent.connect`, `agent.disconnect` | Forwarded (P9) | Consent-gated integration file writes and recorded undo disconnect under the `setup` config area (`setup.agentConnect`, `agentDisconnect`). The file plan and undo come from the planner plugin (`planner.preview` and install capabilities, ARCH-12) through the TypeScript plugin host and install transaction, so neither is native yet. |
| `service.status` | Native (M2 service and agent, selective) | `pacer-update` owns `serviceStatus` (`src/core/setup.ts`, `src/service/index.ts`): `installed` is whether the registration file (`~/Library/LaunchAgents/com.pacer.serve.plist` or `~/.config/systemd/user/pacer-serve.service`) reads; `launchctl print gui/<uid>/com.pacer.serve` or `systemctl --user show pacer-serve.service --property=...` is spawned from Rust as argv with a 2 s deadline (SEC-5), and `parseLaunchd`/`parseSystemd` semantics (JavaScript `\s`, `Number`, the `Object.fromEntries` quirk) produce `running` and `pid`. The health probe TypeScript runs does not change this reply. Other platforms (TypeScript refuses them) and macOS OTA fixture builds, whose sandbox label only the compiled fixture policy knows, selectively forward. Residuals: a timed-out manager is killed but not its process group, and its partial stdout is dropped (TypeScript keeps it); the OTA fixture forward is a path heuristic. On macOS hosts Linux parsing is covered by unit tests only. Parity: `test/native-service-update-parity.test.ts` (fake `launchctl`/`systemctl` on `PATH`). |
| `service.install` | Forwarded (P9) | Login-item/service install with explicit consent: the install transaction and manifest, the `pacerArgv` of the running core, `launchctl bootstrap`/`systemctl enable` and the health wait stay in TypeScript (`src/service/index.ts`, `src/install/`). |
| `service.handover`, `service.work` | Forwarded (remaining TypeScript-owned) | Not registered in the native op list, so every front door forwards both to TypeScript. `pacer-update::handover` keeps parameter validation and the `HandoverBridge` trait for a future native path; that needs Core to serve a `handover.effects` bridge (no TypeScript handler yet) and parity tests. |
| `update.check`, `update.apply` | Forwarded (P9) | Release feed check (optional force) and shared `update.apply` job with download/verify/replace/refuse package-manager and source installs (`src/api/ops.ts`, update preflight). |
| `task.attach`, `task.session`, `task.takeover`, `task.hand_back` | Forwarded (P6/P7) | Live session viewers, session-host metadata, headless-to-interactive takeover and hand-back (`src/api/ops-session.ts`, `src/tasks/session.ts`, `takeoverTask`, `handBackTask`). Shares the attach/viewer path with `session.*`; native vt100 replay gate remains **NO-GO**. |
| `task.send` | Forwarded (P6) | Injects text into an interactive lane's live worker with driving-lease and `expect_rev` rules (`sendMessage` in `src/tasks/send.ts`); does not create attempts. |
| `runner.list`, `runner.block`, `runner.unblock` | Native (M2) | `pacer-config-ops::runner_ops` owns `blocked.json` (manual blocks, JS-stringified bytes through the private writer) and composes `runner.list` rows from blocks, `broken.json` and the provider eligibility the usage-broker bridge (`/_internal/status-broker-parts`, stdio `_internal.status-broker.parts`) supplies, as `listRunners` does (`src/core/runners.ts`, `src/executors/blocked.ts`, `src/exec/broken.ts`). `PACER_FORWARD_OPS` remains the escape hatch. |
| `runner.add` | Native (M2, selective) | With `test: false`, `pacer-config-ops::runner_ops` owns `runnersConfig.add` (`src/core/runners-config.ts`): the non-interactive schema with Zod issue text, runner/account/host checks, the runner declaration, the routing rule insert (block or flow sequences, same YAML bytes) and the pacing rank, in one validated strategy edit; the `runners` config publication and the endpoint-plugin sync follow as for `runner.set`. Interactive terminals, check jobs (`test` omitted or `true`), params outside the schema and strategy files that are unreadable or not valid YAML (TypeScript reports its own parser's text) selectively forward. |
| `runner.check` | Forwarded (P2/P6) | The check steps (CLI, sign-in, usage and the scratch test task) run in the TypeScript job owner (`src/core/runner-check.ts`, `src/jobs/registry.ts`); native `job.*` only read and cancel its job file. |
| `strategy.preview` | Native (M2, selective) | `pacer-config::strategy_write::preview_draft` applies the draft to the current `strategy.yaml` text without writing, then reports the Bun YAML bytes, schema problems and `summary`. `pacer-config-ops::strategy_preview_ops` ranks both strategies with `usage_broker::routing_status` over the usage-broker bridge rows that `routing.status` already uses. Those rows describe the current strategy, so a valid draft that changes provider inputs (`planner`, `accounts`, `hosts`, `runners`, `legacy`, `runnerAliases`, `providers`, or pacing thresholds and reserve) forwards to TypeScript, which recomputes `computeStatus` for the draft. An unreadable current strategy also forwards. Parity: `test/native-job-strategy-setup-parity.test.ts`. |
| `strategy.build` | Native (M2, selective) | Rust (`pacer-config-ops::strategy_build_ops`) validates params with Zod issue text, loads the planner and base strategy, owns the prompt template, `request_id` idempotency under the `strategy-build-<id>` lock, the intent and prompt files under `link/sessions` (atomic 0600 writes, seven-day cleanup) and the `strategy-build` alert. Two effects stay on Core through the setup effects bridge (`/_internal/setup-effects`, `_internal.setup.effects`): `status_text` renders `renderText(computeStatus)` from in-process status caches and plugin readings, and `strategy_terminal` opens the terminal (desktop work admission, `openInTerminal`, the app's built-in PTY for cookie callers). Core builds the agent argv (`strategyArgv`, including cursor-agent `--trust`) from the prompt file Rust wrote and validated IDs, never from a caller-supplied command. Forwarded while `PACER_WORK_GRANT` is set. `PACER_FORWARD_OPS` remains the escape hatch. |
| `client.register`, `client.heartbeat`, `client.list` | Forwarded (P6) | Client registry with 45-second lease renewal and connected instance listing (`src/api/client.ts`). |
| `client.control.enroll`, `client.control.targets`, `client.control.request`, `client.control.result` | Forwarded (P6/P8) | App-page control worker enrollment, allowlisted navigation/window/tray/quit requests and polled outcomes (`src/api/ops-client-control.ts`). |
| `client.control.claim`, `client.control.complete` | Forwarded (P6/P8) | Worker-side claim/complete loop for distributed UI actions; worker credentials stay page-private. |
| `project.messaging.get`, `project.messaging.set`, `project.messaging.remove` | Native (P6, selective) | `pacer-config::project_messaging` owns `project-messaging.json` reads, Zod-order normalization, revision checks and atomic writes under the shared `project-messaging` lock; set/remove publish the `project-messaging` config area via the P3-B publisher. Repository keys are native. Absolute checkout paths (Core repository probe), an unreadable or schema-invalid policy file (Node read errors and Zod issue text) and set params with invalid nested `rules` items or `liveness` selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `project.strategy.list`, `project.strategy.get`, `project.strategy.set`, `project.strategy.remove` | Native (M2, selective) | `pacer-config-ops::project_strategy_ops` builds `repo` references from `pacer-repos` (read-only for policy keys and `list`, pruning for other keys as `resolveRepoInput` does), resolves executor aliases with `pacer_lifecycle::resolve_runner`, and owns `project-strategies.json` compare-and-set writes under the shared `project-strategies` lock in Zod schema order; set/remove publish the `project-strategies` config area. Absolute checkout paths resolve natively through `pacer-repos` (`resolveRepoInput` for get/remove, including `identityUnverified` references; strict `resolveRepo` for set) and register the checkout under the `repos` lock. Registries that `repo.list` forwards, an unloadable strategy and an unreadable or schema-invalid policy file selectively forward to TypeScript. `PACER_FORWARD_OPS` remains the escape hatch. |
| `job.list`, `job.get`, `job.cancel` | Native (M2) | `pacer-task-ops::job_ops` reads `state/jobs/<id>.json` with the `pacer-lifecycle::jobs` helpers: id validation, `list` pruning of expired jobs and ICU-sorted output. `cancel` marks a running job `endedAt` and writes the file privately; the TypeScript job owner polls its file, so the write cancels across processes. Rust then publishes the redacted `job` entity event (`redactEndpointError` and email redaction). Job files whose shapes the TypeScript reader treats differently (non-object JSON, non-number `startedAt` or `endedAt`, unreadable directory) forward. Parity: `test/native-job-strategy-setup-parity.test.ts`. |
| `executor.setup.models` | Native (M2, selective) | `pacer-config-ops::executor_setup_ops` ranks cached catalog models from `cache/models.json` (fresh within 24 hours, strict `parseCatalog` shape): usable filter, coding, context and release ordering with ICU collation, and `classify` usage labels. The `local` group, `base_url` probes and providers without a usable cached catalog entry forward, because they need local model-server probes, the `opencode models` subprocess or a models.dev fetch. |
| `executor.setup.connect` | Native (M2) | Pure: Zod checks on `provider` and `key`, then the `opencode auth login <provider>` hand-off. It writes nothing. |
| `executor.models.available` | Forwarded | Lists a runner's models through the `opencode models` subprocess, connection models and the cached catalog, with a 10-minute cache under `cache/available-models/` (`src/models/available.ts`). |
| `runner.models.get` | Forwarded | Reads an executor's default model and allowed tiered models with the strategy-file sha256 revision (`src/core/runner-models.ts`); `runners.<id>.models` and the load warnings live in the TypeScript strategy parser (`src/config/accounts.ts`). |
| `runner.models.set` | Forwarded | One revision-checked edit of the default model and the allowed tiered models under the shared `executor-settings` lock, validated against the live listing (`availableModels`/`isOffered`); refuses ids a known listing does not offer and warns when the listing is unknown for agents that have a model list. |
| `executor.setup.candidates` | Native (M2, selective) | Rust (`pacer-config-ops::executor_candidates_ops`) reads the cached models.dev catalog, the OpenCode config providers and the strategy accounts, runs `opencode auth list --format json` (argv only, 15 s timeout, capped stdout) and builds the candidate groups, order and notes. Probing the two fixed local server URLs (Ollama, LM Studio) goes through the endpoint plugin on Core via the setup effects bridge (`discover`), because endpoint discovery is plugin-owned (P13). Inputs stay forwarded when the catalog is missing, stale or malformed (TypeScript refreshes it over the network), when the strategy does not load, or while `PACER_WORK_GRANT` is set. |
| `attention.dismiss`, `attention.snooze` | Native (M2, selective) | `pacer-task-ops::attention_ops` raises items with `pacer_read_model::attention::raised` over the snapshot probe bridge (`snapshotProbeParts`, read-only status as in TypeScript `raisedItems`) and owns the `state/attention.json` transaction under the shared `attention` lock: Zod issue text, `unknown attention item` errors, unchanged-store no-op and JS-stringified bytes (`src/core/attention.ts`, `src/attention/store.ts`). Selectively forwards `discovery-network` items (raised from the radio network in TypeScript memory), dismissing task items (TypeScript also dismisses the task), an unloadable strategy, and store files or entries the TypeScript transaction would throw on. |
| `issue.import`, `issue.search` | Native (M2 issue reads, selective) | `pacer-issues` owns both ops: published and core Zod params (issue text and order, UTF-16 lengths), the enforcement-identity and executor refusals, registered-repository lookup through `pacer-repos`, the GitHub identity of the `origin` remote (`git remote get-url`, 5 s), issue references (`#n`, digit strings, same-repository URLs through WHATWG URL parsing), and `gh issue view` / `gh issue list` spawned from Rust as argv with the allowlisted environment plus `PWD`, lookup on the service `PATH`, a 20 s deadline over the exit and both output streams that kills the process group, a 4 MiB stdout cap, two running and eight waiting calls, and typed failures from exit codes and stderr. Untrusted titles, bodies and labels are cleaned to plain text as `src/core/issue-import.ts` does; search keeps only this repository's issue URLs, refuses `repo:`/`org:`/`user:` qualifiers and shares a 30 s cache of successes per process. Registries that `repo.list` forwards selectively forward to TypeScript. Residuals: `gh` output with lone-surrogate escapes is not JSON to serde (gh never writes them); the per-process path probe starts cold, so a missing checkout that a long-running TypeScript core has already pruned reads as `not_github` until a native probe has seen it; a `gh` that is found but cannot start reports the operating-system error text rather than Bun's. Parity: `test/native-issue-parity.test.ts` (fake `gh` on `PATH`). |
| `insights.summary` | Native (M2 analytics reads, selective) | `pacer-dispatch-ops::insights_ops` runs the `src/insights/summary.ts` queries over `tasks`, `task_first_settle`, `work_nodes` and `attempt_usage` for the period and the previous one: first-settle acceptance cohorts, per-agent spread (`parseRunnerId` agent), buckets, kinds, ladder steps and rules, and skip reasons. Sorts use ICU root collation (`localeCompare`), `byAgent` objects keep JavaScript integer-key order, `Math.round` rounds halves up, and parsing a routing `skipped` note stops where TypeScript throws. Params use Zod issue text and order, including the period refinements. Inputs with `from` or `to` at or above 1e15 forward, because only `JSON.stringify` prints those numbers. Residual: a skip reason cut at 200 UTF-16 units inside a surrogate pair keeps the lone surrogate only in TypeScript. Parity: `test/native-analytics-parity.test.ts`. |
| `onboarding.try` | Forwarded (P9) | Scratch-repo onboarding delegation via setup mutation (`setup.onboardingTry` in `src/setup/`). |
| `setup.init` | Native (M2, selective) | Rust (`pacer-config-ops::setup_init_ops`) validates the planner (Zod issue text, local planner IDs), sets the planner on an existing strategy without integrations (`pacer-config::settings::set_planner_without_integrations`) or detects installed CLIs, Ollama (`/api/tags`) and LM Studio (`lms ls --json`) and writes the starter strategy with the accounts migration, then publishes the `config` and `setup` changes. Forwarded when `OLLAMA_HOST` is `https://` with an installed `ollama` and no strategy file (TLS probe), or while `PACER_WORK_GRANT` is set. |
| `setup.health` | Forwarded (P9) | Startup Checking-setup gate (`setup.health`): bounded doctor and setup checks as fixed steps, a persisted last-pass fingerprint and the snapshot probe; v3-only. M2 re-evaluation: every run includes the full `doctor` step (see `doctor.run`) and the `setup.check` step, so it stays forwarded until both are native. |
| `tree.status` | Native (M2 analytics reads, selective) | `pacer-messaging-ops::msg_ops::tree_status` resolves the caller as `msg.log` does (an executor may read only its own tree), walks `rootOf`, lists the work-graph node ids in `workTree` order (`depth`, `task_id`) and reads each task record, its pending messages and the tree's turn count from `state/tasks.db` (`pacer-store::messages`). Work-grant, enforcement and Orca-worktree callers forward through `msg_stays_forwarded`. Residual: a corrupt `work_nodes.options` or `work_decisions` row fails `workTree` in TypeScript but not natively. v3-only public op (`liveness.status` remains MCP-only). Parity: `test/native-analytics-parity.test.ts`. |

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

## P6e-run `_run` launch guards (library, no new native ops)

P6e-run deepens P6b without registering `task.delegate` or activating
`RunSpawnOwner::NativeSupervisor`. `resolve_launch_admission_lease` and
`build_run_spawn_plan_for_launch` mirror `launchTaskRunner` lease inheritance;
`drain_launch_run_spawn_plan` and `guard_run_spawn_plan` are the required drain
hook checks before effectful spawn; `SupervisorRunSpawnSpec` maps a guarded plan
into ProcessOwner fields but returns an error while `RUN_SPAWN_OWNER` remains
TypeScript. Cross-runtime coverage: `test/run-spawn-launch-parity.test.ts` and
`cargo test -p pacer-lifecycle run_spawn`.

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

## P2-D SSH/plugin host ops triage (library + native account map)

P2-D evaluated `host.account.add`, `host.check`, `host.clean`, `host.terminal`
and `host.repo.setup` for the largest safe native registration. Only
`host.account.add` met parity without SSH execution: Rust maps the account home
in strategy YAML and returns the login command (`pacer-config::host::
account_login_command`) with endpoint sync and `hosts` publication matching other
host mutations. `host.check`, `host.repo.setup` and `host.clean` need plugin SSH
grants, job runners, transfer gates and effectful remote git/identity/cleanup still
owned by TypeScript; decision logic over injected probes/tasks lives in
`pacer-lifecycle::hosts::{check,setup,clean,setup_plan,validate_clone_preview}`.
`host.terminal` needs Core terminal openers; Rust owns SSH argv/title only via
`terminal_ssh`. Cross-runtime coverage: `test/p6e-parity.test.ts` (check/setup/clean),
`test/host-account-native-parity.test.ts`, `test/host-ssh-lib-parity.test.ts`, and
`cargo test -p pacer-lifecycle terminal_tests`.

## P6d stop/wait triage (library + selective native stop)

P6d evaluated `task.stop` and `task.wait` for the largest safe native
registration. Full parity still needs agent-session gates, `stopWork` subtree
orchestration, queue drain and supervision for managed-work and agent-session
paths; those cases selectively forward to TypeScript. The safe native slice is
`pacer-lifecycle::record_task_stop` (store CAS) plus Core bridges for runner
liveness probe, process/host signals, live-worker release and settle activity
(pattern: `task.dismiss` auto-clean bridge). Selective native `task.wait` returns immediately when `task_wait_settled`
already holds (Core `taskWaitProbe` over agent-session holds); active tasks
forward for drain/supervise. Cross-runtime coverage:
`test/record-stop-parity.test.ts`, `test/native-task-stop-parity.test.ts`,
`test/native-task-wait-parity.test.ts`, `test/task-wait-settled-parity.test.ts`, and
`cargo test -p pacer-lifecycle record_stop wait_settled`.

## P7 session ops triage (library)

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
session ops that need live sessions or replay waits on a full native vt100 replay **GO**, a session host owner, and
the P6 spawn/policy bridges. Session WebSocket and `/v3/.../session` routes remain
forwarded; do not register them, or session ops that depend on live sessions or
replay, while the replay gate is **NO-GO**. A later
slice registers `session.context` natively: it is a read model over the task
store and attachment drafts with no live session state (see its row). The other
thirteen stay Forwarded.

## P6f prepared delegate admission (library, no new native ops)

P6f evaluated `task.delegate` for native registration after P6b–P6d. Public
cutover still needs live plugin `policy.before`, work-grant and work-sync
validation, `commitDelegate` store/queue mutation, `launchTaskRunner` effectful
spawn and messaging turns owned by TypeScript. The incremental library step is
`pacer-lifecycle::delegate_admission`: `map_policy_amendment` and
`DelegateAdmissionSnapshot` mirror `prepareDelegate` / `prepareCreationAdmission`
host snapshot and amendment mapping; `prepare_delegate_admission` composes brief
parse, `validate_current`, runner resolution and `PreparedAdmission::prepare_delegate`
with injected policy. Cross-runtime coverage:
`test/prepared-admission-parity.test.ts`,
`test/fixtures/task-admission/prepared-admission-goldens.json`, and
`cargo test -p pacer-lifecycle prepared_admission`. Native registration waits on
host snapshot bridges (repo identity, exclusions, parent/work lineage), work-sync
grants and a NativeSupervisor `_run` owner.

## P6e dispatch and messaging triage (ledger, no new native ops)

P6e evaluated all twenty-three public `dispatch.*` and eight `msg.*`
operations for native registration. None met parity without the managed work
graph (`src/dispatch/work.ts`, `src/core/work.ts`), observation refresh and
learning stores, enforcement probe jobs, usage-broker-backed preview/explain,
effectful `_run` spawn, messaging store turns, project policy, and
`deliver`/`autoCleanTask` side effects still owned by TypeScript. This slice
only expands the ledger with explicit Forwarded rows and residual owners; it
does not register native handlers. Native cutover waits on P6 spawn ownership,
P5 observation/broker bridges, and a messaging read model. The messaging read
model has since landed for `msg.inbox`, `msg.log` and `msg.read`, and the policy
evaluation for `msg.policy`, and the M2 message-writes slice made `msg.send`,
`msg.confirm`, `msg.close` and `msg.wait` native with turn delivery, human publication
and auto-clean forwarded as effects (see the Native rows above). The later P6 dispatch-reads slice registers
`dispatch.config.get`, `dispatch.list`, `dispatch.tree` and `dispatch.events`
over `pacer-lifecycle::work_reads` (parity:
`test/native-dispatch-reads-parity.test.ts`); the other nineteen stay Forwarded
for the reasons in their rows. The M2 analytics-reads slice later registers
`dispatch.analytics`, `dispatch.learning.reset` and v3-only `tree.status` (see
their rows); `liveness.status` remains MCP-only (`src/mcp/server.ts`). The M2
dispatch-planning slice registers `dispatch.models`, `dispatch.refresh` (backoff and
refusals; a due refresh forwards) and `dispatch.enforcement.consent`; `dispatch.preview`,
`dispatch.explain`, `dispatch.enforcement`, `dispatch.enforcement.probe` and
`dispatch.enforcement.denied` stay Forwarded on TypeScript process state (see their rows).

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
ownership, usage refresh bridges, and P9 setup/service owners. The later
assistant-reads slice registers ten `assistant.*` ops (see below);
`assistant.ask` and `assistant.cancel` stay Forwarded. The later M2 accounts
slice registers seven `account.*` ops (see below); `account.list` and
`account.signin` stay Forwarded.

## M2 accounts (native, selective)

`account.remove`, `account.add`, `account.edit`, `account.adopt`,
`account.models`, `account.test` and `account.usage.check` are registered
native on stdio and HTTP in the `pacer-account-ops` crate. Rust owns the logic
and the writes: the strategy edit, `endpoints/state.json`, evidence retirement
and home deletion. No op calls TypeScript to execute; the
`account_stays_forwarded` predicate forwards only the inputs listed in their
rows, and an enforcement identity is refused natively. After a native write the
existing endpoint-sync hook (`_internal.native-config.finish`) regenerates the
OpenCode endpoint configuration, and the `accounts` config area is published.
No handler reads, logs or returns an endpoint key. `account.list` stays
Forwarded on plugin usage readings and `account.signin` on the terminal
hand-off. `test/native-account-parity.test.ts` compares replies, errors,
strategy, endpoint state, evidence, OpenCode configuration and outbox events
against the TypeScript handlers.

## P7/P8 assistant settings and history cutover (native, selective)

`assistant.status`, `assistant.candidates`, `assistant.settings.get`,
`assistant.settings.set`, `assistant.conversations`, `assistant.conversation`,
`assistant.turn`, `assistant.delete`, `assistant.card.record` and
`assistant.card.refresh` are registered native on stdio and HTTP. Rust opens the
assistant tables in `state/tasks.db` with the TypeScript schema and pragmas
(`pacer-store::assistant`) and reads and writes them directly. No op calls back
into TypeScript to execute. Params use Zod issue text and order. The caller
policy from `parseOpParams` runs first: the enforcement token and executor
sessions (`PACER_ROLE=executor` or an own task worktree) get `not_allowed`, and
Orca task worktrees forward. Inputs where only TypeScript reproduces the result
also forward: admissible `status` (planner pacing), unreadable strategies, stored
settings that fail the schema, an unresolvable local time zone, and card refresh
for a task without a brief or title. `assistant.ask` and `assistant.cancel` stay
Forwarded: they need the assistant plugin, the read-tool loop, the SSE stream
and the in-process live-turn map. Parity: `test/native-assistant-parity.test.ts`
compares results, error bodies and the four assistant tables against TypeScript
`callOp`.

## P2/P6 client, project, runner, job and executor-setup triage (ledger, no new native ops)

This slice evaluated the remaining public `client.*`, `project.*`, `runner.*`,
`job.*` and `executor.setup.*` operations for native registration. None met
parity without client registry liveness, distributed UI control workers,
project messaging/strategy config effects, interactive runner add/check jobs,
shared job cancellation, or OpenCode endpoint onboarding still owned by
TypeScript. This slice only expands the ledger with explicit Forwarded rows; it
does not register native handlers. The M2 job, strategy and executor-setup slice
later registers `job.*`, `strategy.preview`, `executor.setup.models` and
`executor.setup.connect` (see below).

## M2 job, strategy preview and executor setup (native, selective)

`job.list`, `job.get`, `job.cancel`, `strategy.preview`, `executor.setup.models`
and `executor.setup.connect` are registered native on stdio and HTTP. Rust owns
the logic and the state: the job files, the draft application and validation,
and the cached model catalog. No op calls TypeScript to execute. The
`job_strategy_setup_stays_forwarded` predicate forwards only the inputs listed
in their rows. `strategy.preview` reuses the usage-broker bridge, like
`routing.status`, for the current strategy's provider rows. The M2 setup slice
later registers `strategy.build` and `executor.setup.candidates` (see below).
`test/native-job-strategy-setup-parity.test.ts` compares replies,
errors, job files and outbox events against the TypeScript handlers.

## M2 setup init, strategy build and setup candidates (native, selective)

`setup.init`, `strategy.build` and `executor.setup.candidates` are registered
native on stdio and HTTP. Rust owns validation, the strategy file writes,
the prompt and intent files, idempotency, subprocess probes and event
publication. The setup effects bridge (`pacer-config-ops::setup_effects`) carries only
three Core effects: rendering live status text, opening the strategy terminal
from the Rust-written prompt file, and endpoint-plugin discovery of the fixed
local server URLs. `setup_stays_forwarded` lists the forwarded inputs in each
row. `doctor.run`, `setup.health` and `setup.check` stay as their rows describe.
`test/native-setup-parity.test.ts` compares stdio and HTTP replies, errors,
strategy files, session files, terminal hand-offs and outbox events against the
TypeScript handlers, with fake CLIs on `PATH`.

## P6 project messaging cutover (native, selective)

`project.messaging.*` is registered native on stdio and HTTP. Rust validates the
operation params with Zod issue text and order, then reads and writes
`project-messaging.json` directly. Stored entries are rewritten in Zod schema key
order with integral numbers, as TypeScript `JSON.stringify` writes them. The
`project_messaging_stays_forwarded` predicate sends an input to TypeScript when
it names an absolute checkout path, when the policy file cannot be read or fails
the schema, or when `set` carries an invalid nested rule or liveness object.
`project.strategy.*` was later registered native on top of the Rust repository
registry (see its row and `test/native-repo-registry-parity.test.ts`).
`test/native-project-messaging-parity.test.ts` compares results, errors, file
bytes and outbox events against the TypeScript handlers.

## P5/P8 insights, issue and setup residual triage (ledger, no new native ops)

This slice evaluated `insights.summary`, `issue.import`, `issue.search`,
`onboarding.try` and `setup.init` for native registration. None met parity
without task-store analytics, user `gh` subprocess reads, onboarding delegation
spawn, or setup strategy initialization still owned by TypeScript. Native
`setup.check` and `onboarding.skip` remained the only P9 setup/onboarding native
ops. This slice only expands the ledger; it does not register native handlers.
The M2 setup slice later registers `setup.init` (see its row).
The M2 analytics-reads slice later registers `insights.summary`, and the M2
issue-reads slice registers `issue.import` and `issue.search` (see their rows).
The M2 service-and-agent slice registers `service.status`, `update.check`,
`agent.detect` (cache hits), `limits.refresh` (accounts without a refresh
source); `service.handover`, `service.work`, `agent.preview`, `agent.connect`, `agent.disconnect`,
`service.install` and `update.apply` keep their Forwarded rows.

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
`computeStatus` warming). The M2 service-and-agent slice registers the
`unsupported` path natively, which needs no read, and forwards every account
with a refresh source.

## P8 desktop and discovery triage (ledger, no new native ops)

P8 evaluated all seventeen public `desktop.*` and five `discovery.*`
operations for native registration. None met parity without the desktop capture
broker, verified OTA/adoption runtime, LAN discovery radio/state files, pairing
hand-over plugins, client registry liveness, and config/attention publication
still owned by TypeScript (`src/desktop/`, `src/discovery/`, `src/api/ops-desktop*.ts`,
`src/api/ops-discovery.ts`). Snapshot and read-model probes may carry desktop
update rows and pairing eligibility summaries only. This slice expands the
ledger with explicit Forwarded rows; it does not register native handlers.

## P8 desktop reconcile and discovery writes (native, selective)

A later slice re-evaluated `account.*`, `desktop.*` and `discovery.*` for
operations Rust can own from files alone. `desktop.reconcile.status`,
`desktop.reconcile.request` and `desktop.reconcile.cancel` are native: status is
the fixed peer-less assessment and request/cancel validate, then return
`unavailable`. `discovery.set` and `discovery.respond` are native over
`discovery/state.json` under the shared `discovery` lock and publish the
`discovery` config area. The `discovery_stays_forwarded` predicate sends
`respond` `pair` and any state file Rust cannot rewrite byte-for-byte to
TypeScript; `desktop_reconcile_stays_forwarded` sends request/cancel from an
Orca task worktree to TypeScript. `discovery.list`, `discovery.network.get` and
`discovery.network.set` later became native over the Rust `currentNetwork`
probe (see the detailed table);
`desktop.update.status` and `desktop.capture.targets` read in-memory service
runtimes; `account.list` needs usage, endpoint and Orca plugin reads.
`test/native-discovery-desktop-parity.test.ts` compares results, errors, state
file bytes and outbox events against the TypeScript handlers.

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
private `call` on the flag-on path, but **keeps default serve TypeScript-owned**
(`serve_starts_reverse_bridge_by_default = false`). **P4d-6/7** wire
`PluginCapabilitySession` on the flag-on `ProcessOwner`: hello-sealed
`capability.log` / `capability.config.get`, plus Core `call_authority` that
seals exact-path `fs.read` / exact-host `net.http` (and host-supplied
reads/commands/http) so native modules attach for fixture plugin calls.
Default stays off because TypeScript plugin consumers cannot reach the native
owner: Core refuses local spawn when the host is on, and only native HTTP
`plugin.*` operations start children. P4d-13 flipped the const without that and
was reverted. Stdio native plugin ops and further `/_internal/plugins` deletion
remain later. See inventories under `.work/reviews/`.

### Per-scope plugin process owner (P4d-1 … P4d-7)

| Scope | Owner today | Notes |
| --- | --- | --- |
| Service (`pacer serve`) | TypeScript Core (default); Rust `ProcessOwner` when flag on | Flag-on: ProcessOwner starts/supervises children for native HTTP plugin RPC and bridge spawn/call/find/stop; answers hello-sealed `capability.log`/`config.get` and Core-sealed call-scoped fs/process/http (P4d-6/7); Core seals spawn_spec/`call_authority` and refuses local spawn; private `call` retired. Default stays off; `=0` escape ready for default-on. |
| Stdio (`pacer-core api --stdio`) | TypeScript | Unchanged (P8) |
| CLI one-shots | TypeScript | Unchanged |
| `_run` runners | TypeScript (effectful) | P6b/P6e-run: Rust `run_spawn` records and guards the launch plan with `RunSpawnOwner::TypeScriptCore`; drain hooks must call `drain_launch_run_spawn_plan` before injected spawners. ProcessOwner spawn via `SupervisorRunSpawnSpec` stays gated until `RUN_SPAWN_OWNER` cutover. |

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
  (library `claimRun` proof). Live Core `executor.run` stashing, full process.run
  lifecycle on the native owner, and CT-11 remain open; default stays off.
- **P4d-13 (reverted):** flipped `serve_starts_reverse_bridge_by_default = true`
  without CT-11. With the native host on, Core refuses local spawn but only native
  HTTP `plugin.*` operations start children through the `ProcessOwner`, so every
  TypeScript plugin consumer (usage refresh, doctor and setup-health integration and
  Usage checks, planners) failed with `plugin_unavailable`. The default is off
  again until TypeScript consumers reach the native owner over the bridge.
- **P4d-1 landed (flag-gated):** serve can claim `ProcessOwner` + reverse bridge
  + `PACER_HOST_SOCKET`. Default remains TS child ownership.
- **P4d-2 landed (flag-gated):** live `_host.plugin.call` / `find` against
  serve-owned children.
- **Blocked on later P4d:** flipping `serve_starts_reverse_bridge_by_default`
  (needs TypeScript plugin consumers to reach the owner over the bridge),
  deleting remaining `/_internal/plugins` kinds (still needed for
  prepare/spawn_spec/call_authority/ready/changed/publish/log), stdio native
  plugin ops, executor-class call resources, observation/hosts/orca on the
  native owner, and CT-11 live evidence.
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
| `host.account.add` | Native YAML map + login command; no SSH or host-adapter probes. |
| Host YAML edits (`host.add` / `set` / `remove` / `repo.map`) | Native: `pacer-config::host` plus P2-C endpoint sync, `hosts` publication and pause activity (`host.set` summary via host-read bridge). |
| `runner.settings.*` | Native: library CAS + `executor-settings` lock + `runners` publication. Endpoint sync is not required for these ops. |
| `repo.list` | Native: `pacer-repos` registry read, path probe, prune and branch reads; unusual registries forward. |
| `repo.add` | Native: `pacer-repos` git identity and registration under the `repos` lock; unusual registries forward. |
| `repo.remove` | Native file effects when registry JSON is compatible; legacy shapes forward to TypeScript. URL `repo_key` remains in `pacer-config::host`. |

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

Pinned against `stdio_hello.json` v3 (`231` ops). The Rust registry lists
native names in the detailed table above; every other public op remains TypeScript-owned
until a cutover PR registers it and updates this ledger. Rows already named in
the table above are omitted here. Owner streams follow
`docs/specs/2026-10-20-rust-host-migration-design.md` §2 and the 2026-11-01
reconcile plans. Counts are op prefixes, not reviewable PR slices.

No prefix aggregates remain: every v3 public op in `stdio_hello.json` is named
in the detailed Native or Forwarded table above (including HTTP-native plugin
ops and selective forwards such as `mode.hold` without `until`).

Total unregistered (not in the detailed table): **0**.
Total native: **145** of 231 (133 on the Rust stdio registry plus 12 HTTP-native
`plugin.*` ops). Fifty-eight of these selectively forward some inputs or effects to TypeScript:
`config.set`, `mode.hold`, `routing.route`, `task.retry_options`, `repo.list`, `repo.add`, `repo.remove`, `task.stop`,
`task.wait`, `task.review`, `project.messaging.get`, `project.messaging.set`,
`project.messaging.remove`, `project.strategy.list`, `project.strategy.get`,
`project.strategy.set`, `project.strategy.remove`, `msg.inbox`, `msg.log`, `msg.read`, `msg.policy`, `tree.status`,
`msg.send`, `msg.confirm`, `msg.close`, `msg.wait`,
`discovery.set`, `discovery.respond`, `discovery.list`, `discovery.network.get`,
`discovery.network.set`, `runner.add`, `runner.set`, `attention.dismiss`, `attention.snooze`, `desktop.reconcile.request`,
`desktop.reconcile.cancel`, `assistant.status`, `assistant.candidates`,
`assistant.settings.get`, `assistant.settings.set`, `assistant.conversations`,
`assistant.conversation`, `assistant.turn`, `assistant.delete`,
`assistant.card.record`, `assistant.card.refresh`, `dispatch.dependencies.waive`, `insights.summary`,
`dispatch.refresh`, `dispatch.enforcement.consent`, `strategy.preview`, `executor.setup.models`,
`issue.import`, `issue.search`, `strategy.build`, `executor.setup.candidates` and `setup.init`, `service.status`, `update.check`, `agent.detect`, `limits.refresh`, `account.remove`, `account.add`, `account.edit`, `account.adopt`, `account.models`, `account.test`, `account.usage.check`.
Total still not native (v3 − native set): **86**.

When a prefix cutover lands, move those ops into the detailed table as Native
or keep an explicit Forwarded row with the residual reason. Do not delete a
prefix row until every op under it is accounted for.
