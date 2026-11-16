# Task: independent security re-review of owner parity PR G after its rebase onto main (REPO-10)

Executor: cursor-agent (default model, frontier tier: authentication code across a multi-PR rebase). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts work in a `git archive HEAD` copy under `/tmp`, and delete it afterwards (disk space is limited).

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-g, branch `fix/owner-bridge-caller-auth`, head `a37c93c29`: 8 commits on `main` `ece942407`. Pre-rebase head `ad1c801b1` (branch `backup/parity-g-ad1c801b1`, on old base `693b1b182`) was reviewed PASS.

Inputs:
- First review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-review.md (PASS at `ad1c801b1`; §4 expected conflicts; N1–N7, A1; rulings R-a to R-c).
- Rebase handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-rebase-handoff.md (conflict resolutions, N1–N5 and A1 fixes with mutation evidence, checks, CT-11 with two flag-on FAIL rows the worker calls probe defects and reran to PASS, updated PR body).
- Brief `rebase-parity-g.md` and the first review's brief `review-parity-g.md` next to this file for rules and reviewer definitions; ADR 0027 (A's, E's and F's sections now on `main`).

## What to verify

1. **Rebase.** `git range-diff 693b1b182..ad1c801b1 ece942407..a37c93c29` plus a per-file check that no change from `main` (A #945 sealed owning-call authority, C, D, E runners own their plugins, F #962 observation generations) was dropped or weakened in the conflict resolutions, and that G's handshake, key custody and narrower bridge survive intact. Pay attention to every place the bridge accepts a caller: A's and F's new private kinds and observation requests must sit behind G's authentication too.
2. **N4.** The attached connection's reconnect hint after a serve restart names both causes, the ADR Rotation bullet matches the code, and the TS stand-in now proves with a different key (the real path).
3. **N5.** The deadline, 4 KiB line cap and reflection tests are real (red by mutation) and the configurable deadline cannot be lowered or raised outside tests.
4. **Docs (N1–N3, A1).** ADR 0027 no longer contradicts itself; the stale runner-refusal text is gone and "no runner inherits the credential" stays; the residual names the per-user directory; the ledger keeps #918 item 3 as an open red PR 7 gate; the PR body says "Part of #918", never "Closes #918".
5. **Evidence.** Rerun the required checks from `rebase-parity-g.md` with both front doors built from this head (including the I1 `runnerKeys` assertion in E's fixture and the A+G assistant-key e2e). Judge the two flag-on CT-11 FAIL rows: confirm they were probe defects and not product behavior.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never use ports 4317, 11434, 1234, 41343; no real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `a37c93c29`, findings with severity and code references, commands with results. Report with `orca orchestration worker_done`. Always end with worker_done.
