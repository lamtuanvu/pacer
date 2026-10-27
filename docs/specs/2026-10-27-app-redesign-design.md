# App redesign: dispatcher first

Date: 2026-10-27. Status: approved by the maintainer. Applies to: `app/**`, `src/view-model/**`, `docs/design-system.md`.
Builds on:
- [UI functionality](2026-10-16-ui-functionality-design.md)
- [UI implementation](2026-10-16-ui-implementation-design.md)
- [session UI layout](2026-10-25-session-ui-layout-design.md)
- [built-in terminal](2026-10-26-built-in-terminal-design.md)
- [dispatcher settings](2026-10-26-dispatcher-settings-design.md)
- [attempt token accounting](2026-10-27-attempt-token-accounting-design.md)

## Problem

pacer's core value is the dispatcher: one planner hands work to many executors within their budgets. The app does not show that value.

- **Split home.** Start and Overview divide the home screen between them, and neither answers the questions a user actually has:
  - How much work did the dispatcher handle?
  - What did it cost?
  - Which executors carried it?
  - What needs me now?
- **Duplicated task views.** The same task looks different in the task list, the session's side list and the tray.
- **No room to grow.** There is no place for plugins to add UI, and the terminal takes several steps to open.

The redesign was worked out on a design canvas that uses the pacer design system. The canvas is not part of this repository, so this spec is the normative record of its decisions.

## Goals

1. Put the dispatcher's results first: root tasks handled, total tokens, and how tokens spread across executors.
2. Make what needs attention stand out: tone, tint and order, with words always present (UI-2).
3. Show the same concept the same way everywhere: one component per concept, built from one view-model descriptor (UI-10).
4. Use icons and colour to help scanning, and use space efficiently, with compact desktop density (UI-26).
5. Leave room for plugins and dev tools: collapsible side panels, extensible panel tabs and a terminal dock.

Non-goals:
- new backend data, other than through the specs listed under data gaps;
- the assistant backend;
- the plugin protocol changes themselves.

## Information architecture

Start and Overview merge into one **Dispatch** home. The primary routes become:

| Activity bar | Route | Hash | Replaces |
|---|---|---|---|
| Dispatch | `dispatch` | `#/` | `start` (`#/`) and `overview` (`#/overview`) |
| Needs you | `review` | `#/needs-you` | unchanged |
| Tasks | `sessions` | `#/tasks`, `#/tasks/<id>` | unchanged |
| Insights | `insights` | `#/insights` | new, shown once token data exists |
| Terminal | `terminal` | `#/terminal`, `#/terminal/<id>` | unchanged; it also opens as a dock |
| Settings | `settings` | `#/settings/...` | unchanged; regrouped (see Settings) |

- `#/overview` redirects to `#/` and keeps its `repo` and `scope` query. Existing links and desktop deep links keep working.
- Unknown or undecodable hashes fall back to `dispatch`, as they fall back to `overview` today.
- `setup`, `hosts` and `add-executor` keep their hashes. `hosts` is shown as Settings › Machines, and `add-executor` keeps its route id but is titled "Add agent".
- The rule that a setup in progress lets you reach the interactive entry now applies to `dispatch`, as it applied to `start` before.
- The top bar's title for the home is "Dispatch". The page title still appears once, in the top bar (UI-9).

### Dispatch home

The regions appear in this order:

1. **Start work.** The existing `StartSessionForm` (interactive session) and the quick delegate, shown as one composer. It is collapsed to a single input row until it gets focus. Its submit button is the region's one primary action (UI-14).
2. **Needs you.** The attention items, as task tree nodes with the warn or bad tint, most urgent first. The section is hidden when nothing needs the user, and the empty state says so.
3. **Live dispatch.** Running and queued work, as task tree nodes in compact density.
4. **This week at a glance.** Root tasks handled, subtasks and accept rate, plus total tokens once token accounting reports them.
5. **Where the tokens went.** A stacked share bar of tokens by executor, with a legend that uses agent marks and percentages. It is shown only when token coverage is `measured` or `partial`, and it labels partial coverage.
6. **Planner budget.** The planner's pace meter and the next decision. On the Dispatch home this region is the one place that shows the planner's budget (UI-15). See the top bar and status bar rows below.

## Window regions

One `AppFrame` owns every region. Screens fill slots and never draw chrome themselves.

| Region | Contents | Behaviour |
|---|---|---|
| Top bar | Mark, ⌘K search, planner chip with pacing mode, layout toggles, "Delegate a task" (secondary) | Always shown on desktop. The planner chip owns the pacing mode label from the UI-10 vocabulary and shows no budget figure |
| Activity bar | Primary routes, then a plugin section, then Settings with an attention badge | Icons with tooltips. Badges carry a count, and their accessible names say it in words ("Settings, 2 agents need attention"). No badge is colour alone |
| Left panel | Context list for the route: the task tree on Tasks and Session, the settings menu on Settings | Collapsible (⌘B); state is kept per route |
| Main | The screen | Has a max width, except for the terminal and session |
| Right panel | Tabs: Task, Agents, plus plugin tabs; overflow goes to "+N" | Collapsible (⌥⌘B); tabs are keyboard navigable |
| Terminal dock | The built-in terminal, which can be split | Toggled with Ctrl+`; resizable |
| Status bar | Budgets per vendor icon, running and queued counts, terminal toggle, version | Hidden on narrow screens. While the Dispatch home's Planner budget region is on screen, the planner's entry shows only its vendor mark and links to that region, so the figure is not repeated |

On narrow screens (767 px and below), both side panels become sheets opened from the top bar. The bottom navigation is unchanged, except that Start and Overview become Dispatch and Insights appears once token data exists.

## Shared components

New design-system pieces are listed below. No new runtime dependencies are added; drag and drop, the identicon and the aurora are built on the platform. Existing ones are reused, with new variants added centrally (UI-22): Button, IconButton (gains an `icon` prop; End session uses the `danger` variant), Pill/StatusPill, StatusGlyph, UsageMeter, Card, ListRow, Tabs, SegmentedControl, Field/controls, Page/Stack/Section, DisclosurePanel, Dialog, Tooltip, AgentMark and Mark. Each new component gets a catalog entry in `docs/design-system.md` (UI-22).

| Component | Kind | Purpose |
|---|---|---|
| `StatusDot` | primitive | Tone dot paired with a visible status label or the UI-10 `StatusGlyph`, never colour alone. Pulses when live, and not at all under reduced motion |
| `HostChip` | primitive | "Local Mac" or remote host name |
| `MetaRow` | primitive | Icon and text facts (PR, commits, files ±, checks, time, retries). Facts without a value are left out |
| `AgentStack` | primitive | The executors that worked on a task, as agent marks |
| `Identicon` | primitive | Deterministic 5×5 mirrored pixel icon for saved dispatcher setups |
| `StackedShareBar` | primitive | Token share by executor, with a text legend |
| `PanelTabs` | composite | Extensible tabs with an overflow menu |
| `SidePanel` | composite | Collapsible left or right panel with an `aria-expanded` toggle |
| `TaskTreeNode` | composite | Root task card with a "N subtasks" toggle and child rows. Densities `regular` and `compact` |
| `SettingRow` | composite | Label and help on the left, control on the right. The single row grammar for settings |
| `Stepper` | composite | Numbered steps for guided flows (Add agent, add host, dispatcher setup) |
| `SortableList` | composite | Drag-and-drop list. Up, down and remove buttons are the keyboard path |
| `SaveBar` | composite | Count of unsaved changes, with Discard and one primary Save |
| `AuroraSheet` | composite | Assistant sheet: solid at the bottom edge, fading to transparent at the top |

**Descriptors.** `TaskTreeNode` takes one `TaskNodeView` built by a selector in `src/view-model/task-tree.ts`. Tasks, the Session's left panel, Needs you, Dispatch home and the tray call that same selector. A list and its detail therefore cannot disagree.

**Tokens.** The canvas's literal colours become tokens before any component uses them (UI-21):
- `chart-1` to `chart-5`, a calm series for long viewing;
- `aurora-1` to `aurora-3`;
- the existing agent brand colours.

`app/src/ds/tokens.json` is the source of truth; `scripts/ds-sync.ts` keeps exported copies of the design system in step. New tokens land in the app first.

## Screens

| Screen | Key decisions |
|---|---|
| Tasks | Tree of root tasks: status dot with its status label or glyph, title, attention pill, host chip, branch, agents, tokens, and the notes, terminal and changes icon buttons. A metadata row below. A collapsible subtask list. A selected-task panel with Open session, Dispatch trace, linked work, notes and latest activity |
| Session | The agent's interactive built-in terminal fills the centre, and there is no view switch. The title bar shows the agent mark, title, elapsed time, tokens and subtask position, plus a details toggle and an End session icon button. The terminal's control strip (mode, Take control / Release, Reconnect, Screen reader, size) stays as its footer. The left panel is the task tree in compact density. The right panel has Changes and Details tabs |
| Root task: dispatch trace | One row per attempt: routing rule, chosen executor, why, and skipped candidates with reasons. Tokens per attempt once accounting exists |
| Insights | Root tasks handled, tokens over time, executor spread, accept and retry rates. Gated on token accounting |
| Settings | A grouped menu: Dispatch (Overview, Agents, Accounts, Dispatcher, Budget & pacing, Machines), Extend (Plugins, plugin pages) and App (App preferences, Diagnostics). Every page uses `SettingRow`. Nothing saves silently: changes go through `SaveBar` or an explicit button |
| Dispatcher | A guided setup in four steps: scope; who may do the work, as a sortable list per task type beside a pool of available executors; the choice ladder; and Try a task. Saved setups are marked with an `Identicon` |
| Machines | This Mac's settings, and a guided host add: pick an SSH alias, name it, then connect and check |
| Assistant | An `AuroraSheet` opened from the top bar. Older messages fade at the top. Input with a tools button and a context chip. Gated on an assistant spec |

### Settings sections

Existing `#/settings/<section>` links and `settingsPath` keep working through these mappings:

| Section today | Page |
|---|---|
| (none) | Overview |
| `executors`, `add-executor` | Agents, Add agent |
| `accounts` | Accounts |
| `dispatcher` (and the `routing`, `strategies` redirects) | Dispatcher |
| `planner` | Budget & pacing |
| `machine`, `hosts` | Machines |
| `updates`, `notifications`, `appearance` | App preferences, as sections of one page |
| `diagnostics` | Diagnostics |

### What this supersedes

- From the [session UI layout](2026-10-25-session-ui-layout-design.md): the action row moves into the title bar (End session as an icon button, Open in terminal in the terminal tab strip). Files moves to the right panel's Changes tab, and Resume conversation joins End session in the title bar when it can work. The footer control strip is kept.
- From the [tasks workspace](2026-10-25-tasks-workspace-design.md): the Session, Changes, Brief and Result tabs become the centred terminal plus right-panel tabs. Changes keeps its own tab; Brief and Result move into the Details tab.

## Data gaps

The UI shows only facts pacer has (UI-6, and the token accounting rule that a missing reading is never shown as zero). Until a gap closes, the element is not rendered, and no control that depends on it is offered (UI-13). It never shows a placeholder value.

| Element | Closes with |
|---|---|
| Tokens on cards, Where the tokens went, Insights | [attempt token accounting](2026-10-27-attempt-token-accounting-design.md), slices 1–3 |
| PR count and state, commits, checks | a "task delivery facts" spec: worktree git, plus `gh` when the user is signed in |
| Plugin activity items, panel tabs, settings pages | a plugin-protocol amendment for `contributes.ui`, with an ADR. Plugin UI is schema-driven and rendered by the design system; plugins ship no CSS or JS into the app |
| Assistant | an assistant spec |

## Delivery

One PR per slice, each targeting `main`. Each slice updates the affected `docs/*.md` pages and adds a CHANGELOG Unreleased entry (REPO-7). Each slice passes `bun run ui:check`, typecheck, tests, the UI-18 screenshots and `bun run live` (CT-11), with the app bundle reported against its 60 KB gzip budget (UI-3), plus the implementer compliance report and independent UI/accessibility and QA review (UI-24, REPO-10).

| Slice | Scope |
|---|---|
| 1 | Tokens, icons, the primitives `StatusDot`, `HostChip`, `MetaRow`, `AgentStack`, `Identicon`, and the `IconButton` `icon` prop. No screen changes |
| 2 | `AppFrame`, `SidePanel`, `PanelTabs`, the terminal dock and shortcuts |
| 3 | `TaskTreeNode` and its descriptor, used by Tasks and the Session panel |
| 4 | Session screen layout |
| 5 | Dispatch home (the merge and the `#/overview` redirect) and Needs you |
| 6 | Settings menu and `SettingRow` pages, then Agents, Accounts, Add agent and Machines |
| 7 | Guided dispatcher setup |
| 8 | Insights (gated) |
| 9 | Plugin UI contribution points (gated) |
| 10 | Assistant (gated) |

## Verification

- **Descriptors:** tests from the golden fixture `test/fixtures/ui/snapshot.json`. Attention ordering, unknown tokens left out, labels matching the status vocabulary.
- **Components:** DOM and keyboard tests (`aria-expanded`, `aria-current`, tab arrow keys, keyboard reordering in sortable lists), and browser geometry tests for compact density and clipping at 272 px and 375 px.
- **Reduced motion and dark mode:** checks for the live pulse and the aurora.
- **Routing:** `#/` resolves to `dispatch`; `#/overview` redirects to `#/` with its query preserved; unknown hashes fall back to `dispatch`; every old settings section resolves to its page; the setup-in-progress rule still reaches the interactive entry.
