# pacer app redesign: local copy of the design canvas

This folder is a complete, editable copy of the design canvas "Pacer App Redesign".
It was taken from canvas version 74 (`1793271289-39c7`) on 2026-10-29; every board matches the live canvas byte for byte. Sample data uses neutral example repositories (`acme/web`, `acme/runner-forge`, `acme/ota-client` …).
Any agent can read and edit it, with or without access to claude.ai.

- Live canvas: https://claude.ai/code/artifact/1682485c-1188-4421-9a33-a687fc753794 (private to its owner)
- Board list: [BOARDS.md](BOARDS.md)
- Format and editing rules: the canvas type's own guide, `SKILL.md` and `artifact-type/reference/format.md` on the live canvas (`Artifact` read with `path`). A local working copy, when present, keeps them in `reference/` (not tracked).

## Layout

```
project/
  canvas.json            index: one entry per board (position, size, title, flags), notes, order, design system record
  *.dc.html              one file per board (artboard); 48 boards
  ds/pacer/              the pacer design system copy: tokens.css, tokens.json, components/bundle.{css,js}
BOARDS.md                generated board index
```

## How to read a board

Each `*.dc.html` file is one self-contained design component:

- Markup lives between `<x-dc>` and `</x-dc>`. **Inline `style="…"` values are the spec**: sizes, padding, gap, radius, font size and weight, colours (as `var(--token)`), order and copy.
- `<helmet><style>` holds the board's shared classes (`.lbl`, `.cap`, `.tab`, `.pb` …).
- `{{hole}}` placeholders are filled from `renderVals()` in the `<script type="text/x-dc">` block at the bottom, which holds the sample data and per-state values. `<sc-for>` repeats, `<sc-if>` branches.
- `<x-import component-from-global-scope="Pacer.Button" …>` mounts a design-system component (Button, Pill, Card, UsageMeter, Mark: `window.Pacer` in `ds/pacer/components/bundle.js`).
- `<dc-import name="TopBar">` mounts another board as a child component (TopBar, ActivityBar, StatusBar, SettingsNav, AgentMark, Shell, NeedsYou …).
- `<a href="Other.dc.html">` links boards into the clickable prototype (Play in the canvas). A link styled with `class="pc-btn pc-btn--primary pc-btn--sm"` is a button; never put a `<button>` inside an `<a>` (it swallows the click).

Tokens: `project/ds/pacer/tokens.css` (light values on `:root`, dark under `prefers-color-scheme`). Boards use the class `theme-dark` to force dark.

## Design rules decided so far (keep these when you edit)

- **Page frame:** every page fills the window: `main` padding `24px 32px 40px`, no `max-width`, h1 28/34 weight 650 at the same position on every screen. Settings pages sit right of the 240px settings menu.
- **Top bar:** 36px tall. Pacer mark, centred search 420×26 (radius 6), planner chip 24px, a Layout group of three 28px toggles (left panel, terminal, right panel) on every screen, then a 26px New task link.
- **Type scale:** 11, 12, 13, 14, 16, 22, 28px only. **Radii:** 4, 6, 8, 12, 99px only (36px is the phone frame).
- **Controls:** design-system buttons are `sm` (32px) on desktop boards; `md` (44px) only on phone boards. App density: Comfortable (default) = 32px controls, Compact = 28px. Icon buttons 28px (24px in panel strips, 40px in the activity bar, 44px on touch); segmented controls 30px; switches 36×20.
- **Section headings:** 16/22 weight 650, sentence case, on content pages. Settings uses 11px uppercase group labels.
- **Terminal:** one design everywhere (board 5's panel, also used by 5b and 18): 6px resize sash on the top edge, 30px tab strip, kill ×, `+` with a location menu, Find / Split / Kill / More / Maximize / Hide icons, find widget on ⌘F, colours from the theme (no hard-coded dark).
- **Task page and workspace (adopted 2026-10-30, boards 25, 25b, 25c, 26):** a task is the only thing you navigate to. Every task title, everywhere, opens its task page (header, state actions, Overview: now card, cost, dispatch trace, acceptance). Work happens in the Workspace (26, opened by Open workspace, Take over or the rail's Workspace item): left, tasks with their sessions nested (collapsed: session icons in a row; expanded: rows in a column); middle, tabs of any kind (agent session following or driven, shell, file, diff) with + for a shell, a new agent session on the task or a file; right, the selected task (Overview, Changes, Notes). The open panel's details sit left of the top bar search and its actions, as icon buttons with tooltips, right of it. Open workspace is offered on the task page in every state, ended tasks included (their sessions open read-only). Every panel is resizable: 6px sash on the shared edge, arrow keys move 16px, double-click resets (workspace list 272px, 200–480; task panel 320px, 260–560; terminal height), sizes persist per window. Boards 4, 5b, 5d, 22 and 23 are retired.
- **Loading (board 27):** a page-shaped skeleton in `--surface-lane` blocks with a soft 1.4s pulse (none under reduced motion), shown only after 150ms, no spinner and no visible text; a reload keeps the content already on screen.
- **Terminal setting:** one setting, a select on Machines (Automatic plus detected terminals). App preferences has no Terminal row.
- **Assistant:** the floating pill is always shown while "Show the button" is on; with no account chosen it opens the setup card (board 6b). The app never picks an account itself.
- **Contrast and working controls win over a board value:** text ≥ 4.5:1 (UI-2); no control that cannot work (UI-13).
- **One data story** across boards: planner Claude Code 16% of week, pace 38%, Relaxed, resets Thu 14:00, strategy no-agy. Codex 81%, ahead of pace, so the next capable task goes to Antigravity (22%). Three items need you (a question on `ota: stale plan…`, a failed check on `runner-forge: GitHub App authentication`, a result to review on `Browser-validate the web app PWA build`). Two agents need attention (BytePlus no subscription, Cursor reading 113h old). One task running (`Make remote-support access mode opt-out`).

## Core flow (the clickable prototype)

Start at `Main.dc.html` (1 · Dispatch). Needs you (`NeedsYou`, 20) → Answer (`Answer`, 21) · the task page (`TaskPage`, 25 review; `TaskPageFailed`, 25c) → Accept / Retry → Tasks. Running tasks open `TaskPageRunning` (25b); Open workspace / Take over → `Workspace` (26). New task (`NewTask`, 3a) → Tasks. ⌘K (`CommandMenu`). Planner chip → Budget. Activity bar → Dispatch, Needs you, Tasks, Insights, Workspace, Settings. The tray (`Tray`, 19) links into the same screens.

## Editing with any agent

1. Edit the `.dc.html` files and `project/canvas.json` here. Follow the canvas type's `SKILL.md` ("Rules that bite") and `format.md`: keep the `<script src="./support.js"></script>` head line, close every element, quote every attribute, holes are lookups only (`{{a.b}}`, never expressions), no scripts that build UI.
2. To add a board: create `project/<Name>.dc.html`, then add a `boards` entry (`x`, `y`, `w`, `h`, `title`, plus `"expand":"fill"` for pages and `"is_interactive":true` for boards with links or handlers) and its name in `order`. Leave 80px between frames in a row and 120px between rows.
3. To check markup: any HTML parser should report every tag closed. There is no local renderer; the canvas runtime renders the boards.

## Publishing changes back to the live canvas

With Claude Code's Artifact tool (any session signed in to the owner's claude.ai account):

- `Artifact` publish with `url` = the live canvas link above, `root` = this folder, `file_path` = `<this folder>/project/canvas.json` (or one board), and `files` = `{"project/<Board>.dc.html": "project/<Board>.dc.html", …}` for every file you changed. Send `project/canvas.json` only when boards, notes or order changed, and read it from the live canvas first.
- A publish is refused if someone saved the canvas since: read the files it names, redo your edit on them, publish again.

Other agents without that tool can still edit here; hand the changed files to a Claude Code session to publish.

## Related working files (local only, untracked)

- Board-vs-app audit: `.work/reviews/2026-10-29-full-ui-audit.md`
- Design coherence review: `.work/reviews/2026-10-29-design-coherence-review.md`
- Per-screen design reviews: `.work/reviews/2026-10-29-w*-review.md`
- Integration notes: `.work/reviews/2026-10-29-integration-todo.md`
- An older copy used by reviewers: `.work/fixtures/boards/` (kept in sync; this folder is the one to resume from)
