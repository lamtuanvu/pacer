# Agent conventions

## Where working documents go

This repository is public. Agent working files stay out of git.

| Document | Location | Tracked |
| --- | --- | --- |
| Implementation plans (superpowers `writing-plans`) | `.work/plans/YYYY-MM-DD-<feature>.md` | no |
| Code reviews, verdicts, task briefs | `.work/reviews/` | no |
| Transcripts, captured tool output, scratch fixtures | `.work/fixtures/` | no |
| Design specs (superpowers `brainstorming`) | `docs/specs/YYYY-MM-DD-<topic>-design.md` | yes |
| Architecture decisions (ADRs) | `docs/decisions/NNNN-<title>.md` | yes |

These locations override the `docs/superpowers/...` defaults in the superpowers skills.
Do not commit anything under `.work/`. Summarize the plan in the PR description instead.

Tracked files must not contain machine-specific paths (`/Users/...`, `/Volumes/...`) or personal emails.
Test fixtures that are needed go in `test/fixtures/` and use `$HOME` or temp-dir paths.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). PRs are squash-merged, so the PR title becomes the commit on `main`.
Sign off every commit (`git commit -s`); the DCO check rejects PRs with unsigned commits. See CONTRIBUTING.md.

## Project context

Before working, read `.agents/skills/project-governance/SKILL.md`, `.project/constitution.md` and `.project/context.md`. Repository-local skills are tracked and require no global installation. If your agent does not discover `.agents/skills/`, read the referenced files directly; Claude adapters under `.claude/skills/` point to the same instructions.
From the context index, load the scoped rules (`.project/rules/`) and reviewer definitions (`.project/reviewers/`) that match the areas your task touches. Pass these references and the applicable rule IDs to any workflow you select and to any reviewer you delegate to. Keep the project's established constraints in effect through planning, implementation and review. Surface conflicts and unresolved decisions (`.project/decisions.md`). Change a rule only through the amendment process in the constitution.

## Agent work routing

If you are the planner, follow REPO-11 to REPO-14 in [.project/rules/repository.md](.project/rules/repository.md#repo-11-to-repo-14-agent-work-routing) (proposed, amendment 0.15.0). In short, delegate execution through pacer as the current mode requires, pick the smallest model tier that can do the job for any work on your side, and record the choice in each brief and report. Executors don't delegate further except through an API-5 grant.

## Definition of done

A task that changes runtime behavior is done only after it passes live validation with the harness (`bun run live`). Follow [docs/testing/live-validation.md](docs/testing/live-validation.md) and include the evidence report's summary in the result (rule CT-11). Report surfaces you could not exercise as UNVERIFIED.

Before delivering changed code as complete, follow [.agents/skills/project-review/SKILL.md](.agents/skills/project-review/SKILL.md): obtain independent project review, fix confirmed blocking findings, rerun affected validation, and independently review the fixes against the final revision (REPO-10). Store reports under `.work/reviews/` and summarize the evidence in the result and PR. Documentation and skill changes also require a proportionate repository-rule review. Missing independent review or unresolved required checks mean UNVERIFIED/incomplete, not done.
