# Task: fix round for "Core secrets on stdin" (security PASS, QA UNVERIFIED)

Executor: cursor-agent (default model, frontier tier: credential transport robustness plus a paired-native test). No subagents. Never use `git stash`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md (test environment, sandbox, sccache workaround). Never start the shared sccache server from a disposable HOME: if `sccache` misbehaves, build with `RUSTC_WRAPPER=` instead of stopping or starting the server.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/core-secrets, branch `fix/core-secrets-stdin`, reviewed commit `79c898d8a`. Do not push. Commit with `git commit -s`, Conventional, author Vu Lam <lamtuanvuqs@gmail.com>.

Inputs: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-security-review.md and /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-qa-review.md (finding tables and details); your handoff `.work/reviews/core-secrets-handoff.md`.

## First: rebase

Rebase onto `origin/main` (now includes #976, which conflicts in `crates/server/src/lib.rs`: keep both `mod` lines). If PR #970 (owner parity H, `origin/fix/door-plugin-calls-via-core`) has merged by then, it is on main and you resolve its conflicts too (ADR 0027 Q1 follow-ups and doors bullet, `docs/testing/m2-ledger.md`, `src/plugins/host-bridge.ts`, `lib.rs`): keep H's text and code and apply this branch's meaning (secrets in the stdin frame; #918 item 3 closed by decision; #973). If #970 has not merged, say so; the coordinator rebases later.

## Fix

1. **Silent stdin (security F1, QA F2).** Core must never block forever waiting for the frame: a blocking pipe held open without writing, a TTY, `/dev/null` or a closed fd must fail closed within a bounded time (keep the 10 s budget for all reads, e.g. poll/non-blocking reads, not just EAGAIN). Make sure the marker can't be inherited where no frame follows: every place that execs or spawns Core or another process from a process holding `PACER_CORE_SECRETS` must drop it (QA F2 names `crates/cli` `child_env` and the front door exec path). Red/green tests for: silent blocking pipe, TTY or `/dev/null`, inherited marker.
2. **Duplicate keys (security F2).** Reject a frame whose JSON repeats a key, with a test.
3. **Signed paired native path (QA F1, Medium).** Add a tracked test for the frame after the `B` byte with SCM_RIGHTS: the frame is written only after the ack is read, survives the 1-byte `recvmsg` iovec, and Core reads it only after authenticating fd 0. Use the QA reviewer's scratch approach (the real C shim against Core's reader) as a tracked test if possible; if a full signed paired live run is impossible here, state that clearly as UNVERIFIED with the reason.
4. **Version mismatch (QA F3).** Document the same-build requirement for the door and Core in the PR body and CHANGELOG. If cheap, have Core or the door name the mismatch (a Core that sees an unknown marker version, or a door whose Core never acknowledges) instead of the opaque errors.
5. **`CONSUMED` (QA F4).** Add `PACER_CORE_SECRETS` to `core_process::CONSUMED` and its test list.
6. **Docs (security F3, F4; QA F5; security F8).** Reword the ledger PR 7 gate header so it matches its rows; point the `bridge_auth.rs`, `serve_host.rs` and plugin-runtime `lib.rs` rustdoc at the stdin frame; change the spec line at `docs/specs/2026-10-20-rust-host-migration-design.md:119` to the secrets frame on stdin; fix ledger rows that still say "sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`" if they describe the transport.
7. **Optional (security F7):** assert the agent-session `--add-dir` values equal the run and attachment directories.
8. **Security F5 (Linux `/proc/<pid>/fd/0` race):** do not fix; add it to the handoff for issue #973 and make the ADR 0027 sentence it cites accurate (a sandbox that denies reads of the home does not by itself stop a same-uid ptrace-capable process on Linux).

## Verify

fmt; clippy `-D warnings` (with and without test-ops); `pacer-server`, `pacer`, `pacer-cli` and `pacer-plugin-runtime` tests; `xtask loc --check`/`deps`; typecheck; the handoff's Bun list plus the new tests with front doors built from your head (plain and `--features test-ops`). CT-11 rerun on the new head (owner off and owner on), recording the head commit and any retried fixture attempts (QA F6). No machine paths or personal emails in tracked files.

## Output

Update `.work/reviews/core-secrets-handoff.md` (new head, per-finding resolution, red/green evidence, CT-11 summary, updated PR body with the same-build note, the security and QA review summaries, and the #973 addition). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/core-secrets-fix.md exactly. End with orca orchestration worker_done.
