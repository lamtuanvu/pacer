# Task: independent security, protocol and QA review of M2 wave 3 PR 5 (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr5, branch `feat/owner-crash-backoff`, head `b96d8c9af`: four commits `2400bf1a6..b96d8c9af` on top of wave 3 PR 2 (`644c062e8`, #920, not merged yet). Review only `644c062e8..b96d8c9af`. The coordinator rebased these commits onto #920's CI fix and ported that fix (pass `XDG_RUNTIME_DIR`, fail pending stdio replies on early exit) into the helpers PR 5 moved to `test/native-plugin-door.ts`; check that port too. Bun tests read `PACER_TEST_FRONT_DOOR` (a plain `cargo build -p pacer` copy) and `PACER_TEST_NATIVE_FRONT_DOOR` (a `--features test-ops` copy), both in a temp dir.

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave3-pr5.md.
- Plans: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md ("PR 5", §7 OD-7) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-pr2-stdio-owner.md (§1.1, §3.2, §4.2, Q2, Q6). Maintainer decisions: OD-5 `crashed` kind, OD-7 a second serve refuses (no TypeScript fallback), Q2 owner-side restart floor, Q6 exit code 3 + stable message + doctor check.
- ADR 0027 and the PR 2 reviews (`wave3-pr2-security-review.md`, `wave3-pr2-rereview.md` in /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/).
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## Focus

1. **Process termination:** SIGTERM → 2 s → SIGKILL at serve shutdown and stdio teardown; signals go only to the door's own children (process group / pid reuse / already-reaped pid); no orphan; no kill of an attached connection's shared children; behavior when shutdown races a crash or a restart.
2. **`crashed` IPC kind:** sealed like the other private kinds (sync key / internal token, hello v3, no work grant); a caller cannot forge crashes to push a plugin into `failing` or alter backoff; Core-side `recordCrash` twin matches TypeScript byte for byte (`restarts`, `error`, `nextStartAt`, three-crashes→`failing`, recovery).
3. **Backoff and the owner restart floor:** sealed `nextStartAt` honored; floor per plugin id cannot be bypassed by an attached door; cannot be used to deny service to the owner's own door beyond the TypeScript rule; clock handling.
4. **OD-7:** bounded wait, exit code 3, stable message; `run/host.sock.pid` sidecar created safely (0600, inside the verified 0700 run dir, no symlink follow, removed at shutdown, stale handling); `pacer doctor` check reads it without trusting it beyond display; no TOCTOU that lets another local user make a serve refuse or attach.
5. **PR 2 follow-ups fixed here** (N1/N2/N3, `native_listener` umask): correct and tested.
6. **Tests:** each new behavior has a test that fails without it (rerun at least two mutations yourself: one for escalation or crash reporting, one for exit code 3 or the sidecar); no fixed ports; temp homes.
7. **CT-11:** the live report's claims match the code; the one FAIL that was fixed and rerun is genuinely harness timing.
8. CHANGELOG, ledger rows 22/23, module docs: accurate; no machine paths or personal emails; commits signed off and Conventional.

Run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR -u PACER_HOST_SOCKET` unless pointing it at your own `cargo build -p pacer --features test-ops` copy in a temp dir. One cargo command at a time, debug only; another reviewer may build at the same time. Signal/escalation tests blocked by the sandbox may run outside it with a disposable HOME; say so. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never `launchctl`; never ports 4317, 11434, 1234, 41343.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-security-review.md: verdict (PASS / FAIL / UNVERIFIED) against `b96d8c9af`, a findings table (ID, severity blocking/nonblocking, rule, code reference, evidence, fix), and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-wave3-pr5-security.md exactly. End with orca orchestration worker_done.
