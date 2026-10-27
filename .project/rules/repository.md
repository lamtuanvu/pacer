# Repository hygiene and documentation rules

Applies to: all tracked files, commits and pull requests, and `docs/**`.
Out of scope: untracked `.work/` content (it must just stay untracked).
Owner: @lamtuanvu
Canonical sources: [AGENTS.md](../../AGENTS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), [GOVERNANCE.md](../../GOVERNANCE.md), `.github/pull_request_template.md`, `.github/workflows/pr-title.yml`, `.gitignore`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| REPO-1 | Agent working documents go under the untracked `.work/`: plans in `.work/plans/`, reviews and briefs in `.work/reviews/`, scratch files in `.work/fixtures/`. Never commit them. | Established | AGENTS.md | `git status`; review |
| REPO-2 | Design specs go in `docs/specs/YYYY-MM-DD-<topic>-design.md`. ADRs go in `docs/decisions/`. | Established | AGENTS.md | Review |
| REPO-3 | Tracked files contain no machine-specific paths (`/Users/...`, `/Volumes/...`) and no personal emails. | Established | AGENTS.md | `git grep -nE '/(Users|Volumes)/'` on the diff; Gitleaks |
| REPO-4 | Every commit carries a DCO sign-off (`git commit -s`). | Established | CONTRIBUTING.md | DCO check on PR |
| REPO-5 | PR titles are Conventional Commits. The allowed types are those in `pr-title.yml` (feat, fix, docs, chore, test, refactor, perf, ci, build, revert). PRs are squash-merged. Changes reach `main` only through PRs. | Established | CONTRIBUTING.md; pr-title.yml | CI pr-title |
| REPO-6 | The PR description has Summary, Linked issue and How tested, and completes the template checklist. Significant changes are discussed in an issue first. | Established | PR template; CONTRIBUTING.md | Review |
| REPO-7 | User-visible behavior changes update the matching `docs/*.md` page and add a CHANGELOG Unreleased entry. | Established | PR template ("docs updated"); CHANGELOG | Review |
| REPO-8 | ADR file naming: AGENTS.md says `NNNN-<title>.md`, but every existing ADR uses `YYYY-MM-DD-<title>.md`. Proposal: make the date form canonical and update AGENTS.md. | Proposed | Conflict between AGENTS.md and docs/decisions/ | Pending decision |
| REPO-9 | When a later decision retires part of an ADR, mark that part superseded and fix its broken links (e.g. the 2026-10-12 ADR's `../plans/...` links). Do not leave historical text that reads as current. | Proposed | Stale and broken content observed | Pending decision |

## REPO-10 — independent review before delivery

Amendment 0.10.0: approved for this task by the maintainer's setup instruction;
proposed repository-wide policy until adopted by maintainer merge.

Before delivering changed code as complete, obtain independent project review
using `.agents/skills/project-review/SKILL.md` against all applicable established
rules. Documentation, skill and governance changes require proportionate review
of repository rules and policy consistency; unrelated specialists are unnecessary.
Use the context index to select specialist criteria. Review recommendations remain
advisory; performing review and satisfying established requirements are mandatory.

Blocking findings are confirmed violations of applicable established rules and
confirmed Critical/Important defects (security/data loss, broken required behavior,
or material correctness/regression risks). Proposed-rule suggestions and optional
style preferences do not block by severity label alone. Record evidence-backed
reassessment of disputed findings and explicitly deferred nonblocking suggestions.

The implementer fixes blockers, reruns affected checks and applicable live validation,
and obtains independent review of the fixes and any subsequent changes. Reports
must identify the final reviewed revision (including working-tree content when
uncommitted), reviewer independence, governance version, scope/rule IDs, actual
checks/evidence, findings/resolutions, exceptions and PASS/FAIL/UNVERIFIED verdicts.
Store them in `.work/reviews/`; summarize results in the delivery and PR, making
required evidence accessible to the maintainer without committing `.work/`.

Missing independent review, unresolved blockers or required unverified behavior
prevent a completion claim. If tooling or authorization prevents review, report
UNVERIFIED and the remaining work. Self-review is not independent review. Only the
maintainer grants scoped, expiring exceptions under the constitution. Existing UI
evidence and CT-11 requirements remain in force. This is an agent completion gate;
it does not add automated CI enforcement or grant bots merge approval.

Relevant reviewers: applicable definitions from the context index, plus independent
repository-rule review for every changed work product.
Exceptions and open decisions: REPO-8 and REPO-9.

## REPO-11 to REPO-14: agent work routing

Amendment 0.15.0. Proposed; the rules apply repository-wide once the maintainer merges the amendment. Until then, reviewers report REPO-11 to REPO-14 findings as advisory.
They apply to every agent working in this repository, whatever planner or tool
it uses (P3, ARCH-5). "Planner" means the agent that plans and reviews the task.
"Executor" means an agent that pacer delegates to. REPO-11 to REPO-13 apply to
the planner. An executor never delegates further except through a grant under
API-5.

| ID | Rule | Status | Rationale/source | Verification |
|----|------|--------|------------------|--------------|
| REPO-11 | The planner plans, decides and reviews. Execution goes through pacer (`pacer route <kind> --json`, then `pacer delegate`, then `pacer review <id> --accept\|--reject`) as the current pacer mode requires (the [README mode table](../../README.md)):<br>• in normal, strict and emergency mode, the planner delegates execution;<br>• in relaxed mode, the planner may execute directly but still delegates any task it would split across several agents or sessions.<br>Subagents and parallel sessions running on the planner's own subscription count as the planner doing the work. Execution may also stay with the planner when `pacer route` reports no eligible executor, delegation is paused (`pacer pause`), or pacing is off for the session (`PACER=off`). Read-only helpers and independent reviewers may always run on the planner's side. | Proposed | Constitution purpose; README "Planner policy" modes; [docs/configuration.md](../../docs/configuration.md) | Review: the delivery report names each delegation, or the exception that applied |
| REPO-12 | When work runs on the planner's side, each agent or session uses the smallest model tier that can do that job. The tiers are the planner vendor's model families, ordered by cost:<br>• the smallest family for lookups, status checks and read-only searches;<br>• the middle family for implementation from a written brief, tests, live validation and evidence;<br>• the largest family only for planning and design decisions, security-sensitive changes, and a final independent review when a stronger second opinion is worth the cost.<br>Choose the tier explicitly; don't let a helper inherit the planner's tier by default. | Proposed | Subscription budgets are the resource pacer manages | Review, using the record REPO-13 requires |
| REPO-13 | Every brief, delegation and spawned session names the executor or model tier chosen and why. The result report records what actually ran. | Proposed | Makes REPO-11 and REPO-12 reviewable | REPO-10 repository-rule review checks the reports |
| REPO-14 | Executor briefs require a sandboxed `PACER_HOME`, never the operator's real `~/.pacer`. Any change to pacer state under `PACER_HOME` must be non-destructive: keep or copy the original files, and never rename, rewrite or delete them in place. | Proposed | An executor once renamed real task data while testing a migration | Review the brief; CT-2 and CT-11 keep isolated homes in tests and live runs |

These rules change how agents spend budget and where execution happens. They
don't relax REPO-10 review, CT-11 live validation, the UI evidence gates or the
maintainer's merge authority.
