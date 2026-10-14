# pacer CLI and skill

`pacer install <planner>` installs the pacer skill and planner policy/hooks. Supported
planners are claude-code, codex, cursor and opencode. Skills live at
`~/.claude/skills/pacer/SKILL.md`, `${CODEX_HOME:-~/.codex}/skills/pacer/SKILL.md`,
`~/.cursor/skills/pacer/SKILL.md`, or `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/pacer/SKILL.md`.
Cursor and OpenCode also read `~/.claude/skills`; Cursor also reads `~/.codex/skills`.
Identical pacer skill copies may appear in their skill lists; update refresh keeps the installed copies identical.
The install manifest tracks files and backups; `pacer uninstall <planner>` reverses the install
while preserving later user edits. `pacer doctor` reports skill integrity.

MCP is optional: `pacer install <planner> --mcp` registers it. A default reinstall
leaves an existing pacer MCP entry unchanged; `--no-mcp` explicitly removes it.
`pacer update` replaces the binary and refreshes every installed planner’s skill, policy and hooks
with the new binary, preserving each planner’s MCP choice. It also refreshes the managed Orca
plugin folder when installed; turn pacer off and on in Orca Settings > Plugins to load it.
`--no-reinstall` skips both refreshes;
`--check` only checks, and `--to <version>` forces replacement and refresh even at the same version.
Refresh failures warn and do not stop other integrations or fail the update.

Restart a running MCP client after updating pacer. CLI commands always run the current binary.

`pacer api --stdio` runs client protocol v2 as newline-delimited JSON-RPC 2.0
on stdin/stdout, without a daemon. The `--stdio` flag is required; omitting it
prints usage and exits 2. `hello` returns the protocol and pacer versions,
operation names and event types; `snapshot` returns the current snapshot with
its sequence number. Every core operation is available by its registry name
(for example, `task.get` with `params: {"id":"<task-id>"}`).
Requests run concurrently and responses carry the request's `id`; notifications
without an `id` receive no response. `subscribe` accepts optional `since` (a
non-negative sequence number), replies with `{ "subscribed": true, "last": N }`,
and streams `event` notifications. A `reset` event means re-fetch the snapshot.
Closing stdin stops subscription polling and drains outstanding requests.

Read `pacer status --json`, choose an executor with `pacer route <kind> --json`, then
write a brief JSON file:

```json
{"goal":"Fix the flaky test","repo":"/absolute/repo","kind":"debug","scope":"test/","acceptance":"bun test","worktree":"current","worktree_reason":"Follow-up on uncommitted work"}
```

Run `pacer delegate --brief-file brief.json --json`, or pipe the JSON to
`pacer delegate --brief-file - --json`. Flags override file fields. The brief supports
`goal`, `repo` (defaults to cwd), `kind`, `scope`, `acceptance`, `constraints`, `context`,
`executor`, `timeout_min` (1–240), `worktree` (current/new/auto), and `worktree_reason`
(max 200 characters). Executors cannot delegate onward.

Choose current for uncommitted work, research/review, installed dependencies, or small
follow-ups. Choose new for parallel tasks, concurrent user edits, or risky experiments;
omit the choice for auto placement.

`pacer wait <id> --timeout 600 --json` blocks until a task leaves queued/running, or times out.
Timeout defaults to 600 seconds, maximum 3000; exit 0 means settled, exit 2 means timeout
(or invalid input). Review the diff and run acceptance before
`pacer review <id> --accept|--reject [--kind <kind>] --json`.
Use `pacer stop <id> --json` to cancel.
`pacer retry <task-id> [--executor <id>] [--json]`: Re-delegate a task's stored brief.
`--executor` picks the runner; otherwise routing chooses. Refused while the task
already has a queued or running retry.
Use `pacer report-limit <provider>` to record a quota limit, and
`pacer dismiss <id...>` to hide cards. Unknown ids are reported and the command
exits 2; known ids are still dismissed.

`pacer limits check [--json]` shows where each account's usage comes from,
when it was captured, its age and freshness, and its verdict and usage window.
Text output lists one line per account, with `no data` and `never` for missing
readings and a `stale` marker for old readings. An indented second line shows
an error or a hint when available. JSON returns an array with `account`, `kind`,
`source`, `capturedAt`, `ageS`, `stale`, `verdict`, `usedPct`, `window`, `resetsAt`,
`runners`, `error` and `hint`. A successful check exits 0.

`pacer clean [--dry-run] [--force] [--json]` removes pacer-owned worktrees of
terminal tasks that have been reviewed, dismissed or resolved. Only tasks run
in a new worktree under pacer's worktrees directory are eligible. Dirty worktrees
are kept with `uncommitted changes; use --force` unless `--force` is given.
`--dry-run` reports what would be removed without changing files. Cleanup deletes
the removed tasks' run directories and always keeps their branches. Text output
lists removed or kept task IDs and reasons, or `nothing to clean`; exit status is 0.

JSON contracts:

| Command | Top-level fields |
| --- | --- |
| status | generatedAt, strategy, planner, mode, disabled, calendarPace, providers, executors |
| route | kind, ranked, excluded |
| limits check | Array of per-account usage, source, capture time, freshness, runners, error and hint rows |
| delegate | id, createdAt, kind, requestedExecutor, timeoutS, brief, state, attempts, placement; optional runtime fields |
| tasks id, wait, stop, retry | task_id, state, kind, requested_executor, placement, attempts, result, review, resolved |
| tasks | Array of task summaries |
| review | recorded |
| clean | removed (task IDs), kept (objects with id and reason) |

The task summary matches MCP task_status; delegate keeps returning the full task record.
Needs attention clears for partial/failed tasks reviewed with either verdict, whose worker
worktree was removed, or whose tracked/untracked file contents already match the base branch
tip. The brain checks at most once per task per minute and exposes `resolved` with reason
`reviewed`, `worktree removed`, or `already on <branch>`. Running and attention cards with
live Orca terminals open their session on click or Enter/Space; unavailable sessions show a
short action error.

## Setup

`pacer init [--planner <id>] [--yes] [--agents a,b] [--no-dashboard] [--json]`
sets up planner selection, strategy, login service, agent integrations and the
Orca live panel in order. `pacer setup` is an alias. Planner choices are
claude-code, codex, cursor and opencode. With several detected planners, a TTY
shows a numbered choice defaulting to the current strategy's planner. Explicit
`--planner` skips the question. With no CLIs, init creates a valid starter using
claude-code and explains how to choose another later.

Existing strategies are preserved; changing planner updates only the planner
line. Completed steps print “✓ … (already done)”. Each unconnected detected agent
shows a file preview and undo command before its own y/N consent prompt. `--yes`
accepts all; `--agents` limits selection. No MCP servers are added. Undo an
integration with `pacer uninstall <agent>`.

Non-TTY runs set up strategy and service without prompts. Agents connect only
with `--yes` or `--agents`; `--json` returns the summary as data. Non-TTY runs
never wait or launch the dashboard. On a TTY, init prepares the managed Orca
folder when Orca is installed, prints its path and guides you to Settings >
Plugins > Development > Add folder. It waits up to five minutes for the live
heartbeat; Enter or Ctrl-C skips with `Finish later with: pacer init`. Setup then
prints a summary and opens the dashboard unless `--no-dashboard` is supplied.

## Terminal dashboard

`pacer dashboard` opens a full-screen live budget and task dashboard. Marketplace
Orca installs open it in the **pacer** terminal tab after setup. It uses the v2
API and connects to `pacer serve` when it runs; without it, the dashboard works
in-process. It refreshes on events and every two seconds, with status computation
in the background so network requests never block the display. An interactive
TTY is required.

- Arrows or j/k select a card; Enter retries on the suggested executor, stops a
  stalled task, or focuses a running task's Orca terminal.
- d prompts for a goal, repo (defaults to cwd), and optional kind.
- x dismisses an attention group or completed task; b blocks/unblocks an executor.
- s lists strategies to switch; r refreshes; ? toggles help; q quits.
- Escape cancels a prompt. Action results appear for five seconds.

The planner bar shows `#` for usage and `|` for pace. Small terminals use a
compact view with scrolling lists. `NO_COLOR` disables highlighting; the dashboard
uses no animated spinners, including when `PACER_NO_ANIM` is set. Exiting,
Ctrl-C, SIGTERM and errors restore the normal screen, cursor and input mode.

### Update checks

`pacer update --check [--json]` checks `latest.json` and reports the current CLI,
latest release, availability, and installed Orca plugin version and update instructions.
It exits successfully even when offline and never installs anything. Checks time out
after three seconds; failures are recorded in `~/.pacer/update-check.json`.
The shared check caches results for 24 hours; explicit checks force a refresh.
Text `pacer status` displays a cached update notice; `--line`, `--json`, and `--hook`
never check or display update notices.

Set `PACER_NO_UPDATE_CHECK=1` or add top-level `update_check: false` to the active
strategy YAML to disable checks (including explicit checks). No telemetry is sent:
the only release request is a GET of `latest.json`. `PACER_RELEASE_BASE`, including
`file://` bases, works as it does for `pacer update`.

The live panel's Updates card sends `check-updates` and `update` through the pacer
console. The console also accepts these commands directly. In the dashboard, `c`
checks immediately and `u` asks `Run pacer update? (y/n)` before updating; Escape or
`n` cancels. After an update, turn pacer off and on in Orca Settings > Plugins.
Marketplace plugins check on startup and every six hours, notifying once per new
version: use Orca Settings > Plugins > Refresh, then Update plugin. Live plugins
show the panel Update instruction. The worker also warns if the CLI is newer than
the running plugin. These checks never install a newer release automatically;
bootstrap installation still only installs/updates the CLI version shipped with
that plugin.

## Accounts, runners and configuration

See [Accounts and runners](accounts.md) for sign-in, endpoint budgets, Orca
links and account folder behavior.

```text
pacer account list [--json]
pacer account add <claude|codex> <name> [--home <dir>] [--no-login]
pacer account add <claude|codex> <name> --orca <id>
pacer account add endpoint <name> --usage <quota|metered|unmetered> [--quota-source arkcli] [--weekly-tokens <n>]
pacer account rm <name> [--delete-home]
pacer runner list [--json]
pacer runner add <agent#account> [--model <m>]
pacer runner rm <agent#account>
pacer config get [key] [--json]
pacer config set <key> <value>
pacer config migrate
```

Commands write the active strategy and validate the whole result. Refused edits
leave its bytes unchanged; successful edits preserve comments and untouched
layout. Legacy provider strategies load unchanged until migration; account and
runner edits ask you to run `pacer config migrate` first. Migration saves the
original as `<file>.pre-accounts.bak` and prints how to restore it.

`config get` returns each effective value and its source: the strategy filename
or `default`. With a key, JSON is `{value, source}`; without a key, JSON maps
setting names to those objects. `config set` prints the change and an undo
command. Account and runner list JSON are arrays (see the accounts guide).

| Key | Value |
| --- | --- |
| planner | A runner id, such as `claude-code#work` or `codex`; moves the installed planner integration |
| pacing.order | Comma-separated runner ids; `opencode` means the OpenCode group; `''` clears the order |
| pacing.policy | Existing engine policies: `priority`, `even`, `burn-before-reset`, `cheapest-first` |
| pacing.planner_reserve | Percent, 0–99 (default 15) |
| pacing.accounts | `spread` or `fill` (default `spread`) |
| pacing.fill_threshold | Percent, 50–100 (default 90) |
| update_check | `true` or `false` (default `true`) |

For example:

```sh
pacer config get pacing.accounts --json
pacer config set pacing.accounts fill
pacer config set pacing.order codex#team,claude-code,opencode
pacer config set planner claude-code#work
```

`runner add` uses the id itself, rather than a nickname, and adds the runner to
the default routing rule. Remote `@host` ids are reserved and refused for now.
Account removal refuses accounts used by a runner or planner; runner removal
refuses the planner and the last runner. Homes are retained unless
`--delete-home` is supplied and its y/N prompt confirmed. Logins inherit the
terminal and are started only for newly created pacer-managed accounts unless
`--no-login` is given.
