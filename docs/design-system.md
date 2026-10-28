# pacer design system

The web app, desktop webview and tray use the Preact foundation in `app/src/ds/`. The service owns domain state; screens bind API actions and compose presentation. Components must not import screens, shell, data clients, API/core implementations or stores. The TUI consumes shared view-model descriptors, independently of Preact.

## Tokens and density

Author `app/src/ds/tokens.json`; `app/tokens-gen.ts` validates the explicit color, type, spacing, radius, size, shadow, layer and motion groups. `tokens.local.json` holds documented provisional additions only; it currently holds the Tasks board values the design system lacks: `radius-card` (12 px), `space-3.5`, `space-7`, `space-10` (14, 28, 40 px) and `size-10`, `size-14`, `size-15`, `size-21`, `size-34`, `size-52`, `size-272`, `size-1240`, until the design system adds them. Generate CSS and TypeScript with `bun scripts/ds-sync.ts app/src/ds/tokens.json` or `bun run app:build`. Never edit generated `tokens.css`/`tokens.ts` or embedded app assets manually. The app build also refreshes the generated token prefix in `desktop/ui/shell.css`, preserving the handwritten startup-shell suffix at its existing boundary comment; a missing boundary fails the build rather than overwriting it.

`chart-1`–`chart-5` provide a calm categorical series and identity fills. Every value reaches at least 3:1 against `surface-page` and `surface-lane` in both themes. Neighbouring series can have similar luminance, so charts separate segments with gaps and carry a text legend. `aurora-1`–`aurora-3` reserve soft assistant-sheet glows; they are decorative only, never status. Neither palette replaces semantic status tokens.

All themes use one type scale. `space-2.5` supplies the missing 10px inset; control tokens specify compact 28px, normal 44px and touch 48px minima. Semantic foreground/background pairs carry statuses. Brand identity tokens are separate from status colors. The warning and information navigation badges use the tested semantic pairs, and text on tinted surfaces uses `ink-secondary`.

Compact is the desktop default, including dialogs outside the shell. `DensityProvider value="compact"` also scopes the tray, including list rows, pills and meters. Buttons (all variants and button links), text inputs and choice pickers share the 28px compact minimum, caption typography and medium radius. The top-bar Delegate is the reference control. Settings forms retain their shared 32px density; small settings actions remain 28px. Explicit `normal` density remains available at 44px for a documented need, rather than becoming a page-local override.

`NarrowContext`, owned by DS and reexported by shell for compatibility, selects 48px touch targets for narrow/repository-scoped views. At viewport widths up to 560px, DS supplies touch targets and readable input typography even for dialogs mounted outside shell context. An explicit compact surface wrapper keeps the desktop tray compact at popover widths. Textareas retain their 96px minimum and vertical resize. `ListRow` also accepts an explicit density. Screens must not override primitive typography or control dimensions to create another density.

## Catalog and API contracts

| Component | API and supported states | Production use and accessibility contract |
| --- | --- | --- |
| `Button` | Native button props and ref; `variant="primary\|secondary\|ghost\|quiet\|danger"`, `size="md\|sm"`, `busy` | All screen, shell, terminal and tray actions. Defaults to `type="button"`; opt into submit. Busy sets native disabled and `aria-busy`, while retaining its name. Visible reasons accompany unavailable capabilities; ordinary pending progress stays announced. |
| `ButtonLink`, `TextAction`, `IconButton` | Native anchor/button props and refs; ButtonLink shares button appearance; IconButton adds optional `icon: IconName` | Navigation stays an anchor, including href, current page, target, download and modifier behavior. IconButton requires `aria-label`; tooltip alone is insufficient. It retains children/ref/native button support and compact geometry; destructive icon actions such as End session use `variant="danger"`. Tray and terminal consumers remain supported. `pc-inline-link` is the CSS contract for underlined links in prose. |
| `StatusDot` | Required `tone="good\|warn\|bad\|info\|neutral"`, `label`; optional `live`, `paired="glyph\|pill"` | DS-owned passive status marker. The label is visible next to the dot (with `title` for clipped text), so status is never colour alone. `paired="glyph"` hides the label visually but keeps it for assistive tech, beside an `aria-hidden` StatusGlyph; `paired="pill"` hides the whole dot from assistive tech, because the adjacent StatusPill announces the status. Tone and label come from the `src/view-model/` status vocabulary (UI-10). Live pulse uses motion tokens and stops under reduced motion. No keyboard target or production consumers yet. |
| `HostChip` | `name`, `kind="local\|remote"` | DS-owned compact lane chip; remote includes a decorative servers icon, so host names must identify the machine ("Local Mac", an SSH alias). Long names ellipsize and retain the full name in `title` and DOM text. Passive; no keyboard target. No production consumers yet. |
| `MetaRow` | `items: MetaItem[]`, `label`; item `icon`, `text`, optional `tone`, `emphasis`, `title` | DS-owned labelled group of facts, wrapping between items. Blank text is omitted; empty groups render nothing. Each item stays on one line and clips long text with ellipsis; title defaults to full text. Semantic foregrounds and strong weight supply variants; tone is never the only signal, so the text states the fact ("2 checks failing"). Passive; production consumer: TaskCard. |
| `AgentStack` | `agents: string[]`, `size=16\|18\|20` (default 18) | DS-owned inline group reuses AgentMark; canonical identities/aliases are deduplicated in input order. Exposed as one `role="img"` whose name lists the agent display names; inner marks are decorative. Empty stacks render nothing. Passive; production consumer: TaskCard. |
| `Identicon` | `seed`, `size=16\|24\|32` (default 24) | DS-owned decorative SVG: stable FNV-1a UTF-16 hash, mirrored 5×5 cells from hash bits 8–22 (never empty; the centre cell is the fallback), one categorical chart fill chosen independently on surface-lane. Hidden from accessibility APIs; accompany it with visible identity text. No keyboard target or production consumers yet. |
| `SettingRow` | `label`, optional `description`, `status: {tone,label}` and the control as children | Settings Overview, Budget & pacing, App preferences and Diagnostics. The single settings row grammar: label, description and status on the left, control on the right, stacked at 700px and below. A canonical labelable control (TextInput, TextArea, ChoicePicker, Checkbox, Switch, Range) outside its own `<label>` and without its own `label` prop gets `<label for>` and the description appended to its `aria-describedby`, with no extra group; a bare Checkbox or Switch is wrapped in an empty `pc-checkbox` label so it keeps the settings and touch hit area. Other controls (segmented groups, buttons, links, self-labelled controls) keep their own names, and the row becomes a `role="group"` named by its label and described by its description. Give a segmented group the same label as its row. Status is a text Pill, never colour alone. |
| `SettingsNav` | `label`, `groups: {id,label,items}[]`; item `id`, `label`, `href`, `icon`, optional `current`, `badge: {text,label?,tone?}` | The grouped settings menu in the settings panel. A labelled `nav` of lists, each named by a visible group label (not a heading, so page headings stay first); links stay in document order so Tab follows the groups, and the current item scrolls into view in the narrow strip. The current page carries `aria-current="page"`. Glyph and count badges are visually shown and announced by their `label` through screen-reader text, with `title` for pointer users. The shell lays groups out in a row on narrow layouts. |
| `TaskCard`, `TaskTree` | `TaskCard`: one `TaskNodeView` from `src/view-model/task-tree.ts`, `density="regular\|compact"`, controlled `expanded` and `onToggle(id)`, `selectedId`, `href(id)`, optional `viewHref(id, view)` for the quick actions and `onSelect(id)`. `TaskTree`: `nodes`, `density`, `selectedId`, `href`, `label`, `viewHref`, `onSelect`, and owns expansion by task id | DS-owned composite for "a task in a tree", drawn as the Tasks and Session boards draw it. Regular: a 10 px status dot, the title link (15/21/600), an attention pill (or the outcome for settled work), then `HostChip`, branch in mono, `AgentStack`, tokens in a right-aligned column and three icon links (Notes, Open terminal, Changes), then a `MetaRow` of measured facts. Compact (the 272 px Session panel): 8 px dot and title, host and repository, then the status words, agents and tokens. A quiet "N subtasks" toggle (`aria-expanded`, `aria-controls`, name "N subtasks of <title>") opens indented child rows. The dot carries its words for assistive technology, and the pill or status text carries them for sighted users. Tint, pill colour and words come from one vocabulary status; a subtask's worse attention rolls up with its words ("Subtask: Failed"). Roots sort by tint (bad, then warn), then Needs you severity, then running and queued work, then recency. A root's tokens add up its subtasks'. Facts the descriptor omits render nothing, and their columns keep their width. The selected row takes the lane surface; `TaskTree` opens a root holding the selection. Expansion is keyed by id. Titles clip on one line with the full text in `title`. Touch height below 768 px. Production consumers: Tasks (regular), Session panel (compact). |
| `Field` | `label`, optional `help`, `error`, children and className | Delegate, Quick Delegate, verdict and settings forms. Finds the first canonical labelable control through layout/fragment children, preserves every sibling, and assigns stable label/help/error IDs. Explicit child IDs win; existing `aria-describedby` values are retained. A Field owns one control; use separate Fields for several controls. Custom opaque child components must supply their own label contract. |
| `TextInput`, `TextArea` | Native attributes, events and native element refs | Form validation, autocomplete, disabled state, required, min/max, selection and keyboard behavior remain native. TextArea owns resize/minimum height. |
| `ChoicePicker` | Controlled `value`, `options: {value,label,disabled?,reason?,description?}[]`, `onValueChange`, optional `placeholder`, `searchable`, `required`, `disabled`, `name`, `id`, ARIA attributes and button ref | Shared single-choice menu for app forms. `Field` labels the trigger and connects help/errors. A missing value stays unselected; disabled options expose reasons and cannot be committed. Trigger/search keyboard supports arrows, Home/End, typeahead for short lists, Enter, Escape and Tab; the active option scrolls into view, Tab advances correctly inside dialogs, and outside pointer dismisses. Search is opt-in for long lists. The listbox stays inside its native dialog when modal; the popup chooses the roomier side and caps its scrollable height to the available space. A named hidden input bridges form data only while enabled; owning forms show field errors and focus the first missing required picker. Compact/settings/touch sizes use density tokens. |
| `Checkbox`, `Switch`, `Range` | Native input props/ref; optional visible `label`; Checkbox/Switch `help` and `mixed` | Bulk selection, executor/update settings, host sessions, terminal screen-reader mode and planner reserve. A Checkbox without `label` requires a surrounding label or `aria-label`. `mixed` sets DOM indeterminate and `aria-checked="mixed"`; Switch uses a native checkbox with switch role. Range accepts its accessible label via Field, visible label or aria-label. |
| `Disclosure` | `summary`, native details attributes and children | Technical routing, cost, log, acceptance and CLI details. Native summary retains keyboard and expanded behavior; full code remains selectable. |
| `Dialog`, `PopoverDialog`, `useDialogs` | `Dialog`: `title`, `close`, content; shared confirmation/prompt orchestration. `PopoverDialog`: stable `id`, `title`, `close`, content. | Native modal dialogs own Escape cancellation, Tab cycling and focus return. The compact popover variant anchors above the status bar, focuses its first enabled button, and closes on backdrop click. Dialog/Field styles are DS-owned and available to tray. Use an explicit visible submit label, and preserve whitespace validation on required rejection notes. |
| `TextRow` | `label`, `value`, optional `meta` | Settings check progress uses label/value/meta alignment and tabular figures. Values wrap without hiding labels; this is presentation, not a form or semantic table replacement. |
| `ListRow` | `leading`, `content`, `meta`, `actions`, native div attributes, optional density and `layout="aligned"` | Overview attention/running/done/activity, Tasks list and tray attention. Slots are siblings. The aligned variant gives desktop rows stable metadata and action columns above 1100px; below that it keeps the normal wrapping row. Row-level focus/data attributes remain on the outer row. Keep full titles in title/detail while clipping through CSS. Secondary actions belong in actions, outside any destination link. |
| `ListRowLink` | Native anchor attributes and children | Capacity and tray running rows with a single destination. Never put another control inside it. Session replay uses the DS `pc-row-destination`/`pc-list-row--stretch` contract to expand a single link target without nesting controls. |
| `SelectableRow`, `ChoiceCard`, `FilterChip` | Button props plus optional `selected`; existing aria-pressed/current supported | Review queue/files, Add Executor choices and repo filters. Selection stays controlled by the caller. Choices use buttons and pressed state, not invented tab semantics. |
| `CountBadge` | Numeric `count`, optional accessible unit `label` (defaults to work items) | Repository filter chips and finder rows. Neutral filled badge with tabular figures; selected chips inherit the chip contrast pair. Counts remain non-interactive and separate from status pills. |
| `SearchPicker` | Trigger `label`, `searchLabel`, `placeholder`, `emptyLabel`, controlled `value`, `{value,label,description?,count?,searchText?}` options and `onChange` | Repository finder on Overview and Review; searches every registered repo, including those with zero work. Trigger-anchored, right-aligned menu switches alignment near the left viewport edge and fills the row below 560px. Native buttons expose pressed state, the search field receives focus, arrows/Home/End move among results, and Escape/selection return focus. Tab departure and outside pointer dismiss without stealing focus. Search resets on dismissal; filtered empty text is a polite status. Menu rows inherit normal/compact/touch density. |
| `SegmentedControl`, `Tabs` | Label, controlled value, `{value,label,disabled?}` options and onChange; Tabs additionally requires stable id | Settings switches and Session views. SegmentedControl is a labelled group of pressed buttons. Tabs owns tablist/selected/controls/roving tabIndex and ArrowLeft/Right/Home/End; the consumer renders matching labelled tabpanels. Disabled tabs are skipped. |
| `SidePanel` | `side="left\|right"`, `label`, controlled `open`, `onToggle(open)`, children | Settings navigation (left, default open, `usePanelState("settings")`). Open: an `aside` landmark named by `label`, a quiet `panel-left`/`panel-right` IconButton named "Hide <label>" with `aria-expanded="true"` and `aria-controls` pointing at the content, then the scrollable content. Closed: only a 40px strip with "Show <label>" and `aria-expanded="false"`; the content is not rendered. The open and closed toggles are different elements, so focus moves to the new toggle when the old one had it or when collapsing removed the focused element. Left reuses the 200px settings width, right uses `size-320`. The shell owns sticky positioning and hides side panels below 768px, as the settings panel was before; narrow layouts never use it. Ctrl-b toggles the left panel when one is shown, and is not registered below 768px. Presentational; consumers own persistence. |
| `PanelTabs` | `label`, `tabs: {id,label,icon?,badge?}[]`, controlled `value`, `onChange(id)`, `maxVisible` (default 4) | Compact tablist for panels; no production consumer yet (the right panel adopts it later). The tablist keyboard contract of `Tabs`: `aria-selected`, roving tabIndex and ArrowLeft/Right/Home/End through the shared `tabStep`. Unlike `Tabs` it renders no tab ids or `aria-controls` yet; the first consumer that adds a tabpanel adds them. Tabs past `maxVisible` move into a quiet "+N" IconButton named "+N more tabs" (`aria-haspopup="menu"`, `aria-expanded`) that opens a menu of the hidden tabs; the selected tab always stays in the strip. The menu focuses its first item, supports ArrowUp/Down/Home/End, Enter/Space chooses (focus moves to the chosen tab), Escape closes and returns focus to the "+N" button, and leaving it with Tab closes it. A badge renders through `CountBadge` with words ("3 items"); zero hides it. Labels ellipsize with the full label in `title`. |
| `Card` / `pc-card`, `ApprovalCard` | Native section props; ApprovalCard optional title/actions slots | Shared settings card CSS also works on native form/div containers. Review verdict uses ApprovalCard framing while VerdictPanel owns decisions and actions. Do not repeat the same heading in both wrapper and content. |
| `Pagination` | Controlled `label`, zero-based `page`, `pageSize`, `total`, `onChange` | Overview lists. Uses canonical small Buttons with inherited density. Range is a polite live status; only available Previous/Next actions render. Native Tab/Enter/Space activation. Paging moves focus to the persistent labelled navigation region so disappearing boundary buttons do not lose focus. Empty lists omit navigation. Authored locally; no upstream adaptation. |
| `LoadingState`, `EmptyState` | Loading label/updating; empty title/description/children | Shell connection, task/session/settings resources, Overview and Review clear states, tray connecting. Loading is a polite status with decorative pixel grid; reduced motion freezes it. Refreshing content remains mounted. Errors remain explicit adjacent alerts with existing retry actions. |
| `Page`, `PageHeader`, `PageBody`, `PageColumns` | Named `standard`, `wide` or `full` page width; breadcrumb/identity/metadata/status/action slots; main and optional aside | Every routed app screen uses `full` to fill the available workspace. The `standard` and `wide` variants remain available for explicitly constrained compositions. Page owns width, centering, responsive/safe-area gutters and page rhythm. PageHeader never invents another `h1`; the shell top bar remains the page title. Columns keep main before aside in DOM order and collapse centrally. Screen CSS must not redefine page width, centering or outer gutters. |
| `Stack`, `Cluster`, `Section`, `DisclosurePanel`, `ActionPanel` | Semantic compact/normal/section spacing and contained section/detail/action composition | Shared page composition. These are original local Preact components with no upstream adaptation. Consumers provide content and domain state; DS tokens own spacing, borders and responsive behavior. Specialized tables, diffs, terminal geometry and domain grids remain screen-owned. |
| `SectionHeading`, `Pill`, `StatusPill`, `StatusGlyph` | Existing heading and semantic descriptor APIs | One section-heading type scale. Status descriptors come from `src/view-model/words.ts`; glyph and text accompany color. Color alone never encodes a result. |
| `UsageMeter`, `AgentMark`, `Mark`, `Icon`, `Kbd`, `Tooltip` | Existing documented typed props in their modules | Specialized meter geometry, vendor identity, navigation, shortcuts and tooltips remain shared. Stale meter readings visibly say Historical usage, include a known capture time, and announce freshness through the meter value text. A Kbd composed inside a button inherits the action foreground on a transparent surface, retaining the action contrast pair in both themes. Usage percentages are data, not ad-hoc style. Agent colors mirror shared identity descriptors in both themes. |
| `TrafficLights` | `desktop`, `onClose`, `onMinimize`, `onMaximize` | Linux desktop fallback for the undecorated main window. The macOS main window uses Tauri's decorated overlay and native traffic lights, following [Tauri's window customization guidance](https://v2.tauri.app/learn/window-customization/); the web controls are hidden and their header space remains reserved. Browser views render no window controls. The bundled startup shell provides a drag strip above its content. |

`AppFrame` (shell) owns the window regions: skip link, top bar, activity rail, optional left panel, the work area with the live region and `main#main-content`, optional right panel, optional bottom dock and status bar. Without panel or dock content it renders exactly the landmarks and classes the shell had before. Narrow layouts keep the touch order (bottom navigation first, header inside the work area) and drop the right panel and dock. Panel open state persists per id through `usePanelState` (`localStorage` key `pacer.panel.<id>`; unavailable storage falls back to the default). The terminal dock is 320px (`size-320`), at most half the viewport height, and embeds the workspace terminal without page gutters, keeping its tab choice local. It never appears on the Terminal route, on Setup or below 768px, where the shell also hides side panels. Ctrl-` (registered with `allowInControl`, so it also works while the docked shell has control) and the status-bar Terminal button toggle it; opening moves focus into the dock and closing returns it to the control that opened it. While the dock is open the frame fits the viewport and the work area scrolls on its own. A docked shell holds keyboard control only while focus is inside the dock.

`StatusBar` shows each vendor mark and usage percentage inside one click target below the desktop content. Its accessible name includes account names and stale-reading status. It uses `Kbd` and the active shortcut registry for each route; narrow screens keep the touch navigation and compact executor percentages instead. The usage target opens a read-only account panel using `account.list` windows, reset times and freshness. Reload reads the latest available account data; it does not force a provider refresh. Overview keeps planner advice, executor eligibility and parallel-task slots while usage appears in the status bar.

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
| Review/detail | Selectable queue/file rows, ApprovalCard, Field/input/ChoicePicker/disclosure, asynchronous state | Bulk selection and verdict workflows, semantic definition lists, specialized Diff renderer and horizontal code scrolling. |
| Sessions/detail | ListRow, canonical replay target, Tabs, controls, loading/empty states | Controller/resource fetching, session/PTY lifecycle, timeline, terminal/diff rendering and command copy. Unsupported attach targets are omitted; refused takeover retains visible service reason. |
| Settings/hosts/Add Executor/Diagnostics | Canonical form controls/Field, switch, range, SegmentedControl, ChoiceCard, pc-card, TextRow | Settings grid, semantic tables (including mobile data labels), wizard progress and API-bound operations. Host and executor domain decisions remain local. Diagnostics binds doctor.run to canonical Button, Pill and Disclosure; idle/running/error states are announced, reruns wait for completion, and technical evidence/repair guidance stays collapsed. |
| Setup/delegate/dialogs | Button/ButtonLink/TextAction, Field/ChoicePicker/native text controls, Dialog and Disclosure | Consent, setup checklist, draft/validation and delegation data. |
| Shell | Canonical actions/links and DS density, loading status; TrafficLights native controls | Desktop: one 32px top bar with compact Delegate and a sticky 40px icon rail (32px links). Native controls appear only in Tauri; title and empty header space support native dragging. Narrow screens retain the touch header and bottom navigation; coarse pointers retain touch targets. Settings keeps secondary navigation in a collapsible left `SidePanel`; `AppFrame` owns the regions, including the optional terminal dock. Landmarks, current-route labels, tooltips, skip-link route focus and keyboard focus remain available. |
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

Settings screens mount one editor per route. `settings-pages.ts` owns page
labels, icons, menu groups, Overview descriptions, shell titles and the
attention badges shared by the menu and Overview. Sections folded into another
page (`updates`, `notifications`, `appearance` → App preferences) keep their
routes and scroll to their section. Settings rows use `SettingRow`. The bounded settings
canvas owns label/control grids and semantic table columns. Primary page titles
remain in the shell; nested sections retain `SectionHeading`. Navigation icons
are decorative beside named links, with one current category. No new upstream
adaptation or dependency is introduced.

### Session content

`Prose({ text })` renders executor-authored text as an escaped Markdown subset: paragraphs, headings (canonical `SectionHeading` at h3), unordered lists, bold text, inline code and fenced code. Unsupported Markdown remains literal text. It never renders HTML, images or executable URLs. Code retains token boundaries and scrolls within its container; paragraphs preserve line breaks. It uses the normal token type scale at every density. Session briefs and executor reports are its production consumers. This is an original Preact composition; no additional upstream code or dependency is incorporated.

Session details retain a specialized responsive main/activity layout. They compose canonical Tabs, Disclosure, Field, ChoicePicker, Dialog, Button and StatusPill. Active sessions default to Output; ended sessions default to Brief, and an explicit tab selection stays selected during refreshes. Brief sections use API-provided fields; the original text remains in a collapsed disclosure. The executor report is formatted separately from the unmodified technical log; absent reports are not inferred from logs. Retry selection opens the canonical modal, with picker keyboard controls, Escape dismissal, focus cycling/return, visible unavailable reasons, pending state and errors. Changes remain the service-provided diff rather than an inferred file summary.

Completed task results retain their primary result workflow and offer a quiet Session details action. It opens the session workspace; Back to result returns without changing task state. Active tasks continue to open the session workspace directly.
# Session attachment presentation

`AttachmentPicker({onFiles, disabled})` keeps a native multiple-file input under a styled shared trigger. It supports keyboard file selection; consumer drop/paste handlers feed the same callback. `AttachmentTray({items, onRemove, onRetry})` owns image thumbnails, names, sizes, uploading/ready/error states and secondary retry/remove controls. `items[].removable=false` hides removal for immutable claimed session files. Image alt text is empty because the adjacent filename supplies the name. Actions have explicit accessible names, focus follows canonical Button behavior, and density follows Controls/Button context.

Ownership: `app/src/ds/AttachmentTray.tsx` and DS CSS. Consumers: StartSession and SessionAttachments. Authenticated upload state and file bytes belong to consumers/service, never DS. This is original project code with no copied upstream source. The terminal conversation layout stays specialized: PTY geometry and native terminal input remain owned by the terminal renderer.

Terminal font, cell geometry and ANSI colors are generated by upstream `@xterm/xterm` 6.0.0 (`src/browser/renderer/dom/DomRenderer.ts`, MIT license retained in the installed package). The adapter uses its documented `documentOverride` option to nonce only terminal-created style elements; the global document is unchanged. The service issues a fresh style nonce per HTML response, with no `unsafe-inline` CSP allowance. The optional upstream scrollbar stylesheet uses the global document and remains blocked rather than broadening policy. Native PTYs advertise truecolor independently of automation's `NO_COLOR`/`FORCE_COLOR` environment; Pacer's own TUI retains its existing color-preference handling.

The shared `Icon` catalog includes `terminal` for the rail's Terminal route. The route uses the existing rail button semantics and keyboard navigation. The Terminal screen owns tabs, split geometry and PTY controls; `TerminalView` accepts `shell` to show shell-specific copy and xterm search, while agent-session usage keeps its existing controls. The search addon is loaded only with the lazy terminal bundle.

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
does not change task identity or the scoped Tasks destination. The task list uses
the same full-width `Page` gutters and bordered sections as Overview. Its controller prefers the complete `fullTitle`, with the
compatibility `title` as a fallback; `pc-ellipsis` clips only when the row runs out
of space, and tooltips and action names retain the full display text. The list
remembers its scroll offset for each repository/scope during the app session.
Start work recent links put their complete display title in a `pc-ellipsis` child
with a full-title tooltip; clipping belongs to that text block, since ellipsis on
the flex link itself cannot truncate its anonymous text item. Start work uses the
full-width page frame with a main composer and a Recent work side panel; they
stack when the viewport is 1,000px or narrower.
No upstream component or license provenance changed.

### Spacing ownership and rhythm

Layout gaps are the single owner of separation. `Stack` uses `compact` (8px) for
related rows, `normal` (12px) for content and `section` (24px) between regions.
The legacy `pc-section` class is DS-owned and uses 8px between its heading,
status text and related content. Direct children of stacks, page bodies,
sections, cards, sticky detail navigation, action panels and disclosure bodies have zero block margins.
`PageHeader` retains a 24px standalone trailing margin; a parent layout gap
replaces it. Do not layer a child margin over that gap.

`Section` bodies, disclosure bodies and action panels stack content at 12px.
`DisclosurePanel` summaries have a 36px desktop minimum and a 48px narrow-layout
minimum, with full-width keyboard targets and unchanged native details semantics.
Related task disclosures live in one compact stack. Task Result, settings cards,
Overview quick delegation, session reports and task lists consume this contract.
Settings sections own a 12px body gap; label descriptions use 4px, and bordered
sections retain 12px padding after the separator. Session lists use 24px between
regions and 12px between a region heading and its rows. Prose retains 12px between
blocks and list indentation; data tables, diff rows, terminal canvases, setup
choices and composer fields keep their specialized documented geometry.

UI-27 source checks reject consumer CSS spacing overrides of the shared layout
classes, including token-valued overrides. Browser regressions in
`test/app-spacing.test.tsx` check actual geometry at 1440px and 375px; run with
`PACER_TEST_BROWSER` pointing to an installed Chromium executable. They complement
screenshots and live validation rather than asserting that all visual decisions
can be enforced by a source checker. No upstream component was introduced.

The macOS browser CI job explicitly runs spacing and compact-density geometry
checks with its installed Chromium, so these regressions do not silently skip in
CI. Local full-suite runs still opt in through `PACER_TEST_BROWSER`.

Settings save bars, project cards, executor choices and footers inherit the parent
gap instead of adding their legacy outer margins. An empty project executor list
is hidden so it does not insert a second grid gap. The start composer keeps its
intentional landing-page offset; rail dividers retain extra separation between
navigation groups. These specialized layouts do not override shared primitives.
