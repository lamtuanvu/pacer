# Shared page layout and navigation

Status: approved in conversation on 2026-10-21. This design refines the web
application shell described in
[the UI implementation design](2026-10-16-ui-implementation-design.md). It does
not change service behavior or the versioned API.

Applicable agreements: P1, P9, ARCH-1, UI-1, UI-2, UI-8, UI-9, UI-11,
UI-14–UI-16, UI-18–UI-25, CT-1, CT-4, CT-5 and CT-11. Required evidence comes
from the UI/accessibility and QA reviewers; architecture review is advisory for
the shell and route-boundary changes.

## Problem

The app has shared chrome but no shared page canvas. `Layout` renders the rail,
settings panel, top bar and main landmark, then chooses a zero-padding canvas
from a hard-coded list of route names. Individual screens restore their own
maximum width, centering, edge padding and vertical rhythm. Overview, Settings,
Session, Setup, Review and Task Result therefore use different containment
rules. Task Result can reach the viewport edge even though Overview and Settings
are constrained.

The app also has a typed hash parser, but no single navigation interface.
Screens write `location.hash`, embed route strings, implement breadcrumbs and
back actions independently, and rely on a document click handler to preserve
work-scope query parameters. Parent relationships, route titles and navigation
selection are duplicated outside the router.

Spacing values come from generated tokens, but the relationships between
elements are not defined. A screen can be token-compliant while choosing a
different page gutter, section gap or disclosure inset from its peers.

## Goals

- Give every routed screen deliberate, consistent containment and edge spacing.
- Keep width differences intentional through named variants rather than local
  CSS.
- Make route parsing, URL generation, query inheritance, page identity,
  navigation selection and parent relationships one coherent system.
- Define a small spacing grammar for page and section composition.
- Prevent new screens from bypassing these foundations.
- Migrate without changing task, settings, setup or session domain behavior.

## Non-goals

- Replacing hash routing or adding a third-party router.
- Changing service operations, API schemas, task state or action semantics.
- Converting specialized tables, diffs, terminals or setup-step internals into
  generic components.
- Giving every page the same maximum width.
- Reformatting unrelated dense TSX or performing a broad visual redesign.

## Decision 1: the shell always renders one page canvas

`Layout` continues to own application chrome and the `main` landmark. It stops
selecting padding behavior from route names. Routed screens render a canonical
`Page` as their outer visual container.

`Page` owns:

- full available width and minimum-width containment;
- horizontal centering;
- responsive desktop, narrow and safe-area gutters;
- top and bottom page padding;
- the primary vertical gap between header and body;
- one of the named maximum-width variants below.

| Variant | Intended use | Width behavior |
| --- | --- | --- |
| `standard` | Settings, forms and ordinary single-column content | Uses the shared standard content maximum. |
| `wide` | Overview, Review, task details and session details | Uses the shared wide content maximum. |
| `full` | A genuinely immersive terminal or equivalent canvas | Fills the available content area while retaining required safe-area behavior. |

The exact widths and gutters use existing generated size and spacing tokens. A
screen selects a semantic variant; it does not supply a number. `full` is an
explicit exception, never inferred from a route name.

`PageHeader` owns breadcrumbs, page identity, title, description or metadata,
status and page-level actions. The shell top bar remains the single visible
screen title where the existing hierarchy requires it (UI-9); in that case the
page header renders detail identity at the section-heading scale rather than a
second `h1`. The implementation must document and test this title contract.

`PageBody` provides the default page stack. `PageColumns` owns the standard
main/sidebar grid, gutter and responsive collapse. Screens may keep specialized
internal grids after the page boundary.

## Decision 2: shared composition defines spacing relationships

The design system adds layout primitives whose variants map to generated
tokens:

- `Stack`: vertical relationships `compact`, `normal` and `section`.
- `Cluster`: wrapping inline metadata and action relationships.
- `PageColumns`: main/sidebar placement and collapse.
- `Section`: heading, supporting text, actions and body rhythm.
- `DisclosurePanel`: disclosure header, boundary and expanded-body inset.
- `ActionPanel`: contained sidebar decisions such as Task Result's next step.

These components own spacing relationships, not primitive visual values chosen
by consumers. They remain presentation-only under UI-20: they import Preact,
design-system modules and shared view descriptors only, and receive route or
domain content through props.

Screen CSS may continue to own specialized table columns, diff lines, terminal
geometry, setup-step layout, overflow and domain-specific metadata placement.
It may not own page-level maximum width, centering or outer gutters. The design
system catalog records each primitive, variant, accessibility behavior and
production consumer as required by UI-22.

## Decision 3: one typed route registry owns navigation policy

`router.ts` evolves from a parser plus helpers into a typed route registry. Each
canonical route defines:

- path pattern and typed parameters;
- URL generation;
- query inheritance policy;
- shell title;
- primary navigation group;
- optional settings navigation item;
- optional semantic parent for breadcrumbs and back destinations;
- setup-gating behavior;
- legacy redirects where required.

The registry remains framework-independent. It does not import screens or
application state. Existing hash URLs remain bookmarkable, and legacy URLs keep
their current redirect behavior.

Application code navigates through two canonical interfaces:

- `AppLink`, an anchor-backed design-system link that receives a typed route
  destination and preserves native open-in-new-tab, modifier and copy-link
  behavior;
- `useNavigation`, for action completions and keyboard commands that must
  navigate imperatively.

Only the navigation adapter may read or write `location.hash` or call
`location.replace`. Screens do not embed internal `#/...` strings. Query
inheritance happens while generating or navigating to a destination, so the
document-level click interceptor is removed after migration.

Back controls use semantic parents, not browser history. For example, a Task
Result returns to Tasks and a Host Detail returns to Remote hosts while keeping
the applicable work scope. Browser Back remains native browser behavior.

The registry drives current-page semantics for the primary rail and settings
panel. Breadcrumbs are rendered from route metadata plus dynamic labels supplied
by the screen. Exactly one applicable primary item and at most one secondary
item carry `aria-current="page"`.

## Screen mapping

| Screen | Page variant | Shared structure retained after migration |
| --- | --- | --- |
| Overview | `wide` | Existing overview section grid inside `PageBody`. |
| Needs You / Review | `wide` | Existing queue, evidence and verdict columns inside the page. |
| Tasks list | `wide` | Existing list rows and pagination. |
| Task Result | `wide` | `PageHeader`, main/action `PageColumns`, section and disclosure panels. |
| Active/ended Session | `wide` | Existing tabbed session workspace and activity sidebar; terminal itself may fill its column. |
| Settings pages | `standard` | Existing settings sections, tables and forms. |
| Host Detail | `standard` | Breadcrumbs, page header and current host sections. |
| Add Executor | `standard` | Existing wizard internals. |
| Setup | `standard` | Existing step rail and panel; its internal grid remains specialized. |

If live validation shows that Review needs more room than the shared `wide`
variant, the variant token may be adjusted centrally. A new page-width variant
requires design-system review and documentation; a screen-local width is not an
acceptable workaround.

## Responsive and accessibility behavior

- Page gutters reduce through the shared narrow layout and include safe-area
  insets where applicable.
- `PageColumns` collapses to one column at the canonical breakpoint, with the
  action panel following the primary content in DOM order.
- Breadcrumbs use a labelled navigation landmark and links, not decorative
  text separators alone.
- Native anchor semantics remain intact through `AppLink`.
- Route changes move focus to the main landmark or the declared page focus
  target and update the document title. They do not unexpectedly focus ordinary
  pointer navigation controls.
- Current navigation is exposed through `aria-current`; status never relies on
  color alone.
- Sticky shell and secondary navigation offsets remain valid at wide and narrow
  widths.
- Code, paths, task ids and commands retain horizontal scrolling or separator-
  aware containment under UI-11.
- Reduced motion and forced-color behavior continue to come from the shared
  design system.

## Enforcement

`bun run ui:check` is extended with focused source rules and negative fixtures:

1. Reject `location.hash` and `location.replace` outside the navigation adapter.
2. Reject authored internal hash-route strings outside the route registry,
   navigation adapter and explicit test fixtures.
3. Require each routed screen to render a canonical `Page`, unless its route is
   registered and documented as a `full` page.
4. Reject page-level `max-width`, auto-centering and outer padding in screen CSS.
5. Reject new generic screen layout classes such as `screen`, `top` or `row`.
6. Detect duplicate authored CSS selectors so later declarations do not silently
   replace earlier layout decisions.

The checker must avoid broad exemptions and include negative fixtures showing
that neighboring violations still fail (UI-25). Existing violations are removed
as their screens migrate; there is no permanent baseline.

Tests additionally prove:

- every canonical route parses and generates the same destination;
- route parameters are encoded and malformed parameters are safe;
- work-scope query state survives links, action navigation and breadcrumbs;
- legacy routes redirect to canonical destinations;
- every detail route has the intended parent and title;
- primary and secondary navigation expose the correct current item;
- every routed screen selects an allowed page variant;
- route navigation updates focus and the document title;
- representative layouts contain correctly at desktop and narrow widths.

## Migration and delivery

The expected complete change is approximately 22–30 production files and
10–16 test files, with 700–1,100 changed lines and about 200–350 net new lines.
Domain and API modules remain unchanged. Avoid unrelated formatting because
several current screen files are densely written and would otherwise create
misleading review churn.

Delivery occurs in two independently validated phases:

1. **Foundation and representative screens.** Add the registry, navigation
   interfaces and layout primitives. Migrate Task Result, Session Detail and
   Host Detail. Update the design-system catalog and add initial enforcement.
2. **Complete migration and close enforcement.** Migrate Overview, Needs You,
   Tasks, Settings, Add Executor and Setup. Remove the canvas route-name list,
   direct screen navigation, click interception and superseded page-root CSS.
   Turn all enforcement rules on without a baseline.

Each phase must leave every migrated route functional. If delivered as separate
PRs, the first phase may keep a narrow compatibility wrapper for unmigrated
screens, documented and deleted in phase two. It may not weaken checks for
already migrated screens.

## Validation and review evidence

Implementation requires:

- focused router, navigation, component and rendered-screen tests;
- `bun run typecheck`;
- `bun run ui:check`, including new negative fixtures;
- `bun run test`;
- `bun run app:build` and committed generated assets;
- UI-18 before/after screenshots for every changed screen at 1440 px in light
  and dark mode, plus 375 px because page layout changes responsively;
- keyboard, focus, current-page, disclosure and breadcrumb checks;
- manual VoiceOver validation unless the maintainer records a scoped exception;
- CT-11 live validation through `bun run live` for browser and desktop surfaces,
  with unexercised surfaces reported as **UNVERIFIED**.

The implementer writes the UI-1–UI-25 compliance report. Independent
UI/accessibility and QA reports identify base/head revisions, actual evidence,
findings and verdicts. Required FAIL or UNVERIFIED behavior blocks a completion
claim unless the maintainer records a scoped, expiring exception in
`.project/decisions.md`. Working plans, reviews, screenshots and live evidence
remain under `.work/` and are not committed.

## Risks and mitigations

- **Large visual blast radius.** Migrate representative detail screens first,
  review the primitives, then migrate the remaining roots.
- **Router migration breaks scope preservation.** Keep parser/generator
  round-trip and query-policy tests before removing the click interceptor.
- **Shared primitives become overly generic.** Limit them to page composition;
  retain specialized domain layouts explicitly listed in this design.
- **A single width harms dense screens.** Use named standard, wide and full
  variants, all owned centrally.
- **CSS cleanup obscures behavioral review.** Avoid unrelated formatting and
  remove only rules superseded by the migrated primitives.
- **Enforcement creates loopholes or false confidence.** Add negative fixtures
  and retain manual UI/accessibility and live review; source checks do not prove
  visual or assistive-technology behavior.
