# pacer design system

The web app, desktop webview and tray use the Preact foundation in `app/src/ds/`. The service owns domain state; screens bind API actions and compose presentation. Components must not import screens, shell, data clients, API/core implementations or stores. The TUI consumes shared view-model descriptors, independently of Preact.

## Tokens and density

Author `app/src/ds/tokens.json`; `app/tokens-gen.ts` validates the explicit color, type, spacing, radius, size, shadow, layer and motion groups. `tokens.local.json` holds documented provisional additions only; it is currently empty. Generate CSS and TypeScript with `bun scripts/ds-sync.ts app/src/ds/tokens.json` or `bun run app:build`. Never edit generated `tokens.css`/`tokens.ts` or embedded app assets manually. The app build also refreshes the generated token prefix in `desktop/ui/shell.css`, preserving the handwritten startup-shell suffix at its existing boundary comment; a missing boundary fails the build rather than overwriting it.

All themes use one type scale. `space-2.5` supplies the missing 10px inset; control tokens specify compact 28px, normal 44px and touch 48px minima. Semantic foreground/background pairs carry statuses. Brand identity tokens are separate from status colors. The warning and information navigation badges use the tested semantic pairs, and text on tinted surfaces uses `ink-secondary`.

Compact is the desktop default, including dialogs outside the shell. `DensityProvider value="compact"` also scopes the tray, including list rows, pills and meters. Buttons (all variants and button links), text inputs and selects share the 28px compact minimum, caption typography and medium radius; input padding fits that height and selects reserve room for their arrow. The top-bar Delegate is the reference control. Settings forms retain their shared 32px density; small settings actions remain 28px. Explicit `normal` density remains available at 44px for a documented need, rather than becoming a page-local override.

`NarrowContext`, owned by DS and reexported by shell for compatibility, selects 48px touch targets for narrow/repository-scoped views. At viewport widths up to 560px, DS supplies touch targets and readable input typography even for dialogs mounted outside shell context. An explicit compact surface wrapper keeps the desktop tray compact at popover widths. Textareas retain their 96px minimum and vertical resize. `ListRow` also accepts an explicit density. Screens must not override primitive typography or control dimensions to create another density.

## Catalog and API contracts

| Component | API and supported states | Production use and accessibility contract |
| --- | --- | --- |
| `Button` | Native button props and ref; `variant="primary\|secondary\|ghost\|quiet\|danger"`, `size="md\|sm"`, `busy` | All screen, shell, terminal and tray actions. Defaults to `type="button"`; opt into submit. Busy sets native disabled and `aria-busy`, while retaining its name. Visible reasons accompany unavailable capabilities; ordinary pending progress stays announced. |
| `ButtonLink`, `TextAction`, `IconButton` | Native anchor/button props and refs; ButtonLink shares button appearance | Navigation stays an anchor, including href, current page, target, download and modifier behavior. IconButton requires `aria-label`; tooltip alone is insufficient. `pc-inline-link` is the CSS contract for underlined links in prose. |
| `Field` | `label`, optional `help`, `error`, children and className | Delegate, Quick Delegate, verdict and settings forms. Finds the first canonical labelable control through layout/fragment children, preserves every sibling, and assigns stable label/help/error IDs. Explicit child IDs win; existing `aria-describedby` values are retained. A Field owns one control; use separate Fields for several controls. Custom opaque child components must supply their own label contract. |
| `TextInput`, `TextArea`, `Select` | Native attributes, events and native element refs | Form validation, autocomplete, disabled state, required, min/max, selection and keyboard behavior remain native. TextArea owns resize/minimum height; Select owns its themed arrow and forced-color fallback. |
| `Checkbox`, `Switch`, `Range` | Native input props/ref; optional visible `label`; Checkbox/Switch `help` and `mixed` | Bulk selection, executor/update settings, host sessions, terminal screen-reader mode and planner reserve. A Checkbox without `label` requires a surrounding label or `aria-label`. `mixed` sets DOM indeterminate and `aria-checked="mixed"`; Switch uses a native checkbox with switch role. Range accepts its accessible label via Field, visible label or aria-label. |
| `Disclosure` | `summary`, native details attributes and children | Technical routing, cost, log, acceptance and CLI details. Native summary retains keyboard and expanded behavior; full code remains selectable. |
| `Dialog`, `useDialogs` | `title`, `close`, content; shared confirmation/prompt orchestration | Native modal dialog, Escape cancellation, native focus trap and return. Dialog/Field styles are DS-owned and available to tray. Use an explicit visible submit label, and preserve whitespace validation on required rejection notes. |
| `TextRow` | `label`, `value`, optional `meta` | Settings check progress uses label/value/meta alignment and tabular figures. Values wrap without hiding labels; this is presentation, not a form or semantic table replacement. |
| `ListRow` | `leading`, `content`, `meta`, `actions`, native div attributes, optional density | Overview attention/running/done/activity, Sessions list and tray attention. Slots are siblings. Row-level focus/data attributes remain on the outer row. Keep full titles in title/detail while clipping through CSS. Secondary actions belong in actions, outside any destination link. |
| `ListRowLink` | Native anchor attributes and children | Capacity and tray running rows with a single destination. Never put another control inside it. Session replay uses the DS `pc-row-destination`/`pc-list-row--stretch` contract to expand a single link target without nesting controls. |
| `SelectableRow`, `ChoiceCard`, `FilterChip` | Button props plus optional `selected`; existing aria-pressed/current supported | Review queue/files, Add Executor choices and repo filters. Selection stays controlled by the caller. Choices use buttons and pressed state, not invented tab semantics. |
| `CountBadge` | Numeric `count`, optional accessible unit `label` (defaults to work items) | Repository filter chips and finder rows. Neutral filled badge with tabular figures; selected chips inherit the chip contrast pair. Counts remain non-interactive and separate from status pills. |
| `SearchPicker` | Trigger `label`, `searchLabel`, `placeholder`, `emptyLabel`, controlled `value`, `{value,label,description?,count?,searchText?}` options and `onChange` | Repository finder on Overview and Review; searches every registered repo, including those with zero work. Trigger-anchored, right-aligned menu switches alignment near the left viewport edge and fills the row below 560px. Native buttons expose pressed state, the search field receives focus, arrows/Home/End move among results, and Escape/selection return focus. Tab departure and outside pointer dismiss without stealing focus. Search resets on dismissal; filtered empty text is a polite status. Menu rows inherit normal/compact/touch density. |
| `SegmentedControl`, `Tabs` | Label, controlled value, `{value,label,disabled?}` options and onChange; Tabs additionally requires stable id | Settings switches and Session views. SegmentedControl is a labelled group of pressed buttons. Tabs owns tablist/selected/controls/roving tabIndex and ArrowLeft/Right/Home/End; the consumer renders matching labelled tabpanels. Disabled tabs are skipped. |
| `Card` / `pc-card`, `ApprovalCard` | Native section props; ApprovalCard optional title/actions slots | Shared settings card CSS also works on native form/div containers. Review verdict uses ApprovalCard framing while VerdictPanel owns decisions and actions. Do not repeat the same heading in both wrapper and content. |
| `Pagination` | Controlled `label`, zero-based `page`, `pageSize`, `total`, `onChange` | Overview lists. Uses canonical small Buttons with inherited density. Range is a polite live status; only available Previous/Next actions render. Native Tab/Enter/Space activation. Paging moves focus to the persistent labelled navigation region so disappearing boundary buttons do not lose focus. Empty lists omit navigation. Authored locally; no upstream adaptation. |
| `LoadingState`, `EmptyState` | Loading label/updating; empty title/description/children | Shell connection, task/session/settings resources, Overview and Review clear states, tray connecting. Loading is a polite status with decorative pixel grid; reduced motion freezes it. Refreshing content remains mounted. Errors remain explicit adjacent alerts with existing retry actions. |
| `Page`, `PageHeader`, `PageBody`, `PageColumns` | Named `standard`, `wide` or `full` page width; breadcrumb/identity/metadata/status/action slots; main and optional aside | Every routed app screen uses `full` to fill the available workspace. The `standard` and `wide` variants remain available for explicitly constrained compositions. Page owns width, centering, responsive/safe-area gutters and page rhythm. PageHeader never invents another `h1`; the shell top bar remains the page title. Columns keep main before aside in DOM order and collapse centrally. Screen CSS must not redefine page width, centering or outer gutters. |
| `Stack`, `Cluster`, `Section`, `DisclosurePanel`, `ActionPanel` | Semantic compact/normal/section spacing and contained section/detail/action composition | Shared page composition. These are original local Preact components with no upstream adaptation. Consumers provide content and domain state; DS tokens own spacing, borders and responsive behavior. Specialized tables, diffs, terminal geometry and domain grids remain screen-owned. |
| `SectionHeading`, `Pill`, `StatusPill`, `StatusGlyph` | Existing heading and semantic descriptor APIs | One section-heading type scale. Status descriptors come from `src/view-model/words.ts`; glyph and text accompany color. Color alone never encodes a result. |
| `UsageMeter`, `AgentMark`, `Mark`, `Icon`, `Kbd`, `Tooltip` | Existing documented typed props in their modules | Specialized meter geometry, vendor identity, navigation, shortcuts and tooltips remain shared. Stale meter readings visibly say Historical usage, include a known capture time, and announce freshness through the meter value text. A Kbd composed inside a button inherits the action foreground on a transparent surface, retaining the action contrast pair in both themes. Usage percentages are data, not ad-hoc style. Agent colors mirror shared identity descriptors in both themes. |
| `TrafficLights` | `desktop`, `onClose`, `onMinimize`, `onMaximize` | Linux desktop fallback for the undecorated main window. The macOS main window uses Tauri's decorated overlay and native traffic lights, following [Tauri's window customization guidance](https://v2.tauri.app/learn/window-customization/); the web controls are hidden and their header space remains reserved. Browser views render no window controls. The bundled startup shell provides a drag strip above its content. |

`StatusBar` composes `UsageMeter` and `Kbd` below the desktop content. It uses the active shortcut registry for each route; narrow screens keep the touch navigation and compact executor percentages instead. Its Usage button opens a read-only account panel using `account.list` windows, reset times and freshness. Reload reads the latest available account data; it does not force a provider refresh. Overview keeps planner advice, executor eligibility and parallel-task slots while usage appears in the status bar.

Repository chip labels and finder identities use CSS ellipsis when space runs out. Full names remain in the control's title and accessible text; count badges keep a separate fixed column. Screens compose `pc-chip__label` rather than overriding primitive typography or clipping text by character count.

Example composition:

```tsx
<Field label="Rejection note" help="Explain what needs to change." error={error}>
  <TextArea id="rejection-note" required value={note} onInput={onInput} ref={noteRef} />
</Field>
<ListRow
  leading={<StatusGlyph status={status} />}
  content={<TextAction href={destination}>{title}</TextAction>}
  meta={<StatusPill status={status} />}
  actions={<Button size="sm" busy={pending} onClick={review}>Review</Button>}
/>
```

## Beautiful UI provenance

Adapted from [slev12397/beautiful-ui](https://github.com/slev12397/beautiful-ui/tree/44a274e598395ab61e7c96c26fda2758780253b7), pinned revision `44a274e598395ab61e7c96c26fda2758780253b7`, under MIT. The complete upstream copyright/license is preserved in [beautiful-ui-LICENSE](../app/src/ds/third-party/beautiful-ui-LICENSE). The implementation combines selected upstream structures with existing pacer primitives; it does not install the upstream app or dependencies.

| Pinned upstream source | Adapted implementation | Retained pattern and deliberate differences |
| --- | --- | --- |
| `components/atoms/Button.tsx` | `ds/Button.tsx`, `components.css` | Shared inline-flex alignment, size/variant matrix, quiet action, disabled and restrained transition states. Extends existing pacer Button; Preact types/refs replace React and cva, native safe default/busy semantics are added, pacer corners/tokens and touch targets replace demo pill dimensions. |
| `components/atoms/TextRow.tsx` | `ds/Patterns.tsx: TextRow` | Label-left/value-right, optional baseline metadata and tabular numbers. Supports wrapping and tokens rather than Tailwind pixel literals. |
| Existing Button/TextRow adaptations above | `ds/SearchPicker.tsx`, `ds/CountBadge.tsx` | Repository finder composes the same quiet button and identity-left/count-right grammar. Local Preact search, anchored containment, keyboard dismissal, pressed selection and neutral count badges are pacer extensions; no additional upstream source or dependency is copied. |
| `components/atoms/SegmentedControl.tsx` | `ds/Patterns.tsx: SegmentedControl` | Controlled options and selected segments within shared framing. Removes animated sliding thumb; filters use correct pressed-button group semantics. Tabs are a separate keyboard-capable API. |
| `components/atoms/Switch.tsx` | `ds/Controls.tsx: Switch/Checkbox`, switch CSS | Controlled checked state, rounded track and travelling thumb. Combines existing checkbox styling with a native labelled input, disabled/help/indeterminate/ref support, and reduced-motion/forced-color behavior. |
| `components/primitives/TaskRows.tsx` | `ds/Patterns.tsx: ListRow/ListRowLink/SelectableRow` | Leading status/identity, flexible clipped title, numeric/status metadata, bounded row and disclosure/action grammar. Removes scripted demonstration status sequence, demo tasks, staggered animation and nested assumptions. Service descriptors decide actual state; sibling actions preserve valid HTML. |
| `components/primitives/ApprovalCard.tsx` | `ds/Patterns.tsx: ApprovalCard`, Review composition | Closed card, question/content body and separated action/footer framing. Combines with VerdictPanel and native Dialog rather than porting question auto-advance, odometers, GlideMenu or demo state. |
| `components/primitives/LoadingState.tsx` | `ds/Patterns.tsx: LoadingState` | Small decorative 3×3 pixel grid paired with readable status. Removes video, network media, elapsed interval, orbit variants and label shimmer. Uses one restrained token-based pulse only while loading; freezes under reduced motion. |

No paid icon package, remote fonts, analytics, email capture, demo application, React or Tailwind runtime is included. Existing pacer SVG navigation/identity assets retain their own provenance.

## Migration matrix and retained styles

| Surface | Canonical adoption | Retained responsibility |
| --- | --- | --- |
| Overview | Shared rows, sibling secondary actions, row destinations, empty states, filters and canonical links | Screen section placement, capacity grid, counts, scope selection, API actions and shared semantic descriptors. |
| Review/detail | Selectable queue/file rows, ApprovalCard, Field/input/select/disclosure, asynchronous state | Bulk selection and verdict workflows, semantic definition lists, specialized Diff renderer and horizontal code scrolling. |
| Sessions/detail | ListRow, canonical replay target, Tabs, controls, loading/empty states | Controller/resource fetching, session/PTY lifecycle, timeline, terminal/diff rendering and command copy. Unsupported attach targets are omitted; refused takeover retains visible service reason. |
| Settings/hosts/Add Executor/Diagnostics | Canonical form controls/Field, switch, range, SegmentedControl, ChoiceCard, pc-card, TextRow | Settings grid, semantic tables (including mobile data labels), wizard progress and API-bound operations. Host and executor domain decisions remain local. Diagnostics binds doctor.run to canonical Button, Pill and Disclosure; idle/running/error states are announced, reruns wait for completion, and technical evidence/repair guidance stays collapsed. |
| Setup/delegate/dialogs | Button/ButtonLink/TextAction, Field/native controls, Dialog and Disclosure | Consent, setup checklist, draft/validation and delegation data. |
| Shell | Canonical actions/links and DS density, loading status; TrafficLights native controls | Desktop: one 32px top bar with compact Delegate and a sticky 40px icon rail (32px links). Native controls appear only in Tauri; title and empty header space support native dragging. Narrow screens retain the touch header and bottom navigation; coarse pointers retain touch targets. Settings keeps secondary navigation. Landmarks, current-route labels, tooltips, skip-link route focus and keyboard focus remain available. |
| Tray/desktop webview | Compact density, shared actions, ListRow, ListRowLink, headings, status/identity and loading | 340px host containment, count/executor layout, native IPC, menu state and keyboard order. Escape closes menus before IPC hide; Quit is offered only in desktop. |
| Terminal wrapper | Canonical screen-reader checkbox and actions | Lazy import, xterm theme adapter, PTY scaling and session control; xterm vendor CSS remains vendor-owned. |
| TUI | Shared framework-independent status/attention vocabulary | Terminal width/color adapter; it imports no browser components. |

Authored screen CSS may own grids, flex placement, containment, overflow, sticky positioning, responsive breakpoints and domain metadata columns. Primitive visuals are DS-owned. The semantic tables, usage meter, code/diff and PTY renderers remain specialized; converting them into universal rows would damage their semantics.

Narrow data-geometry adapters are explicit: `UsageMeter` supplies clamped numeric `--used`/`--pace`; AgentMark/Mark supply only `${size}px` through `--agent-size`/`--mark-size`; `TerminalView`'s `scale` function computes width/height solely from authoritative PTY cell/font metrics or measured xterm screen geometry. These do not permit arbitrary colors, typography or spacing. SVG path/viewBox/stroke geometry, intrinsic 1em icon dimensions, border hairlines, zero, percentages and responsive breakpoints follow the narrowly checked categories in UI-21. Other measurements come from tokens.

## Checks and evidence

Run `bun run ui:check`, `bun run typecheck`, focused component/behavior tests, the integrated suite and builds. The checker scans every authored app tree, including shell, tray and terminal, and rejects controls outside DS, reverse imports and visual token bypass. Negative fixtures establish that violations actually fail.

Component tests establish native attributes, disabled/busy behavior, label/help/error relationships, compound fields, selected filters, mixed selection, sibling row actions, compact density, semantic contrast and async copy. Set `PACER_TEST_BROWSER` to a local Chrome/Chromium executable when running `test/app-ds-browser.test.tsx` to verify actual modal/disclosure keyboard composition and Settings frame borders; without an executable those browser checks explicitly skip. Rendered markup is not browser keyboard or visual evidence. UI-18 requires before/after route/theme/width screenshots; CT-11 requires isolated live validation. Record unexercised browser/native/assistive-technology surfaces as UNVERIFIED.

This migration consolidates the shared-foundation inventory from #174 while preserving #134's semantic status, title, time, containment and one-action requirements. Product-specific remaining work in #134 is complete only when its own observed acceptance criteria and visual evidence pass; architectural reuse alone does not close it.

The canonical Disclosure supports `pc-disclosure--wrap` for multi-part summaries, wrapping title, status and evidence within the container. Diagnostics uses this variant with `pc-ellipsis` and a full title attribute for long identities. Native disclosure keyboard and open/closed semantics remain unchanged; no new upstream adaptation is introduced.

Button backgrounds change immediately when theme tokens change; only opacity transitions. This avoids stale native WebKit background transitions during Appearance changes while preserving keyboard/focus semantics and the existing Button API.

### Task result composition

TaskResult composes canonical SectionHeading, StatusPill, Disclosure, Field,
TextArea and Button controls. It orders result, checks and changes, delivery and
next actions before collapsed transcript and technical details. Explicit review
requests expose verdict controls; ordinary completion keeps them in an optional
disclosure. Failed checks expose recovery controls. The layout uses existing
spacing tokens and stacks its columns below 900px. No new upstream component or
primitive appearance is introduced. Production consumers: Tasks detail and
legacy task/review deep links. Existing session viewing remains available for
active tasks. Standard disclosure keyboard behavior, field labels, busy states
and polite result announcements apply.

ListRow also supports `outlined` for a standalone row with a closed border, and
`tone="bad"` for a failure tint. Outline and tone belong to the shared component,
including the last child; Needs you uses them for actionable rows. Existing
list density, sibling action slots and keyboard behavior are unchanged.
### Settings page density

`DensityContext` additionally supports `settings`: 32px minimum form buttons,
inputs, selects and range hit areas, using `control-settings`. Small row actions
retain the 28px compact minimum; segmented choices use 32px. Body/field text stays
13px, help 12px and pills 11px. Narrow layouts resolve to touch density; settings
controls outside the shell also retain 48px targets at narrow/coarse-pointer sizes.
The existing compact tray density and normal app density are unchanged.

Settings screens mount one editor per route. `settings-pages.ts` owns category
labels/icons for the sidebar, General links and shell titles. The bounded settings
canvas owns label/control grids and semantic table columns. Primary page titles
remain in the shell; nested sections retain `SectionHeading`. Navigation icons
are decorative beside named links, with one current category. No new upstream
adaptation or dependency is introduced.

### Session content

`Prose({ text })` renders executor-authored text as an escaped Markdown subset: paragraphs, headings (canonical `SectionHeading` at h3), unordered lists, bold text, inline code and fenced code. Unsupported Markdown remains literal text. It never renders HTML, images or executable URLs. Code retains token boundaries and scrolls within its container; paragraphs preserve line breaks. It uses the normal token type scale at every density. Session briefs and executor reports are its production consumers. This is an original Preact composition; no additional upstream code or dependency is incorporated.

Session details retain a specialized responsive main/activity layout. They compose canonical Tabs, Disclosure, Field, Select, Dialog, Button and StatusPill. Active sessions default to Output; ended sessions default to Brief, and an explicit tab selection stays selected during refreshes. Brief sections use API-provided fields; the original text remains in a collapsed disclosure. The executor report is formatted separately from the unmodified technical log; absent reports are not inferred from logs. Retry selection opens the canonical modal, with native keyboard controls, Escape dismissal, focus cycling/return, visible unavailable reasons, pending state and errors. Changes remain the service-provided diff rather than an inferred file summary.

Completed task results retain their primary result workflow and offer a quiet Session details action. It opens the session workspace; Back to result returns without changing task state. Active tasks continue to open the session workspace directly.
# Session attachment presentation

`AttachmentPicker({onFiles, disabled})` uses the canonical file control and a visible label. It supports keyboard file selection; consumer drop/paste handlers feed the same callback. `AttachmentTray({items, onRemove, onRetry})` owns image thumbnails, names, sizes, uploading/ready/error states and secondary retry/remove controls. `items[].removable=false` hides removal for immutable claimed session files. Image alt text is empty because the adjacent filename supplies the name. Actions have explicit accessible names, focus follows canonical Button behavior, and density follows Controls/Button context.

Ownership: `app/src/ds/AttachmentTray.tsx` and DS CSS. Consumers: StartSession and SessionAttachments. Authenticated upload state and file bytes belong to consumers/service, never DS. This is original project code with no copied upstream source. The terminal conversation layout stays specialized: PTY geometry and native terminal input remain owned by the terminal renderer.

Terminal font, cell geometry and ANSI colors are generated by upstream `@xterm/xterm` 6.0.0 (`src/browser/renderer/dom/DomRenderer.ts`, MIT license retained in the installed package). The adapter uses its documented `documentOverride` option to nonce only terminal-created style elements; the global document is unchanged. The service issues a fresh style nonce per HTML response, with no `unsafe-inline` CSP allowance. The optional upstream scrollbar stylesheet uses the global document and remains blocked rather than broadening policy. Native PTYs advertise truecolor independently of automation's `NO_COLOR`/`FORCE_COLOR` environment; Pacer's own TUI retains its existing color-preference handling.

### App feedback: Alert and Toast

`ds/Alert.tsx` owns severity presentation (`success`, `warning`, `error`, `info`), a visible glyph/title, wrapped detail and semantic announcement. Errors use `role=alert`; other severities use `role=status`. Set `announce=false` for duplicate diagnostic detail when its completion is already announced. Production consumers: shared ErrorMessage, settings conflicts/validation, job diagnostics and Toast.

`ds/Toast.tsx` composes Alert and a named dismiss Button. `data/notification-context.tsx` mounts one app notification host outside route content, backed by `model/notifications.ts`. Success/info expire after five seconds, paused while hovered/focused; errors/warnings persist. Three notifications are visible with a bounded queue; operation keys deduplicate repeats. Notifications never take focus. Consumers notify only after confirmed mutations or completed jobs, never on polling. Screen drafts remain local until an explicit Save and do not trigger notifications while editing. Presentation modules import no API/store code. These are original in-repo components, with no upstream adaptation.

The Executors table retains its specialized metadata columns. Priority controls use a fixed three-column layout; Save/Discard sit outside the table. Model identifiers scroll instead of wrapping mid-token. Settings editors load on demand via LazySettings; HostsSection is extracted to avoid eagerly importing all editors through the hosts screen. The root Screen imports concrete host/add modules to preserve this boundary; the settings barrel remains available for other consumers/tests.

### Update notification

`UpdateNoticeCard({ version, restart, later, busy, narrow, children })` is the canonical nonmodal bottom-right update panel, consumed by the app shell's `UpdateNotice`. Ready, pending and inline error states use existing Button and status semantics. Arrival never steals focus; busy actions retain focus and reject activation. Narrow layouts leave room above the bottom navigation and safe area. The shell owns capability checks, per-installation/version dismissal for the app session, confirmation and the existing revision-checked restart operation. The Updates screen retains the detailed status and controls. This is an original composition of existing primitives; no new upstream code or dependency is used.

### TrafficLights

`TrafficLights({ desktop, onClose, onMinimize, onMaximize })` owns the custom
undecorated window controls. The shell only mounts it in a native desktop window.
Each named button remains keyboard-focusable, with a token-based focus ring;
visual dots sit inside larger hit areas, expanded for coarse pointers.
Production consumer: `shell/TitleBar` inside `shell/TopBar`. No upstream source
was copied for this component.

### Task detail identity and navigation

`PageTitle` renders a sentence-case `h2` using headline tokens, with layout ellipsis
and a `title` attribute supplied by the consumer for the complete name.
`PageHeader.heading` accepts this title instead of the default section heading.
`Page embedded` removes outer page gutters and width constraints when a routed
view is composed inside another page; it retains the page-body rhythm.
Production consumers: task Summary and Session in `TaskResult`, and embedded
`Session`. Standalone session rendering retains its existing header.

Task details compose the canonical quiet `ButtonLink`, `PageHeader`, `StatusPill`
and `Tabs` in a sticky navigation region. Both tabs retain the short task name,
metadata and status. The full goal remains available in Brief. Tabs retain their
roving focus, Left/Right/Home/End navigation and labelled tab panels. Active tasks
initially select Session; completed tasks initially select Summary. Changing views
does not change task identity or the scoped Tasks destination. The task list
remembers its scroll offset for each repository/scope during the app session.
No upstream component or license provenance changed.
