# 0018 — Orca executor uses pacer-composed terminal launches

Status: accepted with amendment 0.18.0 (ARCH-4 and P8), merged on 2026-10-31 in #523. Supersedes the unmerged draft `0007-orca-user-settings-execution.md`.

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

### Implemented split (SP10)

The SP10 implementation puts more on the host side than the extraction plan listed for the plugin. ARCH-4 and §1 of this decision allow this split:

- The host makes every Orca CLI call: client, setup, placement, terminal, worker start, lookup, read, release, stop, close and cleanup. It also parses Orca output, runs the supervision loop behind `capability.orca.wait`, maps outcomes, recovers uncertain starts and handles live lanes (`src/plugins/orca-attempt.ts`, `src/plugins/orca-host.ts`, `src/exec/orca/`).
- `pacer-exec-orca` sequences these coarse, attempt-bound effects. Its own decisions are the call order, the bounded uncertain-start lookup and the keep-alive request.
- The provider maps the wait result and a failed start to an outcome (`mapWait`, `mapFailedStart`). The host computes the same mapping and refuses a mismatch. The duplication is deliberate: the provider proposes the outcome and the host checks it.
- Free-text `pacer send` into a live Orca lane is a host-owned guarded effect. The host checks that the lane's agent is still in the foreground, then types the text through its own Orca client, whether or not the provider is enabled. Release of a kept-alive lane goes through the provider's `executor.stop`. If the provider is disabled, its call fails or it returns an invalid result, the host closes the exact recorded worker and terminal itself, because closure is host authority.
- `executor.sessionState` for `host: "orca"` is staged. The provider and capability are implemented and tested, but no host feature calls them yet.
