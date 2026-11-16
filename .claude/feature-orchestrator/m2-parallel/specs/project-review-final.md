# Task: final independent project review (REPO-10) for the M2 integration PR

Executor: cursor-agent (independent project and repository-rule reviewer). You did not implement these changes. Read-only: don't start live sessions, don't run cargo builds, don't edit tracked files. You may run `git`, `bun .work/fixtures/m2-ledger-check.ts`, `bun run protocol:doc` followed by `git status` (to check the docs are generated, then `git checkout -- docs/` if anything changed), and focused `bun test` files.

Follow `.agents/skills/project-review/SKILL.md`. Read `.agents/skills/project-governance/SKILL.md`, `.project/constitution.md`, `.project/context.md`, `.project/rules/repository.md` (REPO-4, REPO-7, REPO-10 to REPO-14) and the scoped rules and reviewer definitions the context index maps to the touched areas.

Scope: PR #870, worktree /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, base main a8331c6b4 (`git merge-base origin/main HEAD`), head 3c5a87dc3. It merges eight M2 branches (m2/dispatch-ops, m2/account-list, m2/task-send, m2/runner-ops, m2/service-handover, fix/managed-work-actions, m2/setup-doctor, refactor/split-pacer-server) plus integration fixes and two syncs of main.

Prior reviews in `.work/reviews/` (read the verdicts and blocking findings; don't redo their full scope):
- project and integration: m2-integration-project-review.md (FAIL: DCO on four merge commits), -review-a.md, -review-b.md, -review-b-*.md, -review-fix1.md, -review-ledger.md, -review-final.md, -review-sync.md, -review-sync2.md, -review-test.md, -handoff.md;
- QA: m2-integration-qa-final2.md (PASS, including Part A on test commit fff6b18b7);
- UI: m2-integration-ui-final-verdict2.md and the gap reports (a third UI verdict runs in parallel; don't decide UI).

Do:
1. For every FAIL or blocking finding in the prior project and integration reviews, find what resolved it (commit, later review, or CI evidence) at head 3c5a87dc3. List any that remain open.
2. REPO-4: every commit in `git log a8331c6b4..HEAD` has a Signed-off-by trailer (`git log --format='%H %s%n%b' a8331c6b4..HEAD`), Conventional Commit subjects, no `.work/` paths tracked, and no machine paths (`/Users/`, real `/Volumes/` paths) or personal emails added in tracked files (`git diff a8331c6b4 HEAD | rg '^\+' | rg '/Users/|@gmail|@icloud'`).
3. Review the commits after the last reviewed head for correctness and rule compliance: 3a84c194a (decisions.md exception row: scope, authority, expiry, format matching neighbouring rows), 3c5a87dc3 (CHANGELOG entries: accurate against the ledger diff `git diff a8331c6b4 HEAD -- docs/testing/m2-ledger.md` and the managed-action code; protocol docs generated from `scripts/protocol-doc.ts`; the `work` field matches `src/api/read-model/tasks.ts` and `crates/read-model/src/tasks.rs`).
4. REPO-7: do the user-visible changes have matching docs and CHANGELOG entries? Name any that are missing.
5. The ledger checker passes (`bun .work/fixtures/m2-ledger-check.ts`).
6. REPO-13 (advisory): note whether delegation and model tiers are recorded in the reviews.

Write `.work/reviews/m2-integration-project-review-final.md` with: the verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity, governance version; the prior-finding resolution table; findings (rule, severity, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what's unavailable. CI status is outside your verdict; say so.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.
