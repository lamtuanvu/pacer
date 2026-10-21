# Executors

Install and authenticate executor CLIs yourself. pacer launches existing tools; provider/model availability and subscription access come from those tools.

| Strategy ID | Launcher | Usage source |
| --- | --- | --- |
| codex | `codex exec` | Rate limits in local Codex rollout logs. |
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

Claude usage requires the status-line integration to have received rate-limit data. Missing/stale readings are surfaced as unknown rather than invented quota values. BytePlus readings are cached for 10 minutes; OpenCode metered stats for 5 minutes, with stale fallback when a query fails.

## Execution and review

`execution.backend: auto` (default) uses pacer's own supervisor through the direct backend. Set `execution.backend: orca` to run agents as supervised workers in visible Orca terminals, including agy through Orca's antigravity agent. OpenCode-routed providers require `execution.worktree: current` for Orca model selection; other placement policies fall back to direct execution.

Each direct attempt records `pid`, live `stdout` and `stderr`, and `exit` under `<pacerHome>/runs/<task-id>/<attempt>/`. New task worktrees live under `<pacerHome>/worktrees/…` on branch `pacer/<task-id>`; current placement uses the selected repository. `pacer clean [--dry-run] [--force] [--json]` removes pacer-owned worktrees and run directories of settled tasks that have been reviewed, dismissed or resolved. Dirty worktrees are kept unless `--force` is given, and branches are always kept.

Orca defaults to a child based on the current branch. A brief or `--worktree` flag can choose `current`, `new` or `auto`, with `--worktree-reason` explaining the choice. Concurrent activity and unsafe placement can prevent in-place execution. Inspect the returned task's placement and reported worktree before review.

The executor contract asks workers to stay in scope, avoid further delegation, avoid commits/pushes and run acceptance. pacer records reports, logs and any acceptance result; provider-limit detection can retry another ranked executor. Review the changes and run acceptance independently before `pacer review <id> --accept` or `--reject`.

```sh
pacer tasks --json
pacer tasks TASK_ID --json
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
remote runner the test task checks the host's login. **Usage readable** is
skipped, with the reason, when a Claude or Codex account has no usage reading yet
(Claude usage comes from the Claude Code status line, Codex usage from its
session logs); routing treats that usage as unknown, so it does not fail the
check. A usage reader error still fails it. The row shows `checking` while
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
