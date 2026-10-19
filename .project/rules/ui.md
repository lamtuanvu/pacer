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

### Visual craft (UI-8 to UI-18)

These rules apply to `app/**`. They came from a review of every app screen on 2026-10-19 (tracking issue: #134). Each one names a failure that review found.

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| UI-8 | No browser-default controls. Links, disclosures (`<details>`), checkboxes, selects and range inputs render through a `ds/` component or a `ds/` class. A link inside running text may be underlined; any other link is a quiet button or a styled text action. | Established | Unstyled blue links, ▶ markers and native checkboxes on every screen | Review; screenshot |
| UI-9 | One type scale from tokens. A page title appears once, in the top bar. Sections use the single `ds/` section-heading style, and no screen invents its own heading size. No `font-size` in px outside `ds/`. | Established | Four section-heading styles; title shown two or three times | Review; `grep font-size` |
| UI-10 | One status vocabulary. Each task, session, executor and pace state maps to one label, tone and glyph, taken from `src/view-model/`. The same fact uses the same color on every screen, and a list and its detail view never disagree. | Established | Claude 37% orange in one place, green in another; "waiting for review" next to "Failed" | View-model tests; review |
| UI-11 | Truncate by layout, not by character count. Display text is clipped with CSS (ellipsis or line clamp), and the full text stays reachable (`title` or the detail view). Code, paths, ids and commands never wrap mid-token: they scroll horizontally or break at separators. | Established | `src/core/short-title.ts` cuts titles mid-phrase; paths and task ids break mid-word | Review; screenshot at 1440 and 375 px |
| UI-12 | No internal strings in the UI. Enum values, reason codes, hook names, raw log lines and classifier jargon are mapped to plain copy in the view model. Technical detail may appear only inside a labelled, collapsed disclosure, in the mono style. | Established | "ok, used 0%; codex busy", "Kind (corrects the classifier)", `hook: PostToolUse` | Review |
| UI-13 | Only offer actions that can work. An ended, failed or removed item shows no action that cannot succeed. A disabled control is shown only with a visible reason; "unavailable" buttons are not rendered. | Established | "Accept and bring back" with the worktree gone; "Take over" on an ended session | Review; live check |
| UI-14 | One primary action per region. Repeated rows use secondary or quiet buttons, or make the whole row the target. The primary style marks the one next step on the screen. | Established | 30 identical black "Review" buttons; a "Replay" button in every row | Screenshot |
| UI-15 | Show each fact once per screen. A count, a pace or a status is stated in one place, and other places link to it. | Established | Pace shown four times and the 31 count three times on Overview | Review |
| UI-16 | Alignment and containment. Content has a max width. Repeated rows put pills and numbers in fixed-width columns with `tabular-nums`. Every bordered box is closed on all sides. A label sits next to its control. A secondary nav stays visible while its page scrolls. | Established | Ragged Sessions columns; open-bottomed Settings boxes; checkbox 1500 px from its label; Settings nav scrolls away | Screenshot |
| UI-17 | Readable time. Times within today read "10:24", yesterday reads "Yesterday 10:24", within a week reads the weekday, and anything older reads the date. A duration says what it measures ("ran 25m", "ended 25m ago"). | Established | "Sun 10:24" for yesterday; bare "25m" | View-model tests |
| UI-18 | Visual evidence. A PR that changes `app/**` includes before/after screenshots of each changed screen at 1440 px in light and dark mode, plus 375 px when the layout changes. Screenshots stay under `.work/` or in the PR, never in tracked files (P9). | Established | Detail-level regressions are invisible in a diff | PR description; QA reviewer |

### Implementer checklist

Before you hand a UI change over, check the screen against this list:

1. Did any browser-default link, ▶ marker, checkbox or select appear? (UI-8)
2. Does the page title appear more than once, or is there a heading style that isn't the `ds/` one? (UI-9)
3. Does every status on the screen agree with its list or detail counterpart, in label and color? (UI-10)
4. Is any text cut mid-word or mid-phrase by code, or does a path or id wrap mid-token? (UI-11)
5. Can a user read every string without knowing pacer's internals? (UI-12)
6. Does every visible button work in the item's current state? (UI-13)
7. How many primary buttons are visible? It should be one per region. (UI-14)
8. Is any number or status repeated on the screen? (UI-15)
9. Are columns aligned, boxes closed and labels next to their controls? (UI-16)
10. Do times and durations read naturally? (UI-17)
11. Are before/after screenshots attached? (UI-18)

Relevant reviewers: [ui-accessibility](../reviewers/ui-accessibility.md)
Exceptions and open decisions: UI-7.
