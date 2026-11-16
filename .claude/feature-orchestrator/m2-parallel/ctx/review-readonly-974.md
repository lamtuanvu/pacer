# Task: independent QA and architecture review of the #974 fix — read-only store on a cleanly closed WAL database (REPO-10)

Executor: cursor-agent (default model, frontier tier: SQLite open semantics in two runtimes and a new shared opener in `pacer-store`). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. In zsh, pass test file lists as separate words.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/readonly-974, branch `fix/readonly-store-wal`, head `a94e1b5af` on `main` `ea5d766f4`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-handoff.md; brief `.claude/feature-orchestrator/m2-parallel/ctx/readonly-store-974.md`; issue #974; `.work/reviews/w4-5a-review.md` F3 (the original measurement); rules `.project/rules/{architecture,rust,rust-crates,code-and-testing,security}.md`, `.project/reviewers/{qa,architecture}.md`; `.agents/skills/project-review/SKILL.md`.

Verify:
1. **Behaviour.** The rule "a WAL-mode store whose WAL is absent or empty opens immutable when a plain open would have to create `-wal`/`-shm`; the first read is part of the fallback" is the same in `src/dispatch/readonly.ts` and `pacer_store::read_only`. Check correctness of `immutable` against a store a live writer may open concurrently (stale reads, torn reads, a writer starting between the check and the open): is reading immutable safe when the WAL might appear a moment later, and what does each side return then? Strict and non-strict semantics for garbage, missing tables, locked stores and missing files are unchanged. No file is ever created.
2. **Architecture.** The shared opener's layer (`pacer-store`), dependency direction (`cargo xtask deps`), the duplicates in `pacer-dispatch` and `pacer-lifecycle` removed, public API minimal, CRATE-1 sizes.
3. **Tests.** The new differential cases (clean WAL writable/read-only, strict/not; live WAL; locked; `files.search` on a clean WAL store) are meaningful and red on main and with either half reverted; reproduce at least two reds. fmt, clippy `-D warnings`, crate tests (`pacer-store`, `pacer-dispatch`, `pacer-lifecycle`), `xtask loc`/`deps`, typecheck, the affected bun suites with both front doors built from the head.
4. **Follow-ups.** Judge the busy-timeout difference (rusqlite 5 s vs Bun 0) — is it user-visible on these read paths now? — and Bun on Linux not exercised.
5. **CT-11.** Judge the live evidence (7 PASS, 3 UNVERIFIED).
6. Commit signed off, Conventional, no machine paths.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-review.md with verdict (PASS / FAIL / UNVERIFIED) against `a94e1b5af`, findings with severity and code references, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.
