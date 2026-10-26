# Plugin extraction: sub-projects 2 to 12 of milestone M0

Status: design agreed 2026-10-19. Follows [plugin host core](2026-10-19-plugin-host-core-design.md)
(sub-project 1) under the [plugin system design](2026-10-19-plugin-system-design.md). Each
section below is one sub-project with its own implementation plan and PR. Nothing is built.

## Decisions taken while brainstorming

| Question | Decision |
|---|---|
| Executor plugins | Full attempt owners. A plugin owns the run directory, logs, worktree, supervision and live-session files of an attempt. The host keeps the task store and applies the plugin's progress events to it. |
| Distribution | In M0, as the last sub-project: `plugin.add` from a signed archive, publisher keys, `entitlement.report`. |
| SDK publishing | `@pacer/plugin` 0.1.0 is published to npm with the pacer release that closes M0. The Rust crate waits for M1. |
| Order | Usage, classifier, notifier, endpoint vendor, planner integration, policy, host runner, direct executor, Orca executor, surfaces, distribution. |
| Orca | Not redesigned. The Orca executor is extracted as it is; the Orca panel stays a client. |

## Protocol additions (1.1.0, additive under P14)

### Streaming calls

A plugin may send `$/progress { id, event }` notifications while a request with that id is
in flight. The host's `request` takes an `onProgress` callback and `deadlineMs: 0` means no
deadline; such calls end only by reply, `$/cancel` or exit. Used by `executor.run`.

### Events to plugins

A plugin that declared `events.subscribe` receives `$/event { type, data, seq }` notifications
for the API event types it subscribed to with `capability.events.subscribe { types }`.

### Capabilities, by the sub-project that implements them

| Capability | Call | Host behavior | Sub-project |
|---|---|---|---|
| `fs.read` | `{ path }` → `{ text }` or `{ missing: true }`; `fs.list { dir, glob }` → `{ paths }` | Path must be inside a declared scope after expanding `~`, `$HOME`, `$PACER_HOME`, `$ACCOUNT_HOME` (the current call's account home). Read as the host user, 4 MiB cap. | 2 |
| `process.spawn` | `{ argv, cwd?, stdin?, timeoutMs, env? }` → `{ code, stdout, stderr, timedOut }` | `argv[0]` basename must be in the declared scope (`*` for executors). Argument vector only. Output capped at 1 MiB each. `env` entries whose value is `{ secretRef }` are resolved by the host at spawn. | 2 |
| `net.http` | `{ url, method, headers?, body?, timeoutMs, authorization?: { secretRef, scheme? } }` → `{ status, headers, body }` | URL host must match a declared scope; the host adds `Authorization: <scheme> <secret>` so the plugin never sees it. 4 MiB body cap, no redirects. | 3 |
| `secrets.resolve` | `{ ref }` → `{ present }` | Refs: `env:NAME`, `secrets:NAME` (the pacer secrets file), `endpoint:<account>` (endpoint key store). Never returns the value. | 3 |
| `tasks.read` | `{ id }` → `{ task }`; `tasks.list { states?, limit? }` → `{ tasks }` | Read model tasks, redacted as the API does. | 7 |
| `events.subscribe` | `{ types }` → `{ ok }` | Starts `$/event` delivery. | 7 |
| `hosts.open/run/fetch` | See section 8 | Forwarded to the host-runner plugin serving the alias. | 8 |
| `fs.write` | `{ path, text, mode? }`, `fs.mkdir`, `fs.remove` | Inside declared scopes only. | 9 |
| `tasks.patch` | `{ id, expect_rev, patch }` → `{ task }` | Only the fields an executor owns: `run`, `placement`, `worktree`, `baseBranch`, `progress`, `takeover`, `question`. `conflict` on a stale rev. | 9 |
| `entitlement.report` | `{ status, detail?, until? }` → `{ ok }` | Stored on the registry entry, shown by `plugin.list`. | 12 |

Scopes are declared in the manifest capability entry (`scopes: [...]`) and shown in the grant
prompt. In phase 1 the host enforces them on capability calls; a subprocess can still bypass
them through the operating system, which is what the wasm transport closes in M3.

### Secret references (P5)

A secret reference is a string the host can resolve and the plugin cannot: `env:NAME`,
`secrets:NAME`, `endpoint:<account>`. Plugins receive references in their inputs and pass
them back in `net.http.authorization` or `process.spawn.env`. The host resolves at the
moment of use. No capability returns a secret value.

## 2. Usage readers: `pacer-usage`

Extension point `usage`. Host calls `usage.read { provider, account, accountHome, model?, weeklyTokens?, quotaSource? } → UsageReading` with a 10 s deadline. The manifest's `contributes.usage.providers` lists the provider ids served (`claude-code`, `codex`, `arkcli`, `metered`). The host's broker (`src/usage/index.ts`) keeps the 60 s cache, the per-account aggregation, remote merge, auth marks and exhausted marks, and dispatches `base()` to the plugin that contributes the provider.

Moves into the plugin: `claude.ts`, `codex.ts`, `byteplus.ts`, `metered.ts`, `cache.ts` (as SDK helper `cachedFetch` over `fs.read`/`fs.write` is not available yet, so the plugin caches in memory per process; the 60 s host cache covers the rest). Stays in the host: `index.ts`, `auth.ts`, `reactive.ts`, `freshness.ts`, the pure Codex parsers (`findRateLimits`, `windowsFromRateLimits`) moved to `src/usage/codex-parse.ts` for the SSH probe, and `claudeCacheFile` moved to `src/usage/paths.ts` for the status-line writer.

Capabilities: `fs.read` with scopes `$HOME/.claude/state`, `$PACER_HOME/cache`, `$HOME/.codex`, `$ACCOUNT_HOME`; `process.spawn` with scope `arkcli`, `opencode`.

Done: `pacer status` and the web overview show the same readings as before for every account kind, verified live; `test/claude.test.ts`, `codex.test.ts`, `byteplus.test.ts` move into `plugins/pacer-usage/test/`; conformance gains a `shadow` fixture.

## 3. Classifier: `pacer-classify`

Extension point `classifier`. Host calls `classifier.ask { adapter, state, question } → Answer` with the configured timeout (default 5 s) and `classifier.adapters → [{ id, external }]`. The decision log, shadowing, fallback and bench stay in the host (`decide.ts`, `log.ts`, `metrics.ts`, `truth.ts`, `state.ts`, `bench.ts`, `classifier-hooks.ts`). Moves: `rules.ts`, `ollama.ts`, `jev.ts`, `http.ts`.

Capabilities: `net.http` with scopes from config (`classifier.adapters.ollama.url` host, `jev` host), `secrets.resolve`. The plugin passes `authorization: { secretRef: "secrets:JEV_API_KEY" }`; the host resolves from `ctx.env` then the secrets file, as `classify/secrets.ts` does today.

Config: the plugin's slice is `plugins.config.pacer-classify`, populated by the host from the existing `classifier.adapters` section so user config does not change.

## 4. Notifier: `pacer-notify`

Extension point `notifier`. Host calls `notifier.deliver { key, title, body, url } → { delivered }` with a 5 s deadline. The host keeps the ledger, levels and client-notifier preference (`decide.ts`); when no client notifier is registered it calls every enabled notifier plugin in id order until one delivers. Moves: `fallback.ts` (osascript, notify-send). Capabilities: `process.spawn` scope `osascript`, `notify-send`.

## 5. Endpoint vendor: `pacer-endpoints`

Extension point `endpoint` with `contributes.endpoint.apis: ["openai-compatible"]`. Host calls `endpoint.models { baseUrl, keyRef } → DiscoveryResult` (10 s), `endpoint.launchEnv { account } → { env, secretEnv }` where `secretEnv` maps variable names to secret refs the host injects at spawn, and `endpoint.test { account, runner } → EndpointState` (120 s). Moves: `models.ts`, `opencode-config.ts` (rendering), `test-task.ts`. Stays: `keys.ts` (the key store is a host secret source), `state.ts`, `row.ts`. Capabilities: `net.http` scope `*` (user-entered base URLs), `secrets.resolve`, `fs.write` scope `$PACER_HOME/opencode` for the rendered OpenCode config.

## 6. Planner integration: `pacer-planners`

Extension point `planner` with `contributes.planner.agents: ["claude-code", "codex", "cursor", "opencode"]`. Host calls `planner.detect { agent } → AgentDetection`, `planner.plan { agent, folder } → { files, undo }` (preview), `planner.install { agent, env } → InstallReport`, `planner.uninstall { agent } → UninstallReport`, `planner.check { agent } → { intact, files }`. The transaction, manifest and undo machinery (`txn.ts`, `manifest.ts`, `blocks.ts`, `hookjson.ts`, `jsonc.ts`, `fsx.ts`) moves into the SDK as `@pacer/plugin/install` so any planner plugin edits files with backups and recorded undo. Stays: `self.ts`, `role.ts`, `login.ts`, `doctor.ts`, `statusline.ts` (writes the Claude cache; it is a planner hook), `init.ts`, `uninstall-all.ts` (iterates plugins). Capabilities: `fs.read` and `fs.write` scopes `$HOME/.claude`, `$HOME/.codex`, `$HOME/.cursor`, `$HOME/.config/opencode`, `$PACER_HOME`; `process.spawn` scope `claude`, `codex`, `cursor-agent`, `opencode`.

The install manifest file (`$PACER_HOME/install-manifest.json`) stays host-owned; the plugin returns the record and the host writes it, so `pacer uninstall --all` and setup checks keep working without starting plugins.

## 7. Policy

Extension point `policy`, no bundled plugin. Host calls `policy.before { decision, input } → { verdict: "allow" | "amend" | "veto", amend?, reason? }` with a 3 s deadline at three points: `delegate` (before a task is created; amend may change `kind`, `requestedExecutor`, `placement`), `route` (before an executor is picked; amend may remove candidates), `review` (before a verdict is recorded; veto blocks accept). Config `plugins.policy: { mode: "open" | "closed" }` default `open`: on timeout or error the decision proceeds (open) or is refused with `not_allowed` and the plugin id (closed). Every surface that shows setup shows the mode. A veto writes an activity entry `policy` with the plugin id and reason. Capabilities: `tasks.read`, `events.subscribe`, `config.get`, `log`. Conformance adds fail-open, fail-closed, amend and veto cases with a fixture policy.

## 8. Host runner: `pacer-ssh`

Extension point `hostRunner` with `contributes.hostRunner.kinds: ["ssh"]`. Host calls `hostRunner.check { host } → HostCheck`, `hostRunner.open { host } → { session }`, `hostRunner.run { session, script, args, stdin?, timeoutMs } → RunResult`, `hostRunner.stream { session, script, args } → stream of bytes via $/progress`, `hostRunner.fetch { session, bundle } → { path }` (bundle into `$PACER_HOME/transfers`), `hostRunner.close { session }`. Moves: `ssh.ts`, `ssh-config.ts`, `scripts.ts`, `transfer.ts` (bundle verification stays host-side in `src/remote/bundle.ts`), `recording.ts`, `session.ts`, `viewer.ts`, `runtime.ts`. Stays: `hosts.ts` (host records and ops), `eligibility.ts`, `usage.ts` (uses `hostRunner.run` through the capability). Executors reach remote hosts through the `hosts.*` capability, which the host forwards to the plugin serving that alias. Capabilities: `process.spawn` scope `ssh`, `git`; `fs.write` scope `$PACER_HOME/transfers`, `$PACER_HOME/ssh`.

## 9. Direct executor: `pacer-exec-direct`

Extension point `executor` with `contributes.executor.backends: ["direct"]`. Host calls `executor.available { strategy } → { available }`, `executor.run { task, cfg, attempt } → AttemptOutcome` (no deadline, streaming `$/progress` events `{ kind: "spawned", pid }`, `{ kind: "run", run: RunRef }`, `{ kind: "placement", placement, worktree, baseBranch }`, `{ kind: "progress", progress }`, `{ kind: "question", text }`, `{ kind: "log", bytes }`), `executor.stop { taskId, attempt, graceMs } → { code, killed }`, `executor.resume { task, cfg } → AttemptOutcome`. The host applies `run`, `placement` and `progress` events to the task record through the same code `tasks.patch` uses, so `task.get`, the review screen and live sessions keep reading the same fields.

Run directory contract v1: `$PACER_HOME/runs/<task>/<attempt>/` with `argv`, `stdout`, `stderr`, `pid`, `exit`, `session.log` (framed), `session.json`, `report.json`, as `src/supervisor/run.ts` writes today. The host's live-session bridge and `task.log` keep reading it. The contract is documented in the plugin protocol doc.

Moves: `direct.ts`, `launch.ts`, `process.ts` (also kept in the SDK as `@pacer/plugin/exec`), `prompt.ts`, `limits.ts`, `verify.ts`, `supervisor/*`, `session/host.ts`, `session/reports.ts`, `remote/attempt.ts`, `remote/run-io.ts`. Stays: `backend.ts` (now a thin dispatcher to plugins), `broken.ts`, the task store, `session/*` viewers, attach and takeover. Capabilities: `process.spawn` scope `*`, `fs.read` and `fs.write` scopes `$PACER_HOME/runs`, `$PACER_HOME/worktrees`, `$PACER_HOME/tasks`, `$PACER_HOME/transfers`, repository paths (granted per task through the call input), `tasks.read`, `tasks.patch`, `hosts.*`, `secrets.resolve`.

Routing and `selectBackend` stay in the host. `PACER_BACKEND` keeps forcing a backend id.

## 10. Orca executor: `pacer-exec-orca`

Same extension point, `contributes.executor.backends: ["orca"]`. Moves `src/exec/orca/*` and `src/orca/accounts.ts`'s executor parts. `src/link/pump.ts` stops importing `exec/orca`: the live-terminal check becomes `executor.sessionState { taskId } → { live, handle }` on the backend that ran the task. This crosses ARCH-4 and gets an architecture review. Capabilities: `process.spawn` scope `orca`, plus the direct executor's set.

## 11. Surfaces

Extension point `surface`. A plugin declares `contributes.surface: { prefix, dir }` and the host serves the folder's static files at `/app/plugins/<prefix>/` under the app's auth and CSP, with the plugin's manifest id as the only allowed script origin. No host call is needed in phase 1. The web app gains Settings → Plugins: the list with state, tier, capabilities, grant prompts, enable, disable, remove, doctor and entitlement status, built on the `plugin.*` operations and the `plugin` event. The TUI gains a one-line plugin summary in `pacer status`. Orca panel and desktop are unchanged.

## 12. Distribution

- Archive: `<id>-<version>.tgz` containing the plugin folder, plus `<id>-<version>.tgz.sig`: an Ed25519 signature over the archive bytes by the publisher key named in the manifest. `scripts/plugin-pack.ts` builds and signs a plugin folder.
- Keys: `plugins/publishers.json` ships the pacer publisher key; `$PACER_HOME/plugins/publishers.json` holds user-added keys (`pacer plugin trust <publisher> <key>`).
- `plugin.add { source }` where source is an `https://` URL, a GitHub release URL or a local path: download to a temp dir, verify size (≤ 50 MB) and signature, read the manifest, refuse bundled ids and shadows, unpack into `$PACER_HOME/plugins/<id>/`, leave the plugin disabled until `plugin.enable` grants. The CLI is `pacer plugin add <source> [--yes]`.
- `entitlement.report` stores `{ status, detail, until }` on the entry; `plugin.list` returns it; the web screen shows it beside the tier.
- `@pacer/plugin` 0.1.0 is published from `release.yml` with the pacer release. The SDK README documents a usage reader in twenty lines.

## Governance per sub-project

- Each PR regenerates `docs/plugin-protocol.md` and the schema; every new extension point or capability is a protocol minor bump.
- Sub-projects 9 and 10 need the architecture reviewer; 3, 5, 6, 8, 9, 10 and 12 need the security reviewer (secrets, spawn, network, file writes).
- CT-11 applies to every sub-project except 11's TUI line when no plugin is installed.
- Unit tests move with the code into `plugins/<id>/test/` and run through the SDK harness; host tests for the broker, dispatcher and capability checks stay in `test/`.

## Risks

- Full attempt ownership means the executor plugin and the host share the run-directory format on disk. The contract is versioned (`runDir: 1` in `executor.run` input) and the conformance suite asserts the layout.
- Process count: usage, classifier, notifier, endpoints, planners, direct executor and Orca executor make up to seven Bun processes when all are active. SP02 measured five first `plugin.doctor` calls in separate already-running compiled hosts on macOS arm64/Bun 1.4.2: 97–165 ms (median 112 ms), with live child RSS 59,328–59,904 KiB (median 59,664 KiB). These warm-cache samples were taken under concurrent test load; they measure registry/start/hello/ping latency and point RSS, not cold executable launch, private memory or aggregate plugin overhead. Sub-project 2 measures start-up and memory and records them in the PR; if the total is unacceptable, sub-project 4 adds a `pacer plugin run --multi` entry that serves several bundled plugins from one process, invisible to the contract.
- The planner integration moves file-editing machinery into the SDK; the undo records must stay byte-compatible with existing install manifests, covered by fixture manifests in `test/fixtures/install/`.
