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

These model IDs are examples; configure a model available in your OpenCode setup. Ollama models likewise use `ollama/<model>`. `pacer init` can discover local models with `ollama list` and `lms ls --json` when those CLIs and OpenCode are installed. A metered provider needs a `budget.weekly_tokens` value and reads seven-day token totals through OpenCode.

Claude usage requires the status-line integration to have received rate-limit data. Missing/stale readings are surfaced as unknown rather than invented quota values. BytePlus readings are cached for 10 minutes; OpenCode metered stats for 5 minutes, with stale fallback when a query fails.

## Execution and review

`auto` execution tries Orca when its runtime is reachable and falls back to direct CLI execution. Orca maps supported agents into supervised workers and honors placement policy, including agy through its antigravity agent. OpenCode-routed providers require `execution.worktree: current` for Orca model selection; other placement policies fall back to direct execution under `auto`. Direct execution edits the selected repository in place and cannot provide Orca worktree isolation.

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
