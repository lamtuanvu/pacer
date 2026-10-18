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

Before working, read `.project/constitution.md` and `.project/context.md`.
From the context index, load the scoped rules (`.project/rules/`) and reviewer definitions (`.project/reviewers/`) that match the areas your task touches. Pass these references and the applicable rule IDs to any workflow you select and to any reviewer you delegate to. Keep the project's established constraints in effect through planning, implementation and review. Surface conflicts and unresolved decisions (`.project/decisions.md`). Change a rule only through the amendment process in the constitution.

## Definition of done

A task that changes runtime behavior is done only after it passes live validation with the harness (`bun run live`). Follow [docs/testing/live-validation.md](docs/testing/live-validation.md) and include the evidence report's summary in the result (rule CT-11). Report surfaces you could not exercise as UNVERIFIED.
