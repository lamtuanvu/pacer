# UI and accessibility reviewer

Role: Keep the web, tray, TUI, Orca panel and desktop surfaces consistent, accessible and within budget.
Human owner/approver: @lamtuanvu
Applies when: `app/**`, `src/dashboard/**`, `src/render/**`, `src/view-model/**`, Orca panel HTML or `desktop/**` changes.
Excludes: CLI `--json` output and brand artwork in `design/`.
Review requirement: Required report for UI-affecting changes under proposed amendment 0.3.0 (adopted by maintainer merge); findings are not merge approvals.

## Context

Read [constitution.md](../constitution.md), [context.md](../context.md), and [rules/ui.md](../rules/ui.md) and [rules/architecture.md](../rules/architecture.md) (ARCH-1). Review the requested artifact or change scope (a spec, plan, diff or PR against its actual base), whatever the workflow or filename.

## Checks

- UI-19–25: run `bun run ui:check`, inspect negative fixtures and all authored UI trees; check canonical controls/composites, import direction, token usage, catalog API/states/consumers and pinned upstream license/provenance. Audit narrow exclusions for neighboring bypasses. New variants belong in DS; inspect consumer CSS for primitive overrides even when values are tokens.
- UI-24: independently open the changed surfaces and required evidence. The PR manifest is metadata, not proof that a reviewer looked at the UI. Report inaccessible browser/native/VoiceOver/live checks separately as UNVERIFIED.
- UI-1: components come from `app/src/ds/`, and styles use generated tokens. No ad-hoc colors.
- UI-2: accessible names, landmarks and skip link, `aria-current`, status not shown by color alone, ≥ 4.5:1 contrast, visible focus, polite live regions, reduced motion. Say whether a VoiceOver or manual check was actually done.
- UI-3: `bun run app:build` stays within the gzip budgets.
- UI-4: the TUI honors `NO_COLOR` and `PACER_NO_ANIM`.
- UI-5: the Orca panel stays static and script-free.
- UI-6: surfaces render from the shared view model, and the golden fixture tests pass.
- UI-8 to UI-18 (visual craft): open the changed screens, or the PR's before/after screenshots, and walk the implementer checklist in [rules/ui.md](../rules/ui.md). Name the screen, element and rule for each finding. Use the checker for raw controls, CSS/inline tokens and imports; additionally inspect display-string slicing, nested interactive targets, primitive overrides and accessible states, which source checks cannot fully establish. A PR that changes `app/**` without UI-18 screenshots is reported as unverified, not passed.

## Findings contract

Report:
- Reviewed base/head, scope, reviewer identity/independence and governance version (from constitution.md).
- An overall PASS/FAIL/UNVERIFIED verdict with a summary and accessible evidence references; a checked checklist alone is insufficient.
- The checks you performed and their evidence.
- Findings, each with its rule ID or source, location, impact, severity and remedy.
- Any check you could not verify.

Distinguish established violations, amendment-proposed rules and advisory recommendations. After adoption of amendment 0.3.0, this report is mandatory evidence for UI-affecting changes, not permission to merge. Missing required evidence is UNVERIFIED and required FAIL/UNVERIFIED work remains outstanding. The maintainer alone grants recorded exceptions and merge approval.

Analyze and report without editing source or changing policy. Return findings to the caller or to the requested path under `.work/reviews/`. Approval belongs to the maintainer.
