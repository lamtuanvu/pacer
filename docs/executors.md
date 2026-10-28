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

`execution.backend: auto` (default) and `direct` use pacer's own supervisor through the direct backend. Set the backend in Settings › This machine, the TUI or with `pacer config set execution.backend orca|direct`; unset and `auto` display as `direct`. `PACER_BACKEND` overrides the saved choice and is shown as its source. Selecting `execution.backend: orca` runs Claude Code and Codex as supervised workers in pacer-launched Orca terminals. Interactive runners, connection accounts and unsupported agents run directly. If Orca is unavailable or an agent cannot become idle, pacer runs the attempt directly and records the fallback reason.

Each direct attempt records `pid`, live `stdout` and `stderr`, and `exit` under `<pacerHome>/runs/<task-id>/<attempt>/`. New task worktrees live under `<pacerHome>/worktrees/…` on branch `pacer/<task-id>`; current placement uses the selected repository. `pacer clean [--dry-run] [--force] [--json]` removes pacer-owned worktrees and run directories of settled tasks that have been reviewed, dismissed or resolved. Dirty worktrees are kept unless `--force` is given, and branches are always kept.

A brief or `--worktree` flag can choose `current`, `new` or `auto`, with `--worktree-reason` explaining the choice. Concurrent activity and unsafe placement can prevent in-place execution. Inspect the returned task's placement and reported worktree before review.

The executor contract asks workers to stay in scope, avoid further delegation, avoid commits/pushes and run acceptance. pacer records reports, logs and any acceptance result; provider-limit detection can retry another ranked executor. Review the changes and run acceptance independently before `pacer review <id> --accept` or `--reject`.

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

OpenCode model and agent selection are merged into the child's
`OPENCODE_CONFIG_CONTENT` so full-TUI launches work with both CLI generations.
Native configuration files are unchanged.

Cursor and OpenCode still enforce explicit deny rules. These launch options do
not change operating system permissions or managed organization policies.

For Orca tasks, pacer creates or resolves the worktree, launches an idle agent
with its unattended-permission flags, then attaches the worker. Orca opens its
own shell terminal in a new worktree; pacer lists that worktree's terminals and
closes it before launching the agent, and checks once more after the agent is
idle. Terminals in other worktrees are never touched. Pacer closes the
terminal it created when the worker settles. A close that Orca does not confirm
is recorded and retried by the next `pacer clean`. If Orca cannot list the
worktree's terminals, pacer records the worktree and the next `pacer clean`
closes the terminals left in it. For a default account, the
terminal command unsets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` so the agent does
not inherit another account from Orca's shell. Tasks that allow delegation run
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
permission settings, runs its project hooks and starts the MCP servers in its
`.mcp.json` without asking. This matches direct execution, where `claude -p`
already skips the trust prompt. The agent runs with
`--dangerously-skip-permissions`, so only delegate repositories whose
`.claude/` settings, hooks and `.mcp.json` you trust. Codex keeps its per-invocation trust argument.
