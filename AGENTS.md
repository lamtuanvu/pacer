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
