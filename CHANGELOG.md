# Changelog

Notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Releases from 0.1.15 on are published on GitHub Releases, npm and Homebrew.

## [Unreleased]

### Added

- Agent live-control commands for browser/tray, TUI and native macOS targets, with authenticated owned-window self-capture and explicit native permission setup.
- Native permission setup in desktop Diagnostics: a draggable hosting-app chip docks to System Settings, with a Finder alternative, cancellation and owned-window access verification.

## [0.6.2] - 2026-10-21

- Normalize absent compiled desktop signer pins and validate production macOS signing in enabled release dry runs before tagging.

## [0.6.1] - 2026-10-21

- Fix Linux desktop release compilation, secure temporary macOS signing keychain permissions before importing release credentials, and create missing parent directories for the release feed dry run.

## [0.6.0] - 2026-10-21

### Added

- macOS desktop OTA support with complete app/service packages, explicit restart after download, work admission, verified recovery, and shared Settings, tray, TUI and CLI controls. Until pacer has an Apple Developer ID, releases are signed with a pinned project certificate; a later bridge release moves installed apps to Developer ID builds by update. macOS desktop downloads are the signed, auto-updating app; Linux packages are unchanged.
- Separate `desktop.update.*` operations on protocol v3 and `pacer desktop-update` commands; existing standalone CLI update operations retain their behavior.
- Explicit human review handoff through `task.request_review`, MCP `task_request_review`, and `pacer task request-review <id> --note <concern>`, with revision guards and no inferred acceptance.

- Rust front door for local source builds: native version and status line, HTTP/SSE/WebSocket and stdio transports forwarding to a supervised TypeScript core, shared-state locking, Rust plugin SDK and conformance fixtures. Release packaging remains the single Bun binary until paired updates ship.
- Guided OpenCode endpoint setup: `pacer account add` and Settings › Add executor list providers already signed in to OpenCode, local model servers (Ollama, LM Studio) and catalog providers, recommend a model that can call tools, set the usage type from the models.dev catalog and offer an optional weekly dollar cap. Signed-in providers are stored as `source: opencode` accounts that refer to the provider and never hold its key. `pacer account add opencode <provider> [--model] [--cap-usd] [--name] [--no-test]` does it in one command. Spend is read in dollars from `opencode stats --cost`, and new API ops `executor.setup.candidates`, `executor.setup.models` and `executor.setup.connect` serve the app.
- Plugin host: `pacer-plugin.json` manifests, `plugin.list/enable/disable/remove/doctor` operations and `pacer plugin …` commands, a stdio JSON-RPC plugin transport with deadlines and crash backoff, the `@pacer/plugin` runtime, a conformance suite and the generated `docs/plugin-protocol.md`. No plugin is bundled yet; behavior is unchanged for a fresh install.

### Fixed

- Executor routing shares timestamped, scoped eligibility evidence across status and launch guards; uncertain fallbacks remain permitted and visibly labelled, and historical usage no longer implies current quota.

- Native desktop buttons keep readable backgrounds when switching Light/Dark appearance instead of retaining the previous theme during a stuck background transition.
- Settings > Updates distinguishes the native desktop app version from the connected service version, provides desktop download/replacement guidance, and labels the service-only update action explicitly. Failed update checks no longer appear as up to date.

- Settings categories open separate pages with icon navigation and a proper gear icon. Forms use consistent compact sizing, bounded widths and aligned spacing; narrow layouts keep category navigation and focused controls visible.

### Changed

- Session details now show a structured Brief, readable executor reports alongside collapsed technical logs, a responsive Activity panel, and an on-demand retry dialog.
- Overview uses aligned pairs of cards and paginated attention, running, capacity, completed-work and activity lists, keeping the existing design system and compact layout.
- Repository filters use filled count badges and a searchable **Find repo** menu anchored to its trigger, with compact rows, selected checkmarks, keyboard navigation and narrow-screen containment. The finder includes repositories with no current work.
### Fixed

- Delegation preserves an explicitly selected checkout's real path instead of substituting a registry checkout of the same repository.
- User-blocked executors cannot be selected through aliases, dispatch races or fallback. Confirmed budget exhaustion refuses explicit requests when paid execution is forbidden; newer scoped recovery evidence and explicit paid permission remain effective.
- New worktrees fetch origin's default branch tip and record its SHA. `--worktree-base head` explicitly selects the current HEAD. Review retries reuse the original local worktree, including uncommitted changes.
- Automatic child placement still starts executors in local-only repositories without origin, preserving session takeover support; explicit new/default requests continue to require origin.

## [0.5.0] - 2026-10-20

### Added

- One-click releases: **Prepare release** picks the next version from commit titles, opens the release PR, dry-runs it and auto-merges it; **Release tag** then tags and publishes. Release PRs that change only version strings no longer need a UI evidence manifest.
- Settings Diagnostics runs doctor checks with repair guidance, distinguishes configured integrations from fixture-tested handlers and unverified Claude invocation, and flags disabled or incomplete Claude hooks.

### Changed

- Needs you replaces the routine review queue across the app, tray and terminal dashboard. Successful completion without a verdict stays in Tasks; failed checks, incomplete work and explicit human decisions remain actionable. Task results put checks and changes before collapsed transcripts, separate execution from verdicts, and clarify that acceptance does not merge branches. Legacy task links remain supported.

- `pacer dashboard` is redesigned on the shared design system: Home, Review, Sessions, Settings and Setup screens mirror the app, statuses are glyph plus label, colors follow the design tokens for dark and light terminals, destructive actions confirm, and `--plain` and `--once` print screen-reader-friendly or single frames. The dashboard now reads and writes only through the API.

### Fixed

- Executor eligibility now uses timestamped availability and budget evidence across routing, guards and launch checks. Confirmed eligible choices come before automatically permitted, labelled uncertain fallbacks; expired quota remains historical and credits do not override paid-execution policy (#213).
- Linux arm64 gets an AppImage again. AppImages now bundle the CLI untouched: linuxdeploy's patchelf step corrupted Bun-compiled binaries, so they are repacked after bundling and the bundled CLI is checked before release (#217).
- The interactive account and endpoint setup checks each answer as it is entered and asks again instead of aborting: kind, name, key storage, usage, weekly token budget (with a budget-specific message) and quota source. A blank quota source selects `arkcli` instead of saving an empty value, with a warning when `arkcli` is not on `PATH`. Endpoint setup now asks where to keep the key on add as well as edit (Keychain on macOS and a file elsewhere by default). Endpoint save errors show their full reason instead of only the first line, and migration notices no longer print array indexes.
- Account sign-in state now has one source, the local login indicator plus recorded authentication failures, shared by `account list`, routing, the Executors and Accounts screens, attention and `runner.check`. `account list` reports `signedIn: true/false` for native accounts instead of always `null`; a signed-out executor shows as Unavailable with its reason instead of Ready; the Accounts screen shows endpoint state (Ready, Not tested, Not working, Key missing) for endpoints and offers **Fix sign-in** only for signed-out native accounts.
- `runner.check` no longer fails a signed-in Claude or Codex account that has no usage reading yet: **Signed in** uses the sign-in state rather than usage, and **Usage readable** is skipped with the reason, so the test task runs.
- `pacer route` without `--repo` uses the project policy of the registered repository in the current directory, as `pacer delegate` does, instead of always showing global routing.
- `pacer project strategy set --executors ''` explains that `pacer project strategy remove` restores the global strategy, instead of reporting an unknown option.
- When an explicitly requested executor cannot run and another one does, the task records `executorFallback` (`executor_fallback` in summaries) with the requested executor and the reason, and `tasks`, `tasks <id>` and `delegate --wait` show it. Fallback behavior is unchanged.
- The Executors settings no longer claim that an executor failing its check is skipped until it passes; a failed check marks it Failing and raises attention, and routing keeps using it unless it is unavailable for another reason (as before). Disable it to skip it.
- An endpoint executor that has never passed its test task reads **Not tested** in the Executors screen, Overview and tray instead of Ready, matching its account (routing still uses it, as before; the executor summary adds `untested: true`). Add executor offers **Sign in** only for a signed-out native account, each **Fix sign-in** disclosure names its account for screen readers, and an executor row no longer repeats its reason under Last check.
- The accounts guide gives the real default folder for pacer-managed accounts, `~/.<kind>-<name>`, instead of `~/.pacer/accounts/<name>`.

## [0.4.0] - 2026-10-20

### Added

- Per-project executor allowlists with strict priority order, persistent policies, revision-checked API and CLI configuration, and a Routing settings editor (#190).
- The desktop app ships its own CLI, shows Welcome and one consent screen before it changes anything, links `pacer` into `~/.local/bin` and can add an opt-in PATH line; recovery pages each offer one action; unsigned desktop downloads are published with each release. Linux arm64 ships as `.deb` only for now: the AppImage tool corrupts its bundled CLI.
- Setup walks through five steps with an inline connection preview, executor priority controls, and first-task progress and review.

### Removed

- The Orca plugin: its panel, worker, marketplace manifest, `orca-plugin` branch and tag publishing, `pacer link status|probe`, the `pacer init` live-panel step and the "Orca panel" setup item. Use the desktop app or `pacer open`. Running delegated work in Orca worktrees is unchanged. `pacer plugin uninstall` and `uninstall --all` remove an earlier install; other `pacer plugin` subcommands exit 2. Protocol 3 keeps the `plugin.install` op, which now fails with `not_allowed`, `update.check` returns `plugin: null`, and `version.get` no longer includes its optional `plugin` field; the op and the null field go with the next protocol major.

### Fixed

- Setup discovery avoids IDE launchers and local-model app startup, so selecting a planner does not launch another app over the pacer window.
- The desktop app's "Another pacer is running" page names the ports when only the port differs and shows how to free the service (`pacer service uninstall`); on Linux without systemd or a CLI it shows the install page instead of a stuck sign-in (#194).
- `pacer service install` refuses to replace another pacer's login service (`--replace` overrides); `uninstall --all` refuses while delegated tasks run (`--force` overrides) and removes the app's link and PATH line; `pacer update` points to the app when its CLI came with the app.

## [0.3.1] - 2026-10-19

### Fixed

- The macOS service is installed as a Standard launchd job instead of Background. Background jobs get throttled disk I/O, and under memory pressure that stalled the service and its health thread for 30–90 seconds, so the desktop app kept restarting it. Reinstalled on update.

- `release:prepare` now keeps the desktop app configuration, Cargo manifest and lockfile version in step with `package.json`; the desktop version is corrected to 0.3.0 (#188).

## [0.3.0] - 2026-10-19

### Added

- Shared UI foundation checks for canonical controls, token usage and import boundaries, plus required UI compliance and review evidence metadata for UI-changing pull requests (governance adoption by maintainer merge).
- Reviewed or dismissed settled tasks archive after 14 days (configurable), with compressed logs, `tasks --all`, `tasks prune --dry-run` and `tasks restore <id>`.

- Live validation supports `up --seed ui` for isolated setup-complete UI sample data without starting executors.

- Cargo workspace for the Rust host, generated protocol types, and required Rust CI checks.

- Rust plugin SDK `pacer-plugin` (unpublished until M1 completes).

### Fixed

- The service no longer restart-loops when building a snapshot is slow: a listener thread answers `/health` (reporting `backendLagS` from a main-thread heartbeat, 503 when it is older than 45s), snapshot and status reads serve the last value while refreshing in the background, and the desktop app restarts the service only after repeated failed probes over at least 30 seconds.
- Status and activity readers scan Claude and Codex session logs incrementally (per-file cursors, appended bytes only) instead of re-reading the whole 28-day history on every status refresh; `PACER_TRACE_STATUS=1` prints per-phase timings.
- Running tasks are supervised by a 5-second service timer; task reads no longer respawn or fail runners, and resolution checks no longer rewrite unchanged tasks every minute.
- `pacer serve --help` prints usage instead of starting a second server.
- Task records use a private SQLite store with indexed active/recent queries, concurrent transactional updates, non-destructive legacy import and atomic JSON write-through for older binaries.

- Delegate defaults to the active repository filter or remembered repository, supports an optional task kind, previews routing and submits with Cmd+Enter (Ctrl+Enter on Linux).
- Headless Session views explain the run and highlight Take over instead of showing unavailable watch options.
- Desktop sign-in loops show a diagnosis and last error after 45 seconds, keep retrying with a tray error dot, and write lifecycle logs to a rotating private desktop log.
- Account, runner and endpoint edits automatically migrate legacy settings with a backup instead of asking you to run `pacer config migrate`.

- `pacer delegate` accepts common kind aliases (`bugfix`/`fix`/`bug`, `test`, `doc`, `perf`) and suggests the closest kind for invalid input.
- The macOS desktop app detects replacement of its running bundle every 30 seconds and relaunches the installed bundle while preserving window visibility and route and reconnecting the tray.

- Informational planner pace notices stay on the planner strip and tray header without adding Needs you items, badge counts or a tray attention dot.
- Service startup refreshes the managed Orca plugin only when bundled asset hashes differ, with one dismissible Needs you reload reminder per changed bundle (#124).

- Desktop uses `/v3` for native authentication, snapshots, events and operations, and accepts protocol major 3 while retaining major 2 compatibility.

- Local builds embed the package version and Git revision; update notices no longer offer equal or older releases to development builds.
- Completed tasks retain their review diff and file statistics after their worktree is cleaned up (#121).

- Task titles keep bare file names such as `calc.py`; a real path or URL in mid-sentence now ends the title instead of leaving a hole.
- Snapshots report `service.waiting { kind, path, since }` while a repository file-system call is stuck, e.g. behind the macOS removable-volume permission prompt; identical stuck calls are shared instead of piling up.
- Serve avoids synchronous repository I/O and reports stalled repository folders as unreachable while retaining cached task identities.
- Service snapshots, event replay and task resolution stay responsive when repository volumes stall; repo existence and canonical paths refresh asynchronously.
- Desktop windows silently sign in again after expired sessions and service restarts, with bounded retries and shell recovery pages. Browser error pages use themed pacer cards and sign-in guidance.
- macOS builds and staged updates use the optional stable `dev.pacer.cli` signing identity so removable-volume consent survives updates; doctor detects pending or denied access and ad hoc signatures.

### Changed

- Local builds produce a Rust front door `dist/pacer` next to the bun-compiled `dist/pacer-core`.
- App links now point directly to Overview, Review, Sessions and Settings. Retired UI routes fall back to Overview; old screens and route redirects have been removed.

### Added

- Parallel tasks controls for each executor and this machine, with shared-capacity and queue wait explanations in the app.
- Overview and Review support accepting all tasks with passing checks, repository filtering, and multi-select accept/reject with task-list confirmation and per-task results. Verdicts do not merge branches.

- Executor questions raise blocked Needs you items with Answer and Stop actions; `pacer answer`, `task.answer` and MCP `task_answer` retry on the same executor with cumulative question/answer brief context (protocol 2.7.0).
- Protocol 2.6.0: client registry with a notifier lease, one delivery per notification with a built-in system-notification fallback, notify events, `task.retry_all`, console and TUI commands as v2 operations, status line running and needs-you counts.

- Protocol 2.5.0 completes executor and host controls: configured slot limits, a wait queue, delegation pause/resume and mode holds.
- Shared jobs and readiness checks, enabled executor settings, account sign-in attention and job entity events.
- Host capacity and pause controls, repo/account setup, cleanup previews and a 300-second probe that raises attention after two failures.

- Snapshot gains repo identity, capacity rows, planner meter, counts and today; new entity events (protocol 2.1.0).
- Service-owned Needs you queue with actions, dismiss and snooze, attention counts and activity history; app and Orca attention models consume the service queue (protocol 2.2.0).
- Full task detail with routing explanation, usage cost, acceptance timing, diffstat, per-file diffs, retry options and timeline; accept, reject, send-back and retry-elsewhere verdicts.
- Idempotent delegation with request ids, base refs and source labels; repository operations, task list filters and goal-based routing previews.
- Task revisions and optional `expect_rev` checks on task mutations return the current task on conflicts.
- Bearer-authenticated `POST /v2/session/exchange` creates an app cookie session without a sign-in URL.

### Removed

- Old app route redirects. Retired and unknown hashes now fall back to Overview (`#/`); incomplete setup redirects to Settings.

- Protocol 3.0 snapshot fields `v`, `budget`, `alerts`, `console`, `consoles`, `serviceInstalled`. Read `planner`/`accounts`/`executors`, `attention` and `setup` instead.
- Protocol 3.0 `budget` and `alert` events. Subscribe to `planner`, `account`, `executor`, `attention` and `notify` instead.
- Bearer-only `/link` and legacy `/events` routes (404). Use `/v3/snapshot` and `/v3/events`; `/state` and `/console/open|forget` were already removed in 2.6.
- Orca storage bridge writes, channel sends and plugin HTTP/channel/bridge transports. The plugin uses the v2 API over HTTP or a `pacer api --stdio` child; run `pacer update` and restart the plugin if it cannot connect.
- `pacer console`, automatic console opening/restarting, `CMD_NAMES` and shell command line encoding/decoding. Use `pacer dashboard`, `pacer open` or API operations; old `agent-done` and `worktree-created` commands are no longer accepted.

### Changed

- Protocol 3.0 is served at `/v3/*`; `/v2/*` restores 2.8.0 shapes through an adapter for one more pacer minor release. Stdio clients select `{ protocol: 3 }` in `hello` (default remains 2 during overlap); v3 hello advertises `previous: "2.8.0"`.
- In v3, `task.review.accepted` is removed; send required `verdict`. `task.diff.diff` is removed; read `patch`. `task.list` no longer returns a bare array; read `{ tasks, next }` and paginate. `notifications.set`, `pacer status --json` and planner hook output are unchanged.
- Durable outbox events are named `OutboxEvent` and omit `v`; pre-upgrade v3 event cursors receive `reset` and must fetch a fresh snapshot.
- The owner waived the v1 retirement release gate on 2026-10-18. The next minor release removes the v2 adapter, routes, reference document and `hello.previous`.

### Fixed

- `pacer serve` answers right after a restart. Clients replaying events from cursor 0 made the service read every task file once per outbox event, blocking all requests for over a minute on a large home; task events are now enriched in one batch. While the first status is still being computed, snapshots answer within a second with `service.starting: true` instead of waiting.

## [0.2.3] - 2026-10-16

### Fixed

- The Orca panel stays current even when Orca does not start the plugin worker.

## [0.2.2] - 2026-10-16

### Fixed

- The Orca plugin's worker never started, so the panel kept showing the page the old plugin last wrote. Orca starts a plugin worker only for a command or a declared event; the plugin declares `agent.status.changed` and `worktree.created` again so Orca starts it soon after opening.

## [0.2.1] - 2026-10-16

### Changed

- `pacer open` opens the app in an Orca browser tab when Orca is running; `--browser` uses the default browser.

### Fixed

- `pacer serve` refreshes an installed managed Orca plugin after any binary update and reports how to reload it. Plugin installation instructions now list capabilities from the bundled manifest.

## [0.2.0] - 2026-10-16

### Added

- Managed OpenCode endpoint accounts: connection setup, key stores, model discovery, generated config, automatic runners, test-gated Ready state, and edit/test/adopt operations through the CLI and v2 API.
- App API operations for configuration, notifications, accounts, runners, routing, agent connections, setup, service status, plugin installation, strategies, hosts, versions and updates, with `config` events for client refreshes.
- The daemon-served pacer app, with setup, live budgets and tasks, delegation and review, executor and account management, strategies, hosts and settings. Open it with `pacer open`; `--print` prints a one-time sign-in link and `--logout` clears browser sessions. See the [app guide](docs/app.md).
- Browser access through one-time codes and cookie sessions, with loopback Host checks, Origin and client-header checks, security headers and no CORS.

- Remote runners over SSH: `hosts:` in the strategy, runner ids `<agent>[#account]@<host>`, `pacer host list|check|setup|clean`, results returned as a git bundle on `pacer/<task-id>` after an identity and ancestry pre-flight, Codex usage probed over SSH.
- Client protocol v2: `pacer serve` `/v2/*` (hello, snapshot, events with resume, ops, task log), `pacer api --stdio` JSON-RPC, and `docs/protocol.md`.
- `pacer limits check [--json]` shows each account's usage source, capture time, age, freshness and guidance.
- `pacer retry <task-id> [--executor <id>] [--json]` re-delegates a task's stored brief, refusing an already queued or running retry.
- `pacer clean [--dry-run] [--force] [--json]` removes settled, reviewed, dismissed or resolved tasks' pacer-owned worktrees and run directories; dirty worktrees require `--force`, and branches stay.

### Changed

- The Orca plugin reads pacer through the v2 API: `pacer serve` when running, otherwise a `pacer api --stdio` child. The storage bridge and `orca plugin send` channel transports are deprecated and will be removed in the next minor release.
- The Orca plugin shows information only: a read-only status page, no buttons, no consoles started by the plugin; `pacer: Open` points to `pacer dashboard`. `pacer console` is deprecated.
- `pacer dashboard` reads and acts through the v2 API (`pacer serve` when running, in-process otherwise); task actions, executor block/unblock and strategy switching are API operations.
- Stale usage no longer decides routing verdicts: accounts with only stale readings show their last numbers marked stale with verdict `UNKNOWN`.
- Orca's `account list` is never read for usage. Orca-linked Claude and Codex accounts read their own data (Claude status-line caches or reactive limits, Codex session logs in the account folder); Cursor, Antigravity and endpoint accounts no longer try Orca first. Explicit `usage_source: orca` remains accepted but is ignored with a status warning.
- `pacer report-limit <runner>` exhausts the runner's whole account, including every runner sharing it.
- `pacer dismiss` reports unknown ids and exits 2 while still dismissing known ids.
- `execution.backend: auto` uses pacer's own supervisor through the direct backend; Orca is opt-in with `execution.backend: orca`.
- Direct execution honors new placement with a pacer-owned worktree; task reports begin `ran in new worktree <path> (<why>)`.
- Executor timeouts send TERM to the process group, then KILL after a five-second grace period, instead of killing immediately.
- Idle tasks stop after `execution.idle_fail_min` minutes without output or file changes (default 30).

### Fixed

- `pacer account add` for endpoints no longer reports success without a working connection.

## [0.1.24] - 2026-10-14

- Add dashboard Settings on `,` with the shared validated CLI writers, prompt-line account and runner setup, confirmed removals, executor ordering, and terminal handoff that returns after login. Align panel removal reasons below their row titles and keep boundary-arrow reasons in tooltips.

- Add live panel Settings with planner, accounts, runners, executor controls, pacing, strategies, updates and plugin preferences; retain values without a console, confirm removals on a second click, and refresh changed settings without flashing unchanged panels. Show selected choices as segmented controls, explain unavailable actions and pacing policies, and hide the fill threshold in spread mode.
- Reject malformed account names and runner ids before console removal commands reach shared writers.

- Add validated console settings commands for planner and pacing changes, account and runner removal, and fixed terminal actions in the focused worktree.
- Collect account and runner add arguments in the terminal while keeping the shared CLI write path.

## [0.1.23] - 2026-10-14

- Always use direct execution for non-default account folders, even with Orca/auto selected, to avoid interactive workspace-trust hangs; record the reason in attempt logs and preserve default-account backend behavior.

- Detect Claude subscription limits and resolve agent-specific patterns for named runners; honor reported reset times and zones before quota-window/cooldown fallbacks and exhaust the shared account.
- Default new Claude/Codex account homes to `~/.claude-<name>` / `~/.codex-<name>`; show compact folders separately from account sources while retaining full paths in JSON.
- Infer runners added without settings from routing references and preserve flow-list padding when editing strategy lists.

- Show runner ids with their agents, accounts and shared usage in status, route, dashboard and live panel rows, grouping runners by account while preserving legacy strategy rendering; label and align account and runner list columns without changing JSON output.

- Add account and runner list/add/remove commands, private account homes with interactive agent login, sanitized Orca links, endpoint budgets and validated removal safeguards; add config get/set with effective-value provenance, planner integration movement and undo commands.

- Install planner integrations into the selected Claude/Codex account folder, record account-scoped uninstall paths and command environments, and resolve hook budgets from the running session with a warning for unknown folders; init offers agent then account selection.

- Launch Claude and Codex runners on their selected account homes in direct execution, and exclude usage-only Orca accounts whose folders are missing.

- Read usage per account from native Codex sessions, separate Claude status-line caches and Orca active/inactive rate limits; filter Orca account emails, retain native/reactive fallbacks and validate derived Orca account folders.

- Add accounts and runners to the strategy model, with validated agent/account pairings and a compatibility loader for existing provider strategies.
- Add account spread/fill settings and a validated fill threshold (default 90%).
- Add validated, atomic strategy edits that preserve comments and untouched layout, and migrate provider strategies during init, update or `pacer config migrate` with a recovery backup and restore command.
- Pace and route runners against shared account budgets, with account headroom spread and fill preferences restricted to matching agent/account-kind groups (excluding endpoints), migration-equivalent ordering and planner reserve applied to the planner account; add account summaries and runner account fields to status and route JSON.
- Identify runners as `agent#account@host`, resolve default accounts and legacy provider aliases, and infer runners from planner and routing references; reserve remote host ids with a clear validation error.
- Keep default models on accounts with optional runner overrides; migrate routing and pacing to canonical runner ids and omit redundant runner declarations while preserving comments and recovery backups.
- Keep the default OpenCode planner from adding a phantom endpoint budget account.

## [0.1.22] - 2026-10-14

- Make `pacer init` the complete, consent-based setup flow with planner selection, agent connections and live panel guidance; `setup` is an alias.
- Open setup or dashboard in the focused Orca worktree once per launch, and retire marketplace automation when the live panel connects.
- Add a live heartbeat and a real-Orca bootstrap release harness.
- Show real setup checks in the live panel and dashboard, with manual re-checks and automatic operations view once required checks pass; agent connections remain optional.
- Make the marketplace panel static setup guidance with manual install commands and live-panel instructions.

## [0.1.21] - 2026-10-14

### Added

- Cached, opt-out update checks for the CLI and Orca plugin, with version-aware notices and plugin update instructions.
- Live panel update controls and dashboard keys `c` (check) and `u` (update with confirmation).

### Changed

- `pacer update --check --json` reports current/latest versions and installed plugin status without installing anything.

## [0.1.20] - 2026-10-14

### Fixed

- Marketplace installs open the pacer terminal again. 0.1.19 looked for an Orca session id that the plugin worker never has, so the dashboard never opened; it now keys on the Orca app process.

### Changed

- The marketplace setup panel always lists the manual setup commands (install script, `pacer setup`, `pacer dashboard`) under "Setup not finishing?", and opens them after two minutes. Failure notifications point there.
- If Orca can't open the pacer terminal, the plugin now says pacer is running and how to open the dashboard, instead of reporting that pacer couldn't start.

## [0.1.19] - 2026-10-13

### Added

- `pacer dashboard`: live terminal budgets, ranked executors, attention groups and tasks, with keyboard delegation, retry, stop, focus, dismiss, blocking and strategy switching.

### Changed

- Marketplace installs open the dashboard in a **pacer** terminal once per Orca session instead of requiring a manual development-folder handoff. The sidebar folder is still prepared as an optional alternative.
- The static bootstrap panel shows installation progress and elapsed time, dashboard reopening instructions and collapsed sidebar setup steps.

## [0.1.18] - 2026-10-13

### Changed

- `pacer update` refreshes the managed Orca plugin folder.
- The marketplace setup panel shows an activity indicator with elapsed time, and a hint to check the install after two minutes.

### Docs

- Explain how to get marketplace and development-folder plugin updates.

## [0.1.17] - 2026-10-13

### Fixed

- Marketplace installs no longer modify Orca's integrity-checked plugin folder.

### Changed

- A static bootstrap panel and persisted progress notifications install and start pacer, prepare the managed development folder automatically, then show the one-time Orca settings steps for the live budget panel.
- `pacer plugin install` writes a versioned marker and prints the one-time Orca steps; `pacer plugin status` reports marketplace and development copies.

## [0.1.16] - 2026-10-13

### Added

- The Orca plugin installs pacer itself: it downloads the checksum-verified binary for its own version, creates a starter strategy and installs the login service, then keeps the service running and the binary in step with the plugin.
- A live setup checklist in the plugin (install, start, connect) and a one-click **Connect my agents** button, backed by the new `pacer setup` command. Agent configuration is only changed after that click.

### Fixed

- Orca workers stuck on a provider's "model at capacity" message are resent the task with backoff and then handed to the next executor; workers idle without progress are nudged, then failed.

## [0.1.15] - 2026-10-13

### Added

- First public release: Apache-2.0 license, community policies, contribution guidance, GitHub templates, user documentation, design system and roadmap.
- Release pipeline: binaries for macOS and Linux on GitHub Releases with checksums and build provenance, `install.sh`, npm (`@lamtuanvu/pacer`) and Homebrew (`lamtuanvu/tap/pacer`).
- Orca plugin published as `lamtuanvu.pacer`, installable from the pacer repository as a marketplace source.

### Changed

- `pacer update` refreshes agent integrations, and points npm and Homebrew installs to their package manager.
- Install summaries report Claude MCP changes.

## [0.1.14] - 2026-10-13

- Made the CLI and installed skill the primary agent interface, with optional MCP.
- Cleared resolved Needs attention cards and added task-session focus actions.

## [0.1.13] - 2026-10-13

- Added per-task current/new/auto worktree placement with safety vetoes.

## [0.1.12] - 2026-10-13

- Fixed acceptance pipeline failure handling, needs-review outcomes, duplicate retries and requested-executor fallback.

## [0.1.11] - 2026-10-13

- Fixed notification level control without unsupported panel settings calls.

## [0.1.10] - 2026-10-12

- Fixed agy launch arguments, broken-executor fallback, attention lifecycle and Orca coordinator recovery.

## [0.1.10-hotfix.1] - 2026-10-12

- Published each task alert once to prevent notification storms.

## [0.1.9] - 2026-10-12

- Showed unchanged panel snapshots as updated rather than stale.

## [0.1.8] - 2026-10-12

- Added launchd/systemd service management and restart on update.

## [0.1.7] - 2026-10-12

- Opened a pacer console automatically in the focused Orca worktree.

## [0.1.6] - 2026-10-12

- Added agent-built strategies through MCP tools, CLI commands and the panel builder.

## [0.1.5] - 2026-10-12

- Made panel action buttons equal in height.

## [0.1.4] - 2026-10-12

- Redesigned the Orca budget panel.

## [0.1.3] - 2026-10-12

- Refused release builds with stale generated plugin assets.

## [0.1.2] - 2026-10-12

- Added the Orca plugin, console and brain link.

## [0.1.1] - 2026-10-12

- Added guard event IDs for decision feedback.

## [0.1.0] - 2026-10-12

- Established budget readers, active-hour pacing, routing, task delegation and planner integrations.
- Added the CLI/MCP interfaces, classifiers, benchmarks and checksum-based release build/update tooling.
