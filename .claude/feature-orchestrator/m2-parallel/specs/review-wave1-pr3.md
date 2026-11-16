# Task: independent review of wave 1 PR 3 (REPO-10) — native project strategies and previews with a broken strategy file

Executor: cursor-agent (default model), independent reviewer. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p <crate>` / `cargo clippy -p <crate>` for touched crates (debug, existing `target/`), `cargo xtask loc --check`, and focused `bun test` files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr3, branch `fix/native-project-strategy-broken-strategy`, base origin/main `acab1eca4`, head `477476299` (1 commit, 14 files, +582/−45). Implementer handoff `.work/reviews/wave1-pr3-handoff.md` and review packet `.work/reviews/wave1-pr3-review-request.md`. Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md (decisions at the top, sections 1c and 1f, "PR 3").

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/{protocol-compat,qa,architecture}.md` and `.project/rules/{rust,rust-crates,api-protocol,code-and-testing,repository}.md`.

Review:
1. Parity (RUST-7): for a missing and a schema-invalid strategy, native `project.strategy.list/get/set/remove` reply exactly as TypeScript (code `internal`, message, hint) and `strategy.preview` replies `invalid_input` plus `STRATEGY_HINT`. Broken `project-strategies.json` replies match TypeScript's text and code. Compare against `src/core/project-strategies.ts`, `src/config/project-strategies.ts`, `src/config/strategy.ts`, `src/strategy/service.ts`, `src/api/ops.ts`.
2. The forward predicate: only Bun or Node text cases (YAML syntax including empty documents, I/O errors), unnormalized paths, and FIFO or device policy files still forward. Look for an input that now goes native but whose TypeScript reply text comes from Bun or Node, or a FIFO read that could block Rust.
3. The validator fix in `crates/lifecycle/src/projects.rs` (an own `__proto__` key that `z.record` drops): correct against Zod 4 and the 59-input corpus; corpus inputs really ran through TypeScript, not a Rust restatement. CRATE-1: `pacer-lifecycle` is over 8,000 LOC; check the "why and named split" text in the handoff is adequate for the PR description.
4. Tests: stdio and HTTP differential coverage, SSE event comparison, and the lock race actually race (not serialized by the test); each new native path fails if reverted to forwarding (spot-check one by mutation in a scratch copy, then restore).
5. Ledger rows 125 and 131 in `docs/testing/m2-ledger.md` describe the new residuals accurately; generated docs regenerated if required; CHANGELOG `[Unreleased]` entry present and accurate (REPO-7).
6. CT-11: the live report covers CLI and HTTP. Are the two UNVERIFIED items justified: the web Dispatcher screens (implementer had no browser tool; check whether the harness's UI evidence tooling in `scripts/live/` and docs/testing/live-validation.md could reach them), and live stdio for these ops (D3 refusal)? Say which a follow-up worker should exercise.
7. REPO-4: signed-off commit, Conventional Commit subject, maintainer identity; no `.work/` paths, machine paths or personal emails in added lines.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr3/.work/reviews/wave1-pr3-review.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity; findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Do the read-only review above. Report with orca orchestration worker_done.
