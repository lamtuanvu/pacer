# Changelog

Notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Releases from 0.1.15 on are published on GitHub Releases, npm and Homebrew.

## [Unreleased]

### Added

- Add the Plugins settings page, host-drawn plugin settings pages, the Extend settings navigation group and the activity-bar Plugins section.

- Restyle the app frame chrome to the design canvas: a 44px title bar with the pacer mark, planner chip and panel-toggle buttons, a 52px activity bar with an active indicator and count badges, and a 28px status bar with per-vendor budget meters, running and queued counts and the terminal shortcut. The Setup and Settings attention dots are now red.
- Let plugins contribute UI as host-rendered data (plugin protocol 1.2.0): `contributes.ui` declares activity items, panel tabs, a settings page and a status item; the host validates every view document and settings value, and grants cover surface kinds. Adds the `plugin.ui.*` and `plugin.settings.*` client ops (additive, v3), the `pacer plugin settings` and `pacer plugin ui list` commands, and a strategy-independent plugin settings store. See [Plugin UI contributions](docs/specs/2026-10-28-plugin-ui-contributions-design.md).
- Add the read-only `files.search` operation (protocol 3) for the app's command menu Files scope: it searches tracked file paths in registered repositories with `git ls-files` and returns the repository, repo-relative path, size, matched ranges and the running tasks that changed each file. Results, query length and per-repository listing time and size are capped, executors are refused, and nothing is written; the change is additive. See the [design](docs/specs/2026-10-28-files-search-design.md).
- Add the read-only `issue.import` and `issue.search` operations for starting a task from a GitHub issue. They read a registered repository's issue through the user's `gh` login, take the GitHub repository from the checkout's `origin` remote, return the title, body, labels, URL and state as capped plain text, and are refused for executor sessions. Two error codes are added, `unavailable` (503) and `rate_limited` (429); the change is additive. See [Import a GitHub issue](docs/dispatch.md#import-a-github-issue).
- Add the read-only `dispatch.explain` operation and `pacer route --explain`: which executor a request would go to, the ladder step, coded reasons, fallbacks with exclusion reasons, and the planner's cost (`unknown` until a planner adapter reports tokens). It reuses the dispatcher's decision code, starts, reserves and writes nothing, and the change is additive. See [Explain a route](docs/dispatch.md#explain-a-route).
- Record token usage for each attempt with a `measured`, `partial` or `unknown` coverage label. Codex gets its final `tokens used` total as a partial, self-reported figure and Claude Code gets measured usage from its `stream-json` result. The service indexes existing history in the new `attempt_usage` table without touching task files. See [Token accounting](docs/dispatch.md#token-accounting).
- Roll token usage up through work trees (`totals.tokens`, with coverage counts, a lower-bound flag and a split per agent) and show it in task detail. Add per-field `reported` and `complete` flags to totals and executor splits so unreported counts are distinguishable from measured zeros and sums from mixed reporting are shown as lower bounds with a missing-field note; Session Details omits unreported fields and shows only the total and partial note for lower bounds. `Attempt.tokens` is added to task and work-tree results; the change is additive.
- Rebuild a task's screen as a session screen inside the frame: the built-in terminal fills the centre, the Tasks list sits in the left panel, and Changes, Details (and Work for dispatched work) share the right panel with a title-bar toggle (Ctrl-Shift-B). End session moves to the title bar as an icon button that still asks to confirm, an ended session offers no actions that cannot work, and the task's next step stays reachable as a title-bar button while the panel is closed. A watching terminal now passes Ctrl combinations (such as Ctrl-b) on to the app.
- Add a Files scope to the ⌘K command menu. It searches tracked file paths through the read-only `files.search` operation (debounced), shows the match highlighted with its repository and "changed by …" when a running task changed the file, and explains in plain words which repositories could not be searched. Enter opens the task that changed a file, or copies the path of any other file (a repository file viewer comes later). The left-panel shortcut label, the key registry's macOS detection and the title-bar trigger's focus ring are tidied alongside. Also repairs a stray merge marker that disabled the task tree list styles.
- Add the ⌘K / Ctrl-K command menu, also opened from the title-bar search. It searches tasks, agents and machines from the data the app already holds, runs commands with `>`, shows recent items on open and offers New task when nothing matches. Commands, menus and keyboard shortcuts now share one command registry, and a `CommandMenu` design-system component backs it. The menu also runs Dispatcher commands (pause or resume dispatch, switch saved setup, Budget & pacing) and suggests the oldest item waiting on you; ⌘↵ runs a command and keeps the menu open. Keyboard changes: the left panel toggle is now ⌘B on macOS (Ctrl-b elsewhere), so Ctrl-b stays free for a shell or terminal multiplexer; Go to Tasks is now `g t` (was `g s`) and Go to Terminal is `g e` (was `g t`), so Tasks matches the redesign board.
- Add collapsible side panels (the Settings navigation collapses with its panel button or ⌘B on macOS, Ctrl-b elsewhere), a terminal dock below the work area (Ctrl-` or the status-bar Terminal button), and a `PanelTabs` design-system tablist with a "+N" overflow menu.
- Add redesign foundations to the design system: calm chart and aurora color tokens, new icons, `StatusDot`, `HostChip`, `MetaRow`, `AgentStack`, `Identicon`, and an `icon` prop for `IconButton`. The Settings rail icon is now a gear.
- Settings › Dispatcher is a guided setup: choose the scope (all repositories or one repository), order who may do the work per task kind beside the available executors, reorder the choice ladder, and try a task: it explains with `dispatch.explain` where the task would go, why, who else was considered and what could change it, and can include the unsaved choice ladder. Saved setups show an identicon. Lists reorder by drag or with Move up, Move down and Remove buttons, and every change goes through one save bar with a change count and Discard. Adds the `SortableList` and `SaveBar` design-system components.
- Show tasks as task tree cards and rebuild Tasks to match the design board: a page title and summary, search, a repository picker and New task, filters for All, Needs you, Running, Accepted and Stopped with counts, nested subtasks under each task, "Show more" paging, and a Selected task panel with its linked work, notes and latest activity. Cards show status, what needs you, host, branch, agents, tokens and quick links to notes, terminal and changes. Problems and decisions sort first, then running work, then recent work. The Session panel uses the same cards. Dispatched work is now part of Tasks. Task list rows from `dispatch.list` also carry the branch and a token roll-up. Facts pacer has not measured, such as tokens or a PR, are left out rather than shown as zero.
- Add a persistent built-in terminal with workspace shells, tabs, splits, search and integrated app action sessions.
- Strict native subagent control for new managed work: Pacer excludes uncertified executors before dispatch, checks again before launch, and exposes certification status and a quota-using canary in Dispatcher and the CLI. Existing managed tasks retain cooperative behavior.
- Scheduled native control certification. Certificates expire within 24 hours, so the service can now renew them on a timer instead of waiting for a manual canary. **A probe spends the quota of the account it certifies**, so it runs only after you consent: `pacing.planner_probe` defaults to `ask` and nothing is probed until you answer, `auto` allows renewals without asking and `off` disables scheduling entirely. `pacing.planner_reserve_headroom` (default 25 percentage points) is a floor that keeps Pacer from spending the headroom it is protecting; it is separate from `pacing.planner_reserve`, which remains a pace multiplier. Probing also backs off on repeated failures and pauses after a daily ceiling, when the last probe cost too much, and when measured headroom is unknown. Dispatcher and `pacer doctor` show the consent state, the next eligible probe and the last measured cost.
- Delegated tasks now start interactively by default: they open in the agent's terminal UI and finish when the agent runs `pacer report`. To switch back to headless runs, set `execution.launch_mode: headless` with `pacer config set` or in **Settings → This machine**. A runner's `session:` setting still takes precedence. Remote runners, Codex older than 0.162.1 (or of unconfirmed version), agents with no interactive launcher and endpoint test tasks run headless and record why. Managed work under strict native control stays headless; only a runner with an explicit `session: interactive` is refused for it, at once and with the setting to change. Interactive Claude Code launches in a pacer-created task worktree mark that worktree as trusted in the account's Claude state, and unattended task launches approve project MCP servers for that launch, so the folder-trust, external-import, bypass-permissions and MCP prompts no longer block them. Servers you rejected in the source checkout stay off; takeovers and conversations keep Claude's MCP prompt. See [Launch mode](docs/executors.md#launch-mode).
- Executor sessions now start from your login shell's environment instead of the service's, so PATH, locale, proxies and other profile exports match a normal terminal. Pacer adds only its own variables and launch options, listed in [Session environment](docs/executors.md#session-environment). Set `PACER_LOGIN_ENV=off` to use the service environment.
- Open HTTP(S), local file and source-location links from the built-in session terminal. A read-only viewer shows code, Markdown and an isolated static HTML preview without disconnecting the session.
- Add the Dispatch home, which replaces Start work and Overview, laid out as the approved board: the Dispatch title with a live line, a Today / 7 days / 30 days period switch, an "All repos" menu and a New task button (opens Delegate for now); the planner budget and the next task in one split section, with the planner's pace, the chain of next agents ending in the queue, and the active strategy; the period at a glance from task insights (root tasks handled, tokens spent, ran outside the planner, accepted first try); where the tokens went beside Needs you as compact cards; Live dispatch; and the interactive session composer. Figures pacer has not measured are left out, and without task insights the strip says so.

### Changed

- Run local tasks without a fixed cap by default. `execution.local_max_tasks` is now optional (`unlimited` by default; a whole number of at least 1 still sets a hard cap, with no upper ceiling), and new local tasks wait only while macOS memory pressure reaches `execution.local_memory_pressure_limit` (`critical` by default, or `warning`/`off`) or the load per CPU core exceeds the optional `execution.local_load_limit`. Running tasks are never stopped. Waits report `machine_memory_pressure` or `machine_load` with the observed value, the snapshot `machine` row adds the guard state and allows `max: null`, and Settings › This machine and the TUI edit and show it. Existing numeric caps keep working. Client compatibility: protocol 3 clients must accept `machine.max: null`, the string `"unlimited"` from `config.get` for `execution.local_max_tasks`, and the new queue reasons; the 2.x compatibility snapshot keeps `machine.max` numeric (the sum of the local executors' own limits when there is no fixed cap).
- The Needs you page shows task items as task cards, most urgent first. Agent capacity and recent activity left the home; capacity lives in Settings › Executors. The quick delegate form is replaced by the top bar's Delegate. While Dispatch is open, the status bar shows the planner's mark without its figure, because the Planner budget states it.
- Keep App plugin switches focused during changes and reloads, label the plugin list, describe refused plugins, and preserve loaded rows and inline errors when a reload fails.

- Add the service-backed App Plugins list with explicit capability grants, content-sized Terminal selection, and semantic Budget row headings through additive design-system options.

- Refine the terminal file viewer: it opens beside the terminal when there is room (a full sheet on narrow screens), starts on Source, adds whole-file search with match stepping (⌘F/Ctrl+F), lists what the isolated HTML preview blocked, explains missing, outside, too-large, binary and changed-session files, and closes with Esc or Back to terminal.

- Rebuild Budget & pacing around planner pace, mode holds and reported budget windows. Preserve planner integration consent, pacing policy and account controls using shared board rows.

- Rebuild Settings Overview with real readiness and setup facts, and App preferences with board-aligned theme, notification, terminal and update controls. Keep existing operations, legacy section links and desktop OTA controls; add opt-in board rows, segmented controls and a compact Switch.

- Rebuild Settings Diagnostics with report totals, grouped check disclosures, report copying and the existing previewed repair flow.

- Match the Settings navigation board with a 240px panel, Back to Dispatch and save guidance. Agents and Machines replace the executor and machine menu labels; Accounts, Add executor and Remote hosts stay reachable from their parent pages.

- Group the Settings menu into Dispatch and App. Overview summarises readiness and the current setup, Budget & pacing replaces Planner & pacing, and App preferences holds Updates, Notifications and Appearance on one page; their old links still open the right section. Settings rows share one layout with the new `SettingRow` and `SettingsNav` design system components.

### Fixed

- Scheduled certification follows the repository where managed work runs rather than the one most recently viewed, and the Dispatcher row names it by its repository picker label.
- Scheduled certification retries after a pause of at least 24 hours when a probe exceeds the cost ceiling or repeated repository switching invalidates certificates, instead of stopping permanently. The daily probe ceiling still applies; Dispatcher consent and documentation now describe the pause and retry.
- Executor sessions now match a terminal more closely: the login shell's `umask` applies to the agent, direnv and mise apply for the task folder as their own trust allows (pacer never allows or trusts a folder), interactive sessions keep `NO_COLOR`/`FORCE_COLOR` from your profile, and the default account honours `CLAUDE_CONFIG_DIR`/`CODEX_HOME` from your profile (not from direnv or mise) for the run, its folder trust and usage readers. Managed work under strict native control runs with the service environment it was certified with. Backend selection now uses the same launch mode as the attempt under strict enforcement. See [Session environment](docs/executors.md#session-environment).
- The session file viewer opens files in sessions that run in a Pacer task worktree instead of refusing them as private state.

## [0.11.0] - 2026-10-26

### Added

- macOS desktop releases include a `.dmg` for first installs: open it and drag pacer into Applications. It holds the same signed app as the `.app.tar.gz` update package; release validation checks that the two match.

### Changed

- Let a conversation's session UI fill the task workspace between a slim action row and a pinned control footer, and stop calling it a terminal. The footer shows who is driving, Take/Release control, size and the screen reader toggle; files stay with the session. A hidden or collapsed pane no longer resizes the agent's terminal, and Tab no longer traps focus in a watched terminal.

### Fixed

- Show Ark CLI authentication failures as unknown subscription status instead of no active subscription, with sign-in and refresh guidance in Settings › Accounts.
- The desktop shows the live service version before loading older service screens and no longer restarts a mismatched service automatically.

## [0.10.0] - 2026-10-26

### Added

- A dedicated Settings → Dispatcher page shows the default planner, active decision ladder, model choices, and a read-only task preview. Its editor validates and activates a new named strategy. Routing and project strategy precedence are explained in the UI.

- Managed work dispatch through CLI, API and MCP: any supported executor can request a child task, and Pacer selects an eligible executor, account and model using configurable strategy steps, capability tiers, live capacity and usage evidence. Decisions, reservations, lineage, dependencies, scoped grants and independent reviews are recorded for inspection.
- Replaceable decision engines and observation adapters, with bounded provider refresh and reviewed-outcome learning. The Tasks UI and TUI show dispatched work, its tree, timeline, model evidence and review actions. Ordinary interactive sessions and legacy delegation retain their existing routes.
- Managed work can retry or answer in the same task and worktree with revision checks, stable request IDs, cumulative attempt limits and prior review evidence. Work views distinguish execution, dependency, capacity and child waiting, and group shared account usage without counting overlapping parent and child readings twice.
- Refresh usage for idle accounts every 15 minutes while the service runs, or on demand with `pacer limits refresh [account]`, the v3 API, and the app Usage popover. Codex queries its read-only app-server rate limits; provider adapters retain historical readings when refresh fails.
- Discoverable v3 CLI operations through `pacer api list`, `describe` and `call`, with filtered metadata, JSON schemas and bounded JSON file/stdin input. The Pacer skill teaches on-demand discovery for product controls.
- Scriptable authenticated session I/O, attachment upload/list/download/removal, and targeted acknowledged page/native controls for appearance, navigation, windows and tray actions.

### Fixed

- Release a finished conversation's runner ownership so a failed session can resume once its terminal has stopped. Explain disk-full failures and provide an attach command when a terminal viewer cannot open.
- Use the preferred terminal selected in This machine for session viewers and other local terminal actions, while preserving existing terminal.app preferences.
- Round the tray panel corners and overlay its More menu without growing the panel.
- Reopening a running Pacer task from the Tasks list now takes control of an unheld live terminal, including interactive conversations, while preserving explicit takeover when another viewer holds it.
- Keep legacy connected Claude settings usable after unrelated settings edits when pacer's hooks are intact; show the recorded failure reason on a failed interactive session.
- Honor protocol v3 for in-process clients and retain executor role restrictions when generic CLI calls use a planner-owned service. Explicit service selection never retries refused calls locally.
- Complete native interactive adapters for Claude Code, Codex and OpenCode: detect CLI capabilities instead of pinning an exact version, retain native conversation identity for resume, honor named accounts and OpenCode models, and report native session activity. Explicit conversations can select the planner account while retaining execution guardrails.
- Align Tasks and Start work with Overview's full-width page gutters and bordered sections. Keep task metadata and actions in stable desktop columns, show complete titles when space permits, and retain full-title tooltips when long titles clip.

- Remove compounded spacing in app sections, cards, settings and embedded page headers; keep task disclosures evenly spaced and compact while preserving touch targets. Add shared spacing ownership checks and browser geometry regressions.

### Changed

- Settings → Dispatcher now contains saved global profiles and executor eligibility, including repository overrides. Former Routing and Strategies links redirect there.

- Open tasks in a split workspace with a task navigator and a larger session pane. Keep task details compact, make each list row one navigation target, and use the main Tasks route for returning to the list.
- Add a read-only `ui:ready` preflight for PR evidence and make skipped local evidence checks explicit; centralize the agent readiness procedure in the UI rules.

## [0.9.0] - 2026-10-23

### Fixed

- Retry desktop update coordination and status delivery after transient failures, restore controls only after fresh native verification, and keep verified completed or restored updates terminal when cleanup needs another attempt.
- Automatically refresh previously connected agent hooks, policies and skills at service startup and before new local agent launches, including named accounts. Preserve customizations with actionable conflicts, and report freshness separately in doctor.

- Select the ArkCLI quota reader for OpenCode’s `coding-plan` provider during setup and recover existing Ark Coding Plan quota accounts that have no usage source configured.

- Use one keyboard-accessible, searchable dropdown style across Start work, delegation, Settings and retry/review, with aligned Start work fields and a styled native attachment trigger. Missing repository/workspace choices now block starting a session.

### Changed

- Use macOS native title-bar controls and rounded window corners; keep the compact header fixed while content scrolls.
- Show usage and screen shortcuts in a persistent desktop status bar, and keep Overview cards sized to their own content.
- Open account-level quota windows, reset times, and reading freshness from the desktop status bar.

## [0.8.1] - 2026-10-22

### Fixed

- Refresh each executed account's available usage source after a task completes, so Codex session logs and supported provider commands can update the recorded ending usage without waiting for their normal cache interval.

## [0.8.0] - 2026-10-22

### Fixed

- Keep Pacer-managed Claude quota readings current after ordinary headless and interactive turns. Managed accounts gain passive status-line capture, headless runs record Claude's structured quota events, and idle accounts do not consume usage for refresh probes.
- Preserve embedded agent TUI fonts, cell layout and ANSI colors under the app's strict security policy; prevent automation color suppression from flattening native interactive sessions. Session end/resume reads the current revision rather than retaining stale progress state, and resume does not replay the initial prompt or attachments.
- Restore a compact left navigation rail and unify the desktop page header with custom window controls, removing duplicate titlebar rows while preserving touch navigation.
- Finish executor setup with **OK** to clear the wizard and return to Executors, or **Add another executor** to start fresh at agent selection.
- Task details use the short name and persistent Summary/Session tabs, with quiet back navigation and remembered task-list scroll position.
- Align desktop buttons, dropdowns and inputs with the compact Delegate control, tighten task-page spacing, and preserve touch targets, multiline fields and compact tray controls.
- Show native desktop update connection failures in Settings instead of silently presenting manual installation as the normal update path.
- Start work agents with unattended permission settings across headless, interactive, resumed and strategy-planning sessions. Codex worktrees and reporting hooks no longer stop at trust prompts; Antigravity and OpenCode interactive launches use their supported prompt and configuration interfaces. Orca-selected work falls back to direct execution because its worker API cannot enforce permission bypass.
- Refuse automatic release tags after a missing or failed dry run, or when the merge differs from the tested PR head. Prebuild Rust test fixtures during release verification and update the desktop navigation assertion.

### Added

- Interactive start screen with agent/account selection, isolated worktrees, private file and screenshot uploads, and persistent native agent terminals. Conversations retain their selected executor, survive completed turns and window closure, and support explicit end/resume where the agent reports an identity.

- Diagnostics groups setup issues by integration and account, with reviewed repair actions, inline progress and errors, automatic rechecks, and collapsed passed checks and technical details. The live harness can validate the fixed Codex repair in its isolated UI fixture.

## [0.7.1] - 2026-10-22

### Fixed

- Allow cold Rust fixture compilation during release verification and check the current desktop titlebar in responsive shell tests. This unblocks publishing the companion-aware bridge updater.

## [0.7.0] - 2026-10-22

### Fixed

- Restore desktop capture-worker enrollment during client registration so native live diagnostics can capture owned windows.
- Offer “Add another account” after executor setup, resetting the completed setup and clearing the successful account form.
- Setup labels its footer version as the running service version, avoiding confusion with the independently versioned desktop app.
- Claude executor checks collect quota telemetry from Claude Code's structured test-task output for the selected account, then verify usage instead of silently skipping it when no status-line cache exists.

### Added

- Companion-aware bridge updater: validates and verifies `pacer-core` release assets, stages and smoke-tests both executables, installs the core first, and rolls it back if replacing `pacer` fails. Manifests without companions keep the existing single-binary behavior. The bridge remains a single Bun binary.
- `pacer watch <task-id> [--timeout <seconds>] [--json]` streams task output and state changes until settled, with newline-delimited JSON events and observation-only timeout/Ctrl-C. Planner guidance now uses watch instead of polling private logs. The additive `task.log.source` marker lets watchers reset offsets when executor rerouting changes logs.

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
