# Task: independent re-review of owner parity PR H after its review fixes and rebase (REPO-10)

Executor: cursor-agent (default model, frontier tier: deadline and relay code). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts work in a `git archive HEAD` copy under `/tmp`, and delete it afterwards (disk space is limited).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch `fix/door-plugin-calls-via-core`, head `e81571a6c` on `main` `ece942407` (PR F #962 merged in between).

Inputs:
- First review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-review.md (FAIL on B1; N1–N7, nits).
- Fix handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-fix-handoff.md (rebase resolutions with #962, B1 fix, N1–N4 and N7, red-then-green evidence, CT-11 hfon 4 PASS / 1 UNVERIFIED with hfof as flag-off reference, follow-ups).
- Briefs `review-parity-h.md` and `parity-h-fix.md` next to this file for the rules and reviewer definitions.

## What to verify

1. **Rebase.** `git range-diff` against the reviewed `b13d4dd90`: nothing from H or from #962 was dropped. Judge the rename of #962's relay option to stdio and the new `deliver_door_requests` test.
2. **B1.** A failed or timed-out sealed call keeps its `capability.log` lines (carried in `error.data.logs`, written by `callNativeOwner` on failure) on the serve door, self-owned stdio, attached stdio and Core's own owner calls, matching flag-off (`src/plugins/host.ts:159`).
   - **Deadline safety:** on a deadline abort, Core now shuts its write side and drains up to 1 s for the owner's final reply. Confirm this never delays the caller's reply past flag-off's timing (or by how much), never lets a late reply be treated as success, and can't leak a lane, socket or pending request. Check the error reply's size bounds (log line caps) and that `error.data.logs` cannot carry another call's or another plugin's lines.
3. **N2, N3, N4, N7, N1 docs.** The crash row compares `restarts` and accepts either flag-off text; the delays exceed deadline plus margin; `conformance/fixtures/plugin.ts` is identical to R1's (`git diff origin/fix/owner-hello-deadline -- conformance/fixtures/plugin.ts` after `git fetch origin`); the hint is asserted end to end; the ledger, ADR 0027 and CHANGELOG describe logs on failure and the readiness row (caused by this PR on the doors, including self-owned stdio) accurately.
4. **Evidence.** Rerun the required checks from `parity-h.md` with both front doors built from this head, plus the new B1 row; reproduce the B1 red on the pre-fix head and the drain-removed variant. Commits signed off and Conventional; no machine paths or personal emails.
5. **CT-11.** Judge hfon/hfof and the UNVERIFIED self-owned stdio surface.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never use ports 4317, 11434, 1234, 41343; no real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `e81571a6c`, findings with severity and code references, commands with results. Report with `orca orchestration worker_done`. Always end with worker_done.
