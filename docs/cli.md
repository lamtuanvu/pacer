# pacer CLI and skill

For full agent control, use [discoverable operations, session/file commands and the surface coverage matrix](agent-control.md).

`pacer init` connects detected agents after asking. To connect an agent later,
use `pacer install <planner>`; it installs the pacer skill and planner policy/hooks. Supported
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
with the new binary, preserving each planner’s MCP choice.
`--no-reinstall` skips the refresh;
`--check` only checks, and `--to <version>` forces replacement and refresh even at the same version.
Refresh failures warn and do not stop other integrations or fail the update.

Restart a running MCP client after updating pacer. CLI commands always run the current binary.

`pacer api list --json`, `describe <op> --json`, and `call <op> --params-file <path|-> --json`
discover and invoke v3 operations. Use filters to load only relevant descriptions.

`pacer api --stdio` runs client protocol v2 by default (v3 through `hello {protocol:3}`) as newline-delimited JSON-RPC 2.0
on stdin/stdout, without a daemon. The `--stdio` flag is required for the persistent JSON-RPC transport.
One-shot discovery and calls use `api list`, `api describe` and `api call` instead. `hello` returns the protocol and pacer versions,
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
`goal`, `repo` (defaults to cwd), `kind`, `scope`, `acceptance`, `acceptance_pipefail`, `constraints`, `context`,
`worktree_base` (`default` or `head`), `executor`, `timeout_min` (1–240), `worktree` (current/new/auto), and `worktree_reason`
(max 200 characters). Executors cannot delegate onward.

`acceptance` runs exactly as written, as `bash -c "<cmd>"` (or `sh -c` where bash is
unavailable): idioms like `grep -v ... | (! grep .)` or `git log | grep -q ...` keep
their ordinary meaning. Set `acceptance_pipefail: true` (or `--acceptance-pipefail`),
or write `set -o pipefail;` at the start of the command yourself, to fail the check on
a non-final pipeline stage's exit code too. The result always reports the acceptance
command's exit code and which shell/options ran it; a 141 (SIGPIPE) or an instant,
empty-output failure comes with a hint, since both often mean a piped command raced
past an earlier stage rather than the task actually failing.

Delegate accepts kind aliases in `--kind` and brief files: `bugfix`, `fix`, and `bug`
map to `debug`; `test` maps to `tests`; `doc` maps to `docs`; and `perf` maps to
`performance`. Tasks store the canonical kind. Invalid kinds list the allowed
values and suggest the closest kind.

Choose current for uncommitted work, research/review, installed dependencies, or small
follow-ups. Choose new for parallel tasks, concurrent user edits, or risky experiments;
omit the choice for auto placement.

`pacer watch <id> [--timeout 600] [--json]` streams the current attempt's output from the start,
then new output and observed state changes until it settles. It uses the service's
`task.get` and `task.log` operations, checking every half second. Re-running it
replays available output. Automatic executor rerouting resets offsets for the new
log source. stdout and stderr retain their own order; ordering between the two
streams is not guaranteed. Archived output must first be restored
with `pacer tasks restore <id>`.

The final event reports the outcome and a next command. Exit 0 means settled,
including failed or needs-input outcomes; it does not mean acceptance passed.
Timeout defaults to 600 seconds (integer 1–3000); timeout or error exits 2.
Ctrl-C exits 130. Timeout and Ctrl-C stop observation; the task continues independently.
Use `pacer stop <id>` to cancel execution, or `pacer attach <id>` for a live terminal.

`--json` emits newline-delimited JSON. Every event contains `type` and `task_id`:

| Type | Additional fields |
| --- | --- |
| `state` | `state` (initial state and each observed change) |
| `output` | `stream` (`stdout` or `stderr`), `source` (opaque log identity when supported by the service), `offset`, `next` (byte offsets), `text` |
| `settled` | `state`, `summary`, `question` (or null), `next` (suggested command) |
| `timeout`, `interrupted` | No additional fields |
| `error` | `message`; also printed to stderr |

Use watch in planner workflows instead of repeatedly tailing private log files.
Use wait when only the final task summary is needed.

`pacer wait <id> --timeout 600 --json` blocks until a task leaves queued/running, or times out.
Timeout defaults to 600 seconds, maximum 3000; exit 0 means settled, exit 2 means timeout
(or invalid input). Review the diff and run acceptance before
`pacer review <id> --accept|--reject [--kind <kind>] --json`.
Use `pacer stop <id> --json` to cancel.
`pacer retry <task-id> [--executor <id>] [--json]`: Re-delegate a task's stored brief.
`--executor` picks the runner; otherwise routing chooses. Refused while the task
already has a queued or running retry.
`pacer ask "<question>" [--scope dispatch|task:<id>|repo:<path>] [--json]` outside an executor session asks the
[assistant](assistant.md) once and prints the answer and its sources. Proposed actions are printed as the equivalent
`pacer` commands and are never run.
Executors that cannot continue run `pacer ask "<one question>"` once and stop.
This requires an executor session with `PACER_TASK_ID`; the task settles as
`needs_input` and raises a question under Needs you. Use
`pacer answer <task-id> "<text>"` to retry on the same executor. The retry brief
includes cumulative `qa: [{ q, a }]`, rendered as `## Question / Answer`.
Answers contain 1–2000 characters. Answering twice or answering a task that is
not waiting for input returns a conflict. `pacer stop <id>` closes a waiting question.
API clients use `task.answer { id, text, expect_rev? }`; MCP planners use
`task_answer { task_id, text, expect_rev? }`. Both return `{ task, retry }`. Task summaries (including MCP `task_status`)
include the question, its timestamp and any recorded answer.

`pacer delegate --interactive [--group <name>]` starts a routed, budgeted, reviewable
delegated task with a live terminal, instead of a one-shot run; see
[Interactive lanes](dispatch.md#interactive-lanes). `pacer send <task-id> "<message>" [--force]`
delivers one message into an interactive lane's running agent without starting a new attempt. Nothing
is typed unless the agent is its terminal's foreground process. API clients use
`task.send { id, text, force?, expect_rev? }`; MCP planners use `task_send`.

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

Task attempts save their final diff and file statistics in the run directory. Review can still show these changes after the worktree is removed; older tasks without saved evidence still require their checkout.

`pacer clean [--dry-run] [--force] [--json]` removes pacer-owned worktrees of
terminal tasks that have been reviewed, dismissed or resolved. Only tasks run
in a new worktree under pacer's worktrees directory are eligible. Dirty worktrees
are kept with `uncommitted changes; use --force` unless `--force` is given.
`--dry-run` reports what would be removed without changing files. Cleanup deletes
disposable run files while retaining saved review diffs, and always keeps branches. Text output
lists removed or kept task IDs and reasons, or `nothing to clean`; exit status is 0.

If a task's source repository was deleted, plain clean keeps the task with
`source repository is missing; use --force to delete the worktree`. With `--force`,
clean deletes only that task's own worktree, `<worktrees>/<repo-tag>/<task-id>`, after
checking that no path component is a symlink. It renames the folder to a
`.pacer-delete-*` name inside the worktrees folder, verifies it is still the same
folder, then deletes it; if a check fails, the task is kept and nothing is deleted.
`--dry-run` shows the same decisions and renames nothing. A symlinked worktrees
folder blocks only this forced direct delete (`worktrees folder is a symlink; not
deleted`); normal cleans, with the repository present, still use `git worktree
remove`. A `.pacer-delete-*` folder left by an interrupted forced clean is listed
as kept and must be removed by hand. Remote tasks whose repository is missing are
kept, because remote cleanup needs the local repository.

JSON contracts:

| Command | Top-level fields |
| --- | --- |
| status | generatedAt, strategy, planner, mode, disabled, calendarPace, providers, executors |
| route | kind, ranked, excluded |
| limits check | Array of per-account usage, source, capture time, freshness, runners, error and hint rows |
| delegate | id, createdAt, kind, requestedExecutor, timeoutS, brief, state, attempts, placement; optional runtime fields, including executorFallback |
| tasks id, wait, stop, retry | task_id, state, kind, requested_executor, optional executor_fallback, placement, attempts, result, review, resolved |
| tasks | Array of task summaries |
| review | recorded |
| clean | removed (task IDs), kept (objects with id and reason) |

The task summary matches MCP task_status; delegate keeps returning the full task record.

When `--executor` names an executor that cannot run (for example signed out,
blocked, out of quota or at its limit), pacer keeps its fallback behavior and
runs the next eligible executor, but records it: `executorFallback` (task record)
or `executor_fallback` (summary) holds `{requested, reason, executor}`, `tasks <id>`
and `delegate --wait` print `executor: requested <id>, ran on <id>: <reason>`, and
the `tasks` list adds `(requested <id>: <reason>)` to the row. `placement` is about
the worktree, not the executor.
Needs attention clears for partial/failed tasks reviewed with either verdict, whose worker
worktree was removed, or whose tracked/untracked file contents already match the base branch
tip. The brain checks at most once per task per minute and exposes `resolved` with reason
`reviewed`, `worktree removed`, or `already on <branch>`. Running and attention cards with
live Orca terminals open their session on click or Enter/Space; unavailable sessions show a
short action error.

## Setup

`pacer init [--planner <id>] [--yes] [--agents a,b] [--no-dashboard] [--json]`
sets up planner selection, strategy, login service and agent integrations in
order. `pacer setup` is an alias. Planner choices are
claude-code, codex, cursor and opencode. With several detected planners, a TTY
shows a numbered choice defaulting to the current strategy's planner. Explicit
`--planner` skips the question. With no CLIs, init creates a valid starter using
claude-code and explains how to choose another later.

Existing strategies are preserved; changing planner updates only the planner
line. Completed steps print “✓ … (already done)”. Each unconnected detected agent
shows a file preview and undo command before its own y/N consent prompt. `--yes`
accepts these setup steps; `--agents` limits selection. No MCP servers are added. Undo an
integration with `pacer uninstall <agent>`.

Non-TTY runs set up strategy and service without prompts. Agents connect only
with `--yes` or `--agents`; `--json` returns the summary as data. Non-TTY runs
never launch the dashboard. Setup then prints a summary and opens the dashboard unless `--no-dashboard` is supplied.

Before opening the dashboard, interactive init offers a first delegation when
an executor is ranked and no task has been reviewed or the exercise skipped:
`Try a first delegation now? It runs a tiny docs task in a scratch repo. [Y/n]`.
`--yes` still asks this question because the exercise spends executor budget;
non-TTY and `--json` runs never ask or start it. Declining records the skip.

Accepting calls the v3 `onboarding.try` operation with `{}`. It creates a fresh
git repo with a committed README under `PACER_HOME/onboarding/try-<timestamp>/`
and routes a 15-minute docs task: summarize README.md in three bullet points
into SUMMARY.md, checked with `test -s SUMMARY.md`. It returns
`{task_id, executor, repo}` and init prints the task's executor and review command.
Review with `pacer review <id>` or `pacer open`; accepting or rejecting completes
the first-delegation step. Failures use the normal retry flow.

The dashboard offers `t try a first delegation` while that step is pending and
an executor is ranked, alongside `s` service, `c` connect, `e` add executor and
`k` skip. The task carries `source: "onboarding"`, stays in the task list and review
queue, and is excluded from finished-today statistics. Scratch repos are removed
with `pacer uninstall --all` as part of `PACER_HOME` cleanup.

## Remove pacer

`pacer uninstall --all [--yes] [--binary] [--json]` prints a complete removal
plan from the install manifest, including each connected agent and its account
folder, the installed login service, a leftover Orca plugin from an earlier
pacer, `PACER_HOME`, and the binary path. In a terminal it asks once: `Remove all of this? [y/N]`.
Without a terminal, pass `--yes`; otherwise it prints the plan and exits 2.

Removal runs in order: agent integrations (using their recorded undo operations
and restoring backups), service, plugin, then all of `PACER_HOME`. For a leftover
plugin, remove pacer from Orca Settings > Plugins yourself; the command prints that
instruction. It continues after individual failures, reports each step as `ok` or
`failed`, and exits 1 if any step failed. Review the plan carefully: `PACER_HOME`
contains configuration, history and account data. Paths resolving to your home
directory or `/` are refused.

The binary is left in place unless you pass `--binary`. Development runs refuse
to delete the shared Bun/Node runtime; use an installed pacer binary for that
option. If the binary is inside `PACER_HOME`, removal requires `--binary`.
`--json` returns `{plan, results}`; prompts and errors use stderr.
Existing `pacer uninstall <planner>` remains available for a single integration.

pacer no longer ships an Orca plugin. `pacer plugin uninstall` removes one that an
earlier version installed: its files, its install record and pacer's keys in Orca's
plugin storage.

## Plugins (unreleased)

Plugin management is separate from the retired Orca plugin:

```sh
pacer plugin list --json
pacer plugin doctor pacer-usage --json
pacer plugin disable pacer-usage
pacer plugin enable pacer-usage
```

`list` shows bundled and installed plugins, their state and capabilities.
`doctor` checks an enabled plugin's handshake and liveness, starting it if
needed. It does not verify a provider login or fetch fresh quota data. `pacer-usage` supplies the
[usage readers](accounts.md#usage-reader-plugin-unreleased). Disabling it stops
new reads through that plugin without selecting a built-in fallback.

Installed plugins need a grant before use. `enable` asks before granting requested
capabilities; `--yes` grants without the interactive question. A version requesting
additional capabilities needs another grant. `remove <id>` removes an installed
plugin; bundled plugins can be disabled but cannot be removed.

## pacer open

`pacer open [--print] [--logout] [--browser] [<screen>]` opens the pacer app
using a one-time sign-in link: in an Orca browser tab when Orca is running,
otherwise in your default browser (`--browser` forces the default browser). The app currently shows a placeholder
until the full app ships. An optional screen selects a page, for example
`pacer open sessions`.

The daemon must already be running (`pacer service install` installs the
background service; `pacer serve` runs it in the foreground). If it is down,
`pacer open` exits 1 and prints `pacer service install` as the next step.
`PACER_PORT` selects the port (default 4317).

- `--print` prints the sign-in URL instead of opening the browser. The link
  expires after 60 seconds and works once.
- `--logout` signs out all browser sessions and exits without opening the app.

## Terminal dashboard

`pacer dashboard [--plain] [--once [--screen home|review|sessions|settings] [--width N]]`
opens a full-screen terminal UI that mirrors the app. It reads and writes only through
the versioned API, connecting to `pacer serve` when it runs and working in-process
otherwise. It refreshes on events and every two seconds; network requests never block
the display. An interactive TTY is required unless `--once` prints a single frame.

Screens are tabs in the app's order: **1 Home** (Needs you, Running, Capacity, Done
today), **2 Review** (evidence and verdicts), **3 Sessions** (running and recent
sessions, watch and timeline) and **4 Settings** (planner and pacing, accounts,
executors, routing, project strategies, strategies, updates, notifications,
appearance). While setup is incomplete, **5 Setup** replaces the work screens.

- `1`–`5` or Tab/Shift-Tab switch screens; `,` opens Settings; `?` lists every key.
- Arrows or `j`/`k` select a row; Enter runs the row's primary action, which the key
  bar names; `.` opens a numbered menu of all the row's actions.
- `d` delegates a task; `f` cycles the repo scope; `R` or Ctrl-R refreshes; `q` quits.
- Review: `a` accept, `s` send back, `r` reject, `t` retry on another executor.
- Sessions: Enter watches here, `t` opens a terminal window, `m` a tmux pane, `s` stops.
- Destructive actions (stop, remove, update, accept) always ask to confirm. Escape
  closes a dialog or goes back.

Status is always a glyph and a label, never color alone. Colors follow the design
system tokens in truecolor, 256 or 16 colors, for dark or light terminals
(`PACER_THEME=light|dark` overrides detection; `PACER_ASCII=1` uses ASCII glyphs). `NO_COLOR` removes color,
`--plain` also removes glyphs, boxes and redraw effects for screen readers and logs,
and `PACER_NO_ANIM` freezes the loading spinner. Exiting, Ctrl-C, SIGTERM and errors
restore the normal screen, cursor and input mode.

### Update checks

`pacer update --check [--json]` checks `latest.json` and reports the current CLI,
latest release and availability.
It exits successfully even when offline and never installs anything. Checks time out
after three seconds; failures are recorded in `~/.pacer/update-check.json`.
The shared check caches results for 24 hours; explicit checks force a refresh.
Text `pacer status` displays a cached update notice; `--line`, `--json`, and `--hook`
never check or display update notices.

Set `PACER_NO_UPDATE_CHECK=1` or add top-level `update_check: false` to the active
strategy YAML to disable checks (including explicit checks). No telemetry is sent:
the only release request is a GET of `latest.json`. `PACER_RELEASE_BASE`, including
`file://` bases, works as it does for `pacer update`.

In the dashboard, Settings › Updates checks immediately and asks to confirm before
updating; Escape or `n` cancels. These checks never install a newer release
automatically.

## Console retirement

`pacer console` and its command lines were removed in protocol 3.0. Use
`pacer dashboard` for terminal actions or `pacer open` for the app.

## Remote hosts

See [Remote runners over SSH](remote-hosts.md) for prerequisites and the
`hosts:` strategy table. Host scripts run under `bash -lc`; Linux hosts need
`setsid` from `util-linux`.

```text
pacer host list [--json]
pacer host check <alias> [--repo <path>] [--json]
pacer host setup <alias> [--repo <path>]
pacer host clean <alias> [--json]
```

`list` shows configured aliases, repository keys and running task counts. JSON
rows include `alias`, `ssh`, `maxTasks`, `repos`, `runners` and `running`.
`check` returns `{alias, ok, checks: [{name, ok, detail}]}` in JSON, or one line
per check in text. It exits 0 on success, 1 for failed checks and 2 for invalid
input. `--repo` selects a local repository's mapping; without it, all mapped
checkouts are checked against the current local repository's identity.

`setup` uses the current local repository unless `--repo` is supplied. It asks
separately before cloning a missing host checkout and before setting repo-local
identity, then checks the result. Its y/N prompts require a TTY to approve
changes; it has no `--json` mode. `clean` removes eligible settled tasks' host
worktrees and run directories after review, dismissal or resolution, returning
`{removed, kept}` in JSON. Remote branches are deleted only when their local
task branch exists.

Use `pacer delegate --executor codex@box --worktree new` to select a remote
runner. Results return as a verified git bundle on `pacer/<task-id>` for local
review and acceptance. The API exposes `host.list` and `host.check`; setup and
cleanup are CLI-only.

## Accounts, runners and configuration

See [Accounts and runners](accounts.md) for sign-in, endpoint connections and
budgets, Orca links and account folder behavior.

```text
pacer account list [--json]
pacer account add
pacer account add <claude|codex> <name> [--home <dir>] [--no-login]
pacer account add <claude|codex> <name> --orca <id>
pacer account add opencode <provider> [--model <id>] [--cap-usd <n>] [--usage <quota|metered|unmetered>] [--name <name>] [--no-test]
pacer account add endpoint <name> --usage <quota|metered|unmetered> [--quota-source arkcli] [--weekly-tokens <n>]
pacer account add endpoint <name> --base-url <url> --key <keychain|file|env:VAR|none> --models <id,...> --usage <quota|metered|unmetered> [--context <n>] [--output <n>] [--quota-source arkcli] [--weekly-tokens <n>] [--no-test]
pacer account models <name> [--refresh]
pacer account test <name>
pacer account edit <name> [--base-url <url>] [--key <keychain|file|env:VAR|none>] [--models <id,...>] [--context <n>] [--output <n>] [--usage <quota|metered|unmetered>] [--quota-source arkcli] [--weekly-tokens <n>]
pacer account rm <name> [--delete-home] [--delete-key]
pacer runner list [--json]
pacer runner add <agent#account> [--model <m>]
pacer runner rm <agent#account>
pacer config get [key] [--json]
pacer config set <key> <value>
pacer config migrate
```

Interactive `account add` offers **Model endpoint (OpenCode)**: it lists providers
already signed in to OpenCode, local model servers, a catalog search (OpenCode
stores the key) and **Enter a URL yourself** (URL, hidden key, model
discovery/selection, limits, usage and an optional test). `account add opencode
<provider>` adds a signed-in provider in one command, using the recommended model
unless `--model` is given; `--cap-usd` sets a weekly dollar cap. The explicit
connection form creates the provider and runner automatically and tests by
default; `--no-test` leaves it Not tested. Only a passing test reports Ready.
For `--key keychain` or `file`, read the key from stdin; `env:VAR` refers to an
environment variable, and `none` requires no key. Model limits default to 128K
context and 16K output; size flags accept `K`, `M` and `G` suffixes.

`account models` lists selected models; `--refresh` discovers and prompts for
a new selection. `account edit` without flags is interactive and offers adoption
for an External OpenCode provider, asking for a new key rather than copying one
from OpenCode's config. Flag-based edits and model refreshes leave the endpoint
Not tested; use `account test` to rerun the temporary-repo test. Not working and
Key missing runners are excluded from routing. `account rm --delete-key` removes
a stored Keychain/file key; environment keys remain untouched. The usage-only
endpoint add form above retains the legacy externally configured provider flow.

Commands write the active strategy and validate the whole result. Refused edits
leave its bytes unchanged; successful edits preserve comments and untouched
layout. Legacy provider strategies load unchanged until migration; account and
runner edits ask you to run `pacer config migrate` first. Migration saves the
original as `<file>.pre-accounts.bak` and prints how to restore it.

`config get` returns each effective value and its source: the strategy filename
or `default` (`env PACER_BACKEND` when that override is set). With a key, JSON is `{value, source}`; without a key, JSON maps
setting names to those objects. `config set` prints the change and an undo
command. Account and runner list JSON are arrays (see the accounts guide).

| Key | Value |
| --- | --- |
| execution.backend | `orca` or `direct`; unset and `auto` display as `direct`. `PACER_BACKEND` overrides the saved setting. |
| planner | A runner id, such as `claude-code#work` or `codex`; moves the installed planner integration |
| pacing.order | Comma-separated runner ids; `opencode` means the OpenCode group; `''` clears the order |
| pacing.policy | Existing engine policies: `priority`, `even`, `burn-before-reset`, `cheapest-first` |
| pacing.planner_reserve | Percent, 0–99 (default 15); scales the planner's pace, and is not the probe floor below |
| pacing.planner_reserve_headroom | Percent, 0–99 (default 25); measured headroom a planner account must keep before Pacer will spend its quota on a certification probe |
| pacing.planner_probe | `ask` (default), `auto` or `off`; whether scheduled certification probes may run, given that each spends the certified account's own quota |
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
the default routing rule. Remote `@host` ids require a declared host and support
`codex` and `claude-code`; non-default accounts also need a host account folder.
Account removal refuses accounts used by a runner or planner; runner removal
refuses the planner and the last runner. Homes are retained unless
`--delete-home` is supplied and its y/N prompt confirmed. Logins inherit the
terminal and are started only for newly created pacer-managed accounts unless
`--no-login` is given.

## Plugins

`pacer plugin list|enable|disable|remove|doctor` manage plugins. A plugin that contributes UI (plugin protocol 1.2) is granted its surface kinds as well as its capabilities, and `enable` lists both.

- `pacer plugin ui list [--json]` lists the activity items, panel tabs, settings pages and status items of enabled plugins.
- `pacer plugin settings get <id>` prints a plugin's settings schema, values and revision as JSON.
- `pacer plugin settings set <id> --values '<json object>' [--rev <n>]` validates the values against the schema from the plugin's manifest and saves them. A stale `--rev` fails with `conflict`.

Settings are stored in `$PACER_HOME/plugin-settings.json` (mode 0600), not in the strategy file. The app's plugin pages use the same operations. Secrets are never values: a `secretRef` field holds the name of a secret reference.

## Machine

Every pacer home has a machine identity: a long-lived key, an id derived from it, and a display name.

- `pacer machine show [--json]` prints the name, id and revision. It also warns when the home looks copied from another machine.
- `pacer machine rename <name> [--json]` changes the name. Names are display-only (1–64 characters; control and bidirectional characters are removed) and never change the id. A rename that races another client fails with `conflict`.
- `pacer machine rotate --yes [--json]` replaces the key, prints the old and new ids, and forgets every plugin's recorded transport key. Machines paired with the old id must be told or pair again. Without `--yes` it refuses and exits 2.

The id changes only on rotation. The private key never appears in command output. The API equivalents are `machine.get {}`, `machine.set { name, expect_rev }` and `machine.rotate {}`. Through the API, executor sessions may call `machine.get` but not `machine.set` or `machine.rotate`. Their client still has to be accepted by the service, for example through a scoped work grant, so `pacer machine show` run from an executor shell can fail.

## Pause and resume delegation

Set `PACER=off` for a session (for example, `PACER=off claude`) to disable
planner pacing enforcement. Run `pacer pause <duration>` (for example,
`pacer pause 30m`) to pause new work for up to seven days. Durations accept
whole minutes, hours or days, such as `30m`, `1h` or `1d`.
The tray menu also offers **Pause 1h**.
Running tasks continue. New tasks wait with the `paused` queue reason and resume
on the next queue drain after expiry. `pacer resume` ends the pause early.
The API equivalents are `delegation.pause { for, reason? }` and
`delegation.resume {}`. `mode.hold { mode, until? }` holds a budget mode until the
planner window resets (seven days if unknown); `mode.release {}` ends the hold.

Use `pacer executor set <id> --enabled false --model <model> --max-tasks 2` to
change executor settings. Executor readiness, host checks and updates expose
shared progress through `job.get`, `job.list` and `job.cancel` when cancellable.

New worktrees fetch `origin` and start at `origin/<default-branch>` rather than the source checkout's current branch. The task JSON records `baseBranch` and the immutable `baseSha`. Use `--worktree-base head` (brief/API: `worktree_base: head`) to opt in to the current HEAD, including detached HEAD. An explicit brief `base` or configured `execution.base_branch` still selects that ref. Fetch or default-branch discovery failures stop creation rather than silently using a stale checkout.

An explicit `--repo` preserves that checkout's real path, including linked worktrees; repository identity can still be shared for project policy. Registered repo keys select the saved checkout when a path is not supplied. Blocked executors and executors with confirmed exhaustion where paid execution is forbidden are excluded from automatic selection and fallback; requesting one explicitly returns an error. A review retry reuses the original local worktree, including uncommitted work.

## Eligibility evidence

Status and routing expose the same eligibility decision used at launch. `route --json` adds `eligibility` on candidates and exclusions, `fallback: "uncertain"` on fallback candidates, and an `uncertain` subset. Human output labels uncertainty and shows historical quota without inventing a reset. See [execution eligibility](executors.md#execution-eligibility-and-evidence).
