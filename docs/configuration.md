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
