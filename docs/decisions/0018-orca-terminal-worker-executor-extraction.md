# 0018 — Orca executor uses pacer-composed terminal launches

Status: proposed with amendment 0.18.0 (ARCH-4 and P8); adopted only on maintainer merge. Supersedes the unmerged draft `0007-orca-user-settings-execution.md`.

## Context

Pacer's #461 backend already launches Claude Code and Codex in an Orca terminal through a pacer-composed command. Orca attaches the worker to that terminal. This gives pacer control of the interactive agent arguments and unattended flags while Orca provides the worktree, terminal and worker supervision. The older draft assumed `worker-start --agent` and claimed Orca user settings governed permissions. That assumption no longer describes main. SP10 must extract the running flow behind the executor plugin contract without changing permission or fallback semantics.

## Decision

1. `pacer-exec-orca` is a bundled executor provider selected through the versioned contract. The host owns strategy selection, task/revision/attempt identity, launch policy, placement, admission lease, exact effect grants, durable recovery and cleanup authority. The plugin drives the granted Orca lifecycle and reports bounded observations and results. The host has no built-in Orca executor fallback after cutover.
2. For supported interactive Claude and Codex runs, pacer constructs the agent arguments and per-run settings, shell-quotes the fixed `exec env ...agent` command, and supplies it to `orca terminal create --command`. After verified TUI idle, `orca orchestration worker-start --terminal` sends the task spec. The task brief is never interpolated into the nested terminal command. Orca user settings do not replace pacer's launch flags for this path.
3. A potentially started worker stays bound to its task and work lease until positive same-identity recovery or verified closure. Stable request IDs may strengthen recovery only when the target Orca CLI proves idempotent replay for terminal-bound starts. Uncertainty never triggers direct fallback or a second worker. Before worker start, verified terminal closure permits logged direct fallback.
4. Pacer closes only the exact terminal it created, handles Orca's initial terminal only with captured ownership proof, and removes a pacer-created worktree only after review and ownership/unchanged checks. Existing worktrees and user terminals remain user-owned. Interactive lane foreground/incarnation checks and `exec` shell replacement guard free-text sends.
5. Headless, strict managed, connection, unsupported-agent, secret-work-grant and unavailable-Orca cases retain #461's logged direct route. The recorded backend is the one actually used. No native credentials are copied into the terminal command or plugin protocol.

## Consequences and alternatives

The plugin adds a narrow task-owned Orca capability surface and persistent start/closure state, but removes the built-in Orca execution path under ARCH-12. The nested command is a deliberate, constrained exception to the usual argv-only subprocess pattern: the outer Orca CLI is always spawned with argv, while the inner command is generated exclusively from validated host launch tokens and shell-quoted. A generic shell/string broker, worker-start `--agent` under Orca settings, and forced-Orca failure semantics are rejected because they change #461 behavior or weaken proof. Live Orca validation and independent review remain required; this ADR grants no exception.
