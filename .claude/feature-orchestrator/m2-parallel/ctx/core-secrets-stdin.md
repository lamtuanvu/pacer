# Task: hand Core its secrets on stdin, pin the agent-session sandbox flags, and close #918 item 3 (PR 7 gate)

Executor: cursor-agent (default model, frontier tier: secret transport between serve, doors and Core). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/core-secrets, branch `fix/core-secrets-stdin`, based on `main` after PR #971 (owner bridge caller key) merged.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first (safety, build and environment). Never use `git stash`.

## Background and decision

Read /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/918-item3-analysis.md (whole file) and `.work/reviews/parity-g-review.md` rulings R-a and R-c. The maintainer accepted the analysis's recommendation:

- #918 item 3 closes as "executors run unsandboxed by design; pacer ships no sandbox profile".
- Before PR 7: options 2a, 1b and 4 below. Deferred hardening is tracked in issue #973 (do not implement it here).

Measured fact behind 2a: on macOS any same-uid process, sandboxed or not, reads another process's initial environment with `sysctl(KERN_PROCARGS2)`, and no usable Seatbelt rule blocks it. Core's initial environment currently carries the owner key (from #971), `PACER_INTERNAL_TOKEN` and `PACER_NATIVE_CONFIG_SYNC_KEY`.

## Scope

1. **Option 2a — secrets off Core's environment.** Serve → Core and stdio door → Core pass the owner key, `PACER_INTERNAL_TOKEN` and `PACER_NATIVE_CONFIG_SYNC_KEY` on Core's stdin (already piped, `crates/server/src/serve/core_child.rs`) instead of the environment. An inherited extra fd would need `pre_exec`, which `unsafe_code = "forbid"` rules out; use stdin unless you find a safe alternative. Design a small, versioned framing that cannot be confused with other stdin use, is read once at startup before any other code can read it, and fails closed (Core refuses to start the owner path with a clear error) if the frame is missing or malformed. Keep the flag-off and forwarded paths working.
   - Files per the analysis: Rust `serve/native_host.rs`, `serve/core_child.rs`, `stdio_plugins.rs`, `stdio_proxy.rs`; TypeScript `takeOwnerKey` in `src/plugins/host-bridge.ts`, Core startup in `src/cli.ts`, `src/serve/background-worker.ts`. Find every other reader of these three variables (`rg`) and every place that sets them, including tests and the live harness.
   - Core must also not re-export them: no child process (executors, plugins, `opencode models`, `runner.check`) may receive them. `executorEnv` already deletes some; make that hold for all three wherever Core spawns.
   - Tests: a test that Core's process environment (read via `KERN_PROCARGS2` on macOS, `/proc/<pid>/environ` on Linux, or `ps eww` as a fallback) holds none of the three secrets on both serve and the stdio door, with red evidence against the current behaviour; a test that a missing or malformed frame fails closed; the existing owner, parity and serve-auth suites stay green.
2. **Option 1b — pin the one pacer-controlled sandbox.** A test in the agent-session plugin tests that the codex launch in `plugins/agent-session` keeps `-s workspace-write` and never adds `--allow-unix-socket`, network access or Unix-socket overrides. Red evidence by mutating the argv.
3. **Option 4 — documentation.** ADR 0027 consequence (executors run as unsandboxed same-uid processes; pacer ships no sandbox profile; a user who enables an agent sandbox must not allow Unix sockets under `$PACER_HOME/run` or the per-user socket directory; Core's secrets travel on stdin). `docs/executors.md` gets the user-facing rule. CHANGELOG entry. Update the `docs/testing/m2-ledger.md` PR 7 gate row for #918 item 3 from red to "closed by decision", linking #973. PR body says "Part of #918".

CT-11: required (runtime change). `bun run live` with the Rust front door on a fixture home, owner flag on and off: serve and the stdio door start, plugin calls work through the owner, an executor fixture runs, and the secrets are absent from Core's environment (show the probe output). Report surfaces you could not exercise as UNVERIFIED.

Required checks: fmt, clippy `-D warnings` and tests for every touched crate, `cargo xtask loc`/`deps`, typecheck, the affected bun suites (serve auth, owner bridge and G's caller-auth tests, stdio door, background worker, agent-session).

Reviews after your handoff: security (secret transport, fail-closed, no child inherits) and QA.

Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-handoff.md with a draft PR body. PR title: `fix(serve): hand Core its secrets on stdin instead of the environment`.
