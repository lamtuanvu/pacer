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

Relevant reviewers: none. Repository checks are covered by CI and maintainer review.
Exceptions and open decisions: REPO-8 and REPO-9.
