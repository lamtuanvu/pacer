# Task: independent re-review of wave 1 PR 4 after fix round 1 (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Security-sensitive: the fixes tighten D3, harden the D8 proxy and change the HTTP undecodable-body forward. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p <crate>` / `cargo clippy -p <crate> --all-targets` for touched crates (debug, existing `target/`, one cargo command at a time), `cargo xtask loc --check`, the deps check, `bun run typecheck`, and focused `bun test` files, inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never install or uninstall real planner integrations.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr4, branch `fix/native-config-set-planner-backend`, base origin/main `acab1eca4`. Reviewed head was `3d10b9c33`; fix round head `1b3b214b9` (three commits). Prior review (PASS with findings): `.work/reviews/wave1-pr4-review.md`. Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave1-pr4-r1.md. Handoff "Fix round 1" section: `.work/reviews/wave1-pr4-handoff.md`.

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/{security,protocol-compat,qa,architecture}.md` and `.project/rules/{security,rust,rust-crates,api-protocol,code-and-testing,repository}.md` (whichever exist).

Review against the final head:
1. Each finding N1-N4 and P1-P3 is fixed as the fix brief decided, with a test that fails without the fix (spot-check at least two by mutation in a scratch copy under /tmp, then discard; one must be P1 or P3).
2. P1: D3 refuses `config set planner` in every spelling the TS CLI accepts (look at `src/commands/config.ts` and the CLI argument parser: `planner=x`, flags before/after, `--`, aliases, case). Nothing else legitimate became refused.
3. P3: the D8 proxy refuses inexact or unregistered `/v[23]/ops/` paths; confirm the registered-op list it uses can't drift silently from `src/api/ops.ts` (or a test catches drift), and that the web app, CLI, TUI and harness requests still pass (run `test/live-harness.test.ts` and `test/live-api-guard.test.ts`).
4. P2: `config.set` HTTP bodies serde rejects forward to TypeScript; no other op's behavior changed accidentally; the differential test covers the BOM and lone-surrogate cases.
5. N1: the race reply matches TS text and code exactly (cite TS).
6. New regressions in `git diff 3d10b9c33..HEAD`; ledger and CHANGELOG accuracy; LOC (`pacer-config` 8,107, `pacer-server` 8,195, `pacer-config-ops` 5,045) and the CRATE-1 paragraph; the D3 call-out text for the PR description.
7. CT-11: live-wave1-pr4-r1-rust (5 PASS, 6 UNVERIFIED) and live-wave1-pr4-r1-ts; read the reports and judge the UNVERIFIED items. The worker's one Bun failure (live-ota EPERM on /Applications inside sbx-deny, passing outside) is environmental: confirm by reading the test, not by running it outside the sandbox.
8. REPO-4: signed-off commits, Conventional Commit subjects, identity Vu Lam; no `.work/` paths, machine paths or personal emails in added lines.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr4/.work/reviews/wave1-pr4-rereview.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; per prior finding: status and evidence; new findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy); checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and execute the review brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave1-pr4.md. Read-only review. Always finish with orca orchestration worker_done.
