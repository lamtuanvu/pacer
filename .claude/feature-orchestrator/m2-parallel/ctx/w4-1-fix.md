# Task: M2 wave 4 W4-1 — fix review finding B1 (flaky SSE assertion) and the nonblocking items, rebase onto main

Executor: cursor-agent (default model, frontier tier). No subagents. Never use `git stash` (shared by all worktrees); save patches under `.work/fixtures/w4-1-<what>.patch` instead.

Read and follow the "Build and environment", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Disk space is limited: delete `/tmp` copies when you are done with them.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-1, branch `feat/w4-runner-models`, head `8a039d95e` on `main` `a05f95414`.

Inputs:
- Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-review.md (FAIL on B1 only; N1–N5, nits T1–T4). Evidence under `.work/fixtures/w4-1-review/`.
- Your handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-handoff.md.

## Steps

1. **Rebase** onto `origin/main` (`git fetch origin`). `main` now has #945, #960, #961 (W4-4: `usage_broker_params`, `strategy_preview_ops`) and #962. Keep both sides in any conflict; rebuild and rerun your parity suite before step 2. W4-3 (`feat/w4-opencode-models`, another worker) is based on your current head and will rebase onto your new one, so keep commit 1 (library) and commit 2 (ops) as separate commits and put the fixes in a new third commit.
2. **B1 (blocking, test only).** `test/native-runner-models-ops-parity.test.ts` ~254-258 compares the two doors' SSE lists, and the forwarded door's SSE can drop an event under load (pre-existing forwarded-path behavior). Do not require the forwarded door's SSE to be lossless. Assert instead that each door's SSE `config` events for `runners`/`strategy` equal its own home's outbox `config` envelopes, polling with a deadline; or poll both until they reach the outbox-derived count and fail only after the deadline. Show it passing 10 runs in a row on the rebased head. Write a short issue text (title and body) for the forwarded SSE event loss, with the reviewer's evidence, so the coordinator can file it.
3. **N2.** Add parity cases with an absolute `active` name and with `active` = `../x` (write `active` directly; `strategy.use` refuses them). Both must forward, with identical replies and disk.
4. **N3.** Add a Rust unit test for `set_many` with a stale `expectedRevision`.
5. **N1 (docs).** Record in the `runner.models.set`/`set_many` ledger rows and the PR body: clearing a block `models` list followed by an indented comment, where native writes valid YAML and Core refuses with "All mapping items must start at the same column…".
6. **N4, N5 (PR body).** Name the live head: base `a05f95414` plus a working tree identical to `8a039d95e` (fingerprint matched). Mention that native saves write `strategy.yaml` at 0600 through the shared atomic writer, as other native strategy writes do (SEC-7).
7. **T3.** Verify that commit 1 builds and passes alone, using a `git worktree add` at commit 1 under `/tmp` (not `git stash`), and remove that worktree afterwards.

Required checks: fmt; clippy `-D warnings` and tests for pacer-models, pacer-config, pacer-config-ops, pacer-dispatch-ops, pacer-server; `xtask loc` (pacer-config must stay under 8,000) and `deps`; typecheck; `bun scripts/golden/strategy-doc.ts --check`; the new parity suite (10 consecutive passes) and the affected suites from your handoff with front doors built from the rebased head.

CT-11: the product code did not change, so no new live run is needed unless the rebase changes runtime behavior; if it does, rerun the HTTP and stdio op calls in a sandbox and report.

## Output

Rebased commits plus one fix commit (signed off, Conventional), not pushed. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-1-fix-handoff.md with the rebase result, each fix with evidence, the SSE issue text, checks and an updated PR body. Report with `orca orchestration worker_done`. Always end with worker_done.
