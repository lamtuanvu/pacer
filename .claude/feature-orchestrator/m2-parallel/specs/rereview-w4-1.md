# Task: short independent re-review of M2 wave 4 W4-1 after its test fix and rebase (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts work in a `git archive HEAD` copy under `/tmp`, and delete it afterwards (disk space is limited).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-1, branch `feat/w4-runner-models`, head `084531ce6` on `main` `ece942407`: `d7c593e1e` (library) and `79d7fd964` (ops) are the reviewed `afcadc663` and `8a039d95e` rebased, and `084531ce6` is the fix.

Inputs:
- First review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-review.md (FAIL only on B1, a flaky SSE assertion; N1–N5, T1–T4).
- Fix handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-fix-handoff.md (rebase, fixes, one deviation, the filed SSE-loss issue, checks, updated PR body).
- Brief `review-w4-1.md` next to this file for rules and reviewer definitions.

## What to verify

1. **Rebase.** `git range-diff a05f95414..8a039d95e ece942407..79d7fd964`: the product commits are unchanged apart from context; #961's `strategy_preview_ops`/`usage_broker_params` wiring survives next to W4-1's five ops in `native.rs`, `serve/mod.rs` and `stdio_proxy.rs`.
2. **B1.** The new assertion: the native door's SSE must equal its own outbox's `runners`/`strategy` `config` envelopes (polled with a deadline), and the forwarded door's SSE must be an in-order subsequence that invents nothing. Judge whether the native side still catches a native publishing regression (missing, extra or reordered events) and whether the deviation from the brief is sound. Run the parity suite at least 10 times in a row, some under load.
3. **N2, N3, N1.** The absolute and `..` active-name cases forward with identical replies and disk (red if the predicate is bypassed); the `set_many` stale-revision unit test is red with the revision check disabled; the ledger states the block-`models`-with-comment residual.
4. **Checks.** fmt; clippy `-D warnings` and tests for pacer-models, pacer-config, pacer-config-ops, pacer-dispatch-ops, pacer-server; `xtask loc` (pacer-config under 8,000) and `deps`; typecheck; `bun scripts/golden/strategy-doc.ts --check`. Commits signed off and Conventional; no machine paths or personal emails.

Environment: as in `w4-common.md` ("Build and environment"). One cargo command at a time, keep memory modest. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never use ports 4317, 11434, 1234, 41343; no real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `084531ce6`, findings with severity and code references, commands with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-w4-1.md exactly. End with orca orchestration worker_done.
