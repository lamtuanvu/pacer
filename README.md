<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/pacer-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/pacer-logo-light.svg">
    <img src=".github/assets/pacer-logo-light.svg" alt="pacer" width="240" height="64">
  </picture>
</p>
<p align="center">Subscription budgets for AI coding agents</p>
<p align="center">
  <a href="https://github.com/lamtuanvu/pacer/actions/workflows/ci.yml"><img src="https://github.com/lamtuanvu/pacer/actions/workflows/ci.yml/badge.svg?branch=main" alt="Build status"></a>
  <a href="https://github.com/lamtuanvu/pacer/stargazers"><img src="https://img.shields.io/github/stars/lamtuanvu/pacer?color=52525B" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-52525B" alt="License Apache-2.0"></a>
  <a href="https://github.com/lamtuanvu/pacer/releases/latest"><img src="https://img.shields.io/github/v/release/lamtuanvu/pacer?color=52525B" alt="Latest GitHub release"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/lamtuanvu/pacer"><img src="https://api.scorecard.dev/projects/github.com/lamtuanvu/pacer/badge" alt="OpenSSF Scorecard"></a>
</p>

Subscription budgets for AI coding agents: route and delegate coding work according to usage, pace and available executors.

A planner can spend its subscription too quickly while other coding agents have unused capacity. pacer compares usage against time until reset, learns your active hours from local session logs, and helps the planner reserve capacity for decisions and review. Claude Code can plan while Codex, Cursor, agy, BytePlus or local models execute; Codex, Cursor and OpenCode can also be planners.

[Roadmap](ROADMAP.md) · [Design system](design/README.md).

## Features

- Budget status, executor ranking and routing by task kind.
- Priority, even, burn-before-reset and cheapest-first pacing policies.
- Delegation, limit-triggered fallback, task tracking and explicit planner review.
- Planner skills and hooks, an optional stdio MCP server, a desktop app and a web app.
- Direct CLI execution or Orca workers, with per-task worktree placement in Orca.
- Rules-based classification, optional model adapters and local decision benchmarks.

## Install

[Download pacer for Mac](https://github.com/lamtuanvu/pacer/releases/latest).
Choose the `darwin-arm64-unsigned.dmg` for Apple silicon or
`darwin-x64-unsigned.dmg` for Intel, then drag pacer into Applications.

The app is not yet signed. On first open, Control-click pacer in Applications and choose Open.

Welcome leads to one consent screen for the background service and the terminal
link at `~/.local/bin/pacer`. If needed, an optional checkbox adds
`export PATH="$HOME/.local/bin:$PATH"` to your `~/.zshrc` or `~/.bashrc`; it is
off by default. Continue to the step-by-step **Setup** to choose your planner,
connect agents, choose an executor and try a task. The app includes its CLI.

`pacer uninstall --all` removes everything setup added, including the terminal
link and the optional PATH block. Move the app to the Trash afterward. See
[installation](docs/install.md) for Linux AppImage and `.deb` downloads, updates
and uninstall details.

### Terminal and servers

Install the standalone CLI:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
```

The installer verifies SHA-256 checksums; verify a downloaded binary's build provenance with `gh attestation verify <file> -R lamtuanvu/pacer`. `PACER_RELEASE_BASE` remains an override for another HTTPS or local `file://` release host. See [installation](docs/install.md) for source builds and installer options.

From a source checkout, use Bun 1.4.2 or newer:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
cp dist/pacer dist/pacer-core "$HOME/.local/bin/"
export PATH="$HOME/.local/bin:$PATH"
pacer --version
```

### macOS desktop app

Desktop releases are signed with the project's own code-signing certificate until pacer has an Apple Developer ID, so macOS blocks the first launch:

1. Download `desktop-pacer-<version>-darwin-<arch>.app.tar.gz` from [GitHub Releases](https://github.com/lamtuanvu/pacer/releases), extract it and move `pacer.app` to `/Applications`.
2. Open the app once. When macOS says it cannot verify the developer, open **System Settings › Privacy & Security** and choose **Open Anyway**.

Alternatively, from a terminal: `xattr -dr com.apple.quarantine /Applications/pacer.app`.

This is needed once. In-app updates are verified against the same pinned certificate and a separate update signature, and install without further prompts.

The future npm package is `@lamtuanvu/pacer`; it is not published yet. The planned Homebrew tap is `lamtuanvu/homebrew-tap`; it has not been created. The command stays `pacer`.

## Quickstart

Install and sign in to your planner and at least one executor CLI first. For
example, use Claude Code as planner and Codex as executor (Codex installation
requires Node.js/npm):

```sh
# Claude Code: install, then sign in
curl -fsSL https://claude.ai/install.sh | bash
claude    # then type /login
# Codex: install, then sign in
npm install -g @openai/codex
codex login
```

See the [Claude Code install guide](https://code.claude.com/docs/en/setup),
[Claude Code login reference](https://code.claude.com/docs/en/cli-reference) and
[Codex CLI guide](https://developers.openai.com/codex/cli) for prerequisites.
In the desktop app, follow **Setup** to connect these tools. For terminal and
server installs, install pacer and run setup:

```sh
curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh
pacer init
```

`pacer init` detects your tools, writes `~/.pacer/strategy.yaml`, asks before installing the
background service and before connecting each agent.
Open your planner in the repository you want to work on and ask it for work —
it delegates execution through pacer. Run `pacer open` to watch budgets and tasks,
and `pacer doctor` to check the installation.

For a shell prompt, tmux or an agent status bar, `pacer status --line` reads the local
snapshot and prints one compact line: `▬┃ Claude 63%·77  ▸2  ⚑1`. The tick turns
amber ahead of pace and red when out of quota. The needs-you flag disappears at
zero; the mode appears only outside normal mode. `--width N` overrides `COLUMNS`
(default 80): at 60 columns the mode drops, at 40 the planner name drops, and at
20 or fewer it becomes `▬┃63 ⚑1`. Content shrinks further if needed to fit.
Use `--no-color` (or `NO_COLOR`) for plain text and `--line --json` for the same
fields as JSON. Plain `status --json` still returns the full budget status.
Offline it prints `pacer not running · pacer serve`; `--line` always exits zero.

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

Pace uses learned active hours, falling back to calendar time until enough history exists. Modes guide installed planner policies; supported hooks can guard planner subagent execution. `PACER=off` disables pacing enforcement for a session (for example,
`PACER=off claude`). To pause new delegation, use `pacer pause <duration>`
(for example, `pacer pause 1h`) or choose **Pause 1h** in the tray menu. Running
tasks continue; `pacer resume` ends the pause early.

## Configuration and executors

`pacer init` creates `~/.pacer/strategy.yaml` from detected tools. Edit providers, pacing and routing there; `PACER_HOME` overrides the state directory. See [configuration](docs/configuration.md) and the [starter strategy](examples/strategy.yaml).

Native executor launchers support Codex (`codex`), Cursor (`cursor-agent`), agy and Claude Code (`claude`). OpenCode runs configured `provider/model` IDs, including BytePlus Coding Plan and local Ollama or LM Studio models. Usage support differs by provider; see [executors](docs/executors.md).

The CLI is the primary agent interface. `pacer install <planner> --mcp` optionally registers `pacer mcp`, exposing budget, routing, delegation, task and review tools over stdio.

## App

With the service running, `pacer open` opens the pacer app in your browser.
Track budgets and pace, delegate and review tasks, manage executors and accounts,
and change strategies, hosts and settings. Until setup is done, the Setup screen
lists each step with one action (install the service, connect your planner, add
an executor) and ends with a guided first delegation you review; provider sign-in
shows the command to run in a terminal.

The app is served locally by the daemon and signs you in through a one-time link.
Use `pacer open sessions` to open a screen, `pacer open --print` to print the sign-in
link, or `pacer open --logout` to sign out all browser sessions. See the
[app guide](docs/app.md) for screens, security and troubleshooting.

## Uninstall

```sh
pacer uninstall --all
```

It lists everything it will remove (agent integrations, restoring their backups;
the login service; a leftover Orca plugin from an earlier pacer; `~/.pacer` or
`PACER_HOME`), asks once, then removes it. Add `--binary` to delete the pacer
binary too, and `--yes` to skip the question in scripts. pacer no longer ships an
Orca plugin; if you installed it earlier, also remove pacer from Orca Settings >
Plugins. To disconnect a single agent, use
`pacer uninstall <agent>`.

## Privacy

pacer sends no telemetry. Its budget and activity readers use these local sources:

- Claude rate-limit caches: `~/.pacer/cache/claude-rate-limits.json` and `~/.claude/state/budget/claude.json` (the newest available file).
- Codex rate limits: tails of recent `~/.codex/sessions/**/rollout-*.jsonl` files.
- Active-hour learning: timestamps extracted from `~/.claude/projects/*/*.jsonl` and Codex rollout logs over the last 28 days. The files themselves are read locally, including their other contents; the activity profile retains hour counts.
- pacer's own strategy, caches, limit/block marks, task records, executor output logs, decision logs, installation manifests and local link/service state under `~/.pacer` (or `PACER_HOME`).

BytePlus usage is read through `arkcli usage plan --product coding-plan`; metered OpenCode usage through `opencode stats --models --json --days 7`. Setup detects installed CLIs and may list local models with `ollama list` or `lms ls --json`. Integration commands inspect and edit planner configuration, skills and hooks, keeping backups. Delegation reads the supplied brief, repository Git state and executor reports; verification runs your acceptance command. Orca integration reads local runtime/worktree state and the bearer token for loopback HTTP.

Executors receive your brief and can access the selected repository under their CLI permissions; their services have their own data policies. Optional `ollama` and `jev` classifier adapters send decision state to their configured endpoints. The default classifier is local rules; external shadow calls require `classifier.shadow_external: true`. Classifier keys may be read from environment variables or `~/.pacer/secrets`. Release install/update commands download from GitHub Releases by default, or from your `PACER_RELEASE_BASE` override. No usage logs are uploaded for analytics.

## Star history

<a href="https://star-history.com/#lamtuanvu/pacer&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=lamtuanvu/pacer&type=Date&theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=lamtuanvu/pacer&type=Date">
    <img alt="Star history chart for lamtuanvu/pacer" src="https://api.star-history.com/svg?repos=lamtuanvu/pacer&type=Date">
  </picture>
</a>

## Community

Read [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), [Support](SUPPORT.md), [Security](SECURITY.md), [Governance](GOVERNANCE.md) and the [Changelog](CHANGELOG.md). GitHub community channels will become available when the public repository launches.

Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE).

pacer is an independent project and is not affiliated with Anthropic, OpenAI, Cursor, BytePlus or Orca. Product names are used only to describe compatibility.
