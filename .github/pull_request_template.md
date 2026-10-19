## Summary

Describe the problem and resulting behavior.

## Linked issue

Link the issue, or explain why none is needed.

## How tested

List commands actually run and results, including manual checks. For runtime changes, link/summarize the CT-11 live report with a verdict for every changed behavior and affected surface. Required FAIL or UNVERIFIED behavior remains outstanding.

## UI evidence

For UI-affecting changes, attach accessible implementer compliance, independent UI/accessibility and independent QA reports. Each report names reviewed base/head, governance version, scope/rule IDs, actual checks/evidence, findings with severity/remedy and PASS/FAIL/UNVERIFIED surfaces. Include UI-18 before/after screenshots (1440 light/dark, 375 when layout changes, tray 340 when affected), keyboard/focus, contrast/reduced-motion and applicable CT-11 evidence. Update the component catalog/provenance when shared APIs change.

CI requires the following JSON manifest for UI changes. Replace the SHA and report placeholders after review; update the PR body when new commits require review. All three verdicts must be PASS with actual summaries and concrete HTTPS report/comment URLs or `artifact://artifact-name/report-path` references. A checkbox or local `.work/` path alone is insufficient. Metadata validation does not prove the reports: the maintainer inspects actual evidence and retains merge/exception authority. Non-UI PRs may remove this section.

<!-- pacer-ui-evidence
{
  "version": 1,
  "base": "REVIEWED_BASE_SHA",
  "head": "REVIEWED_HEAD_SHA",
  "compliance": { "verdict": "PENDING", "report": "REPORT_URL", "summary": "Applicable UI rule results and command evidence" },
  "ui": { "verdict": "PENDING", "report": "REPORT_URL", "summary": "Independent UI/accessibility findings and visual evidence" },
  "qa": { "verdict": "PENDING", "report": "REPORT_URL", "summary": "Independent QA findings, live report and affected surface verdicts" }
}
-->

## Checklist

- [ ] PR title follows Conventional Commits (governance amendments use `docs:`).
- [ ] All commits are signed off with `git commit -s` (DCO).
- [ ] `bun run test`, `bun run typecheck` and `bun run ui:check` pass.
- [ ] Documentation and CHANGELOG are updated for behavior changes.
- [ ] Generated token/app/plugin assets are rebuilt when their inputs changed.
- [ ] Required evidence reports are linked above; any exception is recorded with maintainer, scope and expiry in `.project/decisions.md`.
