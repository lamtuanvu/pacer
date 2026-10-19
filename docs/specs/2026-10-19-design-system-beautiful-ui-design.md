# Shared UI foundations and Beautiful UI adoption

Status: Design approved by the maintainer in conversation on 2026-10-19. Implements #191; coordinates with #174 and #134.

## Intent and success criteria

Make pacer's UI consistent by putting reusable controls and presentation patterns in one design system, migrating production consumers, and requiring implementers and reviewers to demonstrate compliance. Adopt Beautiful UI as real shared component implementations, adapted to pacer's stack and workflows.

The requested outcome is a project-wide audit, strict project rules, and high-quality reusable UI. The recommended implementation preserves the existing navigation and workflows, Preact runtime, service/API boundary, status vocabulary, and accessibility requirements. It changes component ownership and presentation, not task execution semantics.

## Approach and alternatives

**Recommended: adapt selected Beautiful UI sources into the in-repo design system.** This provides source ownership, consistent token integration, and small Preact components without adding a second runtime or parallel component library. The tradeoff is responsibility for documenting upstream provenance and maintaining adaptations.

Installing the full React/Tailwind kit would make upstream examples easier to copy, but brings incompatible assumptions, styling overlap, and dependencies that threaten the existing bundle budgets. A token-only visual refresh would be smaller, but would leave duplicated controls and would not fulfill the component adoption requirement.

## Evidence and upstream contract

The audit report is `.work/reviews/191-audit.md`; it records source locations, rule IDs, severity, and remediation. Source inspection and actual visual verification must remain distinguishable. Existing issue #174 findings are a starting point, not assumed current facts: the 6px token already exists and 650 is present in the canonical type scale.

Beautiful UI source is pinned to commit `44a274e598395ab61e7c96c26fda2758780253b7` in https://github.com/slev12397/beautiful-ui. Its README describes copy-paste components using React, Tailwind v4, and shared foundations. Its license is MIT. Preserve the full copyright and license in `app/src/ds/third-party/beautiful-ui-LICENSE`; add a source mapping with upstream paths, revision, adapted files, and differences in `docs/design-system.md`.

Do not install the demo application, analytics, email capture, or the paid icon package referenced by SidebarNav. Use pacer's SVG icon system. Translate the selected components' utility classes into the existing CSS/token pipeline, React types into Preact types, and demo state into component props. Keep the existing theme mechanism and semantic status colors.

## Canonical organization

1. **Tokens:** `app/src/ds/tokens.json` is the authored foundation; generated CSS and TypeScript remain generated. Add missing control-size, weight, shadow, layer, and motion values through the generator's explicit schema. Migrate tray typography and spacing to the same scale.
2. **Primitives:** `app/src/ds/` owns buttons, links/actions, fields, selects, checkboxes/switches, disclosure, icons, pills, tooltips, and dialogs. Preserve semantic HTML, forwarded attributes, accessible names, keyboard interaction, and disabled/busy states.
3. **Shared presentation patterns:** the same directory owns list rows, label/value rows, segmented filters, loading/empty states, and review-card framing. These components receive content and state via props and do not import screens, API clients, stores, or service internals.
4. **Domain composition:** task, account, session, setup, and settings components may compose primitives with domain data and actions. They must not duplicate primitive markup or styling. Layout-specific CSS is permitted for grids, placement, containment, and responsive structure; visual control styles remain in the design system.
5. **Other renderers:** TUI and Orca panel share vocabulary and appropriate tokens/semantics, not Preact components. The panel stays script-free and information-only. The desktop shell renders the same web app; no new Rust behavior is required.

## Beautiful UI component mapping

| Upstream source/pattern | Shared pacer component | Production consumers |
| --- | --- | --- |
| `components/atoms/Button.tsx` | Extend existing `Button` with one quiet-action variant and consistent size/busy behavior; retain `LinkButton` semantics | Screen, shell, and tray actions |
| `components/atoms/TextRow.tsx` | `TextRow` for label/value/meta alignment | Settings summaries and task/session facts |
| `components/atoms/SegmentedControl.tsx` | `SegmentedControl` with labelled group and pressed/selected state | Repository and session/review filters |
| `components/atoms/Switch.tsx` | Shared switch/checkbox primitive with visible label and reason when disabled | Host session controls, preferences, selection controls |
| `components/primitives/TaskRows.tsx` | `ListRow` with leading, content, meta, and actions slots; compact tray density | Overview, Review, Sessions, Settings, tray lists |
| `components/primitives/ApprovalCard.tsx` | Shared review-card framing composed with existing verdict controls | Review queue/detail and confirmation surfaces |
| `components/primitives/LoadingState.tsx` | Lightweight loading treatment using existing motion tokens and reduced-motion fallback | Existing loading states, without decorative perpetual animation |

Port only the structure and styling required for these existing workflows. Keep task/business decisions outside the primitives. Document retained specialized components (terminal, diff viewer, usage meters) and their primitive composition in the catalog. Remove replaced row/button styles and duplicate markup as consumers migrate.

## Audit-driven corrections

The audit identifies three concrete defects to include in the migration: the warning rail badge uses a calculated 3.186:1 light-theme contrast pair; the terminal screen-reader checkbox and settings range evade existing control guards; and the TUI renders an unreviewed completed task as successful instead of using the canonical waiting-for-review descriptor. Correct these with semantic tokens, canonical controls, and shared task/attention descriptors, respectively. Add focused regression coverage and live evidence for the affected web and TUI surfaces.

Move `Button`'s density dependency out of shell and into the design system; keep Dialog and Field styles with their primitives so tray consumers receive the same foundation. Consolidate form controls, tabs, disclosure, cards, and async-state presentation identified in the migration matrix even where no upstream component is adopted directly. Keep semantic tables distinct from task rows. Document all retained specialized styles and narrowly scoped exceptions.

## Visual and interaction behavior

Use one type scale, consistent control dimensions, aligned metadata columns, closed card/list borders, restrained shadows, and coherent light/dark surfaces. Keep the pacer brand accent separate from state colors. Shared row density supports normal app and compact tray presentation without separate type scales.

Rows containing actions must not nest interactive elements inside a row-level button or link. Where a whole-row destination is appropriate, use a semantic link separate from secondary actions. Long names truncate through layout with accessible full text; paths and IDs remain selectable and do not break mid-token.

Controls support keyboard use and visible focus. Status includes text or glyph, not color alone. Loading, empty, error, disabled, and busy variants are part of the catalog and tests. Honor reduced motion. Preserve screen-specific API interactions and display errors explicitly.

## Enforceable project rules

Extend `.project/rules/ui.md` with explicit rule IDs for component ownership, composition boundaries, shared variants, token usage, catalog coverage, and exception handling. Update UI/QA reviewers, context index, and PR template to require evidence for those rules.

Use a deterministic checker with tests that prove it rejects representative violations. Scan every authored UI TSX/CSS file, including tray, shell, and terminal wrappers. Reject raw interactive controls outside canonical primitives, hard-coded visual values (including font shorthand), and reverse imports from the design system into consumers. Permit semantic layout units, zero, percentages, border hairlines, and breakpoints only through documented categories. Narrow exceptions must state file/symbol, rule, reason, owner, and expiry; do not introduce a blanket baseline allowlist that hides new violations.

The implementation proposes a constitution version bump and decision entry establishing a mandatory UI compliance report and required UI/QA review evidence for UI changes. It becomes policy through the maintainer's amendment approval. The maintainer retains merge authority. CI enforces deterministic checks; visual review requires an actual reviewer report, not just a checked box. Missing evidence is UNVERIFIED and prevents claiming completion. No automatic merge or branch-protection changes are part of this work.

## Migration and validation

Sequence: capture baseline evidence; restore supported toolchain and locked dependencies; implement foundation and primitive tests; migrate app consumers; migrate tray; remove duplicates; add governance and guards; regenerate assets; validate and review the whole result.

The audit's migration matrix tracks each affected screen and each retained exception. #174's shared-foundation work is satisfied here when verified; #134's remaining product-specific issues stay separately tracked unless actually fixed and validated.

Required commands: `bun run typecheck`, `bun run test`, `bun run app:build`, and `bun run build`. Run with Bun >= 1.4.2. App JavaScript stays <= 60 KB gzip and terminal <= 150 KB gzip. Generated token/app assets must be fresh; regenerate plugin assets if shared inputs affect them.

Component tests cover semantic attributes, variant behavior, disabled/busy states, long content, and native attribute forwarding. Guard tests include failing fixtures for raw controls, font shorthand/literals, token bypass, and forbidden import direction. Keyboard/focus behavior needs browser validation, beyond rendered-string assertions.

Use the isolated live harness with seeded data for visual work. Capture before/after evidence for every changed screen at 1440px in light/dark themes and at 375px when layout changes. Exercise dialogs, filtering, tabs, selection, loading/error/empty states, and tray behavior. Inspect the native desktop host if its integration is affected; static browser evidence must not be presented as native-host validation. Audit TUI/Orca separately and exercise any changed behavior there.

Record per-behavior PASS/FAIL/UNVERIFIED notes and the CT-11 report. Real delegation is required only if execution behavior changes; never treat seeded tasks as real execution. Any unexercised affected surface remains outstanding. Working evidence stays untracked under `.work/`; durable catalog/spec/ADR and rules are tracked.

## Initial environment findings

The checkout initially lacks dependencies. Installed Bun 1.3.14 cannot read lockfile version 2, so the initial typecheck and test run are not a valid clean baseline. Restore Bun 1.4.2 in task-local tools and install with the frozen lockfile before assessing code failures. Do not rewrite the lockfile to accommodate the old runtime.

The configured Cursor executor failed authentication; other executors are excluded. Use the project's no-available-executor fallback without changing account settings. The local-agent audit remains read-only.
