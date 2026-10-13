# pacer

Subscription budgets for AI coding agents: route and delegate coding work according to usage, pace and available executors.

A planner can spend its subscription too quickly while other coding agents have unused capacity. pacer compares usage against time until reset, learns your active hours from local session logs, and helps the planner reserve capacity for decisions and review. Claude Code can plan while Codex, Cursor, agy, BytePlus or local models execute; Codex, Cursor and OpenCode can also be planners.

## Features

- Budget status, executor ranking and routing by task kind.
- Priority, even, burn-before-reset and cheapest-first pacing policies.
- Delegation, limit-triggered fallback, task tracking and explicit planner review.
- Planner skills and hooks, an optional stdio MCP server, and an Orca budget panel.
- Direct CLI execution or Orca workers, with per-task worktree placement in Orca.
- Rules-based classification, optional model adapters and local decision benchmarks.

## Install

Install the latest binary from [GitHub Releases](https://github.com/lamtuanvu/pacer/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
```

This works once the repository is public and its first release exists. The installer verifies SHA-256 checksums; verify a downloaded binary's build provenance with `gh attestation verify <file> -R lamtuanvu/pacer`. `PACER_RELEASE_BASE` remains an override for another HTTPS or local `file://` release host. See [installation](docs/install.md) for source builds and installer options.

From a source checkout, use Bun 1.4.2 or newer:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
cp dist/pacer "$HOME/.local/bin/pacer"
export PATH="$HOME/.local/bin:$PATH"
pacer --version
```

The future npm package is `@lamtuanvu/pacer`; it is not published yet. The planned Homebrew tap is `lamtuanvu/homebrew-tap`; it has not been created. The command stays `pacer`.

## Quickstart

Install and authenticate your planner and at least one executor CLI first. For a Claude Code planner:

```sh
pacer init --planner claude-code
pacer install claude-code
pacer doctor
pacer status --json
pacer route docs --json
```

Run delegation in the repository you want the executor to edit. Supply a concrete scope and verification command:

```sh
pacer delegate --goal "Improve the setup instructions" \
  --kind docs --scope README.md --acceptance "test -s README.md" --json
```

Use the returned `id` in the next commands, replacing `TASK_ID`:

```sh
pacer wait TASK_ID --json
pacer tasks TASK_ID --json
# Review the diff in the reported worktree and run acceptance yourself.
pacer review TASK_ID --accept --json
```

Use `--reject` if the result does not satisfy the brief. For structured briefs, use `pacer delegate --brief-file brief.json --json` or pipe JSON to `--brief-file -`. [CLI and brief reference](docs/cli.md).

## How it works

The planner owns planning, decisions and review. `route` ranks configured, installed executors using usage readings and your strategy. `delegate` starts an executor, records its result and runs any supplied acceptance command. Provider limits can trigger fallback to another executor. The planner checks the diff and acceptance result before recording `review`; settlement alone is not acceptance.

| Mode | Planner policy |
| --- | --- |
| relaxed | Execute directly or delegate when useful; budget is behind pace or expiring. |
| normal | Delegate substantial execution; budget is on pace or unknown. |
| strict | Delegate execution and preserve capacity for decisions and review; budget is ahead of pace or near a limit. |
| emergency | Delegate execution; the planner's reserved budget is exhausted. |

Pace uses learned active hours, falling back to calendar time until enough history exists. Modes guide installed planner policies; supported hooks can guard planner subagent execution. `PACER=off` disables pacing enforcement for a session.

## Configuration and executors

`pacer init` creates `~/.pacer/strategy.yaml` from detected tools. Edit providers, pacing and routing there; `PACER_HOME` overrides the state directory. See [configuration](docs/configuration.md) and the [starter strategy](examples/strategy.yaml).

Native executor launchers support Codex (`codex`), Cursor (`cursor-agent`), agy and Claude Code (`claude`). OpenCode runs configured `provider/model` IDs, including BytePlus Coding Plan and local Ollama or LM Studio models. Usage support differs by provider; see [executors](docs/executors.md).

The CLI is the primary agent interface. `pacer install <planner> --mcp` optionally registers `pacer mcp`, exposing budget, routing, delegation, task and review tools over stdio.

## Orca plugin

```sh
pacer plugin install
pacer serve
```

Add the managed development directory printed by the installer to Orca Settings > Plugins and enable its declared capabilities. The plugin targets Orca >=1.4.224 and shows a budget snapshot, task cards and notifications. It can open a pacer console in the focused worktree when the HTTP service is running. Run `pacer console` manually when needed. See the [plugin guide](orca-plugin/README.md); reopen the panel to refresh its snapshot.

## Privacy

pacer sends no telemetry. Its budget and activity readers use these local sources:

- Claude rate-limit caches: `~/.pacer/cache/claude-rate-limits.json` and `~/.claude/state/budget/claude.json` (the newest available file).
- Codex rate limits: tails of recent `~/.codex/sessions/**/rollout-*.jsonl` files.
- Active-hour learning: timestamps extracted from `~/.claude/projects/*/*.jsonl` and Codex rollout logs over the last 28 days. The files themselves are read locally, including their other contents; the activity profile retains hour counts.
- pacer's own strategy, caches, limit/block marks, task records, executor output logs, decision logs, installation manifests and local link/service state under `~/.pacer` (or `PACER_HOME`).

BytePlus usage is read through `arkcli usage plan --product coding-plan`; metered OpenCode usage through `opencode stats --models --json --days 7`. Setup detects installed CLIs and may list local models with `ollama list` or `lms ls --json`. Integration commands inspect and edit planner configuration, skills and hooks, keeping backups. Delegation reads the supplied brief, repository Git state and executor reports; verification runs your acceptance command. Orca integration reads local runtime/worktree state and the bearer token for loopback HTTP.

Executors receive your brief and can access the selected repository under their CLI permissions; their services have their own data policies. Optional `ollama` and `jev` classifier adapters send decision state to their configured endpoints. The default classifier is local rules; external shadow calls require `classifier.shadow_external: true`. Classifier keys may be read from environment variables or `~/.pacer/secrets`. Release install/update commands download from GitHub Releases by default, or from your `PACER_RELEASE_BASE` override. No usage logs are uploaded for analytics.

## Community

Read [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), [Support](SUPPORT.md), [Security](SECURITY.md), [Governance](GOVERNANCE.md) and the [Changelog](CHANGELOG.md). GitHub community channels will become available when the public repository launches.

Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE).

pacer is an independent project and is not affiliated with Anthropic, OpenAI, Cursor, BytePlus or Orca. Product names are used only to describe compatibility.
