# Task: independent re-review of wave 3 PR 2 fix round 1 (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr2, branch `feat/plugin-ops-stdio-owner`. Final head `7392938a4`. The reviewed implementation is `b7bfe62cd..66272b539` (three commits, rebased onto `origin/main`); fix round 1 is `8cbc91e76..7392938a4` (five commits).

Inputs:
- First reviews: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-security-review.md (S1–S4, P1–P2, Q1–Q4, A1–A2, R1, deep-home recommendation) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-arch-review.md (W3A-1..6).
- Handoff with the "Fix round 1" section: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-handoff.md.
- Fix brief with the maintainer's deep-home decision: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr2-r1.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, architecture, code-and-testing, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Deep-home private socket directory**, against the maintainer decision and the security reviewer's mitigations: base directory from `confstr(_CS_DARWIN_USER_TEMP_DIR)` / `$XDG_RUNTIME_DIR`, never a shared `/tmp` name or bare `$TMPDIR`; `lstat` checks on base and `pacer-<hash>` subdirectory (directory, not a symlink, owner uid, `mode & 0o077 == 0`) with no TOCTOU gap that lets another user substitute the directory or socket; used only when the in-home path is too long; refusal text actionable. Look hard at how the macOS value is obtained (the handoff mentions a `getconf` spawn: PATH lookup, environment influence, failure handling, latency) and at `$XDG_RUNTIME_DIR` being caller-controlled.
2. **S1:** `PACER_HOST_SOCKET` removed from the Core-mode core child; test fails without it.
3. **S2:** host.sock owner check and peer-uid check each covered by a test that fails when only that check is removed (rerun at least one of these mutations yourself).
4. **S3:** stale socket sweep removes only the current uid's stale `s<12-hex>.sock` sockets (not symlinks, not live sockets, not other files), in `run/` and the private directory; no race that deletes a live peer's socket.
5. **S4:** process-wide umask narrowing gone or justified; the socket is never connectable by others between bind and chmod (parent 0700 verified first). Check serve's `host.sock` path if the helper is shared.
6. P2, Q1, Q2, Q4 and W3A-1..6 addressed as the handoff says; the `owner_attach` flake fix (handoff) is sound and not hiding a real race.
7. Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR`: clippy `-D warnings` and tests for `pacer-server` and `pacer-plugin-runtime` (one cargo command at a time, debug), `bun run typecheck`, `test/native-plugin-ops-stdio.test.ts`. Other Rust workers run at the same time; keep memory modest. If deep-home tests need the OS per-user temp directory outside the sandbox, run them outside with a disposable HOME and say so.
8. CT-11 evidence names head `7392938a4` (or the head it ran on, with only test-only commits after) and its claims match the code. ADR 0027, the ledger, CHANGELOG and live-validation docs are accurate; no machine paths or personal emails; commits signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `7392938a4`, a table of every original finding with its status, any new findings with severity and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave3-pr2.md exactly. End with orca orchestration worker_done.
