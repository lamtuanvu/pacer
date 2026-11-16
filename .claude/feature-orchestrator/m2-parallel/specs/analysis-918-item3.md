# Task: analysis — #918 item 3 (executor sandboxes vs the native owner socket), a PR 7 gate

Executor: cursor-agent (default model, frontier tier: security analysis that sets a default-on gate). Research only: do not edit tracked files, commit or push. No subagents. You may write scratch files under `.work/fixtures/918-item3/`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish (read `main` via `git show origin/main:<path>` or a `git worktree add /tmp/...` you remove afterwards). Also read PR #971 (owner bridge caller authentication, `fix/owner-bridge-caller-auth`, auto-merge pending), which adds a per-start key in `run/host.key` and a mutual HMAC handshake.

## Question

Issue #918 item 3 says: "Check every sandbox profile an executor can run under, and deny `connect()` to `$PACER_HOME/run/host.sock` there." The PR G security review (`.work/reviews/parity-g-review.md`, ruling R-c) made it a PR 7 gate: before the owner is on by default, executor sandboxes must deny reads of `$PACER_HOME/run/` (and the per-user socket directory) and `connect()` to its sockets, with a test, or the key must move where a sandboxed executor cannot reach it.

Yet pacer launches executors with their own sandboxes disabled: `src/exec/launch.ts` passes `--dangerously-bypass-approvals-and-sandbox` to codex and `--sandbox disabled` to cursor-agent. Find out what "sandbox profiles an executor can run under" actually means for pacer today.

## Find out

1. Every way an executor (direct and Orca backends, interactive and headless, local and remote host runners, plugin executors) is launched, with its argv and env (`src/exec/*`, `crates/*` native launch paths, executor plugins). For each: is it sandboxed at all, by whom (the agent CLI, pacer, Orca, the OS), and can a user configure a sandbox (for example claude-code's sandbox settings, codex sandbox modes, Orca worktree isolation, the `sbx-deny`-style profiles the tests use)?
2. Whether any of those sandboxes, if enabled, would block exec/kill/file effects but still allow reading `$PACER_HOME/run/host.key` and `connect()` to `run/host.sock`: the threat in #918.
3. What an unsandboxed same-uid executor can already do without the owner (so what the owner adds as an escalation), with and without PR G.
4. The options and their cost:
   - deny `run/` reads and socket `connect()` in profiles pacer controls;
   - move the key off disk (inherited fd or stdin to Core) so a same-uid file read can't get it;
   - bind sealed calls to lanes started from the same spec fingerprint (the review's A2);
   - document that executors run unsandboxed by design and close item 3 with that rationale.
   For each option say what it protects against, what it would take (files, size), and whether it should gate PR 7.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/918-item3-analysis.md: findings with file references, a table of launch paths and their sandboxing, the options with costs, and a recommendation phrased as a maintainer decision (what to do before PR 7, what after). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/analysis-918-item3.md exactly. End with orca orchestration worker_done.
