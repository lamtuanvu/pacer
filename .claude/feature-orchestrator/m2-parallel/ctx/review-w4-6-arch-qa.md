# Task: independent architecture and QA review of M2 wave 4 W4-6 — native `dispatch.preview` / `dispatch.explain` for ladder engines (REPO-10)

Executor: cursor-agent (default model, frontier tier: two user-facing ops registered natively with selective forwarding and byte-exact parity). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME; if `sccache` misbehaves, use `RUSTC_WRAPPER=`. A security reviewer works in parallel in the same worktree; if `cargo` waits on the target-dir lock, wait.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-6, branch `feat/w4-dispatch-preview-native`, head `84b225a05` on `origin/main` `511a08543`. The author's evidence was gathered on `df1a0fd16`/`8d36e2d4e` (same tree, base `7c03bec27`); the coordinator rebased over #976, resolving the op list in `test/native-dispatch.test.ts` and the ledger totals (native 168, selective 94, forwarded 66).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-handoff.md (F6 decision, forward predicate table, CRATE-1, red evidence, CT-11, deviations, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-6.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (§3, §4, §6 W4-6).
- W4-5b review and handoff, W4-4 review (`.work/reviews/`).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,rust,rust-crates,code-and-testing,api-protocol,repository}.md`, `.project/reviewers/{architecture,qa}.md`. Use `.agents/skills/project-review/SKILL.md`.

Verify:
1. **Architecture.** Crate placement and dependency direction (`cargo xtask deps`); CRATE-1 sizes (`pacer-dispatch-ops` 2,996 is at the 3,000 line; `pacer-server` +98 under #848's exception); the new `pacer-dispatch` `decision.rs` and `pacer-dispatch-ops` `policy.rs`; the `pacer-config`, `pacer-repos` changes; CRATE-11.
2. **Forwarding.** Every case the brief lists forwards, both on HTTP (`serve/mod.rs`) and stdio (`stdio_proxy.rs`), and nothing else does. Judge the deviations: no `conversation?` on the enforcement kind (conversation-ranked explains forward), and the YAML-draft forward.
3. **Parity.** Byte-exact replies vs the TypeScript reference across stdio, HTTP and MCP for the plan's case list; F6 (preview's learned-fit read through the read-only view) agrees with TypeScript's writable reader in every case, including F7 (cleanly closed WAL store) and #978 (locked store, zero busy timeout: strict and not). Read-only proof: `explain` writes no file or DB row.
4. **Tests.** Rerun the new parity file and the handoff's Bun list with front doors built from `84b225a05`; reproduce at least three of the six mutations and add two of your own (e.g. the `cached` flag per op, a predicate edge such as a relative `repo` or host runner); fmt, clippy `-D warnings` (with and without test-ops), crate tests for `pacer-store`, `pacer-dispatch`, `pacer-dispatch-ops`, `pacer-core-bridge`, `pacer-server`; `xtask loc`/`deps`; typecheck.
5. **CT-11.** The handoff's live evidence (7 PASS, 0 FAIL, 3 UNVERIFIED vs the TS front door): are the UNVERIFIED surfaces honest and is the evidence adequate? Rerun at least one native surface (CLI `pacer route --explain` or MCP `dispatch.preview`) on `84b225a05` per docs/testing/live-validation.md with fixture homes, fake executors and a separate port, and stop everything you start.
6. Commit signed off and Conventional; no machine paths or personal emails; the draft PR body is accurate (update numbers for the rebase).

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-review.md with verdict (PASS / FAIL / UNVERIFIED) against `84b225a05`, findings with severity and code references, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.
