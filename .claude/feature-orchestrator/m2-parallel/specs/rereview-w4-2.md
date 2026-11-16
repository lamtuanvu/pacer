# Task: independent re-review of M2 wave 4 W4-2 after its review fixes and rebase (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts work in a `git archive HEAD` copy under `/tmp`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-2, branch `feat/w4-routing-residue`, head `8296c123a` on `main` `ece942407`: `c32a800a2` (the reviewed W4-2 commit `f552db759`, rebased over #945, #960, #961 and #962) and `8296c123a` (the fix).

Inputs:
- First review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-review.md (PASS at `f552db759`; N1 fix recommended, N3 and N4 nits).
- Fix handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-fix-handoff.md (rebase resolutions, N1/N3/N4 fixes, four deviations, red-then-green evidence, CT-11 5 PASS / 1 UNVERIFIED).
- Rules and reviewers as in the first review's brief `review-w4-2.md` next to this file.

## What to verify

1. **Rebase.** `git range-diff a05f95414..f552db759 ece942407..c32a800a2`: nothing from W4-2 or from `main` was dropped. In particular, #961's `usage_broker_params` and per-op broker params in `native.rs`, `serve/mod.rs` and `stdio_proxy.rs` survive next to `status_residue_stays_forwarded`.
2. **N1.** `routing.route` and `task.retry_options` forward whenever `native_load` does not load the strategy, before the host-runner check, and the host check uses that strategy. Look for any remaining path where Rust and Bun resolve different strategy files (absolute or dotted `active`, symlinks, trailing whitespace or newline in `active`, names with `..`), and for a TOCTOU window between the predicate and the handler that could rank a remote runner natively.
3. **N3.** `mode.hold`'s integral `until` printing matches `JSON.stringify` (shortest round-trip digits, e.g. `18446744073709549568` → `18446744073709550000`), fractions unchanged, and values ≥ 2^64 forward. Check the default-`until`-from-`resetsAt` residual the handoff names.
4. **Deviations.** Judge the four deviations, especially that `strategy.use` refuses absolute names on both sides (so the reviewer's state is reachable only by editing `active` directly) and the dotted-name substitute for "a strategy only Bun can load".
5. **Evidence.** Rerun the parity file (11 tests) and the 8 related suites with front doors built from this head, the touched crates' fmt/clippy/tests, `xtask loc`/`deps`, typecheck; reproduce the N1 red on the pre-fix predicates. Commits signed off and Conventional; no machine paths or personal emails.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never use ports 4317, 11434, 1234, 41343; no real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `8296c123a`, findings with severity and code references, commands with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-w4-2.md exactly. End with orca orchestration worker_done.
