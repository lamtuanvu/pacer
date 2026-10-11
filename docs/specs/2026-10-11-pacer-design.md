# pacer: design spec

- **Date:** 2026-10-11
- **Status:** Draft for review
- **Owner:** 3332603+lamtuanvu@users.noreply.github.com

## 1. Purpose

The user pays for several flat AI subscriptions, each with usage windows: Claude Max 20x, ChatGPT Pro (Codex), Cursor, the BytePlus Coding Plan, OpenCode Go, and local Ollama. Quota that isn't used before a reset is lost, and the limits that bite in practice are **weekly** (BytePlus also has 5-hour and monthly windows).

**pacer** is a self-contained tool, installed on any machine, that:

1. Knows how much of each subscription's window has been used, and how much *should* have been used by now (its **pace**).
2. Lets one tool act as the **planner** (Claude Code, Codex, Cursor or OpenCode), keeping that tool's quota for planning, decisions and review.
3. Sends execution work to **executors** chosen by a configurable **strategy**, so all quotas get used up without running out early.
4. Integrates with all four planners and uses **Orca** to run executors when it's available.

### Success criteria

- On a configured machine, a planner session automatically receives budget status and delegation policy. No re-explaining.
- Execution tasks go to non-planner executors. Planner-model subagents are blocked unless policy allows them.
- At each weekly reset, each executor subscription has used most of its quota, and the planner has not run out early.
- Paid overflow (for example Codex credits) is never spent when `allow_paid: false`.
- Installing on a new machine: copy one binary, run `pacer init` and `pacer install <planner>`.

### Non-goals (v1)

- Syncing state across machines. Each machine is standalone, by the user's choice.
- Proxying model API traffic (a LiteLLM-style gateway). Each tool keeps its native authentication and harness.
- Committing, pushing or merging. The planner owns integration.

## 2. Background: what exists today (to migrate)

A working Claude-only version of this lives in `~/.claude/`:

- `scripts/budget/budget_status.py`: pacing report, with sources:
  - Claude: status-line `rate_limits` cached to `state/budget/claude.json`
  - Codex: the last `rate_limits` event in `~/.codex/sessions/**/rollout-*.jsonl`. Weekly window; `resets_at` drifts, so it is read live.
  - BytePlus: `arkcli usage plan --product coding-plan` (5h, weekly, monthly), cached 10 minutes.
- `statusline.sh` lines 4–5, a `SessionStart` hook, `rules/model-delegation.md`.
- `agents/delegation/{codex,byteplus}-executor.md`: Haiku relay subagents that run `codex exec` or `opencode run`.
- `scripts/budget/subagent_guard.py`: a `PreToolUse` hook that blocks Claude-model subagents for execution.

Facts learned while building it:
- BytePlus Lite rejects the `ark-code-latest` model; `coding-plan/dola-seed-2.0-code` works.
- At 100% of its plan, Codex silently spends paid credits.
- A rule alone does not stop a planner delegating to its own cheaper models; a hook is needed.

pacer replaces all of this. `pacer install claude-code` migrates it.

## 3. Architecture

```
            planners (Claude Code / Codex / Cursor / OpenCode)
                 │  MCP (stdio) · CLI · hooks · status line
                 ▼
┌──────────────────────── pacer (single Bun binary) ─────────────────────────┐
│  Surfaces: MCP server · CLI · local HTTP endpoint · installers             │
│        │                                                                   │
│  Strategy engine ◄── Pace clock (learned activity)                         │
│        │      ▲                                                            │
│        │      └── Usage sources (quota · metered · reactive · unmetered)   │
│        ▼                     ▲                                             │
│  Execution backends ─────────┴── Provider adapters                         │
│   (Orca workers | direct CLI)                                              │
│  Local state: ~/.pacer/                                                    │
└────────────────────────────────────────────────────────────────────────────┘
                 │ phase 2
                 ▼
       Orca plugin (commands, events, panel) ◄── link transports
```

Each unit has a single purpose and a typed interface, and can be tested on its own.

### 3.1 Provider adapters

```ts
interface Provider {
  id: string                         // "claude-code", "codex", "byteplus", ...
  kind: "native" | "opencode"
  usage(): Promise<UsageReading>     // delegates to its usage source
  available(): Promise<Availability> // CLI present, logged in, not exhausted
  launch: LaunchSpec                 // how a backend starts it: agent id, model, CLI argv
}
```

- **Native:** `claude-code`, `codex`, `cursor`.
- **OpenCode-routed:** one generic adapter, instantiated per configured entry (`byteplus`, `opencode-go`, `ollama`, or any other OpenCode provider/model). Adding a provider is config, not code.

### 3.2 Usage sources

Every provider declares one source. Each reading has the shape `{windows: [{name, usedPct, resetsAt?, lengthS}], capturedAt, stale}`.

| Source | Meaning | v1 implementations |
|---|---|---|
| `quota` | Real used % and reset time | Claude (status-line cache file), Codex (rollout `rate_limits`), BytePlus (`arkcli usage plan`) |
| `metered` | Tokens consumed vs. a user-set budget per window | OpenCode-routed providers (`opencode stats --models --json`) |
| `reactive` | No data: assumed available until a limit error is seen, then exhausted until reset or cooldown | Cursor |
| `unmetered` | Always available, never paced | Ollama (local) |

Rules:
- A `resetsAt` in the past means the window rolled over (drift or early reset): used = 0 until the next reading.
- Readings are cached per source with a TTL. When a fetch fails, the last good reading is used, flagged `stale`. Past a staleness limit the status becomes `unknown`.

### 3.3 Pace clock

**Pace** is the share of a window that *should* be used by now: the fraction of the window's **active time** that has elapsed.

- The clock learns an **activity profile**: an hour-of-week histogram (168 bins) built from timestamps in local agent session logs (Claude, Codex, OpenCode and Cursor transcripts). It's recomputed daily and stored in `~/.pacer/activity.json`.
- An hour counts as active if its bin is at least a threshold share of the busiest bin (default 20%).
- **Fallback:** plain calendar time until there are 7 or more days of history.
- `pace(windowStart, windowEnd, now) = activeSeconds(start, now) / activeSeconds(start, end)`.

### 3.4 Strategy engine

The input is `~/.pacer/strategy.yaml`. Named strategies live in `~/.pacer/strategies/*.yaml`, and `pacer use <name>` switches between them.

```yaml
planner: claude-code              # claude-code | codex | cursor | opencode

providers:
  claude-code: { usage: quota }
  codex:       { usage: quota, allow_paid: false }
  cursor:      { usage: reactive, cooldown: 6h }
  byteplus:    { via: opencode, model: coding-plan/dola-seed-2.0-code, usage: quota, quota_source: arkcli }
  opencode-go: { via: opencode, model: opencode-go/kimi-k2, usage: metered, budget: { weekly_tokens: 20M } }  # example model id; `pacer init` fills in real ones
  ollama:      { via: opencode, model: ollama/qwen3.6-35b-a3b, usage: unmetered }

pacing:
  policy: even                     # even | burn-before-reset | cheapest-first
  planner_reserve: 15              # % of the planner's window held back for the end of the window
  ahead_threshold: 10              # used - pace (points) above this = AHEAD
  behind_threshold: -10

routing:
  - kinds: [boilerplate, tests, docs, rename, migration]
    executors: [byteplus, opencode-go, ollama]
  - kinds: [debug, refactor, performance, unfamiliar-code]
    executors: [codex, cursor, byteplus]
  - default: [byteplus, codex, opencode-go, cursor, ollama]
```

**Verdict per window:**

| Verdict | When |
|---|---|
| `EXHAUSTED` | used ≥ 97% |
| `NEAR_LIMIT` | unpaced window (e.g. BytePlus 5h) at used ≥ 90% |
| `UNKNOWN` | no reading, or stale past the limit |
| `EXPIRING` | 9 or fewer active hours left and 25% or more unused |
| `AHEAD` | used − pace > ahead_threshold |
| `BEHIND` | used − pace < behind_threshold |
| `ON_PACE` | otherwise |

A provider's verdict is its most constraining window.

**Planner mode** comes from the planner's verdict after subtracting `planner_reserve` from its available share:

| Planner verdict | Mode |
|---|---|
| `EXHAUSTED` | `emergency` |
| `AHEAD`, `NEAR_LIMIT` | `strict` |
| `ON_PACE`, `UNKNOWN` | `normal` |
| `BEHIND`, `EXPIRING` | `relaxed` |

**Executor ranking** for a task of a given `kind`:
1. Take the matching routing list, or `default`.
2. Drop providers that are exhausted, not installed, or `allow_paid: false` and over quota.
3. Order by policy:
   - `even`: largest (pace − used) first.
   - `burn-before-reset`: largest unused share weighted by time until reset first.
   - `cheapest-first`: unmetered → flat subscriptions → metered, ignoring pace.
4. `EXPIRING` providers get a priority boost under `even` and `burn-before-reset`.

**Kinds** are a fixed enum: `boilerplate`, `tests`, `docs`, `rename`, `migration`, `feature`, `debug`, `refactor`, `performance`, `unfamiliar-code`, `research`. A missing or unknown kind uses `default`.

### 3.5 Execution backends

```ts
interface Backend {
  start(task: TaskBrief, exec: ProviderLaunch): Promise<TaskHandle>
  status(h: TaskHandle): Promise<TaskState>
  result(h: TaskHandle): Promise<TaskResult>
  stop(h: TaskHandle): Promise<void>
}
type TaskResult = {
  status: "done" | "partial" | "failed" | "limit"
  executor: string; model?: string
  files: string            // git diff --stat
  acceptance?: { cmd: string; passed: boolean; tail: string }
  report: string           // the executor's final summary, trimmed
  worktree?: string; log: string
}
```

- **Orca backend** (default when `orca status` is reachable): `orca orchestration worker-start --agent <claude|codex|cursor|opencode> --model <id> --spec <brief> --worktree new-child`, then `worker-show` / `worker-read` until settled. Each task runs in its own worktree, which makes parallel delegation safe.
- **Direct backend** (fallback):
  - `codex exec -C <repo> -s workspace-write --skip-git-repo-check -o <file> -`
  - `opencode run --agent build -m <model> --auto`. `--agent build` must always be explicit, so a user-configured primary agent can't route work to another paid provider.
  - `cursor-agent -p --output-format json --workspace <repo>`
  - `claude -p` (only when Claude is an executor under a non-Claude planner)
- Every brief gets the **executor contract** appended: stay in scope, don't re-plan, don't commit or push, run the acceptance check, end with a short report.
- **After the run:** `git diff --stat`, plus the acceptance command if one was given, run by pacer itself.
- **Limit detection:** provider-specific patterns in the exit output (for example BytePlus `does not support the coding plan`, quota or 429 messages, Codex `rate_limit_reached_type`). A match marks the provider exhausted and returns status `limit`. `delegate` then retries with the next-ranked executor (at most 2 retries; each logged).

### 3.6 Surfaces

**MCP server** (`pacer mcp`, stdio):

| Tool | Description |
|---|---|
| `budget_status()` | All providers, verdicts, planner mode, ranked executors |
| `route(kind)` | Ranked executors for a kind, with reasons, without running anything |
| `delegate(brief, kind, executor?)` | Starts a task; returns `task_id` immediately |
| `task_status(task_id)` / `task_wait(task_id, timeout_s)` | Poll, or block until done; returns a `TaskResult` |
| `task_stop(task_id)` | Stops a running task |
| `report_limit(provider, until?)` | The planner reports a limit it observed itself |

`brief` is structured: `{goal, repo, scope, acceptance?, constraints?, context?}`.

**CLI:** `pacer status [--line|--json|--hook <planner>]`, `route`, `delegate`, `tasks`, `use <strategy>`, `init`, `install|uninstall <planner>`, `doctor`, `console`, `mcp`, `serve`, `update`.

**Local HTTP endpoint** (`pacer serve`, `127.0.0.1` only, bearer token in `~/.pacer/token`): `GET /state` and `GET /events` (server-sent events), carrying the same JSON as the MCP tools. In v1 it only serves the phase-2 plugin and the status line.

### 3.7 Planner integration (`pacer install <planner>`)

| Piece | Claude Code | Codex | Cursor | OpenCode |
|---|---|---|---|---|
| MCP server | `claude mcp add pacer` (user scope) | `~/.codex/config.toml` | `~/.cursor/mcp.json` | `opencode.json` `mcp` |
| Policy text | `~/.claude/rules/pacer.md` | marked section in `~/.codex/AGENTS.md` | Cursor user rule file | marked section in `AGENTS.md` / agent prompt |
| Budget at session start | `SessionStart` hook → `pacer status --hook claude-code` | Codex `hooks.json`, if it supports session start; otherwise the policy says to call `budget_status` first | the policy says to call `budget_status` first | plugin, or the same policy instruction |
| Guard | `PreToolUse` on `Agent\|Task` (generalized `subagent_guard`) | a `hooks.json` pre-tool hook if blocking is supported; otherwise policy only | policy only | permission config if possible; otherwise policy only |
| Status line | `pacer status --line` added to the existing status line | where supported | none | none |

**Policy text contents:** the role ("plan, decide, review; delegate execution"), the modes, the brief format, "Claude- or planner-model subagents count as the planner doing the work", "verify before reporting done", and the escape hatch `PACER=off` (the successor to `DELEGATION=off`).

**Guard behavior:**
- **Allowed:** pacer executors, read-only helpers (`Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) and reviewers (`*reviewer*`, `*analyzer*`, `pr-review-toolkit:*`).
- **Blocked:** everything else, with a reason naming the top-ranked executor.
- **Lifted when:** the mode is `relaxed`, no executor is available, or `PACER=off`.
- **Fail-open:** any internal error allows the call.

**Installer rules:**
- Back up every file before editing (`<file>.pacer-bak-<ts>`).
- Edit only inside marked blocks or keys pacer owns.
- Safe to re-run.
- `pacer uninstall <planner>` restores the backups or removes pacer's blocks.
- `install claude-code` detects and migrates the hand-built `~/.claude` setup (section 2).

### 3.8 Local state (`~/.pacer/`)

`strategy.yaml`, `strategies/`, `cache/` (usage readings), `activity.json`, `tasks/` (one JSON per task plus logs), `exhausted.json` (reactive or limit marks with expiry), `token`, `install-manifest.json` (what each installer changed, for uninstall).

## 4. Failure handling

| Failure | Behavior |
|---|---|
| Usage source fails | Last good reading, flagged `stale`; `unknown` past the limit; that provider drops one rank but stays usable |
| Executor hits a limit | Mark exhausted until reset or cooldown, retry the next executor (at most 2), log it |
| Executor fails the task | Return `failed`/`partial` with the report; the planner decides whether to retry, narrow the brief or escalate. No silent re-runs |
| Orca unreachable | Direct backend; the result notes `backend: direct` |
| Paid overflow | Providers with `allow_paid: false` are skipped once exhausted |
| Hook or guard internal error | Allow (fail-open). Hooks never wedge a session |
| MCP call slow | Per-call timeout; `delegate` is asynchronous, so long tasks never block the MCP transport |

## 5. Testing

- **Unit tests** (`bun test`): pace clock (histogram, threshold, calendar fallback); each usage parser against recorded fixtures (Claude status-line JSON, Codex rollout lines, `arkcli usage plan` output, `opencode stats --json`); verdicts and modes; all three policies; routing by kind; limit-pattern detection; strategy validation.
- **Integration tests:** `delegate` end to end in a scratch git repo with a **fake executor** (scripted CLI); the Orca backend against a fake `orca` binary; real executors behind `PACER_E2E=1`.
- **Installer tests:** install, re-install, then uninstall into a temporary `HOME` for each planner; files must be restored byte for byte, and installs must be idempotent.
- **`pacer doctor`:** checks provider CLIs, logins, usage sources, Orca reachability and installer state, with actionable messages.

## 6. Deployment

- `bun build --compile` targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.
- GitHub Releases, plus `install.sh` (detects the OS and CPU, downloads to `~/.local/bin/pacer`, verifies the checksum).
- `pacer init`: detects the installed provider CLIs (`claude`, `codex`, `cursor-agent`, `opencode`, `arkcli`, `ollama`, `orca`) and writes a starter `strategy.yaml` with only what's present.
- `pacer update`: replaces the binary; state is kept.

## 7. Phase 2: Orca plugin and brain link

### 7.1 Plugin

An Orca plugin (`orca-plugin.json`, `pluginApi: 1`) contributing:
- **Agent profiles:** pacer executors (for example "BytePlus executor", "Ollama executor") in Orca's launcher.
- **Commands:** Delegate, Switch strategy, Refresh status, Open pacer console.
- **Event subscriptions:** `agent.status.changed` (a worker finished → tell the brain to refresh and verify) and `worktree.created`.
- **A panel:** budget view (needs brain → plugin data; see 7.2).

Capabilities: `workspace:read`, `terminal:send`, `notifications:show`, `events:subscribe`, `storage`, `settings:own`. Orca plugin API v1 offers no filesystem, process or network access.

### 7.2 Link

**Envelope** (identical on every transport): `{ "v": 1, "type": "budget" | "task" | "mode" | "alert", "data": {…} }`.

**Plugin → brain:** `terminal.sendText` into a terminal running `pacer console`. This always works.

**Brain → plugin:** three transports, chosen by run-time detection in priority order:

| # | Transport | Requires | Plugin-side detection |
|---|---|---|---|
| 1 | HTTP: the plugin polls `GET /state` and subscribes to `GET /events` on `pacer serve` | Orca shipping a network capability (manifest change + plugin release) | the capability is granted |
| 2 | Orca channel: the brain runs `orca plugin send pacer <json>` and the plugin receives an event | the upstream feature (7.3) | the event name is in the host's event list |
| 3 | Unofficial bridge: chosen by a spike between **(a)** agent-status piggyback (pacer reports a status whose `state` is at most 256 characters and carries a compact summary) and **(b)** writing to Orca's on-disk plugin storage, which the plugin polls | nothing (works today) | a bridge probe message is received within N seconds |

- **The brain** publishes each message to every transport it can reach.
- **The plugin** uses the best transport detected, and a setting can force one.
- **Switching transports never changes plugin UI logic or brain logic.** Moving to transport 1 needs a one-line manifest change and a plugin release, because Orca rejects unknown capabilities. Transport 2 is auto-detected.

### 7.3 Upstream proposal

Draft an issue for `stablyai/orca` proposing a sandbox-safe CLI → plugin message channel, with pacer as the motivating use case. It goes in `docs/upstream/orca-plugin-channel.md` for the user to review. The user decides whether to post it.

## 8. Scope summary

**v1:** sections 3–6. Core, all four planner installers, the Orca and direct backends, migration of the existing `~/.claude` setup.

**Phase 2:** section 7. The plugin, link transports, the bridge spike, and the upstream proposal draft.

## 9. Open questions (to resolve during planning)

- Whether Codex `hooks.json` supports a blocking pre-tool hook and a session-start hook (this decides guard vs. policy-only for Codex).
- Cursor rule-file location and format for user-level rules.
- Whether OpenCode Go's quota is visible anywhere; until confirmed, it stays `metered`.
- Default activity threshold (20%), to be tuned after a week of real data.
