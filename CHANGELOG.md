# Changelog

Notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Releases from 0.1.15 on are published on GitHub Releases, npm and Homebrew.

## [Unreleased]

### Fixed

- Delegate defaults to the active repository filter or remembered repository, supports an optional task kind, previews routing and submits with Cmd+Enter (Ctrl+Enter on Linux).
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
