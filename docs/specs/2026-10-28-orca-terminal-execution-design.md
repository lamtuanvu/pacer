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
- Cases that stay direct, each logged in the attempt log as today: interactive runners; accounts with a `connection` (credentials must not appear in a visible Orca terminal command); agents without a supported terminal launch (see 3). Managed (`pacer`/`orca` source) Claude and Codex accounts are supported: their config-folder environment variables are placed in the terminal command, which contains paths only, never keys.

### 2. Orca attempt (`src/exec/orca/backend.ts`, `client.ts`)

`runOrcaAttempt` keeps its existing structure (prepare, admission, supervision via `waitForWorker`, fingerprinting, reports, fallback rules) with these changes:

1. **Placement.** For `new-child`, create the worktree first with `orca worktree create --name pacer-<task>-<executor> --repo id:<repoId> --base-branch <base> --setup skip --json` and read its worktree id. `existing` placement resolves the worktree id with `orca worktree show --worktree path:<realpath> --json`. Both yield the `id:<repo>::<path>` selector used below.
2. **Trust.** Pre-trust the worktree for the agent (section 4).
3. **Agent terminal.** `orca terminal create --worktree <selector> --title "pacer <task-id>" --command "<cmd>" --json`, where `<cmd>` is `env PACER_ROLE=executor PACER_TASK_ID=<id> [account env] <interactive argv without prompt>` built from a new `launchArgvFor(cfg, worktree, runDir, trustRoot)` in `src/exec/launch.ts` that shares flags with the existing interactive launcher (Claude: `claude --dangerously-skip-permissions [--model m]`; Codex: `codex --no-daemon -c <trust> -C <worktree> --dangerously-bypass-approvals-and-sandbox --add-dir <runDir> [-m m]`). Arguments are shell-quoted with the existing `shq`. Record the handle with the work admission immediately.
4. **Ready.** `orca terminal wait --terminal <h> --for tui-idle --timeout-ms 60000 --json`. If not satisfied (including `agent-trust-workspace`), close the terminal and fall back to direct with the reason logged (no worker exists yet, so this cannot duplicate work).
5. **Start.** `worker-start --spec <spec> --terminal <h> --worktree <selector> --run <run> --from <coordinator>` (no `--agent`/`--model`). `workerSpec` no longer rewrites the `pacer ask` line, because the identity variables are in the terminal environment. Existing uncertain-start handling is unchanged.
6. **Cleanup.** After settlement, timeout or stop: existing `worker-release`/`worker-stop` calls, then always `orca terminal close --terminal <h>` for the handle pacer created (never any other). The current "close orphaned agent terminal" check becomes unconditional for pacer-created terminals.

### 3. Supported agents

Claude Code and Codex use the terminal launch. Other agents (Cursor, Antigravity, OpenCode) fall back to direct with a logged reason until their trust and idle behavior is verified; extending the table is a follow-up.

### 4. Claude workspace trust (`src/exec/orca/trust.ts`, new)

- Before creating a Claude terminal, set `projects["<realpath worktree>"].hasTrustDialogAccepted = true` in the account's Claude config file: `~/.claude.json` for the default account, `<CLAUDE_CONFIG_DIR>/.claude.json` for managed accounts.
- Only the exact worktree path pacer is about to use. Read-modify-write with an atomic replace, preserving all other content and the file mode; retry once if the file changed between read and write. If the entry already exists and is trusted, do nothing and record nothing.
- Record each entry pacer added in `<pacerHome>/orca/trusted.json` (`{path, configFile, taskId, at}`).
- Remove pacer-added entries when the task's worktree is removed by `pacer clean` (or the task is dismissed with its worktree gone), and only if the entry still equals what pacer wrote. Never remove entries pacer did not add.
- Codex needs no file edit: its trust stays in the `-c projects=...` argument.
- Failure to write trust falls back to direct with the reason logged.

### 5. Switch follow-ups (review of 18f240b1)

- Copy (web, TUI, docs): "Orca runs tasks as supervised workers in Orca terminals; tasks run directly when Orca isn't running or the agent isn't supported." Warning text stays "Orca isn't running; tasks run directly until it is."
- TUI shows `config.set` warnings in warn tone (`src/dashboard/controller.ts`).
- `config.get` reports `source: "env PACER_BACKEND"` for `execution.backend` when the service environment overrides it; the warning is not shown in that case.
- Release the edit lock before the readiness probe, and cap the probe at 3 s.
- Regenerate Rust protocol types (`cargo xtask gen`).
- Docs: `docs/cli.md` config key table, `docs/configuration.md` and `docs/executors.md` (replace the "Orca uses direct execution" text), CHANGELOG `[Unreleased]`.

## Error handling

- Every failure before `worker-start` succeeds closes any terminal pacer created and falls back to direct (logged once per hour as today). After `worker-start`, existing uncertain-start and supervision rules apply; no direct fallback.
- Terminal close failures are logged and retried during cleanup; a terminal pacer cannot close is reported in the task log with its handle.

## Testing

- Unit tests with a fake `ctx.run` for: terminal command construction and quoting per agent and account; new-child and existing placement; idle wait success, timeout and trust block (terminal closed, direct fallback); worker-start argument shape with `--terminal`; cleanup always closes exactly the created handle; `selectBackend` returns the Orca backend for `orca` + ready, direct otherwise, and direct for connection accounts and unsupported agents.
- Trust module: adds only the target entry, preserves other content and mode, no-op when already trusted, records and removes only its own entries, handles concurrent modification.
- Live validation (CT-11): the sandbox forces `PACER_BACKEND=direct` and refuses `orca`, so the Orca path is validated with the user's authorization against the real Orca in a disposable repository, one Claude task and one Codex task (if Codex budget allows), recording the worker lifecycle, trust entry add/remove and terminal cleanup. Surfaces not exercised are reported UNVERIFIED.

## Out of scope

- Remote (SSH) hosts and remote Orca servers.
- Agents other than Claude Code and Codex in Orca terminals.
- Deleting Orca run metadata (Orca has no selective delete).
