# Configuration

The default strategy is `~/.pacer/strategy.yaml`; `PACER_HOME` changes the state root. `pacer init` writes a detected starter, or adapt [examples/strategy.yaml](../examples/strategy.yaml). Authenticate each provider through its own CLI.

This minimal strategy uses Claude Code as planner and Codex as executor:

```yaml
planner: claude-code
providers:
  claude-code: {usage: quota}
  codex: {usage: quota, allow_paid: false}
pacing:
  policy: priority
  order: [codex]
  planner_reserve: 15
routing:
  - default: [codex]
```

## Providers

Native IDs are `claude-code`, `codex`, `cursor` and `agy`. Other provider IDs need `via: opencode` and a `model` such as `provider/model`. See [executors](executors.md).

| Usage | Meaning and required fields |
| --- | --- |
| quota | Local Claude/Codex rate-limit readings; OpenCode-routed quota requires `quota_source: arkcli`. |
| reactive | Available until a recorded/detected limit expires; default `cooldown: 6h`. Cursor and agy use this by default. |
| metered | OpenCode token totals against `budget: {weekly_tokens: 20M}`; this budget is required. |
| unmetered | No usage quota measurement; suitable for local models. |

`allow_paid` defaults to false: exhausted providers are excluded. Setting it true permits routing even when exhausted; it does not purchase credits or configure billing. Durations support `s`, `m`, `h` and `d`. Native providers may set `model`; Cursor and agy cannot use `quota`.

## Accounts and usage sources

The `accounts` mapping names separate provider budgets. Claude and Codex accounts can use a `home` folder or link an Orca-managed account with `orca_account`; these settings are mutually exclusive. Runners select an account with an ID such as `codex#team` or `opencode#local`.

pacer reads usage itself: Claude Code's status line supplies its cache, Codex session logs supply rate limits, `arkcli` supplies supported quota readings, and OpenCode stats supply metered token totals. Reactive tracking records limit errors when measured usage is unavailable.

Orca-linked accounts use their own folders: pacer reads Codex session logs in the linked account's home and uses a separate Claude status-line cache for each linked Claude account. Without a Claude cache, usage remains unknown until data or a reactive limit mark is available. Orca's `account list` is never read for usage.

`usage_source: orca` is deprecated and ignored. Existing configurations still load and retain the setting, with a status warning: Claude and Codex use their native readers, and other account kinds use reactive tracking.

## Remote hosts

`hosts:` maps runner host aliases to SSH aliases and repository checkouts.
Remote runner IDs are `<agent>[#account]@<host>`, for example `codex@box` or
`codex#team@box`. Only `codex` and `claude-code` can run remotely; the planner
must stay local. `@local` normalizes to a local runner.

```yaml
hosts:
  box:
    ssh: box-ssh
    repos:
      github.com/example/project: ~/src/project
    max_tasks: 2
    accounts:
      team: {home: ~/.codex-team}
routing:
  - default: [codex@box, codex#team@box, codex]
```

Add this to a strategy with the corresponding top-level accounts. `ssh` is
required: an SSH alias that works with `BatchMode=yes`, containing only letters,
digits, `.`, `_`, `@` and `-`, without a leading `-`. Host aliases match
`[a-z0-9][a-z0-9-]*`; `local` is reserved. Repository keys are lower-case
`host/owner/repo` without `.git`, matching the local `origin`; every repository
used remotely needs a mapping. Paths may start with `~/`.

`max_tasks` accepts 1–16, defaulting to 2. Optional `accounts` declares host
folders; each non-default remote account needs `home` here, independently of
its local account folder. Unknown keys are errors. Remote runners require new
worktree placement. See [Remote runners over SSH](remote-hosts.md) for host
prerequisites, `bash -lc` execution, setup, transfer and failure recovery.

## Pacing and routing

Policies are `priority` (default), `even`, `burn-before-reset` and `cheapest-first`. Priority follows `order`, whose default is `[codex, cursor, agy, opencode]` filtered to configured providers; `opencode` expands to OpenCode-routed candidates. Expiring capacity moves forward, ahead-of-pace usage moves back and unknown usage moves down one place. Other policies score pace, remaining capacity or usage tiers. The planner, unavailable CLIs and blocked/broken executors are excluded from routing.

`planner_reserve` defaults to 15 percentage points (valid 0–99). `ahead_threshold` and `behind_threshold` default to 10 and -10 percentage points. Planner verdicts produce relaxed, normal, strict or emergency mode; see the [mode table](../README.md#how-it-works).

The first matching `kinds` rule wins, otherwise `default` is used:

```yaml
routing:
  - kinds: [docs, tests]
    executors: [codex]
  - default: [codex]
```

Kinds: `boilerplate`, `tests`, `docs`, `rename`, `migration`, `feature`, `debug`, `refactor`, `performance`, `unfamiliar-code`, `research`. `pacer route docs --json` previews ranking and exclusions.

## Execution and classification

`execution.backend` is `auto` (default), `orca` or `direct`. `auto` and `direct` run agents under pacer's own supervisor, with pacer-owned worktrees for new placement. `orca` runs agents as supervised Orca workers in visible Orca terminals. `PACER_BACKEND=orca` still forces the Orca backend.

`execution.worktree` is `child-of-current` (default), `new-child` or `current`; `base_branch` selects a base ref and implies `new-child` when worktree is omitted. Individual briefs use `worktree: current|new|auto` and an optional reason; safety checks can veto current placement. See [placement](executors.md#execution-and-review).

`execution.idle_after_min` defaults to 10: without output or file changes, the task becomes idle and emits an alert. `execution.idle_fail_min` defaults to 30: continued inactivity stops the task. Both accept whole minutes from 1 to 1440, and `idle_fail_min` must exceed `idle_after_min`.

Classification defaults to deterministic `rules`. Optional adapters are `ollama` (an OpenAI-compatible chat endpoint, default `http://127.0.0.1:1234/v1`) and `jev`. Decisions are `task_kind`, `difficulty`, `guard` and `result_check`; each can set `use` and `min_confidence` (default 0.6). Errors, timeouts and low confidence fall back to rules. Keep defaults unless you intend to configure and evaluate an adapter.

```yaml
classifier:
  default: rules
  log_state: trimmed
  shadow: []
  shadow_external: false
  bench: {redact: true}
```

`log_state` accepts `full`, `trimmed` or `none` (controls stored decision state). Optional model adapters can send briefs/reports to their configured endpoint; external shadow calls require explicit opt-in. `pacer bench --json` evaluates logged decisions. See the [privacy details](../README.md#privacy).

## Named strategies

Save named YAML files under `~/.pacer/strategies/`. `pacer strategy list` and `pacer strategy show` inspect them; `pacer use <name>` switches, and `pacer use default` returns to `strategy.yaml`. `pacer strategy preview` can compare a draft before saving; consult `pacer --help` for the strategy commands. `PACER=off` is the session escape hatch for planner enforcement.

## Orca plugin transport

The Orca plugin uses only the versioned API: HTTP v2 on loopback when the
service is available, otherwise a `pacer api --stdio` child. The `transport`
setting accepts `auto` or `api`; older saved values fall back to API selection.
The storage bridge, channel sends and legacy HTTP routes are retired in 3.0.
If no API can connect, the panel shows **Update the pacer plugin** with
`pacer update`. Restart the plugin after updating. Notifications still use the
service notifier registration and heartbeat. `autoConsole` is ignored;
use `pacer dashboard` or `pacer open` to act.

## Capacity, pause and executor settings

`execution.local_max_tasks` limits all local executors together (1–16, default 2).
In the app, use **Settings → Executors → Parallel tasks** to set each executor’s limit,
and **Settings → This machine → Parallel tasks on this machine** for the shared local limit.
Remote host limits are under **Settings → Remote hosts**. The app explains when a machine
or host limit reduces an executor’s capacity and which limit holds a queued task.
`runners.<id>.max_tasks` limits one executor (1–16, default 1 locally or the
host's `max_tasks` remotely). A full executor is skipped; tasks wait in the queue
when their candidates are full. Queue rows report `reason`, `since` and `position`; capacity waits also report
`limit` (`executor`, `machine` or `host`) and the last checked `capacity` (`used`, `max`).
The pump, runner exits and API reads drain eligible queued work.

`runners.<id>.enabled: false` disables an executor without removing its settings.
Use `runner.set` to edit enabled, model, max_tasks or rank; `runner.reorder` takes
a permutation of all non-planner executor ids. The planner cannot be disabled.

`pacer pause 1h` pauses new delegation; `pacer resume` resumes it. Durations use
whole minutes, hours or days, up to seven days. `mode.hold` can keep a mode until
the planner window resets, or an explicit future timestamp; `mode.release` ends it.

`terminal.app` selects Terminal, iTerm or Ghostty on macOS (default Terminal).
Automatic terminal opening tries Orca, the terminal app, then tmux. On a headless
machine, operations return a copyable command with `opened: false`.
Notifications are stored in `settings.json`, default to `important`, and support
`off`, `important` and `all` without requiring the Orca plugin.
