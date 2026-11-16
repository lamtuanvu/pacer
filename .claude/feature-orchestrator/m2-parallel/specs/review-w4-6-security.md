# Task: independent security review of M2 wave 4 W4-6 — the dispatch-parts Core kinds behind native `dispatch.preview` / `dispatch.explain` (REPO-10)

Executor: cursor-agent (default model, frontier tier: new sealed private Core kinds that spawn executor `--version` and read the task store). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME; if `sccache` misbehaves, use `RUSTC_WRAPPER=`. An architecture/QA reviewer works in parallel in the same worktree; if `cargo` waits on the target-dir lock, wait.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-6, branch `feat/w4-dispatch-preview-native`, head `84b225a05` on `origin/main` `511a08543`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-handoff.md (see "Deviations" 4: the HTTP `/_internal/dispatch-parts` route checks the bearer only, not `PACER_WORK_GRANT`, as W4-4's `/_internal/status-broker-parts` does); brief `.claude/feature-orchestrator/m2-parallel/ctx/w4-6.md`; plan §3 (the `dispatch.enforcement-exclusions` row: input, output, 30 s deadline); W4-4's review `.work/reviews/w4-4-review.md` (the status-broker-parts precedent and its 256 KiB cap follow-up); `.project/reviewers/security.md`, `.project/rules/{security,api-protocol}.md`.

Verify:
1. **Authority.** Who can call the new kinds on HTTP (`/_internal/dispatch-parts`) and stdio (`_internal.dispatch.parts`): only the front door with serve's internal bearer or the owning stdio connection; never a client, executor session, work-grant process, plugin or MCP caller. Judge deviation 4 (bearer only): can a work-grant or executor-session process reach the route, and does it matter given what the kinds return?
2. **Inputs.** The kinds' parameters (repo, runner ids, `cached`, draft parts) are validated in Core; a caller can't make Core spawn an arbitrary binary or arguments, read outside the pacer home and the repo, or write anything (`cached: true` must be read-only; `cached: false` writes only `checkedVersions`/certificates as TypeScript does).
3. **Resource limits.** The 30 s deadline, parallel `--version` spawns bounded by the runner list, process cleanup on timeout or client abort (no orphaned `--version` processes), response size cap (compare W4-4's 256 KiB follow-up), the store opener's zero busy timeout.
4. **Forwarding safety.** A request that should forward can't be answered natively with less checking (executor-session and work-grant callers on `explain`, host runners, plugin engines, relative `repo`), and the selective predicate can't be bypassed by parameter shape (unknown keys, type confusion, unicode).
5. **No secrets.** Replies, errors, traces and logs carry no internal bearer, owner key or account credential; `--version` output is bounded and not echoed beyond what TypeScript shows.
6. Run the security-relevant tests and a few hostile probes of your own against front doors built from `84b225a05` (fixture homes, fake executors, separate port; stop everything you start). Commit signed off; no machine paths or personal emails.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-6-security-review.md with verdict (PASS / FAIL / UNVERIFIED) against `84b225a05`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-w4-6-security.md exactly. End with orca orchestration worker_done.
