# Run delegated tasks as Orca workers with pacer's launch policy

Date: 2026-10-28. Status: approved design. Builds on [the backend switch](2026-10-28-backend-switch-design.md).

## Problem

Since #273, choosing `execution.backend: orca` still runs every task directly. `orca orchestration worker-start --agent` lets Orca launch the agent with its own flags, so pacer cannot enforce its unattended-permission policy (`docs/executors.md`). `selectBackend` therefore replaces the Orca backend with `orcaPermissionFallback`, which runs the direct backend. The new Settings/CLI switch has no effect on execution, and its copy is wrong.

## Evidence

A spike against Orca 1.4.241 (2026-10-28) established:

- `orca terminal create --worktree id:<repo>::<path> --command "<argv>"` starts an agent with any flags pacer chooses.
- `orca orchestration worker-start --spec <brief> --terminal <handle> --worktree id:<repo>::<path> --run <run> --from <coordinator>` attaches a supervised worker to that terminal. Orca types its worker preamble plus the spec into the agent as a new turn. `worker-show`, `worker-read --source auto` and `worker_done` delivery through `orchestration check` work as for `--agent` workers.
- `worker-start` must wait until the agent is idle: `orca terminal wait --terminal <h> --for tui-idle`. Passing the prompt in argv instead starts work before the preamble arrives, so it is not used.
- `--model`/`--effort` cannot be combined with `--terminal`; the model goes in the agent argv.
- The terminal is classified `external`: `worker-release`/`worker-stop` take no process action. pacer must close the exact terminal it created.
- `claude --dangerously-skip-permissions` does not skip Claude's per-folder workspace trust prompt; Orca reports `blockedReason: "agent-trust-workspace"`.

## Design

### 1. Backend selection (`src/exec/backend.ts`)

- Remove `orcaPermissionFallback`. When the effective backend is `orca` (strategy or `PACER_BACKEND=orca`) and Orca is available, `selectBackend` returns the real `orcaBackend`.
- Cases that stay direct, each logged in the attempt log as today: interactive runners; accounts with a `connection` (credentials must not appear in a visible Orca terminal command); agents without a supported terminal launch (see 3); tasks that allow delegation (their `PACER_WORK_GRANT` is a secret and must not appear in a visible Orca terminal command), which fall back before any Orca call. Managed (`pacer`/`orca` source) Claude and Codex accounts are supported: their config-folder environment variables are placed in the terminal command, which contains paths only, never keys.

### 2. Orca attempt (`src/exec/orca/backend.ts`, `client.ts`)

Since SP10 (plugin protocol 1.10.0), the bundled `pacer-exec-orca` provider sequences this attempt and the host performs each step as a task-owned `capability.orca.*` effect: `src/plugins/orca-attempt.ts` and `src/plugins/orca-host.ts` hold the steps below, and `src/plugins/executor-orca.ts` keeps the route, fallback and closure authority (ADR 0018).

`runOrcaAttempt` keeps its existing structure (prepare, admission, supervision via `waitForWorker`, fingerprinting, reports, fallback rules) with these changes:

1. **Placement.** For `new-child`, create the worktree first with `orca worktree create --name pacer-<task>-<executor> --repo id:<repoId> --base-branch <base> --setup skip --json` and read its worktree id. `existing` placement resolves the worktree id with `orca worktree show --worktree path:<realpath> --json`. Both yield the `id:<repo>::<path>` selector used below.
2. **Trust.** Claude terminals carry `CLAUDE_CODE_SANDBOXED=1` (section 4); no configuration file is edited.
3. **Agent terminal.** `orca terminal create --worktree <selector> --title "pacer <task-id>" --command "<cmd>" --json`, where `<cmd>` is `env PACER_ROLE=executor PACER_TASK_ID=<id> [account env] <interactive argv without prompt>` built from a new `launchArgvFor(cfg, worktree, runDir, trustRoot)` in `src/exec/launch.ts` that shares flags with the existing interactive launcher (Claude: `claude --dangerously-skip-permissions [--model m]`; Codex: `codex --no-daemon -c <trust> -C <worktree> --dangerously-bypass-approvals-and-sandbox --add-dir <runDir> [-m m]`). Arguments are shell-quoted with the existing `shq`. Record the handle with the work admission immediately.
4. **Ready.** `orca terminal wait --terminal <h> --for tui-idle --timeout-ms 60000 --json`. If not satisfied (including `agent-trust-workspace`), close the terminal and fall back to direct with the reason logged (no worker exists yet, so this cannot duplicate work).
5. **Start.** `worker-start --spec <spec> --terminal <h> --worktree <selector> --run <run> --from <coordinator>` (no `--agent`/`--model`). `workerSpec` no longer rewrites the `pacer ask` line, because the identity variables are in the terminal environment. Existing uncertain-start handling is unchanged.
6. **Cleanup.** After settlement, timeout or stop: existing `worker-release`/`worker-stop` calls, then always `orca terminal close --terminal <h>` for the handle pacer created. The current "close orphaned agent terminal" check becomes unconditional for pacer-created terminals. In a worktree pacer itself created (new-child), pacer also closes Orca's own initial shell terminal: it lists `orca terminal list --worktree id:<id>` after the create, before the agent terminal exists, and closes only rows in that worktree, each with a receipt naming the handle with `ptyKilled`. Terminals that appear after the agent terminal may be the user's and are never closed; a late Orca shell ends when `pacer clean` removes the worktree. That shell is not pacer work, so the session work lease is never bound to it. Pacer never closes terminals in any other worktree, nor in an existing or retry placement. If the listing fails or is truncated, pacer records the worktree, and `pacer clean` later closes the remaining non-agent terminals of that pacer-owned worktree after verifying ownership.

### 3. Supported agents

Claude Code and Codex use the terminal launch. Other agents (Cursor, Antigravity, OpenCode) fall back to direct with a logged reason until their trust and idle behavior is verified; extending the table is a follow-up.

### 4. Claude workspace trust

Decision (2026-10-28, revised after review and live validation): pacer does not edit Claude configuration files. The Claude terminal command sets `CLAUDE_CODE_SANDBOXED=1`, which Claude Code (2.1.x) treats as an already-isolated environment: the folder-trust check returns trusted without writing `~/.claude.json`.

- The variable is undocumented. `--dangerously-skip-permissions` officially does not skip the trust prompt (anthropics/claude-code#28506, #36342), and the documented `-p` route cannot host an Orca worker. Editing `projects[path].hasTrustDialogAccepted` was rejected because Claude rewrites `~/.claude.json` concurrently and no shared lock exists.
- Side effect: Claude also applies the repository's own `.claude/` permission grants, runs its project hooks and starts the MCP servers in its `.mcp.json` without its approval prompt. This matches direct execution, where `claude -p` already skips the trust prompt. The agent already runs with `--dangerously-skip-permissions`, so the added exposure is small; it is documented for users in `docs/executors.md`.
- Failure is safe: if a Claude release ignores the variable, the idle wait reports `agent-trust-workspace`, pacer closes its terminal and falls back to direct (section 2 step 4).
- Codex is unchanged: its trust stays in the `-c projects=...` argument.

### 5. Switch follow-ups (review of 18f240b1)

- Copy (web, TUI, docs; revised 2026-10-29 for headless tasks, section 6): "Orca runs interactive tasks as supervised workers in Orca terminals. Headless tasks, and any task when Orca isn't running or the agent isn't supported, run directly." Warning text stays "Orca isn't running; tasks run directly until it is."
- TUI shows `config.set` warnings in warn tone (`src/dashboard/controller.ts`).
- `config.get` reports `source: "env PACER_BACKEND"` for `execution.backend` when the service environment overrides it; the warning is not shown in that case.
- Release the edit lock before the readiness probe, and cap the probe at 3 s.
- Regenerate Rust protocol types (`cargo xtask gen`).
- Docs: `docs/cli.md` config key table, `docs/configuration.md` and `docs/executors.md` (replace the "Orca uses direct execution" text), CHANGELOG `[Unreleased]`.

### 6. Interaction with the interactive default launch (#439)

Decision (2026-10-29, after main adopted interactive-by-default launches, [ADR](../decisions/2026-10-28-interactive-default-launch.md)): Orca hosts interactive runs.

- Backend selection resolves the launch mode exactly as the attempt does (`launchModeFor`, including strict enforcement's headless rule). When the effective backend is `orca` and the resolved mode is **interactive**, the task runs in an Orca terminal as described above. When the resolved mode is **headless** (explicit `execution.launch_mode: headless`, a runner `session: headless`, the documented headless fallbacks, or strict managed work), the task runs direct.
- The Orca terminal command reuses the direct interactive launch for the same runner and worktree: the same argv, per-run `--settings` file (bypass-permissions acknowledgement, project MCP approval with the source checkout's rejected servers kept off, under the ADR's task-worktree conditions extended to pacer-created Orca worktrees below), and the login-shell environment rules for account folders. Only values that are paths or flags appear in the visible command; the per-run settings file is written under the task's run directory and referenced by path.
- Project MCP answers (decision 2026-10-29): the ADR's read-only carry-over applies to Orca worktrees pacer created for the task, that is new-child placements named `pacer-<task>-<executor>` whose identity pacer verified after `orca worktree create` (repository id, name, not the repository itself). For an unattended Claude run there, pacer reads only `disabledMcpjsonServers` and `enabledMcpjsonServers` from the source checkout's `.claude/settings.local.json` and the source repository's entries in the `.claude.json` of the account the terminal uses, and writes them with `enableAllProjectMcpServers` into the run's `--settings` file, so a rejected server stays off. If either file exists but cannot be read or parsed, nothing is approved and the attempt log says Claude's MCP prompt may appear. Existing and retry placements keep Claude's MCP prompt, and pacer reads no MCP answers for them. The SEC-1 exception row names these worktrees within the same limits.
- Claude folder trust in Orca terminals stays with `CLAUDE_CODE_SANDBOXED=1` (section 4). Pacer never writes `.claude.json` for Orca worktrees; the ADR's folder-trust grant covers only worktrees under `~/.pacer/worktrees`.
- Interactive-only behaviour that relies on pacer's own PTY (takeover, resume, `pacer report` completion) is replaced on Orca by Orca's terminal and the worker's `worker_done`; the user watches and takes over in Orca.

## Error handling

- Every failure before `worker-start` succeeds closes any terminal pacer created and falls back to direct (logged once per hour as today). After `worker-start`, existing uncertain-start and supervision rules apply; no direct fallback.
- Terminal close failures are logged and retried during cleanup; a terminal pacer cannot close is reported in the task log with its handle.
- A terminal Orca shows disconnected needs no further close. When it was killed because pacer removed its worktree (pacer records each removal), that removal and the disconnected terminal are positive evidence its work ended, and cleanup releases the work lease bound to it.
- A settled worker found after an uncertain start is attached to its task, and the task's review, dismissal and resolution are cleared so the task needs review again before `pacer clean` can remove the worktree.

## Testing

- Unit tests with a fake `ctx.run` for: terminal command construction and quoting per agent and account; new-child and existing placement; idle wait success, timeout and trust block (terminal closed, direct fallback); worker-start argument shape with `--terminal`; cleanup always closes exactly the created handle; `selectBackend` returns the Orca backend for `orca` + ready, direct otherwise, and direct for connection accounts and unsupported agents.
- Claude terminal command contains `CLAUDE_CODE_SANDBOXED=1`; Codex command does not; no code path writes Claude configuration.
- Live validation (CT-11): the sandbox forces `PACER_BACKEND=direct` and refuses `orca`, so the Orca path is validated with the user's authorization against the real Orca in a disposable repository, one Claude task and one Codex task (if Codex budget allows), recording the worker lifecycle, absence of a trust prompt, an unchanged `~/.claude.json` trust state for the worktree, and terminal and worktree cleanup. Surfaces not exercised are reported UNVERIFIED.

## Out of scope

- Remote (SSH) hosts and remote Orca servers.
- Agents other than Claude Code and Codex in Orca terminals.
- Deleting Orca run metadata (Orca has no selective delete).
