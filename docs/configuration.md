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

Legacy `providers:` settings are automatically migrated to the current `accounts:` format the first time you edit an account, runner or endpoint. Pacer saves the original file beside it as `<strategy>.pre-accounts.bak` and then applies your edit. No separate migration command is needed.

## Providers

Native IDs are `claude-code`, `codex`, `cursor` and `agy`. Other provider IDs need `via: opencode` and a `model` such as `provider/model`. See [executors](executors.md).

| Usage | Meaning and required fields |
| --- | --- |
| quota | Local Claude/Codex rate-limit readings; OpenCode-routed quota requires `quota_source: arkcli`. |
| reactive | Available until a recorded/detected limit expires; default `cooldown: 6h`. Cursor and agy use this by default. |
| metered | OpenCode token totals against `budget: {weekly_tokens: 20M}`; this budget is required. |
| unmetered | No usage quota measurement; suitable for local models. |

Confirmed exhausted budgets exclude providers when `allow_paid` is false. `allow_paid` permits execution beyond a measured budget, but never overrides a user block or confirmed unavailability, purchases credits or configures billing. Durations support `s`, `m`, `h` and `d`. Native providers may set `model`; Cursor and agy cannot use `quota`.

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

Two further settings govern scheduled native control certification, which spends the quota of the account it certifies. `planner_probe` is `ask` (default), `auto` or `off`: on `ask` nothing is probed until you answer the consent question in Dispatcher or through `dispatch.enforcement.consent`, and `off` disables scheduling without affecting manual verification. `planner_reserve_headroom` defaults to 25 percentage points (valid 0–99) and is a separate setting from `planner_reserve`: it is the measured headroom an account must still have before Pacer will spend any of it on a probe. It is checked when a probe is admitted; it is not a guarantee that a quota window cannot fall below it afterwards. Headroom that cannot be measured never satisfies it. An over-ceiling probe cost or repeated repository switching pauses scheduled probes for at least 24 hours, then scheduling retries when eligible; the daily probe ceiling still applies.

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

`execution.worktree` is `child-of-current` (default), `new-child` or `current`; `base_branch` selects a base ref and implies `new-child` when worktree is omitted. New worktrees fetch and use the remote default branch tip unless `base_branch`, a brief `base`, or `worktree_base: head` explicitly selects another base. Automatic `child-of-current` placement in a local-only repository without origin preserves its HEAD base; explicit `worktree: new` or `worktree_base: default` still requires origin. A failed fetch never falls back to HEAD. Individual briefs use `worktree: current|new|auto` and an optional reason; safety checks can veto current placement. See [placement](executors.md#execution-and-review).

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

## Capacity, pause and executor settings

`execution.local_max_tasks` limits all local executors together (1–16, default 2).
`execution.launch_mode` sets how delegated tasks start: `interactive` (the default) or
`headless`. A runner's own `session:` setting overrides it. Change it with
`pacer config set execution.launch_mode headless` or in
**Settings → This machine → Delegated task launch**. See [Launch mode](executors.md#launch-mode).
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

`PACER=off` disables planner pacing enforcement for a session (for example,
`PACER=off claude`). `pacer pause <duration>` (for example, `pacer pause 1h`) or
the tray menu's **Pause 1h** pauses new delegation; running tasks continue.
`pacer resume` ends the pause early. Durations use
whole minutes, hours or days, up to seven days. `mode.hold` can keep a mode until
the planner window resets, or an explicit future timestamp; `mode.release` ends it.

**Settings → This machine → Preferred terminal** chooses the app used by
**Open in terminal** and other local terminal actions. The choice is stored as
`terminal.open`; `auto` detects a terminal. Existing `terminal.app` choices
remain in effect until a preferred terminal is chosen. The CLI can also set a
custom argv template with `pacer config set terminal.open '<template with {cmd}>'`.
Automatic terminal opening tries Orca, the chosen terminal app, then tmux. On a
headless machine, operations return a copyable command with `opened: false`.
Notifications are stored in `settings.json`, default to `important`, and support
`off`, `important` and `all`.

## Task retention

`task_retention_days` is a top-level strategy setting (default `14`; `0` disables
retention). Set it with `pacer config set task_retention_days 30`. Once a day, the service archives terminal tasks that were reviewed or
dismissed and settled before that window. A recent review restarts the window.
Queued/running tasks, unreviewed tasks, and tasks with an existing local worktree
or a recorded remote worktree stay untouched. Legacy tasks without a known
settlement timestamp are kept conservatively.

`pacer tasks prune --dry-run` lists the files and destination, compressed bytes
saved, and bytes removed from the working set, without moving files. Omit
`--dry-run` to archive now. Logs are streamed through gzip; logs, briefs, bundles
and compatibility JSON move into
`$PACER_HOME/archive/YYYY-MM/<task-id>/` (private directories and files).
The month is the task's creation month in UTC.

Default task lists and snapshots exclude archives. `pacer tasks --all` includes
all archived and current records, and `pacer tasks <id>` still shows the
record and archive location. `pacer tasks restore <id>` restores the artifacts,
including decompressed logs, and returns the task to default lists. Conflicting
files are never overwritten. Older binaries omit archived tasks because their
JSON compatibility files move into the archive; restore before rolling back if
those tasks must remain visible. Retention does not delete task history in SQLite.

## Per-project executor strategy

A project override defines the executors permitted to work on a repository, in
strict priority order. For example:

```sh
pacer project strategy set --repo "$HOME/projects/api" --executors cursor,codex
pacer project strategy set --repo "$HOME/projects/site" --executors codex
pacer route tests --repo "$HOME/projects/api"
pacer project strategy list
pacer project strategy show --repo "$HOME/projects/api" --json
pacer project strategy remove --repo "$HOME/projects/api"
```

The API project tries Cursor first, then Codex if eligible. The site project uses
only Codex. An explicit executor may select any allowed runner; it cannot bypass
the allowlist, including with `--force`. Disabled, unavailable, exhausted or busy
executors retain their existing eligibility and capacity checks. A classifier
hook may remove choices but cannot expand or reorder this list. Each run still
has a maximum of three attempts.

An override replaces global task-kind candidates and pacing order for that
repository. Repositories without an override keep the global strategy. Removing
an override restores that behavior; an empty list is rejected, with a pointer to
`pacer project strategy remove`.

Like `pacer delegate`, `pacer route` without `--repo` uses the repository in the
current directory, so its preview matches what delegating from there would do.
It does this only for a repository pacer already knows (one you delegated from,
added, or gave a policy); previewing never probes or registers a new repository.
Pass `--repo` to preview another repository.

Policies persist in `$PACER_HOME/project-strategies.json`, independently of named
strategies. Switching global strategies does not remove them. Executors are
stored with explicit agent, account and host identities, so changing a default
account cannot inherit another account's permission. A runner absent from the
active strategy is reported unavailable.

Repository identity follows its normalized origin, with linked worktrees sharing
the main checkout's policy. Clones with the same origin share the policy. A
repository without an origin uses its local identity; moving it or changing its
origin does not automatically migrate the policy. `list` includes orphaned
policies, which can be inspected or removed using the displayed repository key.

Edits take effect at the next attempt reservation, including queued tasks and
fallback attempts. They do not interrupt an already reserved attempt. Concurrent
edits return a conflict instead of overwriting changes; reload and review before
saving again. Invalid or unreadable policy data blocks new routing until repaired.

## Eligibility evidence

`allow_paid` is execution permission, separate from credit balance and quota observations. Routing preserves pacing or project order within the eligible and uncertain groups, and automatically permits labelled uncertain fallbacks after eligible choices. See [execution eligibility](executors.md#execution-eligibility-and-evidence).
