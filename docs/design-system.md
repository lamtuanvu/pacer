# pacer design system

The web app, desktop webview and tray use the Preact foundation in `app/src/ds/`. The service owns domain state; screens bind API actions and compose presentation. Components must not import screens, shell, data clients, API/core implementations or stores. The TUI consumes shared view-model descriptors, independently of Preact.

## Tokens and density

Author `app/src/ds/tokens.json`; `app/tokens-gen.ts` validates the explicit color, type, spacing, radius, size, shadow, layer and motion groups. The tray adds provisional `size-236` (More menu width), `shadow-tray-menu` (More menu elevation, coloured by the light/dark `shadow-tray-menu-tint`) and `tray-count` (count typography). `Button`/`ButtonLink` size `xs` uses space-2 horizontal padding and space-1 gap in default and compact density, using the shared density minimum height and retaining keyboard semantics. The tray footer consumes it.

`tokens.local.json` holds documented provisional additions only; it currently holds the Tasks board values the design system lacks: `radius-card` (12 px), `space-3.5`, `space-7`, `space-10` (14, 28, 40 px) and `size-10`, `size-14`, `size-15`, `size-21`, `size-34`, `size-52`, `size-272`, `size-1240`, plus the app-frame chrome values `size-3/4/5/84/420/neg-6` (`size-10/14/52` are shared), `radius-xs`, the colour `ink-on-fill` (white in light, `#18181b` in dark to keep 4.5:1 on the lighter dark fill) and the type style `count-badge` (10px/700), plus the command menu values `size-72` and the type style `match-strong` (13/19, weight 700), plus the Dispatcher board's column widths `size-220`, `size-140` and `size-110`, until the design system adds them. The command menu also reuses the frame chrome's `size-420`, the Tasks board's `size-15` and `size-52`, and the file viewer board's `radius-4` (key caps) and `radius-7` (row glyph tiles). The file viewer board adds `size-12.5`, `size-10.5`, `size-5`, `size-440`, `radius-2`, `radius-4`, `radius-5` and `radius-7`. Generate CSS and TypeScript with `bun scripts/ds-sync.ts app/src/ds/tokens.json` or `bun run app:build`. Never edit generated `tokens.css`/`tokens.ts` or embedded app assets manually. The app build also refreshes the generated token prefix in `desktop/ui/shell.css`, preserving the handwritten startup-shell suffix at its existing boundary comment; a missing boundary fails the build rather than overwriting it.

`chart-1`–`chart-5` provide a calm categorical series and identity fills. Every value reaches at least 3:1 against `surface-page` and `surface-lane` in both themes. Neighbouring series can have similar luminance, so charts separate segments with gaps and carry a text legend. `aurora-1`–`aurora-3` reserve soft assistant-sheet glows; they are decorative only, never status. Neither palette replaces semantic status tokens.

`chart-1`–`chart-5` provide a calm categorical series and identity fills. Every value reaches at least 3:1 against `surface-page` and `surface-lane` in both themes. Neighbouring series can have similar luminance, so charts separate segments with gaps and carry a text legend. `aurora-1`–`aurora-3` reserve soft assistant-sheet glows; they are decorative only, never status. Neither palette replaces semantic status tokens.

`chart-1`–`chart-5` provide a calm categorical series and identity fills. Every value reaches at least 3:1 against `surface-page` and `surface-lane` in both themes. Neighbouring series can have similar luminance, so charts separate segments with gaps and carry a text legend. `aurora-1`–`aurora-3` reserve soft assistant-sheet glows; they are decorative only, never status. Neither palette replaces semantic status tokens.

All themes use one type scale. `space-2.5` supplies the missing 10px inset; control tokens specify compact 28px, normal (Comfortable) 32px and touch 44px minima. Semantic foreground/background pairs carry statuses. Brand identity tokens are separate from status colors. The warning and information navigation badges use the tested semantic pairs, and text on tinted surfaces uses `ink-secondary`.

Comfortable (`normal`) is the default for new installs and existing installs with no saved density choice, including dialogs outside the shell. An explicit saved Comfortable or Compact choice is preserved. Shared page-header, toolbar and card action buttons use DS `sm`: 32px in Comfortable and 28px in Compact. All variants and button links share one density rule; Settings action buttons inherit the app preference. Comfortable single-line inputs keep 13px body text at 32px height; Compact inputs use 12px caption text at 28px. Settings fields, icons and segmented controls follow the selected desktop density.

`NarrowContext`, owned by DS and reexported by shell for compatibility, selects 44px touch targets for narrow/repository-scoped views. At viewport widths up to 560px or with coarse pointers, DS supplies 44px control targets, including filter chips and tabs, even for dialogs mounted outside shell context. The tray keeps its independent `sm` 32px action size at popover widths, using its own compact token. Textareas retain their 96px minimum and vertical resize. `ListRow` also accepts an explicit density. Screens must not override primitive typography or control dimensions to create another density.

## Catalog and API contracts

| Component | API and supported states | Production use and accessibility contract |
| --- | --- | --- |
| `Button` | Native button props and ref; `variant="primary\|secondary\|ghost\|quiet\|danger"`, `size="md\|sm\|xs"`, `busy` | All screen, shell, terminal and tray actions. Defaults to `type="button"`; opt into submit. Busy sets native disabled and `aria-busy`, while retaining its name. Visible reasons accompany unavailable capabilities; ordinary pending progress stays announced. |
| `ButtonLink`, `TextAction`, `IconButton` | Native anchor/button props and refs; ButtonLink shares button appearance; IconButton adds optional `icon: IconName` | Navigation stays an anchor, including href, current page, target, download and modifier behavior. IconButton requires `aria-label`; tooltip alone is insufficient. It retains children/ref/native button support and compact geometry; destructive icon actions such as End session use `variant="danger"`. Tray and terminal consumers remain supported. `pc-inline-link` is the CSS contract for underlined links in prose. |
| `StatusDot` | Required `tone="good\|warn\|bad\|info\|neutral"`, `label`; optional `live`, `paired="glyph\|pill"` | DS-owned passive status marker. The label is visible next to the dot (with `title` for clipped text), so status is never colour alone. `paired="glyph"` hides the label visually but keeps it for assistive tech, beside an `aria-hidden` StatusGlyph; `paired="pill"` hides the whole dot from assistive tech, because the adjacent StatusPill announces the status. Tone and label come from the `src/view-model/` status vocabulary (UI-10). Live pulse uses motion tokens and stops under reduced motion. No keyboard target or production consumers yet. |
| `HostChip` | `name`, `kind="local\|remote"` | DS-owned compact lane chip; remote includes a decorative servers icon, so host names must identify the machine ("Local Mac", an SSH alias). Long names ellipsize and retain the full name in `title` and DOM text. Passive; no keyboard target. No production consumers yet. |
| `MetaRow` | `items: MetaItem[]`, `label`; item `icon`, `text`, optional `tone`, `emphasis`, `title` | DS-owned labelled group of facts, wrapping between items. Blank text is omitted; empty groups render nothing. Each item stays on one line and clips long text with ellipsis; title defaults to full text. Semantic foregrounds and strong weight supply variants; tone is never the only signal, so the text states the fact ("2 checks failing"). Passive; no production consumers yet. |
| `AgentStack` | `agents: string[]`, `size=16\|18\|20` (default 18) | DS-owned inline group reuses AgentMark; canonical identities/aliases are deduplicated in input order. Exposed as one `role="img"` whose name lists the agent display names; inner marks are decorative. Empty stacks render nothing. Passive; no production consumers yet. |
| `Identicon` | `seed`, `size=16\|24\|32` (default 24) | DS-owned decorative SVG: stable FNV-1a UTF-16 hash, mirrored 5×5 cells from hash bits 8–22 (never empty; the centre cell is the fallback), one categorical chart fill chosen independently on surface-lane. Hidden from accessibility APIs; accompany it with visible identity text. No keyboard target or production consumers yet. |
| `SettingRow` | `label`, optional `description`, `status: {tone,label}` and the control as children | Settings Overview, Budget & pacing, App preferences and Diagnostics. The single settings row grammar: label, description and status on the left, control on the right, stacked at 700px and below. A canonical labelable control (TextInput, TextArea, ChoicePicker, Checkbox, Switch, Range) outside its own `<label>` and without its own `label` prop gets `<label for>` and the description appended to its `aria-describedby`, with no extra group; a bare Checkbox or Switch is wrapped in an empty `pc-checkbox` label so it keeps the settings and touch hit area. Other controls (segmented groups, buttons, links, self-labelled controls) keep their own names, and the row becomes a `role="group"` named by its label and described by its description. Give a segmented group the same label as its row. Status is a text Pill, never colour alone. |
| `SettingsNav` | `label`, `groups: {id,label,items}[]`; item `id`, `label`, `href`, `icon`, optional `current`, `badge: {text,label?,tone?}` | The grouped settings menu in the settings panel. A labelled `nav` of lists, each named by a visible group label (not a heading, so page headings stay first); links stay in document order so Tab follows the groups, and the current item scrolls into view in the narrow strip. The current page carries `aria-current="page"`. Glyph and count badges are visually shown and announced by their `label` through screen-reader text, with `title` for pointer users. The shell lays groups out in a row on narrow layouts. |
| `Stepper` | `label`, `steps: {id,title,detail?,state:"done\|current\|todo",reachable}[]`, `onSelect(id)` | Add agent wizard progress. An ordered list; reachable steps are quiet buttons, the current one carries `aria-current="step"`, done steps say "done" to assistive technology, and steps not yet reachable are plain text. Arrow Up/Down/Left/Right, Home and End move focus between the buttons; Enter and Space select. The Add agent page queries its own inline size: below 774px, steps wrap above the full-width panel without a horizontal scroller. Step marks use the 700 weight token. The caller decides which steps are reachable (the wizard gates them on completed earlier steps). |
| `CheckList` | `label`, `items: {id,label,state:"passed\|failed\|running\|pending\|skipped",note?}[]` | Add agent test task and the Machines connect-and-check list. Each row has a glyph, a visually hidden result word and an optional note, so a result is never colour alone. Rows come from the service's job steps; nothing is invented. |
| `NavTabs` | `label`, `items: {href,label,current?}[]` | Agents page Executors and Accounts tabs. A labelled `nav` of ButtonLinks sharing the Tabs underline; the current page carries `aria-current="page"`. Use `Tabs` for in-page panels and `NavTabs` when each tab is its own route. Settings navigation tabs use 32px minimum height, 13px text and 12px inline padding, with 44px touch height. |
| `MetaRow` | `items: MetaItem[]`, `label`; item `icon`, `text`, optional `tone`, `emphasis`, `title` | DS-owned labelled group of facts, wrapping between items. Blank text is omitted; empty groups render nothing. Each item stays on one line and clips long text with ellipsis; title defaults to full text. Semantic foregrounds and strong weight supply variants; tone is never the only signal, so the text states the fact ("2 checks failing"). Passive; production consumer: TaskCard. |
| `AgentStack` | `agents: string[]`, `size=16\|18\|20` (default 18) | DS-owned inline group reuses AgentMark; canonical identities/aliases are deduplicated in input order. Exposed as one `role="img"` whose name lists the agent display names; inner marks are decorative. Empty stacks render nothing. Passive; production consumer: TaskCard. |
| `Identicon` | `seed`, `size=16\|24\|32` (default 24) | DS-owned decorative SVG: stable FNV-1a UTF-16 hash, mirrored 5×5 cells from hash bits 8–22 (never empty; the centre cell is the fallback), one categorical chart fill chosen independently on surface-lane. Hidden from accessibility APIs; accompany it with visible identity text. No keyboard target. Production use: Settings › Dispatcher saved setups, beside the setup name. |
| `StackedShareBar` | `label`, `segments: ShareSegment[]` from `src/view-model/dispatch.ts` (`id`, `label`, optional `agent` and `role`, `share` 0–100, `tasks`, `tokens`, `series=1…5`) | DS-owned share of one whole: a stacked bar on `chart-1`–`chart-5` with gaps between segments, then a legend in the same order. The bar is one `role="img"` SVG named in words ("Token share: Codex 53%, …"); segments are geometry with no targets. The legend is a labelled table (Agent, Tasks, Tokens, Share) whose row headers state the name and role beside a decorative swatch and agent mark, and whose cells state tasks, tokens and percentage in text, so a share is never colour alone. A zero share stays in the legend but draws no segment; with no positive share it renders nothing. Names clip with the full text in `title`; below 560 px the role is hidden first. Production consumer: Dispatch "Where the tokens went", which renders only when token accounting reports a measured or partial reading. |
| `SettingRow` | `label`, optional `headingLevel={3}`, `description`, `status: {tone,label}` and the control as children | Settings Overview, Budget & pacing, App preferences, Dispatcher and Diagnostics. The single settings row grammar: label, description and status on the left, control on the right, stacked at 700px and below. A canonical labelable control (TextInput, TextArea, ChoicePicker, Checkbox, Switch, Range) outside its own `<label>` and without its own `label` prop gets `<label for>` and the description appended to its `aria-describedby`, with no extra group; a bare Checkbox or Switch is wrapped in an empty `pc-checkbox` label so it keeps the settings and touch hit area. Other controls (segmented groups, buttons, links, self-labelled controls) keep their own names, and the row becomes a `role="group"` named by its label and described by its description. Give a segmented group the same label as its row. Status is a text Pill, never colour alone. |
| `SettingsNav` | `label`, `groups: {id,label,items}[]`; item `id`, `label`, `href`, `icon`, optional `current`, `badge: {text,label?,tone?}` | The grouped settings menu in the settings panel. A labelled `nav` of lists, each named by a visible group label (not a heading, so page headings stay first); links stay in document order so Tab follows the groups, and the current item scrolls into view in the narrow strip. The current page carries `aria-current="page"`. Glyph and count badges are visually shown and announced by their `label` through screen-reader text, with `title` for pointer users. The shell lays groups out in a row on narrow layouts. |
| `TaskCard`, `TaskTree` | `TaskCard`: one `TaskNodeView` from `src/view-model/task-tree.ts`, `density="regular\|compact"`, controlled `expanded` and `onToggle(id)`, `selectedId`, `href(id)`, optional `viewHref(id, view)` for the quick actions, `onSelect(id)`, an optional `flush` borderless presentation (9px/20px row padding, lane dividers; the containing section owns the frame and the row draws no hover surface), and an `actions` slot for buttons beside the title (Take over and Stop on Dispatch). `TaskTree`: `nodes`, `density`, `selectedId`, `href`, `label`, `viewHref`, `onSelect`, and owns expansion by task id | DS-owned composite for "a task in a tree", drawn as the Tasks and Session boards draw it. Regular: a 10 px status dot, the title link (15/21/600), an attention pill (or the outcome for settled work), then `HostChip`, branch in mono, `AgentStack`, tokens in a right-aligned column and three icon links (Notes, Open terminal, Changes), then a `MetaRow` of measured facts. Compact (the 272 px Session panel): 8 px dot and title, host and repository, then the status words, agents and tokens. A quiet "N subtasks" toggle (`aria-expanded`, `aria-controls`, name "N subtasks of <title>") opens indented child rows. The dot carries its words for assistive technology, and the pill or status text carries them for sighted users. Tint, pill colour and words come from one vocabulary status; a subtask's worse attention rolls up with its words ("Subtask: Failed"). Roots sort by tint (bad, then warn), then Needs you severity, then running and queued work, then recency. A root's tokens add up its subtasks'. Facts the descriptor omits render nothing, and their columns keep their width. The selected row takes the lane surface and keeps the same 600 title weight as unselected rows; `TaskTree` opens a root holding the selection. Expansion is keyed by id. Titles clip on one line with the full text in `title`. Touch height below 768 px. Production consumers: Tasks (regular), Session panel (compact), Dispatch (compact flush Live dispatch rows with the `actions` slot). |
| `SortableList` | `label`, `items: {key,label,detail?,displayLabel?,leading?,trailing?}[]`, `onReorder(keys)`, optional `onRemove(key)`, `disabled`, `renderExtra(item,index)`, `iconControls` (28px arrow/remove actions; 48px touch); helpers `moveKey`, `positionAnnouncement`, `useStableKeys(count)` (keys for entries without identity) and `useFocusAfterRender()` (focus a control that a change moves or removes) | DS-owned ordered list (`ol` named by `label`, kept mounted when empty so focus has a target). A decorative drag handle reorders with the pointer (pointer capture, so mouse, pen and touch share one path); the drop target row gets a dashed focus-coloured border, not colour alone. Move up, Move down and Remove buttons are the keyboard path; their names start with the visible text ("Move up: {label}", WCAG 2.5.3). The first row has no Move up and the last no Move down, rather than a disabled control. After a move, focus stays on the same item's control (or its other move control at an edge); after a remove it goes to the neighbour, else the list. A polite live region announces "{label} moved to position N of M." or "{label} removed." Labels clip with ellipsis and keep `title`. Narrow layouts wrap actions under the label with touch-sized targets. Production use: Settings › Dispatcher eligibility rules, project order and ladder steps. |
| `SaveBar` | `count`, `onSave`, `onDiscard`, optional `busy`, `saveLabel`, `blockedReason`, `notice`, `scope`, `statusDot` (warn dirty/good saved), `size="sm"|"md"`, children | DS-owned pending-changes region ("Unsaved changes"; "Save status" while it only shows a notice), sticky to the bottom of its scroller; the app shell offsets it above the status bar and narrow bottom navigation and adds matching scroll padding. Shows "N unsaved change(s)", Discard and the region's one primary Save; a blocked Save stays disabled beside its visible `blockedReason`, linked with `aria-describedby` (UI-13). The count is a polite live region that stays mounted while clean (visually hidden and not a landmark), so the first change, "Saving…" and a later `notice` such as "Saved …" are announced. Children carry errors, conflicts or progress. Production use: Settings › Dispatcher guided setup. |
| `Field` | `label`, optional `help`, `error`, children and className | Delegate, Start work, verdict and settings forms. Finds the first canonical labelable control through layout/fragment children, preserves every sibling, and assigns stable label/help/error IDs. Explicit child IDs win; existing `aria-describedby` values are retained. A Field owns one control; use separate Fields for several controls. Custom opaque child components must supply their own label contract. |
| `TextInput`, `TextArea` | Native attributes, events and native element refs | Form validation, autocomplete, disabled state, required, min/max, selection and keyboard behavior remain native. TextArea owns resize/minimum height. |
| `ChoicePicker` | Controlled `value`, `options: {value,label,agent?,disabled?,reason?,description?}[]`, `onValueChange`, optional `sizing="content"`, `variant="repository"`, `placeholder`, `searchable`, `required`, `disabled`, `name`, `id`, `className="pc-choice-picker--mono"` for repository identifiers, ARIA attributes and button ref | Shared single-choice menu for app forms. Optional `agent` accepts an agent or runner ID and renders the canonical 16px AgentMark before the unchanged label in the trigger and every option, separated by `--space-2`. Marks are aria-hidden; unknown identities use the existing OpenCode endpoint mark. Budget planner, Start work executor, Delegate executor, review/session retry, account-agent and Assistant account/model pickers supply identities; branch and policy choices remain text-only. The New task repository variant shows the repository icon, a 600-weight label and the selected branch (`description`) in mono in the trigger, with a 10px identity gap; its menu retains searchable labels and branch descriptions. Empty, disabled and error behavior is unchanged. `Field` labels the trigger and connects help/errors. A missing value stays unselected; disabled options expose reasons and cannot be committed. Trigger/search keyboard supports arrows, Home/End, typeahead for short lists, Enter, Escape and Tab; the active option scrolls into view, Tab advances correctly inside dialogs, and outside pointer dismisses. Search is opt-in for long lists. The listbox stays inside its native dialog when modal; the popup chooses the roomier side and caps its scrollable height to the available space. A named hidden input bridges form data only while enabled; owning forms show field errors and focus the first missing required picker. Compact/settings/touch sizes use density tokens. |
| `Checkbox`, `Switch`, `Range` | Native input props/ref; optional visible `label`; Checkbox/Switch `help` and `mixed` | Bulk selection, executor/update settings, host sessions, terminal screen-reader mode and planner reserve. A Checkbox without `label` requires a surrounding label or `aria-label`. `mixed` sets DOM indeterminate and `aria-checked="mixed"`; Switch uses a native checkbox with switch role. Range accepts its accessible label via Field, visible label or aria-label. |
| `Disclosure` | `summary`, native details attributes and children | Technical routing, cost, log, acceptance and CLI details. Native summary retains keyboard and expanded behavior; full code remains selectable. |
| `Dialog`, `PopoverDialog`, `useDialogs` | `Dialog`: `title`, `close`, content; shared confirmation/prompt orchestration. `PopoverDialog`: stable `id`, `title`, `close`, content. | Native modal dialogs own Escape cancellation, Tab cycling and focus return. The compact popover variant anchors above the status bar, focuses its first enabled button, and closes on backdrop click. Its DS-owned `pc-dialog-popover__head` is a fixed 44px row with 8px/16px padding and a bottom divider; `pc-dialog-popover__body` owns scrolling below it. Header IconButtons are 28px quiet actions with Tooltip and explicit accessible names. The Usage consumer uses refresh/close icons; refresh is disabled and spins only while busy, with animation omitted under reduced motion. Dialog/Field styles are DS-owned and available to tray. Use an explicit visible submit label, and preserve whitespace validation on required rejection notes. |
| `TextRow` | `label`, `value`, optional `meta` | Settings check progress uses label/value/meta alignment and tabular figures. Values wrap without hiding labels; this is presentation, not a form or semantic table replacement. |
| `ListRow` | `leading`, `content`, `meta`, `actions`, native div attributes, optional density, `layout="aligned"`, `outlined` and `tone="bad\|warn"` | Dispatch and Needs you compact cards (outlined and tinted by tone; the glyph is decorative and the status words are given to assistive technology), Tasks list and tray attention. Slots are siblings. The aligned variant gives desktop rows stable metadata and action columns above 1100px; below that it keeps the normal wrapping row. Row-level focus/data attributes remain on the outer row. Keep full titles in title/detail while clipping through CSS. Secondary actions belong in actions, outside any destination link. |
| `ListRowLink` | Native anchor attributes and children | Capacity and tray running rows with a single destination. Never put another control inside it. Session replay uses the DS `pc-row-destination`/`pc-list-row--stretch` contract to expand a single link target without nesting controls. |
| `SelectableRow`, `ChoiceCard`, `FilterChip` | Button props plus optional `selected`; existing aria-pressed/current supported | Review queue/files, Add Executor choices and repo filters. Selection stays controlled by the caller. Choices use buttons and pressed state, not invented tab semantics. |
| `CountBadge` | Numeric `count`, optional accessible unit `label` (defaults to work items) | Repository filter chips and finder rows. Neutral filled badge with tabular figures; selected chips inherit the chip contrast pair. Counts remain non-interactive and separate from status pills. |
| `SearchPicker` | Trigger `label`, `searchLabel`, `placeholder`, `emptyLabel`, controlled `value`, `{value,label,description?,count?,searchText?}` options, `onChange` and optional `align` (`end` by default; `start` for pickers in a settings row) | Repository finder on Dispatch and Review, and the repository field on plugin settings pages; the desktop trigger is 32px tall with a text label and secondary ink (touch targets retain their shared size); searches every registered repo, including those with zero work. Trigger-anchored menu on its preferred edge that switches alignment when that side would overflow the viewport and fills the row below 560px. Native buttons expose pressed state, the search field receives focus, arrows/Home/End move among results, and Escape/selection return focus. Tab departure and outside pointer dismiss without stealing focus. Search resets on dismissal; filtered empty text is a polite status. Menu rows inherit normal/compact/touch density. |
| `CommandMenu` | `label`, `placeholder`, controlled `query`/`onQueryChange`, optional `prefix` badge, `scopes`/`scope`/`onScope`, `groups: {title, options: {id,label,ranges?,sub?,icon?,leading?,pill?,keys?}[]}[]`, optional `empty: {title,description}`, `enterHint`, `onActiveChange`, `notice`, `modEnterHint`/`modEnterSoon`/`modEnterKeys`, `hints`, `returnFocus`, `onPick(id, {keepOpen}?)`, `onClose` | The ⌘K / Ctrl-K command menu (`shell/CommandPalette.tsx`), opened from the top-bar search. A native modal `dialog` (640 px, 72 px from the top, 14 px radius) holding a `role=combobox` input (`aria-expanded`, `aria-controls` the grouped listbox, `aria-activedescendant` the active option); focus never leaves the input and the row's bottom border turns to the focus colour. ArrowUp/Down wrap, Home/End jump to the first/last option, Enter picks, ⌘↵/Ctrl-↵ picks and keeps the menu open (only where `modEnterHint` says what it does, the `>` commands mode), Tab/Shift-Tab step the scope tabs (`role=tablist` of `role=tab` buttons with `aria-selected` and `aria-controls` the listbox, shown only while searching; a scope with no matches falls back to All and a single scope lists every match), Enter during IME composition is ignored, Escape, ⌘K/Ctrl-K or a backdrop click close it and focus returns to `returnFocus()` (the trigger that opened it, since WebKit does not focus a button on click) or the previously focused element. Matched label text renders in `mark` (underlined, `type-match-strong`). Groups use `role=group`; an empty result shows a polite status above the listbox with fallback options. Mobile (<560px) drops key caps, wraps the scope tabs and long labels (so a matched part of a path stays visible) and keeps the one-line subtitles (the repository of a file). Key caps are the registry's keys: ⌘ ⌃ ⌥ symbols on macOS, Ctrl/Alt elsewhere. Search data comes only from the snapshot and the command registry (UI-13); `?` ask stays off until the assistant exists. Agents and machines share the Agents scope; Files come from the read-only `files.search` operation when the service has it (debounced; the Files tab and group show matched path ranges in `type-match-strong`, the repository as the subtitle (with "changed by …" when a running task changed the file; no pill, as on the board), and `notice` says in plain words which repositories could not be searched or that the list was cut short); a file a running task changed opens that task, and any other file (no repository-scoped viewer exists yet) copies its repo-relative path on Enter, with the footer saying "copy path". ⌘↵ "open beside" is shown in search and recent modes with a "Coming soon" label (`modEnterSoon`; plain text with a visible "Coming soon" pill, since `aria-disabled` on a role-less span is not valid ARIA; the key does nothing) until a right panel exists. The mode `prefix` badge describes the combobox (`aria-describedby`); the caller strips the typed `>` so the input shows only the text after the chip, and `onBackspaceEmpty` (ignored on key repeat) lets Backspace in an empty input remove the chip. Cmd+A (macOS) or Ctrl+A selects the input text itself, so it works in a webview without an Edit menu. |
| `SegmentedControl`, `Tabs` | Label, controlled value, `{value,label,disabled?}` options and onChange; SegmentedControl optional `describedBy` links visible explanatory text such as a disabled reason; Tabs additionally requires stable id | Settings switches, Session views and the Dispatch period switch. SegmentedControl is a labelled group of pressed buttons whose labels stay on one line. Tabs owns tablist/selected/controls/roving tabIndex and ArrowLeft/Right/Home/End; the consumer renders matching labelled tabpanels. Disabled tabs are skipped. |
| `SidePanel` | `side="left\|right"`, `label`, controlled `open`, `onToggle(open)`, optional `bar` (default true), `wide`, `contentToggle`, children | Settings navigation (left, default open, `usePanelState("settings")`). Open: an `aside` landmark named by `label`, a quiet `panel-left`/`panel-right` IconButton named "Hide <label>" with `aria-expanded="true"` and `aria-controls` pointing at the content, then the scrollable content. Closed: only a 40px strip with "Show <label>" and `aria-expanded="false"`; the content is not rendered. The open and closed toggles are different elements, so focus moves to the new toggle when the old one had it or when collapsing removed the focused element. Left reuses the 200px settings width, right uses `size-320`. The shell owns sticky positioning and hides side panels below 768px, as the settings panel was before; narrow layouts never use it. Ctrl-b toggles the left panel when one is shown, and is not registered below 768px. Presentational; consumers own persistence. `bar={false}` is for a panel whose toggle lives elsewhere (the Session screen's title bar): the open panel has no toggle strip and a closed one renders nothing, so the owner's toggle must carry `aria-expanded` and `aria-controls="pc-side-panel-right"`. `wide` uses the 272px Sessions-list width with an inset divider that preserves the content width; its closed strip remains 40px. `bar={false} contentToggle` keeps that closed strip while the owner renders a toggle inside the unpadded content, with id `pc-side-panel-left-toggle`, accessible name "Hide Sessions", `aria-expanded` and `aria-controls="pc-side-panel-left"`. Focus returns to that toggle on reopening when the strip toggle had focus. The Sessions navigator owns its 38px head row (padding 0 8px 0 14px) and list inset (0 8px 12px), with 256px cards. Consumers: Settings (left), the Session screen (Sessions list left, session details right). |
| `PanelTabs` | optional `id`, `label`, `tabs: {id,label,icon?,badge?}[]`, controlled `value`, `onChange(id)`, `maxVisible` (default 4) | Compact tablist for panels; consumed by the Session screen's right panel (Changes, Details, Work). The tablist keyboard contract of `Tabs`: `aria-selected`, roving tabIndex and ArrowLeft/Right/Home/End through the shared `tabStep`. With the optional `id` each tab gets `id="<id>-<tab>-tab"` and `aria-controls="<id>-<tab>-panel"` for the consumer's labelled tabpanel; without it no ids or `aria-controls` render. Tabs past `maxVisible` move into a quiet "+N" IconButton named "+N more tabs" (`aria-haspopup="menu"`, `aria-expanded`) that opens a menu of the hidden tabs; the selected tab always stays in the strip. The menu focuses its first item, supports ArrowUp/Down/Home/End, Enter/Space chooses (focus moves to the chosen tab), Escape closes and returns focus to the "+N" button, and leaving it with Tab closes it. A badge renders through `CountBadge` with words ("3 items"); zero hides it. Labels ellipsize with the full label in `title`. |
| `Card` / `pc-card`, `ApprovalCard` | Native section props; Card tone `bad`, `warn` or `sunken`; ApprovalCard optional title/actions slots | The `warn` tone uses warning tint/border and 12px padding; Needs you uses it for agents that cannot take work, with caption reasons and a secondary small Settings link. Shared settings card CSS also works on native form/div containers. Review verdict uses ApprovalCard framing while VerdictPanel owns decisions and actions. Do not repeat the same heading in both wrapper and content. |
| `Pagination` | Controlled `label`, zero-based `page`, `pageSize`, `total`, `onChange` | Dispatch and Needs you lists. Uses canonical small Buttons with inherited density. Range is a polite live status; only available Previous/Next actions render. Native Tab/Enter/Space activation. Paging moves focus to the persistent labelled navigation region so disappearing boundary buttons do not lose focus. Empty lists omit navigation. Authored locally; no upstream adaptation. |
| `Skeleton`, `EmptyState` | Skeleton `layout` (`task`, `list`, `settings`, `dashboard`, `rows`) and accessible `label`; empty title/description/children, optional `bodyTitle` that renders the title as a body-strong `<strong>` instead of a section heading (for an empty state inside a section that already has one) | Shell connection, task/session/settings resources, Dispatch and Review clear states, tray connecting. Skeletons appear after 150ms, cancel on unmount, and expose a named status with `aria-busy="true"`. Decorative blocks use surface-lane, 4px radius (title 6px, button 8px, pill 99px) and a 1.4s opacity pulse from 1 to .55; reduced motion removes animation. No visible label or spinner. Task layout mirrors Loading board 27: breadcrumb, title, pills, header buttons, now card, four tiles, four trace rows and three aside cards. Other layouts mirror page headers/rows and Dispatch tiles; rows is for embedded panels. Refreshing content remains mounted. Errors remain explicit adjacent alerts with existing retry actions. |
| `Page`, `PageHeader`, `PageBody`, `PageColumns` | Named `standard`, `wide` or `full` page width; breadcrumb/identity/metadata/status/action slots; main and optional aside | Every routed app screen fills its available workspace. All width variants now share uncapped geometry. Page owns width, responsive gutters and page rhythm. PageHeader accepts the routed page heading; desktop page titles live in the page frame. Columns keep main before aside in DOM order and collapse centrally. Screen CSS must not redefine page width, centering or outer gutters. |
| `Stack`, `Cluster`, `Section`, `DisclosurePanel`, `ActionPanel` | Semantic compact/normal/section spacing and contained section/detail/action composition | Shared page composition. These are original local Preact components with no upstream adaptation. Consumers provide content and domain state; DS tokens own spacing, borders and responsive behavior. Specialized tables, diffs, terminal geometry and domain grids remain screen-owned. |
| `SectionHeading`, `Pill`, `StatusPill`, `StatusGlyph` | Existing heading and semantic descriptor APIs; `Pill` also accepts `title` only; its accessible name comes from its full text | One section-heading type scale. Status descriptors come from `src/view-model/words.ts`; glyph and text accompany color. Color alone never encodes a result. |
| `UsageMeter`, `AgentMark`, `Mark`, `Icon`, `Kbd`, `Tooltip` | Existing documented typed props in their modules; `Kbd` also takes `size="sm"` (11 px cap, 4 px radius, page background) for the command menu and the title-bar search | Specialized meter geometry, vendor identity, navigation, shortcuts and tooltips remain shared. Stale meter readings visibly say Historical usage, include a known capture time, and announce freshness through the meter value text. A Kbd composed inside a button inherits the action foreground on a transparent surface, retaining the action contrast pair in both themes. Usage percentages are data, not ad-hoc style. Agent colors mirror shared identity descriptors in both themes. |
| `AuroraSheet`, `AuroraLauncher`, `AuroraAvatar`, `Thinking` | `AuroraSheet`: `label`, controlled `open`, `generating`, `narrow`, `expanded`, `onClose`, optional `header`, and slots `messages`, `suggestions`, `composer`. `AuroraLauncher`: `open`, `onClick`, `shortcut`, `controls`. | The assistant sheet (lazy chunk). Three layers: a decorative aurora (`aria-hidden`; Shell board decorative gradient/blob tokens, solid at the bottom edge and masked to transparent toward the top), the conversation as a `log` region (`aria-live="polite"`, older messages fade through a mask) and the composer. Message text sits on solid card surfaces, never on the gradient, so contrast is that of normal text in both themes. The aurora uses the Shell board’s 16 s gradient, 7 s breathing wrapper and 9/11/13 s blob cycles while visible, and never when `prefers-reduced-motion: reduce` or the assistant’s still preference is enabled; open and close move only `transform` with the motion tokens (never opacity, so a stalled animation clock cannot leave the sheet invisible) and are instant under reduced motion. With `forced-colors: active` the aurora and veil are not drawn and the column gets a plain border. The sheet stays mounted and `inert` when closed; opening focuses the `[data-autofocus]` element, and Escape or `onClose` returns focus to where it was. The consumer streams text into an `aria-hidden` node and inserts the finished answer as a new node, so only the finished answer is announced. Below 768px (`narrow`) the sheet is full height with an opaque veil. The launcher is one `aria-expanded` button with the shortcut as `Kbd`. Presentational; the shell (`app/src/shell/assistant/`) owns data. Authored locally; no upstream adaptation. |
| `TrafficLights` | `desktop`, `onClose`, `onMinimize`, `onMaximize` | Linux desktop fallback for the undecorated main window. The macOS main window uses Tauri's decorated overlay and native traffic lights, following [Tauri's window customization guidance](https://v2.tauri.app/learn/window-customization/); the web controls are hidden and their header space remains reserved. Browser views render no window controls. The bundled startup shell provides a drag strip above its content. |
| `RadioGroup` | `label`, native div attributes, children of button radios | New task workspace, kind and agent choices. `role="radiogroup"` with roving focus: only the checked radio (else the first enabled one) is in the Tab order; arrow keys, Home and End move to and select the next enabled radio, skipping `aria-disabled` ones. |
| `RadioCard`, `RadioChip`, `OptionRow` | `checked`, `onSelect`, optional `disabled`; RadioCard `title`, `sub`, optional `tag {label,tone}`; RadioChip children and optional `note`; OptionRow `leading`, `title`, optional `sub`, `pill {label,tone}` | Button radios (`role="radio"`, `aria-checked`) for use inside `RadioGroup`. RadioCard is a bordered choice with a radio dot and caption (workspace); RadioChip a pill (task kind, "· detected" note); OptionRow a list choice with an agent mark and status pill (agent override). Disabled rows stay visible at reduced opacity with their reason and cannot be selected. Checked state is an ink border, never colour alone. |
| `CheckRow` | `checked`, `onToggle`, `label`, optional `detail`, `source`, `actions` | Acceptance checks. A `role="checkbox"` button carries the label for assistive tech; off rows mute their text. `source` renders a neutral Pill. |
| `FileChip` | children, `removeLabel`, `onRemove`, optional `mono` | Attachments and @-mentioned paths in the New task request. 26px chip with an 18px quiet remove IconButton named by `removeLabel`; long names ellipsize with a `title`. |
| `ValueBox` | children, optional `meta`, native div attributes | A read-only value in picker geometry (the automatic branch name). Not focusable; label it with `aria-labelledby`. |
| `DrillRow` | `label`, `value`, `onClick` | Narrow-sheet rows that open a choice sheet: caption, current value and chevron in a 48px touch row. |
| `Sheet` | `title`, `close`, optional `action`, `footer`, `className`, children | Full-screen native modal for narrow layouts (the 375px New task composer): a 52px header with a 44px Close, the title and an optional action, a scrolling body and a pinned footer. Escape closes; focus cycles inside and returns to the opener. |

**Frame slots** (`app/src/shell/slots.tsx`). `Layout` owns the regions and a screen fills them through `FrameSlot name="title|actions|left|right"` (portals into the top bar context, the bordered layout-toggle group after its panel toggles, the left panel or the right panel) and `useFrameHeading` (the top bar shows the screen's title and `AgentMark` instead of the route name). On a task's route (`#/tasks/<id>`, 768px and wider) the left panel is the Sessions list, the right panel is the Session details panel (Changes, Details and, for dispatched work, Work tabs through `PanelTabs`), and the top bar carries the session's status, elapsed time and repository, with other session actions. The frame's layout toggles include "Toggle right panel" (`aria-pressed`, Alt-⌘B on Apple platforms, Alt-Ctrl-B elsewhere) beside the left panel and dock toggles; End session follows the details toggle in this group as a quiet 30px `IconButton` with `tone="bad"`, named "End session" that asks to confirm through the shared dialog (title "End session (asks to confirm)"). The actions slot remains available on narrow screens; when End session unmounts, focus returns to a remaining title-bar control. An ended, failed or removed session shows no End session, Stop, Take over or Resume that cannot work (UI-13). While the right panel is closed, the task's next step ("Review result", "Answer question" or "Review in Work", when one is due) appears as the title bar's one primary `Button`; it reopens the panel on the tab that holds the action, so a closed panel never hides it (UI-13, UI-14). The visible task `h1` uses the provisional Session board 14px/20px/650 style with an 80px minimum and ellipsis. Facts yield first; search and Delegate remain reachable. Planner names stay on one line in the 28px chip. Below 560px Resume conversation becomes a named icon button. The workspace uses the frame top/status height tokens to fit between its bars without page scrolling. StatusDot retains its semantic tone, pulses while live and stops animation under reduced motion. Below 768px there are no side panels, so the details render in the page after the session and the details toggle is absent. ⌘B (Ctrl-b elsewhere) toggles the Sessions list. While the built-in terminal has control both shortcuts go to the agent; Ctrl-] releases control, and a watching terminal passes Ctrl combinations on to the app.

`AppFrame` (shell) owns the window regions (its optional `overlay` slot floats the assistant sheet over the work area through `pc-work-wrap`, above the dock and status bar): skip link, top bar, activity rail, optional left panel, the work area with the live region and `main#main-content`, optional right panel, optional bottom dock and status bar. Without panel or dock content it renders exactly the landmarks and classes the shell had before. Narrow layouts keep the touch order (bottom navigation first, header inside the work area) and drop the right panel and dock. Panel open state persists per id through `usePanelState` (`localStorage` key `pacer.panel.<id>`; unavailable storage falls back to the default). The terminal dock is 320px (`size-320`), at most half the viewport height, and embeds the workspace terminal without page gutters, keeping its tab choice local. It never appears on the Terminal route, on Setup or below 768px, where the shell also hides side panels. Ctrl-` (registered with `allowInControl`, so it also works while the docked shell has control) and the status-bar Terminal button toggle it; opening moves focus into the dock and closing returns it to the control that opened it. While the dock is open the frame fits the viewport and the work area scrolls on its own. A docked shell holds keyboard control only while focus is inside the dock.

`StatusBar` is a 28px bar (padding 0 10px, gap 14). One click target holds each budget as vendor mark 16, bold percent, a 28×4 `UsageMeter size="mini"` and an "!" (`role=img`, named "Ahead of pace" or "Stale reading"); then "N running · N queued" with an info dot, the Terminal entry (icon, label, mono `Ctrl+\``, only where the dock can open), a quiet "? shortcuts" button that opens the help dialog (shown only while the `?` shortcut is registered) and the version. Its accessible name includes account names, pace and stale-reading status. Per-screen key hints are in the help dialog (the Esc hint still shows while usage details are open). Narrow screens keep the touch navigation and compact executor percentages instead. The usage target opens a read-only account panel using `account.list` windows, reset times and freshness. Reload reads the latest available account data; it does not force a provider refresh. Overview keeps planner advice, executor eligibility and parallel-task slots while usage appears in the status bar.

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
| `components/atoms/SegmentedControl.tsx` | `ds/Patterns.tsx: SegmentedControl` | Controlled options and selected segments within shared framing. Uses SelectionStrip for the measured sliding indicator; filters retain pressed-button group semantics and Tabs retain tab semantics. |
| `components/atoms/Switch.tsx` | `ds/Controls.tsx: Switch/Checkbox`, switch CSS | Controlled checked state, rounded track and travelling thumb. Combines existing checkbox styling with a native labelled input, disabled/help/indeterminate/ref support, and reduced-motion/forced-color behavior. |
| `components/primitives/TaskRows.tsx` | `ds/Patterns.tsx: ListRow/ListRowLink/SelectableRow` | Leading status/identity, flexible clipped title, numeric/status metadata, bounded row and disclosure/action grammar. Removes scripted demonstration status sequence, demo tasks, staggered animation and nested assumptions. Service descriptors decide actual state; sibling actions preserve valid HTML. |
| `components/primitives/ApprovalCard.tsx` | `ds/Patterns.tsx: ApprovalCard`, Review composition | Closed card, question/content body and separated action/footer framing. Combines with VerdictPanel and native Dialog rather than porting question auto-advance, odometers, GlideMenu or demo state. |
| Loading board 27 | `ds/Skeleton.tsx` (exported by `ds/Patterns.tsx`) | Original implementation of page-shaped loading blocks, delayed reveal, accessible busy container and reduced-motion support. Replaces the former upstream pixel grid adaptation. |

No paid icon package, remote fonts, analytics, email capture, demo application, React or Tailwind runtime is included. Existing pacer SVG navigation/identity assets retain their own provenance.

## Migration matrix and retained styles

| Surface | Canonical adoption | Retained responsibility |
| --- | --- | --- |
| Dispatch / Needs you | TaskCard rows with Take over and Stop beside the title, shared rows for items without a task, StackedShareBar, UsageMeter, empty states, filters and canonical links | Screen section placement, the at-a-glance grid, counts, scope selection, API actions and the `src/view-model/dispatch.ts` descriptors. |
| Review/detail | Selectable queue/file rows, ApprovalCard, Field/input/ChoicePicker/disclosure, asynchronous state | Bulk selection and verdict workflows, semantic definition lists, specialized Diff renderer and horizontal code scrolling. |
| Sessions/detail | ListRow, canonical replay target, Tabs, controls, loading/empty states | Controller/resource fetching, session/PTY lifecycle, timeline, terminal/diff rendering and command copy. Unsupported attach targets are omitted; refused takeover retains visible service reason. |
| Settings/hosts/Add Executor/Diagnostics | Canonical form controls/Field, switch, range, SegmentedControl, ChoiceCard, pc-card, TextRow | Settings grid, semantic tables (including mobile data labels), wizard progress and API-bound operations. Host and executor domain decisions remain local. Diagnostics binds doctor.run to canonical Button, Pill and Disclosure; idle/running/error states are announced, reruns wait for completion, and technical evidence/repair guidance stays collapsed. |
| Setup/delegate/dialogs | Button/ButtonLink/TextAction, Field/ChoicePicker/native text controls, Dialog and Disclosure | Consent, setup checklist, draft/validation and delegation data. |
| Shell | Canonical actions/links and DS density, loading status; TrafficLights native controls | Desktop: a 44px top bar (card background; 10px right and 8px left padding, 84px left in the native shell, which reserves the window controls' room, so the in-flow traffic-light placeholder is hidden there) holding the pacer mark (home link), a visually hidden page `h1` (UI-9), a centre slot for the command search (empty until it ships, 420px max 40vw), the 28px planner chip (agent mark, name, mode `Pill`; no budget figure), a "Layout" group of 32px toggle buttons between dividers (left panel, terminal panel, right panel; each rendered only where it has something to toggle, `aria-pressed` shows its state) and a secondary compact Delegate; a sticky 52px activity bar (8px/0 padding, 4px gap) with 40px links, a 2×20 `--ink` indicator at -6px on the current item, 16px `--bad-fill` count badges (10px/700 text) named in words ("Needs you, 3 items"), and a divider before Settings whose 8px attention dot (2px card border) names its count ("Settings, 2 agents need attention"). `--frame-top` and `--frame-status` hold the bar heights for sticky offsets. Native controls appear only in Tauri; title and empty header space support native dragging. Narrow screens retain the touch header and bottom navigation; coarse pointers retain touch targets. Settings keeps secondary navigation in a collapsible left `SidePanel`; `AppFrame` owns the regions, including the optional terminal dock. Landmarks, current-route labels, tooltips, skip-link route focus and keyboard focus remain available. |

| Shell | Canonical actions/links and DS density, loading status; TrafficLights native controls | Desktop: a 44px top bar (card background; 10px right and 8px left padding, 84px left in the native shell, which reserves the window controls' room, so the in-flow traffic-light placeholder is hidden there) holding the pacer mark (home link), a visually hidden page `h1` (UI-9), a centre slot for the command search (empty until it ships, 420px max 40vw), the 28px planner chip (agent mark, name, mode `Pill`; no budget figure), a "Layout" group of 32px toggle buttons between dividers (left panel, terminal panel, right panel; each rendered only where it has something to toggle, `aria-pressed` shows its state) and a secondary compact Delegate; a sticky 52px activity bar (8px/0 padding, 4px gap) with 40px links, a 3×20 `--ink` indicator at -6px on the current item, 16px `--bad-fill` count badges (10px/700 text) named in words ("Needs you, 3 items"), and a divider before Settings whose 8px attention dot (2px card border) names its count ("Settings, 2 agents need attention"). `--frame-top`, `--frame-status` and `--frame-nav` (narrow bottom navigation) hold the bar heights for sticky offsets. Native controls appear only in Tauri; title and empty header space support native dragging. Narrow screens retain the touch header and bottom navigation; coarse pointers retain touch targets. Settings keeps secondary navigation in a collapsible left `SidePanel`; `AppFrame` owns the regions, including the optional terminal dock. Landmarks, current-route labels, tooltips, skip-link route focus and keyboard focus remain available. |
| Tray/desktop webview | Compact density, shared actions, ListRow, ListRowLink, headings, status/identity and loading | 340px host containment, count/executor layout, native IPC, menu state and keyboard order. Escape closes menus before IPC hide; Quit is offered only in desktop. |
| Terminal wrapper | Canonical screen-reader checkbox and actions | Lazy import, xterm theme adapter, PTY scaling and session control; xterm vendor CSS remains vendor-owned. |
| TUI | Shared framework-independent status/attention vocabulary | Terminal width/color adapter; it imports no browser components. |

Authored screen CSS may own grids, flex placement, containment, overflow, sticky positioning, responsive breakpoints and domain metadata columns. Primitive visuals are DS-owned. The semantic tables, usage meter, code/diff and PTY renderers remain specialized; converting them into universal rows would damage their semantics.

Narrow data-geometry adapters are explicit: `UsageMeter` supplies clamped numeric `--used`/`--pace`; AgentMark/Mark supply only `${size}px` through `--agent-size`/`--mark-size`; `TerminalView`'s `scale` function computes width/height solely from authoritative PTY cell/font metrics or measured xterm screen geometry. These do not permit arbitrary colors, typography or spacing. SVG path/viewBox/stroke geometry, intrinsic 1em icon dimensions, border hairlines, zero, percentages and responsive breakpoints follow the narrowly checked categories in UI-21. The tray resize effect supplies `--tray-menu-height` solely from the measured popup height plus its token-derived bottom offset (rounded up); it keeps the open menu inside the tray overflow boundary without a fixed height floor. Other measurements come from tokens.

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
inherit the app preference (Comfortable 32px, Compact 28px); segmented choices use their board size. Body/field text stays
13px, help 12px and pills 11px. Narrow layouts resolve to touch density; settings
controls outside the shell also retain 44px targets at narrow/coarse-pointer sizes.
The tray keeps its own 32px action size.

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

`AttachmentPicker({onFiles, disabled, variant, label, accessibleLabel})` keeps a native multiple-file input under a styled shared trigger. It supports keyboard file selection; consumer drop/paste handlers feed the same callback. `variant="tool"` renders a quiet toolbar trigger (the New task request toolbar); `label` replaces the visible words and `accessibleLabel` the input's name. `AttachmentTray({items, onRemove, onRetry})` owns image thumbnails, names, sizes, uploading/ready/error states and secondary retry/remove controls. `items[].removable=false` hides removal for immutable claimed session files. Image alt text is empty because the adjacent filename supplies the name. Actions have explicit accessible names, focus follows canonical Button behavior, and density follows Controls/Button context.

Ownership: `app/src/ds/AttachmentTray.tsx` and DS CSS. Consumers: StartSession, SessionAttachments and the New task composer. Authenticated upload state and file bytes belong to consumers/service, never DS. This is original project code with no copied upstream source. The terminal conversation layout stays specialized: PTY geometry and native terminal input remain owned by the terminal renderer.

Terminal font, cell geometry and ANSI colors are generated by upstream `@xterm/xterm` 6.0.0 (`src/browser/renderer/dom/DomRenderer.ts`, MIT license retained in the installed package). The adapter uses its documented `documentOverride` to nonce renderer styles. Because xterm's scrollbar bypasses that override, terminal-created containers nonce style nodes before appending them. The pinned build adapter in `app/xterm-csp.ts` converts RowFactory `_addStyle` attribute writes to CSSOM, including truecolor and contrast adjustments; it refuses an unrecognized upstream implementation. No global document patch or relaxed CSP is used. `test/app-terminal-browser.test.ts` verifies geometry, ANSI/truecolor and zero CSP violations.

The shared `Icon` catalog includes `terminal` for the rail's Terminal route. The route uses the existing rail button semantics and keyboard navigation. The Terminal screen owns tabs, split geometry and PTY controls; `TerminalView` accepts `shell` to show shell-specific copy and xterm search, while agent-session usage keeps its existing controls. The search addon is loaded only with the lazy terminal bundle.

### App feedback: Alert and Toast

`ds/Alert.tsx` owns severity presentation (`success`, `warning`, `error`, `info`), a visible glyph/title, wrapped detail and semantic announcement. Errors use `role=alert`; other severities use `role=status`. Set `announce=false` for duplicate diagnostic detail when its completion is already announced. `compact` uses caption text and smaller token spacing, stays at content height in flex layouts, and allows a native action button among its children. Production consumers: shared ErrorMessage, settings conflicts/validation, job diagnostics, Reopen to update and Toast.

`ds/Toast.tsx` composes Alert and a named dismiss Button. `data/notification-context.tsx` mounts one app notification host outside route content, backed by `model/notifications.ts`. Success/info expire after five seconds, paused while hovered/focused; errors/warnings persist. Three notifications are visible with a bounded queue; operation keys deduplicate repeats. Notifications never take focus. Consumers notify only after confirmed mutations or completed jobs, never on polling. Screen drafts remain local until an explicit Save and do not trigger notifications while editing. Presentation modules import no API/store code. These are original in-repo components, with no upstream adaptation.

The Executors table retains its specialized metadata columns. Priority controls use a fixed three-column layout; Save/Discard sit outside the table. Model identifiers scroll instead of wrapping mid-token. Settings editors load on demand via LazySettings; HostsSection is extracted to avoid eagerly importing all editors through the hosts screen. The root Screen imports concrete host/add modules to preserve this boundary; the settings barrel remains available for other consumers/tests.

### Update notification

`UpdateNoticeCard({ version, restart, later, busy, children })` is the canonical nonmodal bottom-right update panel, consumed by the app shell's `UpdateNotice`. Ready, pending and inline error states use existing Button and status semantics. Arrival never steals focus; busy actions retain focus and reject activation. `NoticeCard` (the discovery prompts) shares its look. Both render inside `NoticeStack({ narrow, children })`, the one fixed bottom-right area for nonmodal notices: notices shown together stack top to bottom in source order with a 12px gap, so none covers another and keyboard order matches the screen; each card keeps its own single primary action (UI-14), and the stack scrolls if they outgrow the viewport. The shell puts discovery prompts above the update notice, because prompts come and go and change height while the update notice keeps its corner. Wide layouts leave room above the status bar (`--frame-status`), and narrow layouts above the bottom navigation's real box (`--frame-nav`, 56px items plus at least 20px of bottom padding, or 56px plus a larger safe area). While the Ask pacer launcher is shown, the stack also sits above it (`--frame-launcher`: the launcher's 18px gap and 40px height, 44px on coarse pointers; narrow `--frame-launcher-narrow`: 44px plus 16px up and 44px high). When the sheet is open the wide launcher moves to the sheet's top edge, so the stack keeps its status-bar floor and its maximum height stops below that position; the narrow launcher hides while the sheet is open. A bottom dock raises the launcher by its measured height, which the stack does not follow. The shell owns capability checks, per-installation/version dismissal for the app session, confirmation and the existing revision-checked restart operation. The Updates screen retains the detailed status and controls. This is an original composition of existing primitives; no new upstream code or dependency is used.

`NoticeCard({ label, title, children, actions, busy })` is the same nonmodal panel for any other prompt, sharing the update panel's classes. It does not position itself: it renders inside `NoticeStack`, which owns the bottom-right placement and the narrow-layout spacing. `label` names the complementary landmark; the title is a polite status, so arrival is announced without moving focus. Consumers pass one primary Button and secondary or quiet ones in `actions` (UI-14) and put inline errors or details in `children`. Production consumer: the shell's `DiscoveryNotice`, which shows one discovery prompt at a time (a found machine, then the network question), renders discovered names as text marked "Unverified name", and keeps the discovery id inside a collapsed Disclosure. The shell owns capability checks, session-local dismissal and the operations. This is an original composition of existing primitives; no new upstream code or dependency is used.

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
the same full-width `Page` gutters and bordered sections as Dispatch. Its controller prefers the complete `fullTitle`, with the
compatibility `title` as a fallback; `pc-ellipsis` clips only when the row runs out
of space, and tooltips and action names retain the full display text. The list
remembers its scroll offset for each repository/scope during the app session.
Start work is the last region of the Dispatch home. Its composer shows only the
request until it gets focus or holds text, then adds attachments, repository, agent
and workspace fields; Live dispatch replaces the former Recent work panel.
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
`DisclosurePanel` summaries have a 36px desktop minimum and a 44px narrow-layout
minimum, with full-width keyboard targets and unchanged native details semantics.
Related task disclosures live in one compact stack. Task Result, settings cards,
the Dispatch home, session reports and task lists consume this contract.
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

## New task composer

The composer (`app/src/screens/new-task/`) is its own lazy chunk, so `app.js` stays within its gzip budget. It composes the
components above with `new-task.css`; that file uses only tokens. Where boards 3a and 3b use a measurement the token
scale lacks, the CSS sums tokens (for example 14px is `space-3 + space-half`, the 12px card corner is `radius-lg + space-half`,
and the 52px sheet header is `size-48 + space-1`). The provisional type tokens `composer-agent` (18/24), `composer-request` (14/21), `sheet-title` (17/22)
and `sheet-body` (14/20) preserve the desktop and narrow board typography. Sheet owns its shared title/body
type; the request textarea retains its board-specific line height.

The routing card consumes `dispatch.explain` with configured runner identity, showing Ready, Override,
Waits in queue or Can't start and plain-language reasons. Explanations never disable Delegate.
The issue picker uses the shared Dialog, Field, TextInput and Button components and only appears when
`issue.import` is advertised. Search is offered only with `issue.search`. Imported title/body content remains
escaped plain text in the preview and request; the saved draft and delegated context retain its issue provenance.

Built-in strategy explanations are advisory and show no definite agent or ladder destination. Cached observations,
unmeasured capacity and engine fallback are labelled as preview uncertainty. The compact card shows one summary
reason, prioritizing an engine-not-running warning, with the full reasons available in its title.
The attachment hint reflects the service limit of 25 MiB per file.

Issue-picker Tab and Shift+Tab cycle within the shared Dialog; Enter searches or reads an issue. The imported-source
note offers a shared quiet button to remove provenance, and removing the imported text retires its note and delegated
context. Only validated HTTPS GitHub issue URLs enter that context.

Settings `Section` accepts an additive `step` number: a decorative 28px numbered circle, a question heading at h2 (16/22, weight 650), and a bordered two-column step layout. Dispatcher is its consumer; unnumbered settings sections retain their existing layout. Executor list slots preserve full accessible labels while showing rank, AgentMark, account, mono ID and existing status vocabulary. Pool rows use shared buttons and links; unavailable rows use muted text and a dimmed decorative mark, with a not-allowed cursor on the row body and a full-contrast Fix link for UI-2. Dispatcher supplemental headings use the same 16/22 type without a step badge. Current setup cells and saved-setup rows adapt to their own container widths. No upstream source or provenance changed.

### Session details and caption

The Session board caption shows status, the repository label and optional branch
in mono, then elapsed time. Repository text uses `ink-secondary` and the
Repository tooltip; branch text truncates with ellipsis and uses the Branch
tooltip. Status and repository do not shrink; branch and elapsed time disappear
before the branch falls below the existing 40px size token. Repository yields
only after later facts. At phone widths the status dot and visible label occupy
a second row inside the title bar, preserving title, search and action space.

The Details tab starts with Workspace, using only available `task.get` fields
(Repo label, Branch, Base, Worktree, Machine). Values wrap anywhere in a
12px/18px mono definition list. Routing explanation and reported token totals
appear only when present; unreported token fields are omitted. A field reported by
only some attempts shows "≥ N" with "Some attempts did not report this field.";
fields reported by every attempt stay exact. Partial totals
show only their lower-bound total and partial note. Detail paragraphs have zero
block margins so the existing 6px section gap owns heading-to-text spacing. The
Changes tab remains separate. Detail sections use a 16px gap and, after Workspace,
a 14px top inset with a line divider. The brief shows the repository label with
wrapping; Done when uses 12px mono, 6px/8px padding, a 6px radius and the lane
surface. Open elsewhere follows the task details. These screen compositions reuse
existing tokens and primitives; no shared component, token or provenance changed.

### Settings navigation board

`SettingsNav` adds optional `backHref` to compose the Back to Dispatch link,
Settings headline and save guidance card. SettingsPanel supplies the scoped home
link. Its seven destinations use 34px rows, 10px insets/gaps, 8px corners and
uppercase group labels inside a 240px panel with 14px/10px padding. Embedded
SidePanel removes duplicate insets/borders and keeps its collapse control beside
the header. Narrow strips hide the header/footer and retain touch targets.
The shared Icon catalog adds settings board paths and `chevron-left`; existing
icons retain their paths. This is original project code; provenance is unchanged.

Agents points to executors; Accounts and Add executor select that category.
Machines points to This machine; Remote hosts selects that category. Secondary
page links live in those editors. Page titles remain independent of nav labels.
Only Agents has a nav attention badge; Overview retains real machine/update
status. Unsupported plugin and diagnostics badges are omitted.
Board values without exact tokens use 16px icons for 17px, weight 650 for the
badge's 700 and radius-full (999px) for 99px pills (both fully round).

### Diagnostics board

`DiagnosticRow({title, caption, glyph, tone, status, action, open, children})` composes
the canonical native Disclosure with a 20px status glyph and report detail.
Tones are good, warn, bad and neutral; warn/bad rows use the corresponding tint.
Actions are siblings of the disclosure, so keyboard users can toggle the row
and activate repair/setup independently. Native Enter/Space disclosure semantics
and DS focus rings remain; failures initially open. Its output uses mono text.
The Diagnostics consumer owns report state and all operations; DS receives props
only. The four-cell totals use 26px glyphs, 18/22px numbers and 12/16px captions.
The bounded Diagnostics canvas uses 28/40/48px padding, an 18px gap and a
1080px maximum width (three size-360 tokens). Narrow layouts use 16px gutters,
two totals columns and actions below the disclosure. Weight 650 substitutes for
the board's 700; radius-full substitutes for 99px circles. This is original code
with no upstream adaptation. Native validation retains its existing controls.

### Overview and App preferences boards

`SettingRow variant="board"` adds the 300px label column, 24px control gap,
14px vertical padding and lane-colored top separator. Its existing label/help
association remains intact; narrow layouts stack the columns. `SegmentedControl
variant="board"` (also exposed by the settings `Segment`) adds a bordered,
3px-padded group with 30px buttons and 6px corners; touch targets expand to 44px.
`Card tone="sunken"` uses the card surface. `Switch size="sm"` reuses the native
checkbox keyboard and label behavior with role=switch, explicit aria-checked,
a 36×20px track, a 16px white thumb and good-fill on state. The default Switch
geometry is unchanged. These are additive original adaptations; provenance is
unchanged and no dependency is added.

Overview composes Card, AgentMark and StatusDot with DS-owned readiness rows and
link tiles. App preferences composes SettingRow, SegmentedControl, Switch and
ChoicePicker; consumer code owns service data and exact existing operations.
Dispatcher also composes board SettingRows for standalone ladder fields, saved-setup name/reason, native-control and model rows; schedules and consent details remain plain text below their row. Its Scope uses the board SegmentedControl with a visible dirty-lock reason and an inline mono repository picker.
Both canvases use 28/40/48px padding and max-width 1080px; Overview uses a 20px
gap, App a 24px gap. Heading typography is 28/34px at 650, summary 16/22px at
650, tile values 15/20px at 650 and muted uppercase labels 11/14px at 600.
The board's glyph weight 700 uses the nearest 650 token; fully round corners use
radius-full instead of 99px. All other measured dimensions use exact existing
tokens or sums of tokens (3px group padding; 1080px canvas). Unsupported controls
and claims are omitted, including diagnostic history and release links without
data. Legacy App section hashes retain their section IDs and scroll alignment.

### Budget & pacing board

`SettingRow variant="budget"` is an additive board variant: the same 300px
label column, 24px gap, 14px vertical padding and lane top border, with top
alignment and 14/20px labels at 650. Other row variants retain their geometry.
The budget canvas uses 28/40/48px padding, max-width 1080px and an 18px gap.
It composes sunken Card, Pill, AgentMark (20px), UsageMeter, Range and board
SegmentedControl. The lazy settings stylesheet owns the summary, mode strip
and window-list composition; no dependency or eager JavaScript is added.
The summary uses 16/22px at 650, a 20px column gap and 8px copy gap. The mode
strip has four 6px bars, a 3px gap, and a 2px active outline with 2px offset.
The board's active weight 700 uses the nearest 650 typography token. The
window list uses radius 10px, 10/14px row padding and 12px column gaps.
Only measured windows appear; pace markers require matching service window
data. Missing window settings do not produce inert switches. Mode holds use
the service's existing hold/release operations and reset-bound lifetime.

Settings follow-up: `SettingRow headingLevel={3}` wraps its existing label in an h3,
resetting heading margins and inheriting row typography; label-for and description
association remain unchanged. Budget rows use this opt-in semantic structure.
`ChoicePicker sizing="content"` keeps its trigger content-sized (bounded by its
container), with a 32px desktop minimum height, 0/10px padding and 6px radius;
the narrow layout retains the shared touch minimum height. It preserves
the default menu keyboard and focus behavior; App Workspace Terminal uses it.
App Plugins composes DS Icon, Pill, Switch (small) and confirmation Dialog; its
service-owned list uses 32px lane tiles, 8px tile radius, 12px gaps, 12px/16px row
padding and a 12px list radius via the DS `radius-lg` token. The plugin glyph uses the nearest 16px token to
the board's 17px glyph. Plugin data and grant flow stay in the lazy settings chunk.
The rows form a labelled Plugins list. During changes and reloads, switches use
`aria-disabled` with the shared Checkbox/Switch disabled opacity, preserving
keyboard focus; consumers must ignore input while unavailable. Permanently
refused plugins retain native disabled semantics and describe their error.
Reload errors leave the last loaded list and inline operation feedback visible.

### ActionMenu

`ActionMenu({ label, items: [{ label, onSelect }] })` is the compact overflow menu used by Plugins cards. Its DS `IconButton geometry="board"` trigger uses the three-circle `more` SVG icon, measures 28×28px with 6px corners on desktop, and retains 44×44px targets through `--control-touch` on coarse pointers and narrow screens. It owns its trigger, menu semantics, arrow/Home/End navigation, Escape/outside dismissal and return focus. Enter/Space use native buttons; Tab closes the menu and continues through the page. Styles load with its lazy consumer through an adopted stylesheet. It is authored in-repo, with no upstream dependency. SettingsNav items may set `plugin: true` to show a text marker, included in their accessible name as “, plugin”.

### Tray board composition

The tray composes DS buttons, section headings, agent marks and usage meters in a
340px desktop popover. Its scrolling main region owns the budget, task rows and
executor strip; its footer remains pinned under the 560px cap. Specialized tray
rows own their board spacing. Button and ButtonLink accept `size="xs"` for
extra compact labelled footer controls (8px horizontal padding, 4px gap and the `control-compact` minimum height in default and compact
density); variants, focus, disabled and busy semantics remain shared. Existing
sizes keep their geometry. The tray's 36px quiet icon controls use the shared
stroke `pause` and `play` icons; More owns an absolutely positioned menu, with
Escape returning focus to its trigger. Icons are authored in-repo; provenance is
unchanged. New task opens the New task composer at `/tasks/new` (#460).

### Insights board

`SegmentedControl variant="insights"` retains pressed-button semantics and keyboard
behavior, with 3px group padding, 8px group radius and 32px segments. Narrow
viewports and coarse pointers use the shared touch target token (44px). Only the
Insights Period filter uses this additive variant; other densities are unchanged.
The screen owns its chart and semantic tables in `insights.css`: agent rows use
the board's fixed numeric columns and flexible Agent/Share columns, while the
kind matrix keeps a 76px row-label column with full labels available by title.
Provisional board dimensions live in `tokens.local.json`.

The tray header composes `Pill` with a fixed status glyph and a tray-scoped ellipsizing label. Its `title` tooltip retains the full pace label, and its accessible name comes from the full text in the DOM; truncation is visual only. The planner name retains a 64px minimum; only after the pace label exhausts its space does the mode text truncate (with a full-text tooltip). Shared pill appearance and other consumers are unchanged.

Agents board density: `ListRow layout="planner"` uses a 32px identity mark,
14px × 16px card padding and a 10px radius on surface-card. It preserves sibling
actions and content. `PageColumns layout="agents"` gives the details aside a
340–400px column with 28px × 24px padding, a left border and surface-card;
it stacks below the table on smaller canvases. Production consumer: Settings Agents.
`RadioChoices` takes label, name, value, options, onChange and disabled props.
It uses native radio inputs in a labelled radiogroup, retaining browser arrow-key
navigation, focus and disabled semantics. Production consumer: Settings Accounts'
existing spread/fill policy. These are local compositions, with no upstream copy.
Agents/Accounts tables retain specialized semantic table layouts: 9px × 16px
uppercase headers, 10px × 16px body cells and 24px agent marks. Provisional
`radius-agents`, `size-9`, `size-400` and `shadow-agent-failure` tokens record board values.
`Icon` also supplies lock and close glyphs for the account information banner and
agent detail dismissal; decorative glyphs remain hidden from assistive technology.
`UsageMeter size="slim"` stacks its 6px meter above its caption and wraps caption
text; it is used by both agent tables and the session details panel. `SettingRow layout="stacked"` places the
control beneath its label and description with a top divider for detail blocks.
`SectionHeading variant="headline"` provides the board's 16/22/650 mixed-case
aside title. These variants retain the base components' semantics and actions.
The rounded table frame clips its corners; an inner scrolling region keeps all
columns and real actions reachable when the table is wider than its canvas.
`Card tone="bad"` uses bad-tint and bad-line for readiness explanations; wording
and fix actions remain supplied by the screen. Slim historical meters dim only
the visual track, retaining full contrast for their factual caption.

Machines and Add agent board alignment: `ChoiceCard` accepts `layout="agent"`
(vertical, 14px padding, 6px gap, 10px corners) or `layout="alias"` (8px × 10px
padding). Both retain button/pressed semantics, visible keyboard focus and an ink
selection border/ring. `RadioChoices layout="options"` renders bordered native
radio rows with 12px × 14px padding, 10px corners and an ink selected border;
labels can contain a title and caption. Native arrow-key radio navigation applies.
Existing compact account policy controls keep their default layout.

`Stepper` uses a 2px list gap and 10px step padding/gap. `CheckList` uses 10px ×
12px padding, 6px row gaps and 14px glyphs; `unboxed` removes its outer border,
background and padding when composed inside the Add agent Test task block.
Notes stay right aligned and wrap within the row. The `laptop` outline icon is
available for the Machines local card. These variants are owned by DS; Machines
and Add agent own only their specialized card, panel and grid composition.

Slice 6b board consumers: Agents (Executors and Accounts), Machines and Add an
agent compose `pc-settings-board` and `pc-settings-board__header` with one h1 and
caption. Their settings-bundle rules own the 18px block gap and right-aligned
header actions. Host detail retains its breadcrumb and no h1. This adds no DS
component API or component stylesheet bytes.

Machines uses `SettingRow variant="board"` for all four This Mac rows. The card
body establishes an inline-size container; at widths up to 700px, rows use a
single column and the shared 8px narrow gap, retaining 14px vertical padding.
This documented card containment rule handles two cards within the bounded page.
Agent details retain `layout="stacked"`; Takes work applies immediately with a
disabled, aria-busy switch during saving and an inline alert on failure. Parallel
tasks remain in the page draft. Escape and Close restore row focus; removal moves
focus to Add agent. Detection retry and failed-host recovery use existing service
operations and scoped host-detail navigation.

### Settings Agents and Machines layouts

Settings-specific component styles live in `screens/settings/settings.css` to keep the startup bundle bounded. Agents uses five columns (Executor, Status, This week, Parallel, actions); below 760px of table container width, rows become labelled cards with visible actions. The More actions icon button opens the details region and keeps its focus-return and Escape behavior. Priority and parallel-task edits share the page draft and save bar; Takes work saves immediately. The stacked priority SettingRow keeps movement buttons beside the position number. Parallel-task inputs in details are 72px wide with 6px radius and 10px padding.

Machines uses auto-fit cards with a 440px minimum, bounded by the container. Its board SettingRows use a label track capped at 240px, a flexible control track with a 220px floor, 20px gap and 12px block padding. Rows stack below 420px of the card body. ChoicePickers are 220px wide, capped by their control track after rows stack. At 456px of content the label track shrinks to 216px to fit the picker and 20px gap. Account policy labels, bare Takes work switch labels, and settings text actions keep at least 44px touch height on narrow or coarse-pointer layouts. The new 130px and 90px table dimensions are provisional local tokens.

Accounts composes per-account Check usage controls from Button, Stack, Dialog and Disclosure. A compact result/progress line replaces the full JobProgress panel; provider guidance and deduplicated diagnostics share one initially collapsed, account-labelled Usage check details disclosure. AccountUsage opts out of useOperation job toasts; other consumers retain their existing notifications. Consent uses the shared dialog’s cancel-first focus, Escape dismissal and focus return. Running jobs are scoped to the account; status updates use polite live regions. No shared primitive API or upstream provenance changes.

Accounts uses six board grid tracks: Account, Sign-in (130px), Quota (at least
160px), Status (150px), Used by, and actions (180px). At container widths up to
960px, every cell remains visible in labelled cards. More actions appears only
for accounts with existing sign-in or Ark CLI sign-in help and toggles an inline
region spanning the row. Agents and Accounts paint the header background and
bottom rule on the whole header row. Add agent breadcrumb and footer text
links keep the shared touch minimum for both width and height.

The assistant launcher uses the shared `AuroraLauncher` (surface-card in both themes, muted 11px shortcut) and its `AuroraAvatar` uses the board’s conic aurora token gradient. The shell clips the overlay to the work area; setup composes 24px `AgentMark` rows and a semantic h2 using the 14px/650 session-title tokens. App preferences uses the existing `Switch size="sm"` (36×20, green on). `AuroraSheet autoScroll` defaults to true for conversation updates; setup/status cards set it false to retain their heading at the top. No upstream source is introduced.

Session detail keeps the sole h1 in its in-page session header; the global top bar retains the shared search and actions. Session composition retains specialized board geometry: a 40px header, 272px compact navigator, 300px details pane and 560px file pane. FileViewer `sidePanel` retains desktop controls inside the frame-owned pane; standalone terminal previews keep their existing responsive layout. Session file tabs have adjacent close buttons and arrow-key navigation.

Button `size="bar"` supplies the boards’ 26px header action, 10px horizontal padding and 6px radius, with the shared touch minimum on coarse pointers. The session End session action consumes it.

### Unified page frame and workspace terminal

`Page` owns an uncapped work-area width with 24px top, 32px side and 40px
bottom gutters on desktop. All width names retain compatibility and resolve to
that same frame. Settings keep their separate 240px navigation. Routed page
headings use the display tokens (28px/34px, weight 650); `PageTitle` places the
heading before introductory breadcrumbs in flex layouts.

The desktop `TopBar` is 36px high: a 26px search, 24px planner chip, three
28px layout toggles and a 26px New task link. Absent panels keep their toggle
with a disabled state and a reason tooltip. Native traffic-light spacing remains
owned by the shell.

`TerminalDock` owns local height persistence, a 6px horizontal separator and
120px–80% work-area limits. Up/Down resize by 16px; Home/End select the bounds;
double-click restores 260px. Maximize fills the work area and Restore returns to
the previous height. Its flex proportion is measured layout geometry,
not an authored visual scale. `TerminalScreen` supplies the same terminal panel
for the dock and full-page route: a 30px tab/header row, 24px tools with 6px radii, inline tab
rename, folder creation menu, split panes and keyboard/pointer split separator.
Terminal body padding is 10px/14px and type is mono 12px/19px. Existing session
attachment, control and IO remain in `term/term.tsx`; its optional `onActions`
callback exposes Find, Clear and screen-reader mode to the panel header, and
`onInputLocked` supplies the tab's conditional control-lock tooltip. Find is a
floating widget opened by Cmd/Ctrl+F and closed by Esc. Connection/retry/control
state appears inside the body. The external-terminal menu item explains when the
service lacks that capability. This is an original specialized terminal layout;
no upstream component was copied.

### Result board variants

Inspect failures and Review result compose existing Button, Pill, Field/TextArea,
OptionRow/RadioGroup and SelectableRow primitives. `OptionRow variant="retry"`
uses a closed 12px card with a leading radio dot; RadioGroup retains arrow-key
selection and a single tab stop. `SegmentedControl variant="result"` uses the
Review board's 30px segments and 2px container padding. The changed-file
`pc-result-file` row uses 30px height and 10px horizontal padding. These variants
are owned by DS; result screens bind task state and API operations. Their
production consumers are `screens/failure/Failure.tsx` and
`screens/review/ResultPage.tsx`. No upstream component was introduced.

Result notes use the DS `pc-result-note` textarea variant: three rows, 8px/10px
padding, body typography and no unrelated minimum height. It retains the native
textarea resize and keyboard behavior. Numbered diffs remain a specialized result
layout: hunk-derived line numbers and aligned before/after replacement rows.

The 40px session header keeps its `Review result` navigation action visible when Details
is open; unlike a panel-opening action, it now navigates to the task's dedicated
review or failure page. Other next-step actions retain their existing panel behavior.

### SideDialog

`SideDialog({ title, mark?, close, footer, children, onKeyDown? })` is the native
modal side panel used by Needs you → Answer. It is 480px wide on desktop and
contained by the viewport on narrow screens, between the shared top and status
bars. The header is 48px; body padding is 20px and content gap is 16px. Escape
closes, Tab/Shift-Tab cycle through enabled controls, and closing restores the
invoker's focus. The caller owns loading, error, question, answer and busy states.
The Answer board supplies provisional `answer-scrim`, `shadow-answer` and `radius-answer-chip` (99px) tokens. The panel follows the application-owned `--frame-top` and `--frame-status` layout offsets, whose values reference generated size tokens. This is
original project code; no new upstream component is incorporated.

Needs you retains the board's specialized three-column waiting list (20px glyph,
flexible content, actions), with 14px/16px row padding and a 12px closed border.
Its kind tabs, quick-answer chips and answer textarea use canonical DS controls
with the board's recorded geometry. The API always includes an answer in the
retry brief; the checked checkbox explains that fixed behavior visibly.

The frame's assistant clearance adapters expose measured dock height through
`--pc-dock-height` and the session header's bottom relative to the body through
`--pc-assistant-header-height` (nonnegative CSS pixels). AppFrame owns these
read-only layout measurements; the open launcher clamps below that header.
Neither channel accepts user input or changes the closed launcher's spacing.

Session Details composes its facts and delegated work with a shared section Stack (24px). Workspace paths use `SettingsPath`, preserving non-home paths and adding break opportunities at separators. Navigator subtask disclosures use 22px desktop geometry while touch controls retain their shared target size. The assistant column sits 18px above the veil bottom; the open launcher clears the measured page header as well as the session header when the terminal dock is open. The 11px uppercase Plugins label uses tighter tracking to retain at least 4px on either side of the 52px activity rail.

The app's device-local `pacer.density` preference defaults to Comfortable
(`normal`). The shell sets `html[data-density="normal"|"compact"]` and supplies
DensityContext; shared small buttons, icon buttons, single-line inputs, pickers
and recurring rows use the matching 32px or 28px control token. Settings share
the selected geometry. Rows use 8px/12px padding in Comfortable and 6px/8px in
Compact. Touch targets and the compact tray retain their scoped geometry.
Preferences apply immediately and persist in origin-local storage, without a
service configuration write. Theme uses the same device-local storage scope.

Tooltip uses `text`, optional `shortcut` and one VNode trigger. Hover or focus opens a body portal at the tooltip layer; Escape dismisses it. It preserves existing descriptions, uses an opaque card surface, ink, caption type, 6px radius, 4px/8px padding and popover shadow. The bubble sits 8px to the right, vertically centred, flips left and clamps to an 8px viewport inset; resize and captured scroll update its position. Long copy wraps within the viewport. Shortcut text uses the shared small `Kbd`. Rail and settings are production consumers. Rail hover uses surface-lane; active uses line with the 2px ink indicator.

### Canvas shell icons and refresh feedback

`Icon` retains the 24-unit viewBox and 1.8 stroke. Activity navigation uses
`activity-dispatch`, `needs-you`, `task-checklist`, `activity-insights` and
`activity-terminal` from
`docs/design/project/ActivityBar.dc.html`. Rail icons remain 20px through the
existing size token; `add-plugin` remains 18px. The plugin check-square uses
`plugin-checklist` in the rail and `settings-release` in SettingsNav because
those canvases specify different outlines. TopBar uses `topbar-search` and
`topbar-left/bottom/right`; StatusBar uses the unframed `status-terminal`.
Existing review, session, search and panel symbols keep their other meanings.
SettingsNav icons use the canvas’s 17px local token. Command navigation uses
`command-nav`, task results use `stack`, terminal actions use `command-terminal`,
and pause uses `command-pause`, matching CommandMenu’s separate symbols.
All icons are decorative (`aria-hidden`); their controls own accessible names,
keyboard behavior and current-page state.

Filtered Dispatch, Insights and Tasks reads opt into `useQuery`'s fourth
`keepPreviousData` argument. Other queries, particularly task identities, retain
key isolation. Refreshing regions use `useDelayedBusy` to apply `aria-busy` and
`pc-query-refreshing` only after 150ms. The shared class changes opacity only,
without animation or transitions, including under reduced motion. Existing
content and controls remain mounted while the replacement request is pending;
refresh errors retain data and expose feedback. No new upstream code is used.

### Shared selection motion

`ds/SelectionStrip.tsx` owns `SegmentedControl`, `Tabs` and the geometry used by
`NavTabs` and `PanelTabs`; `Patterns` retains its public exports. Controlled
`label`, `value`, `options` and `onChange` keep domain state with callers.
Options accept disabled states and sibling trailing actions; tabs accept `id`
for the existing `<id>-<value>-tab/panel` relationship. Page tabs remain anchors.
ArrowLeft/ArrowRight wrap, Home/End select the endpoints, disabled choices are
skipped, and exactly one enabled choice participates in sequential focus.

The single indicator measures the selected item's rectangle and offsets;
ResizeObserver watches the track and every item, including label/font changes.
The first measurement is instant. Later changes animate transform and width
with `motion-selection` (160ms ease-out). Segmented tracks retain 3px padding,
30px items, 38px total height and 8px/6px track/indicator radii; board, insights
and result colors retain their existing tokens. Touch geometry remains larger.
Tabs retain their surface's existing compact geometry and underline treatment.
Tab panel swaps cross-fade for `motion-panel` (120ms), using an inert, accessibility-hidden
outgoing snapshot in a closed shadow tree with IDs removed. The snapshot keeps
the surface styles without duplicating live selectors or focusable controls. The panel container
retains the largest measured height for the duration of the swap, so shorter
content cannot collapse it while the outgoing content fades. Reduced motion disables both
indicator and panel animation and swaps content instantly. This is original
in-repository implementation; no new upstream component or dependency.

Production consumers: Dispatch period; Insights period; result diff layout;
Dispatcher scope and task-kind rules; Settings mode, pacing policy,
notifications, theme, density, multiple-account policy and plugin enum fields;
Settings Executors/Accounts page navigation; Session views and Details/Changes/
opened-file tabs; file Source/Preview and file side-panel tabs; Tasks filter;
Needs you kind filter; Inspector Task/Agents/plugin panels; workspace terminals;
and command search scopes. Surface styles retain only specialized layout and
sizes; selected decoration and motion belong to SelectionStrip.

### Task page and Workspace (boards 25–26)

Task titles open `#/tasks/<id>`. This is the Overview destination for every state;
legacy trace, review and failure URLs redirect there. The page uses the recorded
state, token roll-ups, routing trace, candidate decisions and acceptance result.
Task IDs are secondary metadata rather than breadcrumb text. Rejection keeps its
required note; retry keeps the existing executor/feedback/edit-brief choices.

`#/workspace?task=<id>&panel=<panel>` is the work surface. The activity rail’s
Workspace icon uses `M3 4h18v16H3zM9 4v16M9 12h12`; Ctrl+backtick still toggles
the bottom terminal on other screens. The left frame is 272px; the task inspector
is 320px. Task cards contain collapsible session rows or 26px icon controls with
accessible names and portal tooltips. Selection and task navigation are sibling
controls. The current task starts expanded. Recent results, active tasks and tasks
needing review remain available, with the shared status vocabulary and tints.

The shared workbench canvas (`pc-main--workbench`) removes page and assistant
launcher insets and lets desktop workspace content fill the space above the status
bar. Narrow layouts retain page scrolling. The terminal strip uses `Tabs`
`variant="terminal"` and sibling `pc-terminal-tab-kill` controls for the board's
30px strip (31px including its divider). `IconButton geometry="panel"` owns
the 24px panel tool with a 15px glyph and retains the shared touch minimum on
coarse pointers; Workspace's New panel trigger consumes it. The top bar wraps panel identity onto its own narrow row so search,
session actions and New task remain pointer-reachable without horizontal panning.

The middle uses shared `Tabs` for session, shell, file, diff and earlier-attempt
panels. Tabs retain mounted terminals when switched; closing a panel closes its
view, leaving the underlying session available. Arrow keys, Home and End follow
the shared tab-strip behavior. `+` opens a shell in the selected worktree, the
interactive agent chooser, or the existing bounded file viewer. New interactive
sessions currently create a separate task through `session.create`; the chooser
states this service limitation and preserves the selected worktree and brief.
The menu and dialog call this **New task in this worktree**, and the submit action
is **Create task and start session**. The menu uses the shared `useAnchoredMenu`
viewport adapter, remeasuring on scroll, viewport and panel resize; Escape restores
the trigger, arrows/Home/End move between items, and outside clicks dismiss it.
Session read failures replace loading skeletons with the service error and a
**Retry session** action. Ended metadata reads **Ended · read-only**; unavailable
repository or branch values introduce no empty separators. These are compositions
of existing primitives; no upstream source or dependency is added.
Earlier-attempt panels show metadata because the current service has no replay
operation for a selected historical attempt.

The open panel owns the top-bar context and actions. Following agent terminals
are read-only until Take over; Hand back releases control. End session keeps the
existing confirmation. Shells reuse the terminal client and xterm. The right
inspector provides Overview, Changes and Notes; selecting a change opens a middle
diff panel. `NowCard`, `CostTiles` and `Acceptance` own the shared overview patterns
and compact presentation. All geometry and appearances use generated tokens,
including 4/6/8/12/full radii and the shared type scale. Workspace remains lazy
loaded; no new dependency or upstream component was introduced.

`SidePanel.resize` adds a bounded, persisted width with a 6px separator. It accepts
`key`, `initial`, `min`, and `max`; the Workspace defaults are 272/320 with bounds
200–480/260–560. Arrow keys adjust 16px, Home/End select bounds, and double-click
restores the default. `--pc-panel-width` is the narrowly checked, unitless geometry
adapter for this user-selected measurement; CSS multiplies by `--size-1`. Other
styles and custom properties remain subject to the ordinary token checks.

### Board-sized buttons and subtasks

Small action buttons inherit device control density (Comfortable 32px, Compact
28px). Component geometry takes precedence: segmented items are 30px (Compact
26px) with a 3px track inset; chips, chrome and specialized icon buttons retain
their own sizes. Only status-bar chrome buttons lose side padding; usage-popover
actions retain the shared 12px inset. Repository SearchPicker triggers use the
600-weight small button without a chevron; search, Escape and focus restoration
remain unchanged.

`SubtaskToggle` owns the shared task-card and session-navigator disclosure chip:
22px border-box, 6px radius, 7px side padding, 12px/600 label, 13px branch icon,
11px chevron rotating 180 degrees when expanded. Consumers supply `aria-expanded`,
`aria-controls`, children and a toggle callback. The wrapper inset is 0 8px 4px
24px. Native button keyboard behavior and visible focus apply; touch targets
remain 44px. Only the current row gets the page-surface background and 650 title
weight; unselected subtask titles use the provisional task-child 500 weight.

### Skeleton consumer migration

All former loading-state calls use `Skeleton`; refresh-only indicators were removed from `session/resource` and `session/Session` so existing content stays mounted. Errors and their retry controls remain separate. No new dependency or screen chunk is introduced.

| Consumer | Layout / regions |
| --- | --- |
| `plugins/Activity.tsx` | settings |
| `plugins/LazyActivity.tsx` | settings |
| `screens/LazyInsights.tsx` | dashboard |
| `screens/setup/LazySetup.tsx` | settings |
| `screens/settings/LazySettings.tsx` | settings |
| `screens/LazyTaskRoute.tsx` | task |
| `screens/Review.tsx` | task |
| `screens/TaskResult.tsx` | rows, task |
| `screens/dispatch/Dispatch.tsx` | rows |
| `screens/dispatch/LazyDispatch.tsx` | dashboard (Dispatch), list (Needs you) |
| `screens/insights/Insights.tsx` | dashboard, rows |
| `screens/new-task/LazyNewTask.tsx` | settings |
| `screens/new-task/NewTask.tsx` | rows |
| `screens/review/LazyResultPage.tsx` | task |
| `screens/review/ResultPage.tsx` | rows, task |
| `screens/session/Session.tsx` | rows, task |
| `screens/session/SessionPanel.tsx` | rows |
| `screens/session/resource.tsx` | rows default, list for TasksPage |
| `screens/settings/AssistantSettings.tsx` | settings |
| `screens/settings/LazyAssistantSettings.tsx` | settings |
| `screens/settings/LazyDispatcher.tsx` | settings |
| `screens/settings/PluginSettingsPage.tsx` | settings |
| `screens/settings/PluginsPage.tsx` | settings |
| `screens/settings/shared.tsx` | settings |
| `screens/terminal/Terminal.tsx` | rows |
| `screens/trace/LazyTrace.tsx` | task |
| `screens/trace/Trace.tsx` | task |
| `screens/work/LazyWork.tsx` | task |
| `screens/work/WorkView.tsx` | rows, task |
| `shell/Layout.tsx` | route: task/list/settings/dashboard |
| `tray/Tray.tsx` | rows |
| `screens/session/TasksPage.tsx` | list via ResourceView |

### ImmediateSave and ReleaseRange

`ImmediateSave<T>` wraps one save-on-click control with `value`, a synchronous or
asynchronous `save(next)` callback, and a render callback `(value, change, busy)`.
It owns optimistic state, synchronous duplicate-input locking, rollback, and a
polite checkmarked Saved notice lasting two seconds. A false result cancels
without a notice. The busy control dims to .65 and is inert by default; controls
also receive `busy` for native disabling. `focusableWhileBusy` keeps the boundary
focusable for plugin enable switches, whose consumers use `aria-disabled` and
reject pending input while preserving the checked value. Synchronous save locking
remains active in either mode. After settlement, focus returns to the invoking
control only once it is enabled, connected and no other control has taken focus.
Errors appear immediately below the control with
plain public copy and collapsed technical details. Presentation and spacing use
shared tokens; success uses the 12px caption token and good foreground token.
Callers supply an accessible name. Keyboard semantics remain those of the wrapped
control. `ReleaseRange` previews input and commits once on pointer/key release or
blur; pointer cancellation restores its saved value. These are original components.

Settings Budget & pacing, Accounts, App preferences, executor Takes work, host
preferences, Updates and Plugins compose this boundary. `ImmediateSetting` binds
it to service operations in the settings consumer; DS imports no service state.
Machines and other explicit Save forms retain their draft and SaveBar behavior.

`SettingRow.controlId` links its visible label to an explicitly identified control
inside a render callback (where static child discovery cannot inspect it). The
caller assigns that ID to the actual control. Automatic discovery remains the
default for direct children; Automatic update check uses the explicit link.

### Dispatch ledger row spacing

`ListRowLink layout="dispatch"` retains the specialized Dispatch ledger padding
(9px block, 20px inline) in normal and compact control density. DS owns this
spacing; Dispatch owns its seven-column responsive grid and 12px column gap.
The variant retains native link semantics, focus and hover states, and whole-row
keyboard navigation, with no nested interactive controls. Production consumer:
`app/src/screens/dispatch/Dispatch.tsx` Live dispatch ledger.

**Terminal overview preview** (`app/src/term/LazyTerminal.tsx`, `term.tsx`). The specialized terminal renderer remains outside the DS and loads xterm only on demand. `preview` suppresses the session action row; the task overview passes `control={false}` and `resize={false}` and retains connection status, authoritative dimensions and the canonical Screen reader checkbox. Its screen-owned frame is bounded to the 320px size token, with full-size glyphs and a focusable viewport that scrolls on both axes rather than scaling the remote screen down. Watching never takes control, sends input or changes PTY geometry; the workspace link opens the full session. Headless and failed-check text stays in bounded, focusable output regions. No upstream components or provenance changed.

`SearchInput` (Controls) accepts the TextInput attributes plus a required `label`.
Tasks uses it for goal, repository and branch search. The magnifying glass stays
in flow with an 8px gap before the input; the wrapper owns the border, focus ring
and padding. It is 36px high on desktop and uses the shared touch height on narrow
screens. Empty, typed and focused states retain a visible accessible search label;
the native search field keeps its clear affordance. It does not change ordinary
TextInput density or padding.

The frame fidelity variants keep ordinary DS controls unchanged: `Tabs variant="terminal"` owns a 30px strip, ink selected underline and separate 18px close action; the terminal toolbar uses scoped glyph names. Header layout actions are 28px on desktop and retain touch targets. Status strip actions use 400-weight 12/16 text; warning marks alone are 700. Stale meter fills use line, independent of a previous good verdict.

`useAnchoredMenu` is a narrow data-geometry adapter: it measures the anchor, popup and viewport, derives the gutter from CSS padding, flips above when needed and clamps left/top/max-height to the visible viewport. It updates on resize/scroll and ResizeObserver changes; it supplies no authored appearance dimensions. The source checker permits only its three exact measurement assignments. Terminal folder labels resolve task titles and repository labels; tooltips use those same public labels instead of absolute paths.

Command counts inherit their tab colour; selected counts use .75 opacity. Other counts retain full opacity, and captions retain the accessible ink-muted token, because the board’s light muted colour and opacity can fail 4.5:1 on the lane background. The footer omits open-beside when no such destination is implemented (UI-13).

### Dispatch and Insights fidelity variants

- `Button` / `ButtonLink` accept `typography="board"`: 12px line height and regular secondary weight, retaining the active density, focus, disabled/busy semantics and keyboard behavior. Needs you row actions and Insights CSV use this variant.
- `UsageMeter variant="board"` uses the line-colour 8px track and a pace marker extending 4px above/below it. Other meter sizes retain clipping and existing geometry. Dispatch planner cards consume this variant; meter accessibility and reduced-motion behavior are unchanged.
- `Stack space="board"` owns the 20px board section gap. Insights uses it instead of overriding shared stack spacing.
- `ListRow layout="attention"` owns the 12px attention padding in either desktop density. Dispatch attention cards use its existing sibling content/action slots and tone semantics.
- `board-chart-1` through `board-chart-5` preserve the board's categorical fill colours across schemes. Dispatch token shares and Insights charts use these decorative tokens; adjacent text uses accessible ink tokens. Heatmap text retains accessible foregrounds rather than borrowing series colours.
- `TextAction heading` is the inline 22px heading-row action used by narrow Dispatch's “All N” link. It retains anchor semantics, keyboard focus and the shared link colours, without the generic 44px touch line box expanding the board heading.

### Settings board fidelity variants

`IconButton` accepts `geometry="board"` for a 28×28 desktop control with 6px
corners and an unshrinking 16px glyph. Coarse pointers and narrow screens retain
44px targets. Agent details, executor pools and ActionMenu use this variant.
`Tabs variant="pills"` retains tab roles, arrow-key navigation and panel ownership
while drawing outlined 28px pills. Other tabs retain their underline treatment.
`SortableList layout="executor"` adds the bordered, padded executor list and an
end-of-list drag guide; only keyed executor rows participate in reorder geometry.
The Move up/down and Remove buttons use SVG icons and preserve accessible names.

`TextAction size="caption"` provides a 12/16 standalone action for release notes.
`SettingRow layout="inline-help"` places number controls and capacity help on one
line beneath the label. `Field emphasis="strong"` gives the remote-host name step
a bold label. Agent choice cards and wizard steps own auto-height geometry and
body typography independently of shared button density. The Agents column layout
places the details aside beside the entire page, with no compounded gutter.
These are original project variants; upstream provenance and licenses are unchanged.

Workspace board 26 retains a specialized three-row task head in `screens/workspace`:
a shared Button selects the whole head (pressed state), with a leading live status
dot, ellipsized title, 18px host chip and mono repository, then status and tokens.
Session toggles and collapsed 26px icon targets or expanded 28px minimum rows are
sibling controls, with independent keyboard targets. The Tasks tree supplies status
and attention vocabulary. The frame's active-panel actions live right of search;
board IconButtons are quiet 28px controls with native title tooltips; only the
end-session action uses bad tone. Takeover and handback retain the shared hover,
focus, busy and touch-target treatments, with plain ownership text in the header. Session control remains owned by the panel, with confirmation on
end; file panels hand local workspace paths to VS Code's registered file URI handler.
Desktop geometry uses generated tokens; live status respects reduced motion.

Workspace control glyphs (`take-over`, `hand-back`, `stop-session`) follow the approved
board 26 SVG paths. Board IconButton geometry has no border and uses a 16px glyph.

Plugin settings removal and reorder actions use the shared `IconButton geometry="board"` contract: 28px on desktop, 44px on coarse pointers and narrow screens, 6px corners. This follows the SettingsPluginPage board's `.ib` rule; its ordered rows have 8px vertical padding plus borders (46px on desktop). Empty reorder slots retain the same width. File-viewer Search and Copy actions keep the FileViewer board's 28px desktop square, with 44px narrow/coarse targets.

### Terminal palette and authoritative geometry

`terminal-*` color tokens in `tokens.local.json` own the dark terminal surface,
default foreground, selection, cursor and 16 ANSI colors in both app themes.
The renderer requests a 4.5:1 minimum text contrast; it does not rewrite output
ANSI sequences. Explicit indexed black backgrounds match the terminal surface.
Terminal wrappers and the xterm viewport consume `terminal-background`, while
search, status and app chrome keep their normal app-theme tokens. Production
consumers include workspace sessions, shell/split terminals, and conversation
terminals via LinkedTerminal. Overview previews use plain task.log output.
Workspace passes `externalControls` to TerminalView so its
shared frame toolbar owns takeover/handback without a second action row. The
terminal retains its status, Screen reader control, errors and reconnect action.
Followers scroll at normal font size and retain PTY
dimensions; only a visible controller fits/resizes. No upstream provenance changes.

### Command menu elevation

The command menu uses `shadow-command` in both themes, preserving the CommandMenu
board's two-layer 24px/64px and 2px/6px elevation geometry. Shadow pigment is fixed
black, like the Workspace menu and Answer sheet boards, rather than `ink`: text
ink becomes light in dark mode and produces a glow. The border and surface still
follow theme tokens. Semantics, keyboard behavior, density and consumers are
unchanged; `CommandPalette` remains the production consumer.
