# UI and accessibility rules

Applies to: `app/**` (web UI and tray popover), `src/dashboard/**` and `src/render/**` (TUI and status line), `desktop/**`.
Out of scope: CLI `--json` output (see the API rules) and brand artwork under `design/`.
Owner: @lamtuanvu
Canonical sources: [UI implementation spec](../../docs/specs/2026-10-16-ui-implementation-design.md) (accessibility section), [UI functionality spec](../../docs/specs/2026-10-16-ui-functionality-design.md), `app/src/ds/` (tokens.json → generated CSS/TS), `app/build.ts`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| UI-1 | Web and tray UI use Preact and the in-repo design system (`app/src/ds/`). Colors and spacing come from design tokens (`scripts/ds-sync.ts`), not ad-hoc values. | Established | app/src/ds; UI implementation spec | Review |
| UI-2 | Accessibility: controls have accessible names, the current page carries `aria-current`, pages have landmarks and a skip link, and status is never shown by color alone. Contrast is ≥ 4.5:1, focus rings are always visible, live regions are polite, and `prefers-reduced-motion` is honored. | Established | UI implementation spec (accessibility section) | Review; manual VoiceOver check |
| UI-3 | Bundle budgets: app ≤ 60 KB gzip, terminal ≤ 150 KB gzip. | Established | `app/build.ts` | `bun run app:build` |
| UI-4 | The TUI honors `NO_COLOR` and `PACER_NO_ANIM`. | Established | `src/dashboard/` | Tests |
| UI-5 | Retired (0.5.0). Was: the Orca panel is static, script-free HTML. The Orca plugin is removed. | Retired (0.5.0) | ADR retire-orca-plugin | — |
| UI-6 | Every surface renders from the shared view model and vocabulary (`src/view-model/`) and the golden fixture `test/fixtures/ui/snapshot.json`. | Established | view-model tests | `bun run test` |
| UI-7 | Add automated accessibility checks (e.g. axe on rendered app pages) to the test suite. | Proposed | No automated a11y tests today | Pending decision |

### Visual craft (UI-8 to UI-18)

These rules apply to `app/**`. They came from a review of every app screen on 2026-10-19 (tracking issue: #134). Each one names a failure that review found.

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| UI-8 | No browser-default controls. Links, disclosures (`<details>`), checkboxes, selects and range inputs render through a `ds/` component or a `ds/` class. A link inside running text may be underlined; any other link is a quiet button or a styled text action. | Established | Unstyled blue links, ▶ markers and native checkboxes on every screen | Review; screenshot |
| UI-9 | One type scale from tokens. A page title appears once, in the top bar. Sections use the single `ds/` section-heading style, and no screen invents its own heading size. No `font-size` in px outside `ds/`. | Established | Four section-heading styles; title shown two or three times | `bun run ui:check`; review |
| UI-10 | One status vocabulary. Each task, session, executor and pace state maps to one label, tone and glyph, taken from `src/view-model/`. The same fact uses the same color on every screen, and a list and its detail view never disagree. | Established | Claude 37% orange in one place, green in another; "waiting for review" next to "Failed" | View-model tests; review |
| UI-11 | Truncate by layout, not by character count. Display text is clipped with CSS (ellipsis or line clamp), and the full text stays reachable (`title` or the detail view). Code, paths, ids and commands never wrap mid-token: they scroll horizontally or break at separators. | Established | `src/core/short-title.ts` cuts titles mid-phrase; paths and task ids break mid-word | Review; screenshot at 1440 and 375 px |
| UI-12 | No internal strings in the UI. Enum values, reason codes, hook names, raw log lines and classifier jargon are mapped to plain copy in the view model. Technical detail may appear only inside a labelled, collapsed disclosure, in the mono style. | Established | "ok, used 0%; codex busy", "Kind (corrects the classifier)", `hook: PostToolUse` | Review |
| UI-13 | Only offer actions that can work. An ended, failed or removed item shows no action that cannot succeed. A disabled control is shown only with a visible reason; "unavailable" buttons are not rendered. | Established | "Accept and bring back" with the worktree gone; "Take over" on an ended session | Review; live check |
| UI-14 | One primary action per region. Repeated rows use secondary or quiet buttons, or make the whole row the target. The primary style marks the one next step on the screen. | Established | 30 identical black "Review" buttons; a "Replay" button in every row | Screenshot |
| UI-15 | Show each fact once per screen. A count, a pace or a status is stated in one place, and other places link to it. | Established | Pace shown four times and the 31 count three times on Overview | Review |
| UI-16 | Alignment and containment. Content has a max width. Repeated rows put pills and numbers in fixed-width columns with `tabular-nums`. Every bordered box is closed on all sides. A label sits next to its control. A secondary nav stays visible while its page scrolls. | Established | Ragged Sessions columns; open-bottomed Settings boxes; checkbox 1500 px from its label; Settings nav scrolls away | Screenshot |
| UI-17 | Readable time. Times within today read "10:24", yesterday reads "Yesterday 10:24", within a week reads the weekday, and anything older reads the date. A duration says what it measures ("ran 25m", "ended 25m ago"). | Established | "Sun 10:24" for yesterday; bare "25m" | View-model tests |
| UI-18 | Visual evidence. A PR that changes `app/**` includes before/after screenshots of each changed screen at 1440 px in light and dark mode, plus 375 px when the layout changes. Screenshots stay under `.work/` or in the PR, never in tracked files (P9). | Established | Detail-level regressions are invisible in a diff | PR description; QA reviewer |

### Shared foundation enforcement (amendment 0.4.0)

UI-19–UI-25 are **Proposed — adopted by the maintainer merging the amendment PR**. Existing UI-1–UI-18 stay in force. The approved design specifies the implementation; approval of the design does not independently adopt governance.

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| UI-19 | `app/src/ds/` owns native interactive controls and presentation patterns. Consumers compose canonical Button/LinkButton, Field/controls, Disclosure, Dialog, segmented filters and shared rows/cards; screens bind domain state/actions. No raw button/input/select/textarea/details outside DS. A native anchor must use a literal canonical `pc-inline-link`, `pc-text-action` or `pc-btn` class, or a shared link component. Shared rows never nest interactive targets. | Proposed 0.4.0 | [shared-foundations ADR](../../docs/decisions/2026-10-19-shared-ui-foundations.md) | `ui:check`; DOM and keyboard tests; UI review |
| UI-20 | DS presentation imports only DS modules, Preact and shared `src/view-model/` descriptors. It never imports consumers, API/store/domain state or core. Shared presentation receives data and callbacks through props; density belongs to DS. TUI/panel consume shared vocabulary, not Preact components. | Proposed 0.4.0 | ADR; ARCH-1/6 | `ui:check`; architecture review |
| UI-21 | Every authored app visual value uses generated tokens: color, type scale/weight/line height/tracking, spacing, radii, control dimensions, shadows, layers and motion. This includes DS CSS, tray, terminal wrappers, shorthands, inline/DOM styles, custom-property definitions and var fallbacks. Layout-only structure is allowed; it must not redefine primitive appearances. See the exact literal categories below. | Proposed 0.4.0 | UI-1/9; audit #191 | `ui:check` negative fixtures; catalog review |
| UI-22 | A new or changed shared component updates `docs/design-system.md`: API/variants/density, states, semantics/keyboard use, ownership and production consumers. The catalog records justified retained specialized layouts. Add variants centrally instead of overriding a primitive in a screen. | Proposed 0.4.0 | Single foundation with domain composition | Catalog/diff review; component behavior tests |
| UI-23 | Copied/adapted upstream components preserve the full license plus per-component source path, pinned revision and material adaptation notes in the catalog. No full demo app, analytics or paid icon dependency. | Proposed 0.4.0 | MIT Beautiful UI adaptation; bundle budgets | License/source map review; app build |
| UI-24 | UI-affecting PRs include an implementer compliance report and independent UI/accessibility plus QA reports, per constitution 0.4.0. Reports identify base/head, scope, rules, actual checks/evidence and PASS/FAIL/UNVERIFIED verdicts. Required screenshots, keyboard/focus, contrast and CT-11 evidence cannot be replaced by source inspection or a checked checkbox.  A PR whose UI-scoped changes are only version strings (release bumps) needs no reports; CI verifies every changed line (amendment 0.6.0 proposed).| Proposed 0.4.0 | Evidence before merge; human merge authority | PR evidence manifest check; actual reviewer reports and maintainer review |
| UI-25 | The deterministic checker scans every authored `app/src/` TS/TSX/JS/JSX/CSS subtree, including terminal/tray/new directories. Run `bun run ui:check`; negative fixtures prove meaningful bypasses fail. No file-wide baseline, generated-name heuristic or inline suppression comment. An exception requires the maintainer's recorded scope/symbol/rule/reason/owner/expiry, a narrow checker change and a regression proving neighboring cases still fail. | Proposed 0.4.0 | Existing narrow guards missed terminal/range/font shorthand | CI; negative tests; exception log |

#### Literal categories and checker limits

- Generated ownership excludes exactly `app/src/ds/tokens.css` and `app/src/ds/tokens.ts`; authored inputs are `tokens.json`/`tokens.local.json`, validated by the token generator/freshness tests. A generated comment, suffix or a token-named file elsewhere is not an exclusion.
- Structural CSS keywords, zero, percentages, grid `fr`, viewport canvas dimensions and unitless flex/grid proportions are layout. Numeric multiplication/division of a token in `calc()` derives from that token; a literal length added to it remains a violation. Responsive at-rule breakpoints, opacity and transform geometry do not define the type/spacing scale. SVG viewBox/path/shape dimensions and intrinsic 1em icon width/height are geometry, not CSS style exemptions.
- Only 1px border/outline hairlines may be literal; other strokes/focus sizes use tokens. Type resets (`inherit`, `normal`, zero tracking), transparent/currentColor/inherited colors and circular percentage radius are semantic values. Named/hex/function colors, font shorthand literals and var fallback literals still fail.
- `UsageMeter`'s `--used`/`--pace` values come only from its unitless `clamp()` data adapter. Brand `--agent-size`/`--mark-size` pixel templates use only their `size` parameter in the respective canonical AgentMark/Mark file. Terminal viewer `scale()` may assign only width/height from measured `screen.offsetWidth`/`offsetHeight` or the exact PTY cols/rows × fontSize geometry; neighboring properties, functions and arbitrary lengths are rejected. These are scoped geometry adapters, not permission to put visual literals or arbitrary custom properties inline.
- Uninspectable dynamic inline visual values, style-object spreads/computed keys and dynamic DS module specifiers fail closed. Factory props and locally resolvable JSX props objects are inspected recursively for style values; unknown native-attribute forwarding alone is not treated as authored styling. Explicit style-bearing props still require inspectable token objects. DOM cssText is checked as declarations; computed DOM style keys must resolve to a string literal. CSS property identifier escapes are decoded; physical/logical size equivalents and border/outline thickness keywords obey the same token ownership. DS CSS imports accept quoted strings and quoted/unquoted url() only when the path stays within DS; external or uninspectable paths fail. Rendering attributes and complex runtime styling still need reviewer inspection: a source check does not prove accessible names, correct action behavior, no nested targets, visual quality or native host behavior.
- Reports/artifacts stay in untracked `.work/` locally or attached/linked in the PR. A local path alone is not accessible to PR CI or the maintainer reviewing remotely; publish an accessible review/evidence reference in the PR manifest.
- Draft reports may state FAIL or UNVERIFIED honestly, while current SHAs, links, summaries and all source checks remain required. All three reports must PASS once ready for review; CI reruns on both draft transitions. Draft CI success does not satisfy completion or before-merge validation.

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
12. Are primitives/composites canonical, token checks passing, and catalog/provenance current? (UI-19–23/25)
13. Do the compliance, independent UI and QA reports contain real checks and accessible evidence, with outstanding surfaces marked UNVERIFIED? (UI-24; CT-11)

Relevant reviewers: [ui-accessibility](../reviewers/ui-accessibility.md)
Exceptions and open decisions: UI-7 remains proposed. UI-19–UI-25 are the 0.4.0 amendment proposal; see [decisions.md](../decisions.md).
