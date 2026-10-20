# TUI redesign on the shared design system

Status: **Proposed — pending maintainer approval.** Requested by @lamtuanvu ("a proper TUI redesign for the entire app following our current design system").
Governance: constitution 0.4.0 (proposed amendment), rules UI-1–UI-25, ARCH-1/2/8, CT-1–CT-4, CT-7, CT-11, REPO-1–REPO-3, REPO-7, P1, P9.
Builds on: [design system](2026-10-19-design-system-beautiful-ui-design.md), [UI functionality](2026-10-16-ui-functionality-design.md), [UI implementation](2026-10-16-ui-implementation-design.md), [docs/design-system.md](../design-system.md), [ADR clients-over-local-service](../decisions/2026-10-16-clients-over-local-service.md).

## Problem

`pacer dashboard` grew screen by screen. It has one long scrolling board and a settings list, and it diverges from the app and the design system in ways that the UI rules name:

- Each attention row repeats its action buttons (`[⏎ run checks] [2 pause host]`), so the screen has one "primary" per row instead of one per region (UI-14).
- Colors are fixed SGR codes (`33`, `32`, `31`, `36`, `2`) that ignore the token palette, light terminals and 256/truecolor terminals (UI-1, UI-21 in spirit). `PACER_NO_ANIM` is documented (UI-4) but not read anywhere.
- Section names and order differ from the app ("WHO RUNS NEXT" before "RUNNING"; the app and the implementation spec use Needs you → Running → Capacity → Done today).
- Review and Sessions, two of the app's three work screens, have no terminal equivalent. Review verdicts need the app or the CLI.
- Settings reads `strategy.yaml` through `loadStrategy` and writes through CLI command modules (`src/commands/config.ts`, `src/commands/accounts.ts`) instead of the service API (ARCH-1). Project strategies, notifications and appearance are missing.
- `Enter` on a running row without a session stops the task with no confirmation.
- Setup steps hide behind single-letter keys (`s`, `c`, `e`, `t`, `k`) that collide with the normal keymap.
- The frame is redrawn with `ESC[2J` each tick, which flickers.

## Goals

1. **One design language.** The TUI renders the design system's tokens (color roles, type hierarchy, spacing scale, status tones and glyphs, iconography, motion) with terminal equivalents, and the shared status vocabulary from `src/view-model/` (UI-6, UI-10, UI-20).
2. **The app's information architecture.** The same screens, sections, copy, empty states and actions as the web app, where a terminal can reasonably provide them (functional parity; see [Coverage](#coverage)).
3. **Thin client.** All reads and writes go through the versioned API (`hello.ops`, `snapshot`, ops) and the shared view model. Interactive CLI wizards (account add, runner add) run as child CLI processes in the same terminal, never through imported command modules (ARCH-1, ARCH-8, P1).
4. **Accessible by default.** Status is never conveyed by color alone; `NO_COLOR`, light terminals, 16-color terminals, `PACER_NO_ANIM` and a plain screen-reader mode all work (UI-2, UI-4).
5. **Tested as frames.** Golden frames at 120×40 and 80×24, independent of the package version and the host terminal (CT-2–CT-4).

Non-goals: new service capabilities, protocol changes (none are needed), a terminal diff viewer, host detail management, the add-executor wizard UI, bulk review, and persisting TUI appearance choices. These are listed under [Coverage](#coverage).

## Token mapping

The TUI imports the authored `app/src/ds/tokens.json` (never the generated CSS/TS) in `src/dashboard/theme.ts`, so terminal colors follow the design system without a second copy. A test asserts that every terminal role resolves to an authored hex token in both appearances.

### Color roles

| Terminal role | Token (light / dark) | Truecolor | 256 | 16-color | `NO_COLOR` / plain |
| --- | --- | --- | --- | --- | --- |
| `ink` (body, names) | `ink` | exact hex | nearest xterm-256 | terminal default | none |
| `secondary` (supporting text) | `ink-secondary` | exact | nearest | default | none |
| `muted` (captions, times, headings, column labels) | `ink-muted` | exact | nearest | faint (`2`) | none |
| `line` (rules, box borders, meter track) | `line` | exact | nearest | faint | none |
| `good` | `good-fg` | exact | nearest | green (`32`) | glyph + label |
| `warn` | `warn-fg` | exact | nearest | yellow (`33`) | glyph + label |
| `bad` | `bad-fg` | exact | nearest | red (`31`) | glyph + label |
| `info` | `info-fg` | exact | nearest | cyan (`36`) | glyph + label |
| `accent` (brand mark only) | `track` | exact | nearest | default, bold | none |
| `focus` (active tab, focused pane title) | `focus` | exact | nearest | blue (`34`) | `[ ]` brackets / `›` marker |
| selection background | `surface-lane` | exact | nearest | reverse video (`7`) | `›` marker |
| agent identity | `agent-*` (Claude, Antigravity, BytePlus, Gemini) | exact | nearest | not used | name only |

Status roles use the pill text tokens (`*-fg`) because the terminal background is the page surface and those tokens already meet 4.5:1 there (UI-2). The brand accent never marks a status, exactly as `track` is defined in tokens.json.

### Detection

`detectTheme(env, isTTY, {plain})` runs once at start-up; frames receive an explicit theme, so tests never depend on the host terminal.

| Setting | Order of precedence |
| --- | --- |
| Color depth | `--plain` / `PACER_PLAIN=1` → none; `NO_COLOR` (any value) → none; `PACER_COLOR=none\|16\|256\|truecolor`; `FORCE_COLOR` (0–3); not a TTY or `TERM=dumb` → none; `COLORTERM=truecolor\|24bit`; `TERM` contains `256`; else 16 |
| Appearance (truecolor/256 only) | `PACER_THEME=light\|dark`; `COLORFGBG` background 7 or 15 → light; else dark. 16-color mode uses the terminal's own palette, so it follows the terminal's scheme automatically |
| Glyphs | `PACER_ASCII=1` or a non-UTF-8 `LC_ALL`/`LC_CTYPE`/`LANG` → ASCII; else Unicode |
| Motion | `PACER_NO_ANIM` or plain mode → none |

### Type hierarchy

A terminal has one font size, so hierarchy comes from weight, case, color and position, mapped from the type tokens:

| Design token | Terminal treatment |
| --- | --- |
| `display` (page title, once per screen, UI-9) | The active tab in the top bar: bold, `focus` color, bracketed `[ Home ]`. No other title repeats it. |
| `wordmark` | `▬┃ pacer` mark at the top left; the bar uses `ink`, the tick uses `accent`. |
| `headline` | Bold `ink`: the planner answer and the title of an open detail. |
| `label` (section heading, `pc-section-heading`) | UPPERCASE, `muted`, bold, followed by its count in bold `ink` ("NEEDS YOU  4"). One style for every section on every screen. |
| `body` / `body-strong` | `ink` / bold `ink` for names in list rows. |
| `caption` | `muted`: times, repo labels, column headers, footer hints. |
| `mono` | Everything is monospace. Ids, paths and commands are never wrapped; they are clipped at the end with `…` and shown in full in the detail pane (UI-11). |
| `number-lg` | Planner used percentage in bold. Numbers in columns are right-aligned for tabular alignment (UI-16). |

### Spacing and containment

One cell ≈ 8 px horizontally, one line ≈ 19 px (`body` line height). The scale maps to cells and lines:

| Token | Terminal |
| --- | --- |
| `space-1`, `space-1.5` | 1 column between a glyph and its label |
| `space-2`, `space-3` | 2 columns between table columns; row padding is the 2-column selection gutter |
| `space-4` | 2-column page gutter left and right |
| `space-5`, `space-8` | 1 blank line between sections |
| `radius-lg` (cards) | Rounded box corners `╭╮╰╯` (ASCII `+`); every box is closed on all sides (UI-16) |
| max content width | Content is capped at 160 columns and left-aligned; wider terminals add margin rather than stretching columns |

### Status vocabulary and iconography

Every status comes from `src/view-model/words.ts` (`taskStatus`, `attentionStatus`, `executorStatus`, `paceStatus`, `sessionStatus`) and is drawn as **glyph + label**, colored by its tone. The same fact uses the same glyph, label and tone on every screen and in list and detail (UI-10). In ASCII mode the glyphs map to `+ x > ~ = ! o ? v ^ *`; plain mode drops glyphs and keeps labels.

Icons from the app rail become labelled tabs with number keys. Agent marks become a colored `●` before the executor name in truecolor/256 (agent tokens), and the name alone otherwise. The usage meter (`UsageMeter`) becomes `━━━━━━┃──────`: fill colored by the authoritative pace tone (never derived from numbers), track in `line`, pace tick in bold `ink`; ASCII `[####|----]`.

### Motion

The only animation is a spinner on loading states and busy actions (`⠋⠙⠹…`, every 120 ms, matching `motion-loading` pacing). With `PACER_NO_ANIM` or plain mode it is the static text "Loading…"/"Working…". The live dot never blinks.

## Layout grid

```
row 0          top bar: mark · tabs (with counts) · scope · mode · live/time
row 1          planner strip (every screen, as the app's TopBar)
row 2          rule (line)
rows 3..h-3    screen body: section headings, tables, panes, dialogs overlay here
row h-2        message line (result of the last action, 5 s) or prompt
row h-1        key bar for the current selection · version and update state
```

- Body width = terminal width − 4 (2-column gutters), capped at 160.
- **Wide (≥ 110 columns):** Review, Sessions and Settings are two-pane (list | detail). Home is one column.
- **Narrow (< 110 columns):** one pane; Enter or `→` drills into the detail and `Esc`/`←` returns. Columns drop in a fixed priority order (time, then repo, then detail text) so names keep their room. The planner strip keeps meter and verdict.
- **Too small (< 60×16):** a single centered line "Make the terminal at least 60×16 to use pacer dashboard. q quits." The process stays usable.
- The selected row stays visible; lists scroll and show `↑ 3 more` / `↓ 5 more` in `muted` at the cut.

## Navigation model and keyboard map

Screens are tabs, in app rail order: **1 Home, 2 Review, 3 Sessions, 4 Settings**, plus **5 Setup** while the setup checklist is not ready. When setup is incomplete, Home, Review and Sessions show the Setup screen, as the app redirects work routes to `#/setup`; Settings stays reachable.

| Scope | Keys |
| --- | --- |
| Anywhere | `1`–`5` screens · `Tab`/`Shift-Tab` next/previous screen · `,` Settings · `?` keyboard help · `d` delegate · `f` cycle repo scope (All repos → each repo) · `R` or `Ctrl-R` refresh · `q` quit · `Esc` close dialog / go back · `Ctrl-C` quit |
| Lists | `↑`/`↓` or `k`/`j` select · `PgUp`/`PgDn` page · `Enter` the region's primary action · `.` all actions for the selected row (numbered menu) |
| Home | `x` dismiss (when offered) · `v` open in Review · `b` block/unblock the selected executor |
| Review | `j`/`k` next/previous · `Enter`/`→` open detail (narrow) · `a` accept (confirm) · `s` send back (note) · `r` reject (note) · `t` retry on… · `o` show worktree path |
| Sessions | `Enter` watch here · `t` open in a terminal window · `m` tmux pane · `s` stop (confirm) · `→` detail (narrow) |
| Settings | `↑`/`↓` sections · `Enter`/`→` into a section · `Esc`/`←` back · `Enter` primary change · `←`/`→` adjust numbers and choices · section keys in the key bar (`a` add, `x` remove, `[`/`]` reorder, `b` block, `t` check, `e` enable, `n` new, `u` update, `p` pause host) |
| Dialogs | `y`/`Enter` confirm · `n`/`Esc` cancel · menus: `1`–`9` or `↑`/`↓` + `Enter` |

Rationale for departures from the old TUI and the app:

- **Number keys switch screens.** The old `1`–`9` inline row actions move to the `.` actions menu, so each row has one visible primary (`Enter`) and the key bar names it once (UI-14). The app's `g o`/`g r`/`g s` chords are not needed with tabs.
- **Refresh is `R`** because Review's `r` means reject in the app; refresh is rarely needed (events plus a 2 s poll).
- **`f` filters by repo** because numbers select screens; the app uses `1`–`4` for repo chips.
- **Destructive actions confirm** (`stop`, `remove`, `update`, `accept`), and `Enter` on a running row never stops a task.
- **Setup is a screen of rows** with `Enter` running each step after consent, instead of hidden single-letter keys.

The key bar always shows the selected row's primary action first, then up to four other available keys, then `? help`. Keys for unavailable operations (absent from `hello.ops`) are not shown and do nothing (UI-13).

## Screens

Mockups are at 120×40 and 80×24 with `NO_COLOR`. The golden tests render the same frames from `test/fixtures/ui/snapshot.json`.

### Home (app: Overview)

Data: `snapshot` only, through `needsYou`, `running`, `capacity`, `doneToday`, `counts`, `plannerMeter` and `today` with the selected repo scope. Order and copy follow the app.

```
 ▬┃ pacer  [ Home ]  Review 2  Sessions 2  Settings                               All repos · Normal · ● live 08:00
 Claude planner  ━━━━━━━━━━━━━┃━━━━━━───────  63% used · pace 77%  ↓ Behind pace  14 pts under pace — spend it  10 active-h
 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  NEEDS YOU  4
 › ✕ Unavailable        buildbox is not answering                      ssh failed twice · last answered 40m ago   07:40
   ✕ Failed             Retry budget refresh on 429           acme/api  Failed twice on Antigravity · test timed…   07:50
   ◐ Waiting for review Fix flaky retry test in the payments…  acme/api  Tests passed · 11:58                         07:30
   ◐ Waiting for review Add dark mode to the web header       acme/web  Tests passed · 12:13                         07:45

  RUNNING  2 · 1 queued
   ▶ Editing            Add SSH keepalive to remote runs      acme/api  Codex · team on devbox  running 14m  6 files · 2 commits  output 8s ago
   … Idle               Split the settings page into sections acme/web  Claude Code   running 40m  3 files · 0 commits  idle 6m
   … Queued             Document the token sync               pacer     Antigravity   Waiting: this executor is running 1 of 1

  CAPACITY  2/4 executors ready
   P ● Claude Code            ▶ Busy           On pace · planner             ━━━━━━━━┃━━──  63%  1/1
   1 ● Codex · team on devbox ✓ Ready  next    Behind pace · on pace · this… ━──┃────────   3%  1/3
   …
  DONE TODAY  7 · 6 accepted
   07:30  ◐ Waiting for review  Fix flaky retry test in the payments client   acme/api   Codex · team on devbox  ran 50m
   …
 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ⏎ Run checks · . more actions (1) · x dismiss · ? help                                           pacer 0.3.1 · up to date
```

- Needs you: glyph + label from `attentionStatus`, full title (`fullTitle` → `title`), repo label, the service's detail, raised time. The **primary is the service's first action**, exactly like the app; other actions are in the `.` menu. `x` dismisses through `attention.dismiss` when offered; `v` opens a review item in Review. `ui.open` actions navigate inside the TUI (review → Review, task/session → Sessions, settings → Settings section).
- Running: `taskStatus`/`sessionStatus` glyph and label, title, repo, executor label, `running for …` or `queueWait`, changes, `output 8s ago` or `idle 6m` (warn). Primary: **Watch** when a session is attachable, otherwise **Open in Sessions**. Stop is in the actions menu and confirms.
- Capacity: rank (`P` for the planner), agent dot, executor label, `executorStatus`, `next` tag, `executorPace` label and reason, meter, used %, slots. Unavailable rows are `muted` and keep their reason. Primary: **Open in Settings › Executors**; `b` blocks/unblocks.
- Done today: time (UI-17 `clock`), `taskStatus` (an unreviewed result is **Waiting for review**, never ✓), title, repo, executor, "ran 22m".
- Empty states use the app copy: "Nothing needs you.", "Nothing running. Delegate a task, or ask your planner to.", "No executors yet. Add one in Settings › Executors.", "Nothing finished yet today."
- When scoped to a repo, the heading adds "+2 in other repos" (`otherReposNeedingYou`). Budgets stay global; the scope line reads "acme/api · budgets are shared across repos".

At 80×24 the planner strip keeps the meter and verdict; Needs you drops the time and repo columns; Running shows status, title and output; Capacity shows rank, name, status, used %, slots.

```
 ▬┃ pacer [Home] Review 2  Sessions 2  Settings              Normal · ● 08:00
 Claude  ━━━━━━━━┃━━───  63% · pace 77%  ↓ Behind pace
 ──────────────────────────────────────────────────────────────────────────────
  NEEDS YOU  4
 › ✕ Unavailable   buildbox is not answering   ssh failed twice · last answe…
   ✕ Failed        Retry budget refresh on 429  Failed twice on Antigravity …
   …
 ⏎ Run checks · . actions · ? help                          pacer 0.3.1
```

### Review

Data: `reviewQueue` (attention items of kind `review`, oldest first, scoped by repo); the selected item's `task.get` (cached by id and `rev`); verdicts through `task.review {id, verdict, note?, kind?, executor?, expect_rev}`. A `conflict` error shows "Another client already reviewed this task." and refreshes.

```
 ▬┃ pacer   Home  [ Review ]  Sessions 2  Settings                                    All repos · Normal · ● live 08:00
 Claude planner  …
 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  REVIEW QUEUE  2                          │ Fix flaky retry test in the payments client
 › ◐ Fix flaky retry test in the paym…  07:30│ ◐ Waiting for review · Codex · team on devbox · ran 50m · pacer/review → main
   ◐ Add dark mode to the web header    07:45│ acme/api · finished 07:30
                                           │ ╭ Done when ───────────────────────────────╮ ╭ Why Codex ─────────────────────╮
  Accepted today 6 · rejected 1.           │ │ bun test                                 │ │ Best available capacity       │
  Your verdicts teach routing which        │ │ ✓ Tests passed · 38 passed · checks ran… │ │ Skipped other: Quota budget…  │
  executor suits which kind.               │ ╰──────────────────────────────────────────╯ ╰───────────────────────────────╯
                                           │ CHANGES  1 file · +3 −1
                                           │  M src/example.ts                                                    +3  −1
                                           │ EXECUTOR SUMMARY
                                           │  Implemented and verified the change.
                                           │ ╭ Your verdict ─────────────────────────────────────────────────────────────╮
                                           │ │ a Accept and bring back   s Send back   r Reject   t Retry on…            │
                                           │ │ Accept records the verdict; you merge the branch.                        │
                                           │ ╰──────────────────────────────────────────────────────────────────────────╯
 a Accept and bring back · s send back · r reject · t retry on · ? help                         pacer 0.3.1 · up to date
```

- Accept asks `Accept "<title>"? Records the verdict; you merge the branch. (y/n)`. Send back and Reject open a required note prompt ("Add a note first." when empty). Retry lists `retryOptions` with state `ready` only; others are shown with their reason and cannot be chosen (UI-13).
- After a verdict the message reads "Accepted · next: <title>" or "Accepted · review queue is clear", as in the app.
- States: "Loading task…" (spinner unless no motion), "Review queue is clear" + today's counts, "Already reviewed", removed worktree "Changes unavailable · the worktree was removed after the task finished".
- Narrow: the queue fills the screen; `Enter` opens the detail full-screen with the same key bar; `Esc` returns.

### Sessions

Data: `running(scope)` and recently ended tasks (not dismissed, not active, newest first) from the snapshot; the selected task's `task.get` for timeline, done-when and brief goal; `task.session`/`task.attach` for watching (existing viewer flow).

```
  RUNNING  2                                          │ Add SSH keepalive to remote runs
 › ▶ Editing  Add SSH keepalive to remote runs  14m   │ ▶ Editing · Codex · team on devbox · acme/api · started 07:46
   … Idle     Split the settings page into se…  40m   │ 6 files · 2 commits · output 8s ago
                                                      │ WATCH
  RECENTLY ENDED  5                                   │  ⏎ here · t terminal window · m tmux pane · pacer attach t-0420
   ◐ Waiting for review  Fix flaky retry test…  07:30 │ DONE WHEN
   ✕ Failed              Retry budget refresh…  07:50 │  bun test test/retry.test.ts
                                                      │ TIMELINE
                                                      │  07:46 Executor selected
                                                      │  07:47 Working copy created
```

- Primary: **Watch** (attach here) when the session host is attachable and `task.attach` is offered; otherwise **Show details**. `s` Stop confirms "Stop this session and its executor? (y/n)" and sends `task.stop {id, expect_rev}`.
- Empty states: "No running sessions.", "No recently ended sessions." Timeline uses `timelineCopy`; raw lines are never shown (UI-12).

### Settings

Two panes: sections on the left (24 columns), the section on the right. Sections follow the app's order, with Project strategies listed separately (it is a card inside Routing in the app) and Remote hosts kept as a summary.

| Section | Reads | Rows and changes |
| --- | --- | --- |
| Planner & pacing | `config.get`, `snapshot.planner` | Planner (choose → `agent.preview` consent → `config.set planner` with `integrations: install` or `skip`); Policy (Priority / Even / Burn before reset / Cheapest first, `←`/`→`); Planner reserve 0–50 step 5; Multiple accounts Spread/Fill; Fill threshold 50–100 (only in Fill) |
| Accounts | `account.list` + `snapshot.accounts` | Name, kind, source, usage "63% of week · resets Sat 12:00", sign-in, used by. `Enter` Fix sign-in → `account.signin {name}`; `x` remove → `account.remove` (locked rows show their reason and no remove); `a` Add account / `l` Link Orca account → hands the terminal to `pacer account add [--orca]` |
| Executors | `snapshot.executors` | Rank, label, id, status, model, runs on, parallel tasks, last check, enabled. `e` enable/disable → `runner.set {enabled}`; `b` block/unblock; `t` run check → `runner.check`; `[`/`]` reorder → `runner.reorder`; `x` remove → `runner.remove` (planner locked); `a` add → hands the terminal to `pacer runner add` |
| This machine | `config.get` | Parallel tasks on this machine 1–16 → `config.set execution.local_max_tasks` |
| Remote hosts | `snapshot.hosts` | Alias, ssh, checks, "1 / 3 busy", executors, repos. `Enter` run checks → `host.check`; `p` pause/resume → `host.set {paused}` |
| Routing | `routing.get` | "Rule 1 · tests, docs → codex, cursor", "Everything else → …". `Enter` edit executor order; `n` add rule (before the catch-all); `x` remove rule → `routing.set` |
| Project strategies | `project.strategy.list`, `snapshot.repos` | "acme/api → codex, cursor" or "Using global strategy". `Enter` edit order → `project.strategy.set {repo, executors, expect_rev}`; `x` use global → `project.strategy.remove`; conflict copy from the app |
| Strategies | `strategy.list` | Name, summary, Active / `Enter` Use → `strategy.use`; `n` New from a brief → `strategy.build {brief}` |
| Updates & plugin | `update.check` | "Version 0.3.1 · Up to date"; `Enter` Check now (`force`); `u` Update and restart (confirm) → `update.apply`; daily check on/off → `config.set update_check`; Install Orca panel → `plugin.install` |
| Notifications | `notifications.get` | Off / Important / All → `notifications.set` |
| Appearance | terminal detection | Color (truecolor/256/16/none), theme (dark/light), glyphs, motion, plain mode. `Enter` cycles System/Light/Dark **for this session**; the environment variables that persist each choice are listed |

Every row states a disabled reason instead of offering an action that cannot work (UI-13): "Planner — can't remove", "In use by 2 executors", "Not offered by this pacer service". Results report "Saved." plus the service's undo command when it returns one. Section loads show "Loading…"; errors show the code's message and hint with "R retries".

Narrow: the section list fills the screen; `Enter` opens a section; `Esc` returns.

### Setup

Shown instead of Home/Review/Sessions while `setup.complete` is false, and as tab 5 while `setup.ready` is false. Copy follows the app: "pacer works once the required steps are done. The rest makes it useful.", sections REQUIRED and RECOMMENDED, rows "✓ Done", "✕ Failed", "! Needs you". The first open required step is the primary. Actions: Install service (consent dialog), Connect planner (`agent.preview` files and undo, consent), Add executor (hands the terminal to `pacer runner add`), Try a delegation (`onboarding.try`), Skip (`onboarding.skip`), Copy-only steps show their command.

### Dialogs, help and delegate

- **Confirm**: a closed box centered in the body with the question, consequences and `y confirm · n cancel`.
- **Prompt**: a closed box with a label, an input line, help, and validation errors in `bad` with a glyph.
- **Actions menu** (`.`): numbered actions for the selected row; unavailable ones are omitted.
- **Help** (`?`): grouped like the app's CommandHelp ("Anywhere", the current screen), listing only keys whose operations are offered.
- **Delegate** (`d`): Goal → Repo (defaults to the current repo or scope) → Work type (optional, from the app's kind list); `task.delegate {…, source: "ui"}`; the result reads "Delegated · <task id> queued".

### Loading, empty and error states

| State | Treatment |
| --- | --- |
| First connection | Body: spinner + "Connecting to pacer…"; header shows "○ connecting". |
| Service unavailable | The existing in-process fallback continues; the message line reads "! pacer serve unavailable; working locally" (warn) and the header shows "○ local". |
| Stale data | Header "○ updated 07:58" when the last snapshot is older than 30 s. |
| Section/detail loading | "Loading task…", "Loading…" with spinner unless motion is off; previous content stays visible while refreshing ("Updating…"). |
| Errors | `✕ <message> (<hint>)` in `bad` on the message line for 5 s; detail panes keep an inline error with "R retries". `forbidden` errors (for example the live-validation guard) are shown verbatim. |
| Empty | App copy for each section (above). |

## Accessibility

- **No color-only meaning.** Every status has a glyph and a label; selection has a `›` marker; the active tab has brackets; warnings on output staleness say "idle 6m"; meters print "63% used · pace 77%". Golden `NO_COLOR` frames prove the meaning is still present.
- **Plain mode** (`pacer dashboard --plain`, `PACER_PLAIN=1`): no color, ASCII only, no box borders (sections and dialogs use headings), labels before values, no spinner. It suits screen readers that read the terminal buffer line by line.
- **One-shot output** (`pacer dashboard --once [--screen home|review|sessions|settings] [--width N]`): prints one plain frame to stdout and exits; it works without a TTY and is suitable for screen readers, scripts and bug reports.
- **Reduced motion:** `PACER_NO_ANIM` and plain mode freeze spinners.
- **Contrast:** token pairs from the design system; 16-color mode relies on the user's terminal palette.
- **Untrusted text** (titles, details, reasons) is stripped of control characters before layout, so it cannot inject escapes.
- **Keyboard only** by nature; every action has a key, listed in the key bar or in `?` help.

## Architecture

```
src/dashboard/
  theme.ts       design tokens → terminal roles, depth/appearance/glyph/motion detection
  frame.ts       cells, spans, clipping, columns, boxes, meters, painting (pure)
  state.ts       navigation, selection, overlays, key → intent (pure)
  screens/       shell, home, review, sessions, settings, setup (pure: snapshot + state + data → lines)
  settings.ts    settings data and mutations through the ApiClient
  data.ts        refresh, fallback client, action runner, attach (existing)
  cli.ts         terminal I/O loop; flicker-free redraw; child-CLI handoff
```

- Pure renderers take `(snapshot, view state, fetched data, theme, now, width, height)` and return a string, so goldens are deterministic.
- Settings no longer imports `src/config/*` or `src/commands/*`; every read and write is an API op. Account add, Orca link and runner add hand the terminal to the CLI (`pacer account add`, `pacer runner add`) and resume, so the TUI never imports CLI command modules (ARCH-1). The guarded live harness and D8 proxy therefore see every settings change.
- Ops are gated by `hello.ops`. No protocol change is needed; the TUI uses existing ops only.

## Testing

- `test/dashboard-theme.test.ts`: token resolution for every role in both appearances; detection precedence; 16/256 fallbacks; `NO_COLOR` emits no escapes.
- `test/dashboard-frame.test.ts`: wide characters, clipping, sanitization, closed boxes, meters, painting.
- `test/dashboard-state.test.ts`: keymap, tab switching, selection bounds, overlays, gating by ops.
- Golden frames (`test/__snapshots__/dashboard-screens.test.ts.snap`): each screen at 120×40 and 80×24 with `NO_COLOR`, one truecolor frame per screen, plain mode and ASCII. Frames pass an explicit version string (`0.0.0-test`) and time, so goldens are independent of the package version and the clock.
- Settings controller tests run against the in-process API client on a temporary `PACER_HOME`.
- Cross-surface status tests (`test/dashboard-panel-semantics.test.ts`) keep TUI and Orca panel glyph/label/tone parity.
- Live validation (CT-11): `bun run live up --seed ui`, drive every screen in tmux at 120×40, capture each into evidence, and record verdicts.

## Coverage

| App surface | TUI | Notes |
| --- | --- | --- |
| Overview: Needs you, Running, Capacity, Done today, repo scope, planner strip | Covered | |
| Overview: Quick delegate | Covered as `d` dialog | No live routing preview |
| Overview: Activity | Deferred | Needs `activity.list` paging UI |
| Review queue, detail, verdicts, retry | Covered | |
| Review diff viewer, bulk review, kind correction | Deferred | File list with +/− only; `pacer review <id>` shows the diff |
| Sessions list, detail, timeline, watch, stop | Covered | |
| Sessions takeover | Deferred | Watching here already hands over the terminal |
| Settings: all sections listed above | Covered | Planner change uses consent dialog |
| Settings: host detail (repo map/setup, account folders, worktree clean-up, SSH terminal, add host), executor model/parallel edits, add-executor wizard | Deferred | `pacer open settings/hosts` or the CLI |
| Setup checklist | Covered | |
| Appearance persistence | Deferred | Session-only; env vars persist |

## Decisions (proposed)

| ID | Decision |
| --- | --- |
| TD-1 | The TUI reads `tokens.json` directly; no terminal token group is added to the design system. |
| TD-2 | Number keys switch screens; row secondary actions move to the `.` menu (UI-14). |
| TD-3 | Refresh moves from `r` to `R`/`Ctrl-R`; Review's `r` is reject, as in the app. |
| TD-4 | Setup becomes a screen with rows instead of single-letter keys. |
| TD-5 | Settings reads and writes only through API ops; interactive account/runner wizards run as child CLI processes. |
| TD-6 | Destructive actions confirm; `Enter` never stops a task. |
| TD-7 | `--plain` and `--once` are added to `pacer dashboard` for screen readers and scripting. |

## Open questions

1. Should the design system gain a `terminal` token group (the implementation spec mentions one) so the TUI and the session terminal share an ANSI palette, instead of TD-1?
2. Should TUI appearance (theme, color depth) persist, for example in `PACER_HOME/settings.json` beside notifications, or stay environment-only?
3. Is `R` for refresh acceptable, or should Review use a different reject key and keep `r` as refresh?
4. Should Project strategies stay a separate Settings section in the TUI, or nest under Routing as in the app?
5. Should Home add an Activity column on very wide terminals (≥ 160 columns)?
