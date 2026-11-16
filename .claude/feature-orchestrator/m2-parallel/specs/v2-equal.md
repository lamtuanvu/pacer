# Task: same-seed /v2 snapshot equality (native vs TypeScript, head vs main)

Executor: codex. Every comparison below must have a result before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9. Check that `git status --short` is clean. Read `.work/reviews/live-replay-replay-split.md` (the /v2 row) and `.work/live/replay-split-v2/evidence/` (normalizer, raw snapshots, `v2.diff`). The earlier diff compared head against an old saved snapshot, not against a fresh same-seed run.

Fetch the v2 snapshot exactly as replay-split-v2 did (same route and auth), immediately after `live up` and before any write, in three fresh sessions that all use `--seed ui`:

| Session | Start |
| --- | --- |
| `v2eq-head-rust` | this worktree, `bun run live up --front-door rust --native-test-ops --seed ui` |
| `v2eq-head-ts` | this worktree, `bun run live up --seed ui` (TypeScript front door) |
| `v2eq-main-ts` | a scratch detached worktree of main a8331c6b4: `git worktree add --detach /tmp/pacer-v2eq a8331c6b4`, then `bun install --frozen-lockfile` and `bun run live up --seed ui`. Remove the worktree afterwards |

Normalize only genuinely dynamic values: seq, load, memory pressure, timestamps, absolute home paths, and task ids. Map task ids by title, not by order, because the previous diff's `<task5>` and `<task6>` swaps came from order-based numbering. Write the normalizer to `.work/fixtures/v2eq-normalize.ts` and list each rule.

| Comparison | Meaning |
| --- | --- |
| C1 head-rust vs head-ts | the native v2 projection equals TypeScript at the same revision |
| C2 head-ts vs main-ts | v2 changes this branch introduced in TypeScript |
| C3 head-rust vs main-ts | what a v2 client sees after this PR |

For every remaining difference (for example the `work` blocks on managed tasks), say which side and which code produces it (file:line), whether main's TypeScript v2 output also contains it, and classify it as equal-after-normalization, intended (cite the ledger, CHANGELOG or tests), or a defect.

Rules:
- Use the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME. Do NOT wrap `live up` in sbx-deny.
- Run one session at a time, stopping each with `bun run live down --keep`.
- Use session ids prefixed `v2eq-`. Another worker runs `sync-live-*` sessions in this worktree; never stop them.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/live-replay-v2-equal.md`:
- each session's report path and Summary line (add a harness note per comparison);
- the normalizer rules;
- C1–C3, each with its diff file path and verdict;
- the classification of every difference;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.
