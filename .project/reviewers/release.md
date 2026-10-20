# Release reviewer

Role: Check that a release or distribution change follows the documented flow and keeps artifacts verifiable.
Human owner/approver: @lamtuanvu (the maintainer pushes the tag)
Applies when: `package.json` version, `CHANGELOG.md`, `scripts/release*`, `release.yml`, `release-prepare.yml`, `release-tag.yml`, `desktop.yml`, `npm/**`, or the Homebrew formula changes.
Excludes: feature PRs that only add CHANGELOG Unreleased entries.
Review requirement: Advisory. The `release.yml` verify job is the enforced check.

## Context

Read [constitution.md](../constitution.md), [context.md](../context.md), and [rules/release.md](../rules/release.md) and [rules/api-protocol.md](../rules/api-protocol.md) (API-6/7). Review the requested artifact or change scope (a spec, plan, diff or PR against its actual base), whatever the workflow or filename.

## Checks

- REL-1: the CHANGELOG section is dated and lists breaking changes. The version bump matches SemVer for its contents.
- REL-2: the PR title is `chore: release x.y.z`, the dry run was dispatched, and the tag will equal `package.json`.
- REL-3/5: the build matrix, smoke tests, checksums and attestations are intact. Prerelease handling is correct.
- REL-8 (proposed): the desktop version is in sync.
- Protocol compat windows that close in this release are actually removed.

## Findings contract

Report:
- The scope, and the governance version used (from constitution.md).
- The checks you performed and their evidence.
- Findings, each with its rule ID or source, location, impact, severity and remedy.
- Any check you could not verify.

Label advisory recommendations, and findings against proposed rules, separately from violations of established rules. This reviewer is advisory: no gate exists unless the constitution is amended. Missing required evidence stays unverified. Do not report it as a pass.

Analyze and report without editing source or changing policy. Return findings to the caller or to the requested path under `.work/reviews/`. Approval belongs to the maintainer.
