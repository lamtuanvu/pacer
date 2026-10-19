# Shared UI foundations and Beautiful UI adaptation

Date: 2026-10-19
Status: Design approved by the maintainer in conversation; governance amendment 0.4.0 is proposed and adopted only when the maintainer merges its PR.
Tracking: #191; coordinates with #174 and #134.

## Context

pacer already has a Preact design system, generated tokens, shared view-model vocabulary and bundle budgets (60 KB gzip app, 150 KB terminal). The source audit found duplicated controls and row patterns across screens, tray and shell; terminal/range controls escaped existing guards, font shorthand bypassed typography rules, and the DS Button imported shell density. A token-only refresh would leave those ownership problems in place.

Beautiful UI is a copy/adapt source library built around React and Tailwind. The selected revision is `44a274e598395ab61e7c96c26fda2758780253b7` from [slev12397/beautiful-ui](https://github.com/slev12397/beautiful-ui/tree/44a274e598395ab61e7c96c26fda2758780253b7), licensed MIT. The adaptation preserves the full license in `app/src/ds/third-party/beautiful-ui-LICENSE` and maps individual upstream paths to maintained components in [the component catalog](../design-system.md).

## Decision

Adapt selected Button, TextRow, SegmentedControl, Switch, TaskRows, ApprovalCard and LoadingState structures into the canonical in-repo DS. Translate React types to Preact, utility classes to generated-token CSS, and demonstration state to props. Use pacer's icons, themes and semantic status descriptors. Do not install the demonstration app, analytics, email capture or paid icon package.

The dependency boundary is tokens → DS primitives/presentation composites → domain composition → screens. Presentation components own native control semantics, density, visual variants and loading/empty/error states; they receive data and callbacks. They never import shell, screens, stores, API clients or service internals. Screens own business decisions and actions. Domain wrappers remain useful when they bind state/actions to canonical primitives. Semantic tables and specialized terminal/diff renderers keep their purpose; retained styles and production consumers are cataloged.

TUI and the static, script-free Orca panel consume shared view-model labels, tones and glyphs through their renderer adapters. They do not consume Preact components. Desktop continues to host the same web/tray app. No business/API operation or execution behavior changes are part of this choice.

## Enforcement and evidence

`scripts/ui-check.ts` checks all authored app TS/TSX/JS/JSX/CSS trees, including newly added directories, terminal and tray. It parses TSX/imports with the dev-only Babel parser and checks authored CSS/inline/DOM visual declarations, including shorthand and fallback values. Only exact generated token outputs and documented semantic/layout/data-geometry categories are excluded. Negative fixtures prove raw controls, reverse imports and visual literal bypasses fail; there is no grandfathered file baseline or suppression-comment mechanism.

Amendment 0.4.0 proposes UI-19–UI-25 and required implementer compliance plus independent UI/accessibility and QA reports for UI-affecting changes. The CI check validates the PR body's report manifest, reviewed SHAs, concrete references and passing summaries; it does not certify the contents of external artifacts. Required screenshots, keyboard/focus/contrast and CT-11 live evidence still require actual inspection. Missing evidence is UNVERIFIED. The maintainer inspects reports, accepts scoped exceptions and decides merges. Reviewer output is evidence and findings, never approval authority. Adoption happens through the constitution's amendment process; no remote branch-protection changes are made.

## Alternatives

- **Install the complete kit:** easier upstream example reuse, but incompatible React/Tailwind assumptions, overlapping styling/runtime dependencies and bundle risk. Rejected.
- **Refresh tokens only:** smaller change, but leaves duplicated controls, drift and incomplete Beautiful UI component adoption. Rejected.
- **Adapt selected sources:** retains a single Preact/token pipeline and small runtime, with a maintenance obligation to preserve provenance, license and test semantic behavior. Selected.

## Consequences

New reusable visual behavior starts in the shared catalog and DS; consumers compose it. Token generation and asset freshness remain required. The dev-only parser adds no browser/runtime dependency. Source checks provide repeatable guardrails, while independent review and live validation remain necessary for interactions and visual quality. Required reports make gaps visible; they do not replace human judgment. Product-specific findings in #134 remain separate unless the implementation and evidence actually resolve them.
