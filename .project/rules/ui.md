# UI and accessibility rules

Applies to: `app/**` (web UI and tray popover), `src/dashboard/**` and `src/render/**` (TUI and status line), the Orca panel HTML in `orca-plugin/`, `desktop/**`.
Out of scope: CLI `--json` output (see the API rules) and brand artwork under `design/`.
Owner: @lamtuanvu
Canonical sources: [UI implementation spec](../../docs/specs/2026-10-16-ui-implementation-design.md) (accessibility section), [UI functionality spec](../../docs/specs/2026-10-16-ui-functionality-design.md), `app/src/ds/` (tokens.json → generated CSS/TS), `app/build.ts`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| UI-1 | Web and tray UI use Preact and the in-repo design system (`app/src/ds/`). Colors and spacing come from design tokens (`scripts/ds-sync.ts`), not ad-hoc values. | Established | app/src/ds; UI implementation spec | Review |
| UI-2 | Accessibility: controls have accessible names, the current page carries `aria-current`, pages have landmarks and a skip link, and status is never shown by color alone. Contrast is ≥ 4.5:1, focus rings are always visible, live regions are polite, and `prefers-reduced-motion` is honored. | Established | UI implementation spec (accessibility section) | Review; manual VoiceOver check |
| UI-3 | Bundle budgets: app ≤ 60 KB gzip, terminal ≤ 150 KB gzip. | Established | `app/build.ts` | `bun run app:build` |
| UI-4 | The TUI honors `NO_COLOR` and `PACER_NO_ANIM`. | Established | `src/dashboard/` | Tests |
| UI-5 | The Orca panel is static, script-free HTML that shows information only. | Established | ADR orca-plugin-information-only | Review; panel tests |
| UI-6 | Every surface renders from the shared view model and vocabulary (`src/view-model/`) and the golden fixture `test/fixtures/ui/snapshot.json`. | Established | view-model tests | `bun run test` |
| UI-7 | Add automated accessibility checks (e.g. axe on rendered app pages) to the test suite. | Proposed | No automated a11y tests today | Pending decision |

Relevant reviewers: [ui-accessibility](../reviewers/ui-accessibility.md)
Exceptions and open decisions: UI-7.
