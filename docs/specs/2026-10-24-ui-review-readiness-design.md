# UI review readiness

The maintainer requested a reliable agent workflow for UI evidence after repeated
PR failures from stale reviewed SHAs and incomplete reports. Keep `AGENTS.md`
lean: policy belongs in `.project/rules/ui.md`, discovered through the existing
governance and review skills.

## Approach

Instructions alone leave local evidence validation easy to miss. A separate
validator risks drifting from CI. Use a small read-only preflight wrapping CI's
existing `checkUiPullRequest` instead, with canonical procedural instructions in
the UI rules. The maintainer approved this approach in conversation.

`bun run ui:ready --pr <number>` reads current PR metadata with `gh api` and checks
the local git history. `--event <path>` accepts the equivalent event envelope for
a prepared body before PR creation. Both require valid PR metadata; malformed or
unavailable inputs fail closed. `--ready` checks the all-PASS contract even while
the PR is draft. Default draft checks explicitly state that success is only
manifest validity, not completion or review readiness. No writes to GitHub, report
rewrites, automatic PASS verdicts, new dependencies or CI gate relaxation.

The source checker prints that evidence was not checked when invoked without
an event. The rules explain final-revision review, accessible report publication,
draft handling, preflight, and observing current-head CI before completion.
Skills and the PR template link to that single procedure. Correct stale 0.4.0
status labels to match the constitution's recorded adoption of #193.

## Validation

CLI regression tests exercise real temporary git histories and subprocesses:
missing or malformed input, missing manifests, stale base/head, draft incomplete
reports, strict readiness, inaccessible references and the release exemption.
Existing CI evidence tests remain unchanged in meaning. Check real PR metadata
read-only, run typecheck and affected tests, record live CLI evidence, and obtain
independent repository/QA review of the final content. Metadata checks do not
establish the truth or accessibility of the underlying visual evidence.
