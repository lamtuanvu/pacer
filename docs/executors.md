# Executors

Install and authenticate executor CLIs yourself. pacer launches existing tools; provider/model availability and subscription access come from those tools.

| Strategy ID | Launcher | Usage source |
| --- | --- | --- |
| codex | `codex exec` | Codex app-server rate-limit query, with local rollout logs as historical fallback. |
| cursor | `cursor-agent -p` | Reactive limits and cooldown; no quota reader. |
| agy | `agy -p` | Reactive limits and cooldown; no quota reader. |
| claude-code | `claude -p` | Local status-line rate-limit cache. Can execute when another tool is planner. |
| byteplus (configured ID) | `opencode run --agent build -m <model>` | `arkcli usage plan --product coding-plan` when `quota_source: arkcli`. |
| Any OpenCode-routed ID | `opencode run --agent build -m <model>` | Metered OpenCode stats, reactive marks, unmetered, or ArkCLI quota according to config. |

The planner itself is excluded from executor ranking. An optional `model` selects the model passed to a native launcher; Cursor Free setups can use `model: auto` as in the starter example.

## BytePlus and local models

```yaml
providers:
  byteplus:
    via: opencode
    model: coding-plan/dola-seed-2.0-code
    usage: quota
    quota_source: arkcli
  local:
    via: opencode
    model: lmstudio/qwen3.6-35b-a3b
    usage: unmetered
```

These model IDs are examples; configure a model available in your OpenCode setup. Ollama models likewise use `ollama/<model>`. `pacer init` can discover local models with `ollama list` and `lms ls --json` when those CLIs and OpenCode are installed. A metered provider reads seven-day spend through OpenCode; `budget.weekly_tokens` and the newer `budget.weekly_usd` cap are both optional.

The easiest way to add one is `pacer account add` → **Model endpoint (OpenCode)**, or Settings › Add executor → **Model endpoint (OpenCode)** in the app. Both list providers already signed in to OpenCode, local model servers and catalog providers, recommend a model and offer a weekly dollar cap; see [Endpoint accounts](accounts.md#endpoint-accounts-opencode). In the app, a catalog provider shows the `opencode auth login <provider>` command to run in a terminal, then Refresh; the browser never takes a key. A provider signed out of OpenCode reads **Key missing** with that command, and a reached weekly cap counts as a full window, so routing uses other executors until the week turns over.

While the Pacer service runs, it checks provider-supported usage every 15 minutes, including accounts whose executors are idle. `pacer limits refresh [account]` or **Refresh usage** in the app requests an immediate check. Codex uses a read-only app-server rate-limit query; ArkCLI and OpenCode use their existing usage commands. Claude reads its local status-line cache, which changes only when Claude supplies new data. Reactive and unmetered accounts have no quota query. A failed check keeps the last reading marked historical; it does not create fresh quota evidence or run an executor turn.

Claude usage requires the status-line integration to have received rate-limit data. Missing/stale readings are surfaced as unknown rather than invented quota values. BytePlus readings are cached for 10 minutes; OpenCode metered stats for 5 minutes, with stale fallback when a query fails.

## Execution and review

`execution.backend: auto` (default) and `direct` use pacer's own supervisor through the direct backend. Set the backend in Settings › This machine, the TUI or with `pacer config set execution.backend orca|direct`; unset and `auto` display as `direct`. `PACER_BACKEND` overrides the saved choice and is shown as its source. Selecting `execution.backend: orca` runs Claude Code and Codex as supervised workers in pacer-launched Orca terminals when the task's [launch mode](#launch-mode) is interactive (the default). Headless tasks, strict managed work, connection accounts and unsupported agents run directly, and the attempt log says why. If Orca is unavailable or an agent cannot become idle, pacer runs the attempt directly and records the fallback reason.


By default, pacer also runs non-force cleanup immediately after review accept or reject, dismiss, and resolution. `pacer serve` sweeps at startup and hourly to retry resources left behind. Automatic cleanup preserves dirty or shared worktrees, running tasks, tasks awaiting an answer, resolved tasks still open for messages whose next message turn resumes in that worktree, and local branches. Only local direct-backend tasks whose executor can run a headless turn qualify; remote and Orca tasks are cleaned as usual. Such a task keeps its worktree while messages wait for its next turn (a pending or held message to it, or its unread question), and for `messaging.keep_worktree_days` (default 7, `0` turns the window off) after its last message or run end; reviewing, dismissing or closing it with `pacer msg close` releases it at once, and `pacer clean --force` ignores this retention. A message sent after its worktree was cleaned is refused with `msg_worktree_unavailable`; retry the task to restore the worktree from its branch. A cleanup failure never fails the recorded review or dismissal; lifecycle cleanup records why a worktree was kept in task activity. Startup and hourly sweeps retry quietly. A retry restores a removed checkout from its retained `pacer/<task-id>` branch, preserving committed work; if that branch is also gone, it chooses a new worktree and records why in placement. A restored checkout keeps its original task as owner and is cleaned when every task in the retry chain is settled and reviewed, dismissed or resolved. Unreachable remote hosts are skipped and retried on a later sweep. Set `execution.auto_clean: false` (or `pacer config set execution.auto_clean false`) to disable both automatic paths; manual `pacer clean` remains available.

When `pacer delegate` overrides a brief’s requested `worktree: current` placement to `new`, its text output includes the override reason. The `execution.worktree` default remains `child-of-current`.

A brief or `--worktree` flag can choose `current`, `new` or `auto`, with `--worktree-reason` explaining the choice. Concurrent activity and unsafe placement can prevent in-place execution. Inspect the returned task's placement and reported worktree before review.

The executor contract asks workers to stay in scope, avoid further delegation, avoid commits/pushes and run acceptance. Set `acceptance_timeout_min` in the brief (or `--acceptance-timeout-min`) to an integer from 1 to 120 for the acceptance deadline in minutes; the default is 10, independent of the executor timeout, and retries preserve it. Timed-out acceptance results report `timedOut: true`, the deadline in the tail/summary, and a hint to raise the limit. pacer records reports, logs and any acceptance result; provider-limit detection can retry another ranked executor. Review the changes and run acceptance independently before `pacer review <id> --accept` or `--reject`.

```sh
pacer tasks --json
pacer tasks TASK_ID --json
pacer watch TASK_ID --timeout 600 --json
pacer wait TASK_ID --timeout 600 --json
pacer stop TASK_ID --json
pacer report-limit cursor
pacer executor block agy --for 6h --reason "Temporarily unavailable"
pacer executor unblock agy
```

Replace `TASK_ID` with an actual task ID. A wait timeout returns exit 2; inspect and wait again. `pacer doctor` checks configuration, CLIs and integration health. See [CLI docs](cli.md) for briefs and review contracts.

## Settings and readiness checks

Enable or disable an executor without deleting it using `runner.set { id,
enabled }`. The same operation edits model, max_tasks and rank; `runner.reorder`
changes routing order. Disabled executors stay visible with state `disabled`
and are excluded from routing. Disabling the last executor in a rule returns a
warning. The planner is protected from these changes.

`agent.detect` reports installed agents, versions and install hints.
`runner.check { id }` starts a shared job that checks CLI presence, sign-in,
usage and a scratch task that writes `hello.txt` containing `ok`. It never runs
the test in a user repository. **Signed in** uses the account's local sign-in
state (see [accounts](accounts.md#sign-in-state)), not a usage reading; for a
remote runner the test task checks the host's login. For a local Claude quota
account with missing or stale usage, the test task collects Claude Code's own
structured quota telemetry and **Usage readable** is checked again afterward.
It passes only when current usage is available; missing telemetry fails with
subscription and CLI-update guidance. No planner status line is needed for
this check. Codex's missing first session-log reading is still skipped with its
reason. A usage reader error still fails the check. The row shows `checking` while
running and `lastCheck` after completion; a failed check shows `failing` and
executor attention.

A failed check does not by itself remove an executor from routing: the check
reports readiness and asks for attention, while routing excludes executors only
for the reasons `pacer route` lists (disabled, blocked, broken, not installed,
signed out, out of quota, an endpoint that is Not working or has its key missing).
A check can lead to one of those, for example a failed endpoint test task marks
it Not working. To stop using an executor whose check failed, disable it.

Capacity rows use the configured executor limit and report `full` when the
executor, host or shared local machine limit is reached, naming the binding limit.
Tasks try the next eligible executor or wait for capacity.

## Execution eligibility and evidence

Pacer separates execution permission from pacing. An executor is **eligible** when its applicable availability and budget evidence permits execution, **unavailable** when a current restriction prohibits it, or an **uncertain fallback** when required evidence is missing, expired or conflicting. Routing tries eligible executors first, then automatically permits labelled uncertain fallbacks. A guard redirects local work only when a confirmed eligible alternative exists.

Quota observations use the provider event time, not a log file's modification time or a cache fetch time. Newer observations supersede older ones, even when usage decreases before a predicted reset. Equal-time provider CLI evidence outranks passive logs; equally authoritative contradictions stay explicit. A short window (up to six hours) expires after two hours; longer windows expire after one day. A reported reset expires evidence sooner. Expired values remain historical; passing a reset does not create a measured zero. Every applicable quota window must be current.

Before a new attempt, Pacer refreshes sources that support a current provider command and rereads passive logs. It checks the resulting evidence revision, deadline, account configuration and project policy again before dispatch. A failed or unsupported refresh cannot manufacture confirmation. Existing attempts are observed normally on resume.

Credits, credit balances and measured paid consumption are separate from the configured `allow_paid` permission. Current exhaustion with `allow_paid: false` remains unavailable even if credits exist. An uncertain fallback is not permission to change `allow_paid`; its paid-spend risk remains unknown when the source cannot establish it. Reactive and unmetered executors use their declared measurement contracts instead of fabricated quota windows.

Successful execution confirms availability only. Authentication/subscription failures constrain availability; a quota failure constrains budget. Timeouts and unrelated task failures do not establish either. Later applicable evidence can clear an older observed failure; explicit user blocks remain effective until removed or expired.

## Launch mode

Delegated tasks start in interactive mode by default. An interactive task opens in
the agent's own terminal UI, which you can watch or take over. It finishes when the
agent runs `pacer report`. Run that command with the launch environment unchanged;
do not override `PACER_HOME` or `HOME` for it. Agent reports resolve the launch
store from the canonical `PACER_RUN_DIR` and require the current running local
attempt and its `PACER_REPORT_TOKEN`. If `PACER_HOME` differs, pacer uses the launch
store and prints a note to stderr. A headless task runs the agent's non-interactive CLI
(for example `codex exec` or `claude -p`) and finishes when that process exits.

Pacer picks the mode in this order:

1. The runner's own `session: interactive` or `session: headless`.
2. The global `execution.launch_mode` (`interactive` or `headless`).
3. `interactive`.

```sh
pacer config set execution.launch_mode headless
```

In the app, use **Settings → This machine → Delegated task launch**.

If the mode comes from `execution.launch_mode` or the default, and a task cannot run
interactively, it runs headless. The reason is recorded in the attempt's report or
log. This happens for remote runners, for Codex older than 0.162.1 or whose version
cannot be confirmed (older versions lack per-run hook overrides), and for agents with
no interactive launcher. Endpoint test tasks always run headless. A runner with an
explicit `session: interactive` still reports these cases as errors.
Conversations are always interactive.

Managed work with strict native subagent control stays headless, as it was before
interactive became the default: `execution.launch_mode` and the default do not
apply to it, and the attempt note records why. Strict control is certified only for
headless launches, so a runner with an explicit `session: interactive` cannot take
strict work. If that runner was requested, or no other runner can take the work, the
task fails at once and names the setting to change. Pacer does not move requested
work to a different runner because of its launch mode.

The launch mode and `execution.backend` combine as follows:

| Backend | Interactive | Headless |
|---------|-------------|----------|
| `orca`, Orca running | Orca terminal, supervised as an Orca worker | direct, headless CLI |
| `orca`, Orca not running | direct, pacer's own terminal | direct, headless CLI |
| `auto` or `direct` | direct, pacer's own terminal | direct, headless CLI |

An interactive task in an Orca terminal uses the same agent command as a direct
interactive launch, with pacer's per-run Claude settings file (no bypass-permissions
acknowledgement and, in an Orca worktree pacer created for the task, the project MCP
answers described below), and finishes when the worker reports `worker_done`. You watch and
take over the agent in Orca; pacer's own take over and `pacer report` completion do
not apply there.

## Permission policy

Every pacer-launched agent uses its CLI's unattended permission mode, including
interactive sessions, takeover/resume, remote execution and strategy planning:

| Agent | Launch options |
| --- | --- |
| Codex | `--dangerously-bypass-approvals-and-sandbox`; interactive/resume also bypass trust for injected hooks |
| Claude Code | `--dangerously-skip-permissions` |
| Cursor | `--force --sandbox disabled` |
| Antigravity | `--dangerously-skip-permissions`, without `--sandbox`; interactive prompts use `--prompt-interactive` |
| OpenCode | `--auto`, with `--standalone` to keep the process environment private |

Codex interactive and resumed launches pass trusted worktree and original-repository
paths as an invocation-only TOML table, without editing native config. Pacer
adds `--dangerously-bypass-hook-trust` when it injects its reporting hooks.

Claude Code asks whether to trust a folder, and whether to allow external
`CLAUDE.md` imports, before it loads Pacer's hooks. An unattended task would wait
at those prompts unseen. Before an interactive or takeover launch in a worktree that
Pacer created for the task (under `~/.pacer/worktrees`), Pacer marks that worktree as
trusted in the selected account's Claude state (`~/.claude.json`, or `.claude.json`
in a named account's folder), the way Orca does. It never does this for an in-place
run, a folder that is not a git repository, your home folder or `/`; those launches
start normally and the report says the trust prompt may appear. It sets
`hasTrustDialogAccepted` on the worktree's entry. If you have not yet answered the
import prompt for the repository, it also records the answer "No" on the repository
root's entry (`hasClaudeMdExternalIncludesWarningShown`), which is where Claude Code
reads it: the prompt is not shown and imports from outside the repository stay off.
That answer also applies to your own Claude sessions in the repository; an earlier
answer is never changed. Conversations, which you attend, keep Claude's prompts. Pacer
re-reads the file under Claude's lock (`<real path>.lock`, as `proper-lockfile` takes it,
also when `.claude.json` is a symlink), changes only those `projects` entries and
replaces the file atomically. If the file is missing, unreadable or
locked, the task still starts and its report says the trust prompt may appear.
Pacer keeps one trust entry per task worktree and, like Orca, does not remove the
entries when it removes a worktree.

The run's `--settings` file skips Claude's one-time bypass-permissions
acknowledgement. For an unattended launch in a task worktree pacer created, it also
approves project MCP servers for that launch (`enableAllProjectMcpServers`), including a server from a `.mcp.json` in a
parent folder of `~/.pacer/worktrees`. In-place runs, takeovers and conversations keep
Claude's own MCP prompt. The account's `settings.json` and `.claude.json`
are not edited for either.

A server you rejected stays off. Claude Code stores your answers in the checkout's
untracked `.claude/settings.local.json`, or in the project's entry in `.claude.json`,
and a new task worktree has neither. Before the launch, Pacer reads only
`disabledMcpjsonServers` and `enabledMcpjsonServers` from the source checkout's
`.claude/settings.local.json` and from the source repository's entries in the account's
`.claude.json`, and writes them into the run's `--settings` file. Claude Code 2.1.281
applies `disabledMcpjsonServers` before `enableAllProjectMcpServers`, also when both
come from the per-run file. If either file exists but cannot be read or parsed, pacer
approves nothing for that launch and the attempt note says Claude's MCP prompt may appear.

## Session environment

An executor session behaves as if you ran the same agent CLI in a new terminal in the
task's folder, with pacer's own additions. The service runs under launchd or systemd,
whose environment lacks most of your shell profile. Pacer therefore starts your login
shell once (`$SHELL -l -i -c`, with no terminal input and a 5-second limit) and uses
the environment it prints as the base for headless, interactive, takeover and resumed
launches. PATH, locale, tool managers, proxies and API keys exported by your profile
apply as they do in a terminal. Variables that pacer does not own are passed
unchanged. The result is cached for 60 seconds and held in memory only. Each run
directory's `environment.json` records the shell used, or the reason pacer fell back
to the service's own environment; values are never logged or written. If the shell
cannot be used, the attempt note says so. Set `PACER_LOGIN_ENV=off` in the service
environment to skip the login shell.

Managed work under strict native subagent control is exempt from this terminal parity.
Its certification checked the agent binary on the service's PATH and the control files
in the service's account folder, so the attempt runs with exactly that environment: no
login shell, direnv, mise or login umask, and the default account uses the service's
default folder rather than one set by your profile. The attempt note and
`environment.json` record this. A different environment could start another binary or
read other settings than the ones that were certified.

The same login-shell command prints the shell's `umask`. Pacer applies it to the agent
process only, through a fixed `/bin/sh` wrapper, for headless, interactive, takeover and
resumed launches; the service's own umask does not change. If the shell prints no valid
octal mask, the agent keeps the service's umask and the attempt note says why.

After the login shell, pacer applies what a terminal `cd` into the task folder would:

1. **direnv**: if `direnv` is on the login PATH and the folder (or a parent) has an
   `.envrc`, pacer runs `direnv export json` in the folder and applies the changes,
   including unsets. direnv decides trust itself: a blocked or unallowed `.envrc` is
   skipped. Pacer never runs `direnv allow`.
2. **mise**: if `mise` is on the login PATH, pacer runs `mise env --json` in the folder
   and applies it. An untrusted config is skipped; pacer never runs `mise trust`.
3. **asdf**: only its shims apply, through the login PATH.

Neither direnv nor mise may set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`: the account folder
comes from your login profile or the strategy, not from a repository's configuration.
The attempt note names such a variable as not applied.

Each tool has a 5-second limit and runs for every launch (never cached across folders).
A skipped tool is named with a one-line reason, without values, in the attempt note and
`environment.json`. Pacer's overrides are applied last.

Pacer's overrides on top of that base:

| Area | Override |
| --- | --- |
| Environment | `PACER_ROLE`, `PACER_TASK_ID`, `PACER_HOME`; interactive runs also get `PACER_RUN_DIR`, `PACER_TRANSCRIPT_REPORT` and `PACER_REPORT_TOKEN`. Pacer's own tokens are removed. |
| Account | A named account sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to its folder. The default account keeps the value your login profile sets, as a terminal would; a value that only the service environment carries, or that direnv or mise sets, is not used, so the CLI's default folder applies. Pacer records the profile's folder in `state/default-account-folders.json` for usage readers, and each run records the folder it used in its run directory for that run's transcript lookup. Strict managed work uses the service's default folder (see above). |
| Terminal | Interactive runs use pacer's terminal (`TERM=xterm-256color`, `COLORTERM=truecolor`, 120×40 until a viewer resizes it). `NO_COLOR` and `FORCE_COLOR` set by your login profile are kept; values that only the service environment carries are not passed to it. Headless runs have no terminal: input comes from the prompt or `/dev/null`, and output goes to the run's files. |
| Flags | The permission flags above; `-p`/`exec`/`run` and the output format for headless runs; Codex `--no-daemon`; OpenCode `--standalone` and its `build` agent; the model, if the runner sets one. |
| Configuration | Claude: interactive runs get the run's `--settings` file (reporting hooks, the acknowledgement and, for unattended task launches, MCP approvals with your rejections); strict headless runs get a `--settings` file with pacer's subagent guard. Codex: per-run hook, trust and (on resume) update-check overrides, which replace your hooks for those events in that run. Claude folder trust as described above. |
| Prompt | The brief and pacer's report instructions. |

Remote runners start through a login `bash -l` on the host and are not covered here.

OpenCode model and agent selection are merged into the child's
`OPENCODE_CONFIG_CONTENT` so full-TUI launches work with both CLI generations.
Native configuration files are unchanged.

Cursor and OpenCode still enforce explicit deny rules. These launch options do
not change operating system permissions or managed organization policies.

For Orca tasks, pacer creates or resolves the worktree, launches an idle agent
with its unattended-permission flags, then attaches the worker. Orca opens its
own shell terminal in a new worktree; pacer lists that worktree's terminals and
closes it before launching the agent. Terminals that appear later, and
terminals in other worktrees, are never touched. Pacer closes the
terminal it created when the worker settles. A close that Orca does not confirm
is recorded and retried by the next `pacer clean`. If Orca cannot list the
worktree's terminals, the next `pacer clean` closes only the initial terminal
Orca named when it created the worktree. Orca's terminal list has no creation
time, so pacer never closes a terminal it did not record there, such as one you
opened. For a default account, the
terminal command sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to the folder your
login profile sets, as a direct launch does, and otherwise unsets it so the agent
does not inherit another account from Orca's shell. Tasks that allow delegation run
directly, because their work grant cannot be placed in a visible terminal
command. If the agent does not start, pacer
closes that terminal and removes the worktree it just created before running the
task directly; a worktree it cannot remove is removed by `pacer clean` after
review. When pacer cannot tell whether Orca started the worker, it does not run
the task directly: it keeps the terminal and retries the check on the next
`pacer clean`. If that check finds the worker settled, pacer adds its worktree
and outcome to the task and marks the task for review again, even if it was
already reviewed or dismissed. The attempt log lists each step, with account folder values
replaced by their variable names. `pacer clean` removes reviewed or dismissed
Orca worktrees once Orca has deleted the directory; Orca may also remove the
worktree branch when it can prove the branch is merged.

Claude terminals started for Orca carry `CLAUDE_CODE_SANDBOXED=1`, so Claude
skips its per-folder workspace trust prompt and pacer edits no Claude
configuration. The variable is
undocumented by Anthropic. If a Claude release ignores it, the trust prompt
keeps the agent from becoming idle and pacer runs the task directly instead.
With the variable set, Claude also applies the repository's own `.claude/`
permission settings and runs its project hooks without asking. This matches direct
execution, where `claude -p` already skips the trust prompt. The agent runs with
`--dangerously-skip-permissions`, so only delegate repositories whose
`.claude/` settings and hooks you trust. Codex keeps its per-invocation trust argument.
Pacer never writes `.claude.json` for Orca worktrees.

Project MCP servers in an Orca worktree pacer created for the task (a new worktree
named `pacer-<task>-<executor>`, checked after Orca creates it) are handled as in a
pacer task worktree: the run's `--settings` file approves them and carries your
`disabledMcpjsonServers` and `enabledMcpjsonServers` from the source checkout's
`.claude/settings.local.json` and the account's `.claude.json`, so a server you
rejected stays off. If either file exists but cannot be read or parsed, pacer
approves nothing and the attempt log says Claude's MCP prompt may appear. A task in
an existing Orca worktree (current placement or a retry) keeps Claude's MCP prompt.
Orca's worker-start API cannot carry a permission policy, so selecting the Orca
backend (including `PACER_BACKEND=orca`) uses direct execution instead. The
attempt log records the fallback. The direct backend owns worktree placement.

### Agent settings keyboard feedback

In Settings → Agents, opening Details moves focus to the panel. Escape from its
Close button, Takes work switch or the opening Details button closes the panel
and returns focus to Details. Escape in Parallel tasks preserves the open panel
and draft, and a confirmation dialog handles its own Escape key.

Takes work saves immediately. A failed save names the agent in a dismissible
alert above the table, even if its details were closed before the response, and
also appears in notifications. A successful save or reloading saved settings
clears the inline error. In Add agent, Check again focuses the first newly found
agent and announces its name; when nothing new is found, focus stays on Check again.
