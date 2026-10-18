# Service functionality for the redesigned UI

> Historical context: protocol 3.0 retired the v1 Orca link, storage bridge, channel sends, console command lines and unversioned read routes on 2026-10-18. The owner waived the release gate; `/v2` remains for one more pacer minor release. See [current protocol](../protocol.md).

Status: proposed 2026-10-16.
Source: the 2026-10-16 redesign on the "Pacer Dashboard Redesign" Design canvas
(the clickable prototype `App.dc.html` and its boards: Overview, Review, Session,
Settings, Remote hosts, Add an executor, Orca panel, TUI, TUI settings, status
line, tray, notifications).
Builds on:
[clients over one local service](../decisions/2026-10-16-clients-over-local-service.md),
[core contract](2026-10-14-core-contract-design.md),
[pacer app](2026-10-15-pacer-app-design.md),
[live sessions](2026-10-16-live-sessions-design.md),
[remote runners](2026-10-14-remote-runners-design.md) and
[docs/protocol.md](../protocol.md).
Companion: `docs/specs/2026-10-16-ui-implementation-design.md` (front end). This
document owns the service API; that one owns how the screens are built.

## Why

The redesign puts the decisions first. Every surface (web app, Orca panel, TUI,
status line, tray, notifications, an optional desktop app) opens on the same
order: **Needs you**, **Review**, **Running**, **Capacity**, **Done today**,
with an **All repos / this repo** filter and settings behind a gear. The
clients-over-local-service decision says every surface is a thin client of the
v2 API and no surface gets behaviour the API lacks.

Today the v2 API can delegate, list, diff, review, retry, stop and dismiss tasks,
and edit most settings. It cannot answer the questions the new screens ask
first:

- What needs me right now, in which repo, and what should I press?
- How many reviews are waiting, across every repo?
- Which executors have a free slot, and who runs next?
- What did pacer do today?

Each surface would otherwise work these out from raw tasks and budget lines, in
three languages (TypeScript web app, the Orca panel worker, the TUI), and get
them subtly different. This design moves those answers into the service.

## Goals

- One snapshot and one event stream give every surface what it needs to draw
  its first screen, with no follow-up calls.
- "Needs you" is a service concept: raised, cleared and acknowledged in one
  place, and the only thing that drives notifications and badges.
- Every button on the canvas maps to one operation. Clients never compose
  several mutations to do one thing.
- Nothing assumes Claude Code, Orca or any particular planner (D7).
- Safe with several clients open at once (D3).
- Every change is additive to protocol 2.x until a planned 3.0.

## Non-goals

- How the screens are built, laid out or themed (the implementation spec).
- The live-session byte protocol. It is in the live-sessions spec; this
  document only references `task.session`, `task.attach` and the WebSocket.
- Planner-side behaviour: how a planner writes briefs, or hooks inside
  Claude Code, Codex, Cursor or OpenCode.
- Remote access from another machine. The API stays on 127.0.0.1.
- Multi-user. One OS user, one pacer home.

## Anti-goals

- A client that computes routing, pace or "who's next" itself. If two surfaces
  can disagree about what to press, the design has failed.
- Notifications for things that need no decision ("started", "budget
  refreshed"). The notifications board says these live in the activity log.
- A UI that can do something the CLI cannot (D6).
- Running free text in a shell from an API call (existing rule in
  `docs/protocol.md`).

## What the screens show and do

Inventory from the canvas. "Have" means a v2 operation or snapshot field exists
today; "Partial" means it exists but lacks a field or variant; "New" means
nothing exists.

### Header and rail (every app screen)

| Shows or does | Status |
| --- | --- |
| Planner mark and name (any planner), used %, pace tick, "14 pts under pace — spend it", active hours left, reset time | Partial: `budget.providers` has used/pace/reset for the planner line; no planner-agnostic advice text or active hours |
| Mode pill (Strict, Normal, Relaxed) | Have: `snapshot.mode` |
| Live dot with last refresh time; "3 consoles: acme/api, acme/web, pacer" | Partial: `snapshot.at`, `consoles[]` (Orca only, no repo label) |
| Rail badges: Overview "3 need you", Review "2 waiting", Sessions "2 running" | New: counts |
| Gear warning dot when setup needs attention; per-section badges ("Remote hosts 1 needs setup", "Executors 1 down") | Partial: `setup.check` exists; no per-section summary |
| Delegate button | Have: `task.delegate` |
| Version in the footer | Have: `version.get` |

### Overview (Main), Orca panel, TUI dashboard

| Shows or does | Status |
| --- | --- |
| Repo chips "All repos / acme/api / acme/web / pacer" with counts; panel's "This repo · acme/api" and "+1 in other repos" | New: tasks carry no repo identity in the snapshot |
| Needs you rows: mark, goal, repo, detail ("Failed twice on Antigravity · test timed out after 120 s"), a primary and a secondary action ("Retry on Codex" / "See error", "Review" / "Accept"); `x` dismiss | New: derived item with actions |
| Running rows: agent, goal, repo, phase pill, elapsed, "6 files · 2 commits", "output 8s ago" / "idle 6m" (amber), Watch or Stop; queued rows "waiting for a slot" | Partial: `TaskData.progress` has phase, files, commits, lastOutputAt; no queue reason, no repo |
| Done today: goal, repo, executor, accepted/rejected pill, time, duration; "7 · 6 accepted"; "All tasks" link | Partial: tasks capped at 20 in the snapshot; no "today" window or counts |
| Capacity: per executor mark, name, "on pace · this Mac + devbox", used %, pace %, slots "2/3", state dot (ready, busy, failing, down), "next in line first", "next: Codex", "4/5 executors ready" | Partial: `budget.providers` + `ranked`; no slots, no recent failures, no host list per account |
| "Budgets are shared across repos; the filter only narrows work." | Client text |
| Quick delegate: goal text, repo/branch picker ("acme/api · main"), "Goes to Codex now (next in line)" | Partial: `task.delegate`, `routing.route`; no repo list |
| Activity: time, dot, text ("Mode Normal → Relaxed · planner behind pace") | New: outbox keeps 200 entries and is not meant for reading |
| Panel footer: "Delegate from this worktree" | Have: `task.delegate { worktree: "current" }` |

### Review

| Shows or does | Status |
| --- | --- |
| Queue across repos: goal, agent, "tests passed · 11:58" / "failed twice" | New: review queue |
| Title, acceptance pill, executor id with host, duration, branch → base, repo, finished time | Partial: `task.get` |
| Done when: the acceptance command, "✓ 38 passed · 41 s · run by pacer on devbox" | Partial: `Verification.acceptance` has cmd, passed, tail; no duration, count or machine |
| Why this executor: kind, routing rule, pace and slot reasons, what was skipped | New: routing explanation at delegate time |
| Cost: executor account +1.2% of week; planner 0.4% for the brief | New |
| Brief from the planner; executor's summary | Partial: brief stored; summary is `report` |
| Changes: file list with +/−, unified diff, "Open in editor" | Partial: `task.diff` returns text, no per-file stats |
| Accept and bring back; Send back; Reject; Retry on (with availability); Kind correction; Note | Partial: `task.review { accepted, kind, note }`, `task.retry { executor }`; no send back |
| "Accepted today 6 · rejected 1" | New: counts |

### Session (watch)

Covered by the live-sessions spec (`task.session`, `task.attach`,
`/v2/tasks/<id>/session`). This design adds the pieces around the terminal:
the timeline ("Routed to Codex · on pace, free slot", "Worktree created from
main", "Commit 3f2a91c", "Testing"), "Changes so far · 6", "Stop and retry on"
and the viewer count in the header. Status: timeline New; the rest Have.

### Settings (General)

| Section | Shows or does | Status |
| --- | --- | --- |
| Planner & pacing | Planner choice (any runner that can plan), policy (priority, even, burn before reset, cheapest first), planner reserve, multiple accounts (spread or fill at N%) | Have: `config.get/set` keys |
| Accounts | Name, kind, source, usage, sign-in state, used by, Remove (locked with reason) / Fix sign-in; Link Orca account; Add account | Partial: `account.*`; no "locked because" reason, sign-in needs a terminal |
| Executors | Rank, name, id, model, runs on, last check, enabled switch, Remove; drag to reorder; planner row locked | Partial: `runner.*`; no enabled flag separate from block, no model edit, no last check, reorder via `config.set pacing.order` |
| Remote hosts | Checks "8/8 pass", slots "1 / 2 busy", executors, repos | Partial: `host.list`, `host.check` |
| Routing | Rules: kinds → ordered executors; Add rule; Edit | Have: `routing.get/set` |
| Strategies | Name, summary, Active / Use; New from a brief | Have, except "New from a brief" needs a terminal (`strategy-build`) |
| Updates & plugin | Version, last check, Check now, daily check, notification level | Have: `update.*`, `notifications.*` (tied to the Orca plugin today) |

### Remote hosts (HostDetail)

| Shows or does | Status |
| --- | --- |
| Host list with one-line state | Partial: `host.list` |
| Add host: name, SSH alias picked from `~/.ssh/config`, Connect and check | Partial: `host.add`; no alias suggestions |
| Header: Ready, checked/reachable times, OS, git, setsid, agent versions; Run checks; Open SSH terminal; Pause new work | Partial: `host.check`; no pause, no terminal |
| Slots running/max; executors here; done this week / accepted; worktrees to clean | New: per-host summary |
| Checks list with details | Partial: `host.check` |
| Capacity: max parallel tasks 1–16 | Partial: `max_tasks` is enforced at routing time; there is no op to change it |
| Repositories: key, checkout path, origin match, identity match; Map a repo; Set up (clone); Fix identity | Partial: CLI `pacer host setup`; no v2 op |
| Account folders on host: name, home, logged in | Partial: config only |
| Worktrees on host: branch, state, fate (will remove, in use, kept); Clean up | Partial: CLI `pacer host clean`; no v2 op |
| Remove host (refused while an executor uses it) | Have: `host.remove` |

### Add an executor (four steps)

| Step | Shows or does | Status |
| --- | --- | --- |
| Agent | Each agent with "Found 0.52" / "Not installed" on this Mac | New: agent detection op |
| Account | Accounts of that agent with usage; New account: Sign in (opens the agent's login in a new terminal), Link from Orca, API endpoint (base URL, usage, quota source) | Partial: `account.add`, `account.adopt`; sign-in needs a terminal |
| Where | This Mac or a host (reachable, agent found); New host; Test connection | Partial: `host.check` |
| Model and checks | Model, priority position, task kinds; checks CLI found, signed in, usage readable, test task running; "is ready" | New: executor test run; `runner.add` has no priority or kinds |

### Glance surfaces

| Surface | Needs | Status |
| --- | --- | --- |
| Status line | Planner name and colour, used, pace, running count, needs-you count, mode when not normal, ahead/out states with "back Mon 09:00", offline hint; `--json` | Partial: no counts |
| Tray | Planner meter, needs you (two with actions), running, Delegate a task…, Open pacer, Switch strategy, Pause delegation for 1 hour, Quit | New: pause delegation |
| Notifications | Failed, ready to review, stuck, host down, planner ahead of pace; each with two actions ("Retry on Codex", "Keep normal", "Pause host"); levels Important / All / Never | Partial: alerts exist, delivered by the Orca plugin only |

## Design

### 1. One read model: snapshot plus events

Clients keep the existing pattern: `GET /v2/snapshot` (or JSON-RPC `snapshot`),
then `GET /v2/events?since=<seq>` (or `subscribe`). The snapshot grows new
top-level fields. Old clients ignore them; the v1 fields stay until 3.0.

```ts
interface Snapshot {            // existing fields kept: v, seq, at, budget, mode, tasks, alerts, console, consoles, strategies, serviceInstalled
  service: ServiceInfo;         // version, protocol, startedAt, pid, notifier
  planner: PlannerMeter | null;
  counts: Counts;
  attention: AttentionItem[];   // "Needs you", all repos, never capped below 100
  executors: ExecutorRow[];     // Capacity, in routing order, planner first
  accounts: AccountSummary[];   // quota, shared across executors
  hosts: HostSummary[];
  repos: RepoRef[];             // every repo the service knows
  tasks: TaskData[];            // widened, see below
  today: Today;
  setup: SetupSummary;
  pause: PauseState | null;
}
```

- **`tasks`.** All queued and running tasks, plus settled tasks updated in the
  last 24 hours that are not dismissed, newest first, capped at 200 (today 20).
  Older tasks come from `task.list`. Each `TaskData` gains:
  - `repo: RepoRef` (below);
  - `kind`, `kindSource: "brief" | "classifier" | "review"`;
  - `host: string | null` (SSH alias; null for this machine);
  - `queue?: { reason: "no_slot" | "paused" | "host_down" | "waiting_retry"; position: number }`;
  - `acceptance?: { cmd, state: "pending" | "running" | "passed" | "failed" | "none", durationS?, summary?, machine? }`;
  - `diffstat?: { files, added, removed }`;
  - `idleS?: number` when running and quiet;
  - `session?` from the live-sessions spec;
  - `rev: number`, incremented on every change, used for conflict checks.
- **`RepoRef`** is `{ key, label, path }`.
  - `key` is the canonical `host/owner/repo` from `repoKey()` in
    `src/config/hosts.ts`, or `local:<sha256(path)[:12]>` for a repo with no
    supported origin.
  - `label` is `owner/repo` (or the folder name), made unique by adding the
    host when two labels clash.
  - `path` is the main checkout on this machine. A worktree resolves to its
    main checkout, so a task in `.worktrees/t-0415` still counts as `pacer`.
  - The service learns repos from tasks, `hosts.<alias>.repos`, Orca consoles
    and an explicit `repo.add`. `repos` is ordered by last use.
  - `task.delegate` resolves the `RepoRef` once and stores it on the task
    record. Older records get it lazily on first read, from a registry in
    `PACER_HOME/state/repos.json` keyed by main-checkout path, so a snapshot
    never runs `git` for hundreds of tasks.
- **The repo filter is a client choice.** The snapshot is small enough (low
  hundreds of rows) that every client filters `attention`, `tasks` and
  `today` by `repo.key` itself. Counts in `counts.byRepo` let chips show
  numbers without filtering. Budgets, executors and hosts are never filtered:
  they are shared (the Overview note says so).
- **Events.** New event types, all additive: `attention`, `executor`,
  `account`, `host`, `repo`, `job`, `activity`, `counts`, `pause`. Each carries
  the whole entity, or `{ id, removed: true }` when it goes away, so a client
  applies events without refetching. `budget`, `task`, `mode`, `alert`,
  `config` and `reset` keep their meaning. `config { area }` still tells
  clients to refetch a settings area.
- **Outbox.** It keeps the last 1000 entries (today 200) and a `reset` event
  still tells a lagging client to refetch the snapshot. Each entry stores the
  time it was published, and `event.at` returns that time (today it is the
  time of the read).
- **Phases.** `progress.phase` today is `starting | working | idle |
  lost-contact`. The canvas shows Editing, Testing and Queued. The service
  adds `testing` while pacer runs the acceptance command, and the UI labels
  `working` as Editing. `idle` keeps its meaning and drives `stuck`.
- **Throttling.** The service coalesces `task` progress changes to one per
  task per second (as the live-sessions spec does for `session`) and `counts`
  to one per second.

`liveSnapshot` in `src/api/events.ts` already merges the task store into the
stored link snapshot; the new fields are computed the same way, from the task
store, strategy, runner state, host state and the attention store, at read
time and on change.

### 2. Needs you: attention items

An attention item is something only the user can decide. The service raises it
from state, clears it when the state changes, and is the only source of
notifications and needs-you badges.

```ts
interface AttentionItem {
  id: string;                    // stable for the condition, e.g. "review:t-0412", "host_down:devbox"
  kind: AttentionKind;
  severity: "decide" | "problem" | "blocked";   // ordering and colour
  repo: RepoRef | null;          // null for host, account, planner, setup items
  taskId?: string; executor?: string; host?: string; account?: string;
  title: string;                 // "Fix flaky retry test in the payments client"
  detail: string;                // "Failed twice on Antigravity · test timed out after 120 s"
  raisedAt: number;
  actions: Action[];             // first is primary
  notify: "important" | "all";   // lowest notifications level that shows it
  since: number;                 // when the condition began; a new value is a new occurrence
  snoozedUntil?: number;
}
interface Action { label: string; op: string; params: Record<string, unknown>; style?: "primary" | "danger"; confirm?: string }
```

Kinds and the rules that raise and clear them:

| Kind | Raised when | Cleared when | Default actions |
| --- | --- | --- | --- |
| `review` | A task settles `done` or `partial` and has no verdict. For a task with `source: "planner"`, only after 10 minutes without a verdict, because the planner normally reviews what it delegated | `task.review` (a planner's or the user's), `task.retry`, dismiss | Review (opens), Accept |
| `failed` | A task settles `failed` and no retry is active | Retry started, reviewed, dismissed | Retry on `<suggested>`, See error |
| `limit` | A task stopped on the executor's limit and nothing took over | Retried or dismissed | Retry on `<suggested>` |
| `stuck` | A running task has no output for `stuck_after` (default 5 min) while not in `testing` | Output resumes, task ends | Open terminal (`task.attach`), Stop |
| `question` | The executor reported a question (below) | Answered, stopped | Answer, Open terminal |
| `account_signin` | An account an enabled executor uses reads as signed out: its usage read or a task attempt fails with an authentication error. Today `signedIn` is only `true` or `null`, so this needs a `false` value set from those failures | Sign-in detected on the next usage read | Sign in (`account.signin`), Disable executor |
| `executor_down` | An enabled executor fails its check or is marked broken | It passes again, is disabled or removed | Run check, Disable |
| `host_down` | A host with an enabled executor fails `ssh` reachability twice in a row | It answers | Run checks, Pause host |
| `planner_quota` | The planner is ahead of pace enough to change mode, or out | Back on pace, window resets, user keeps the mode | Open pacer, Keep `<mode>` (`mode.hold`) |
| `setup` | `setup.check` has a blocking item (no planner, service not installed, a host repo not mapped for a routed repo) | The check passes | Open settings section |
| `update` | An update is available and `update_check` is on | Updated, or dismissed for that version | Update, Later |

- **Stopped tasks and retry chains.**
  - A `stopped` task raises nothing: the user or the planner stopped it.
  - Items belong to the newest task in a retry chain. Starting a retry clears
    the original's `failed` or `limit` item (today's panel already ignores
    retried tasks), and the retry raises its own `review` or `failed` item
    under its own id (`review:<retry id>`).
- **Suggested executor.** `failed` and `limit` actions name a concrete
  executor: the first one in the task kind's routing chain, other than the one
  that failed, that is ready with a free slot. If none is ready, the action is
  "Retry" with no executor and the detail says why ("all executors busy; next
  free in ~4 min" is out of scope; "all executors busy" is enough).
- **Actions are data.** `op` and `params` are a real v2 operation call. A
  client renders the label and calls the op; it never computes the target.
  The only client-side actions are navigations, expressed as
  `op: "ui.open"` with `params: { view: "review" | "task" | "session" |
  "settings", id?, section? }`. `ui.open` is not a server operation; every
  client maps it to its own screen, and a client that has no such screen
  (status line, tray) opens the app at `/app/#<view>/<id>`.
- **Acknowledging.**
  - Acting clears an item through its rule; there is no separate "ack".
  - `attention.dismiss { id }` hides an item. For task items it dismisses
    the task as today (`task.dismiss`). For condition items (host down,
    sign-in, update) it snoozes until the condition clears and comes back,
    or for `update` until a newer version.
  - `attention.snooze { id, for: "1h" | "4h" | "1d" }` hides it until then.
  - A dismissed or snoozed item is kept in the store with its state, so two
    clients converge and the item does not flash back on the next poll.
- **Store.** `PACER_HOME/state/attention.json`, rewritten atomically when an
  item changes. It holds, per item id, `since` (when the condition was first
  seen, for conditions whose start the state does not record, such as a host
  going down) and any dismissal or snooze with the `since` it applied to.
  A dismissed condition item comes back when it is raised with a newer
  `since`, that is, after it cleared and happened again. Items themselves are
  derived, so a lost file only costs dismissals and first-seen times.
- **Who evaluates.** `pacer serve` evaluates the rules on every state change
  and every pump tick (15 s). Without the daemon, `snapshot` and
  `task.list` evaluate them on read, and time-based items (`stuck`, the
  planner review grace) appear on the next read.
- **Ordering.** `blocked` (question, stuck), then `problem` (failed, limit,
  down, sign-in, quota, setup), then `decide` (review, update), then oldest
  first within a group. The Overview shows all; the panel and tray show the
  first two or three.

#### Questions from executors

Headless executors cannot ask mid-run today; they exit. The design adds one
small, planner-independent path:

- `pacer ask "<question>"`, run by an executor inside its task, records the
  question on the task (`task.question = { text, at }`), raises a `question`
  item and returns immediately. It is installed into executor sessions the
  same way the existing result report is (the `PACER_ROLE=executor`
  environment).
- For an **interactive** session (live-sessions phase 3), the user answers by
  attaching and typing. The item clears when the session reports progress
  again or ends.
- For a **headless** run, the agent is told in its prompt to ask only when it
  cannot continue, then stop. The task settles as `blocked` (a new terminal
  state, shown with `failed` in the UI). "Answer" calls
  `task.answer { id, text }`, which retries the task on the same executor with
  the stored brief plus a "Question / Answer" section. This is `task.retry`
  with an extra brief section, and it keeps one active retry per task.

### 3. Review queue

- **Queue.** The `review` attention items, newest last, across all repos.
  `counts.review` drives the rail badge. No separate list op is needed; a
  client that wants older settled tasks uses `task.list`.
- **`task.get` returns the whole task.** Today `summarizeTask` drops
  timestamps, progress, retry links and the brief, so the app merges it with
  snapshot `TaskData`. `task.get` returns `TaskData` plus the brief, attempts
  with start and end times, and these additions for the review screen:
  - `routing: { kind, kindSource, rule, chosen, why, skipped: [{ executor, reason }] }`,
    recorded by the runner at delegate time from the same data
    `routing.route` explains. Example `why`: "on pace (3%), free slot on
    devbox; codex#team busy".
  - `cost: { executor: { account, deltaPct, window }, planner?: { deltaPct } }`.
    The executor delta is the account's used % at settle minus at start, when
    both reads exist and nothing else ran on that account; otherwise `null`
    with `reason: "shared"`. The planner delta needs the planner to report
    its own usage around the delegate call; it is `null` until a planner
    integration provides it. The UI hides a null cost line.
  - `acceptance` as in the snapshot, plus `tail` (last 4 KiB).
  - `summary`: the executor's report (today `report`).
  - `branch`, `base`, `machine` (host alias or null), `startedAt`, `endedAt`.
  - `files`: the diffstat per file (the same list `task.diff` returns, without
    the patch), so the review screen needs one call plus a per-file
    `task.diff` when a file is opened.
  - `retryOptions`: the same list `task.retry_options` returns.
  - `timeline`: `[{ at, text }]` for the Session and Review side panels
    ("Routed to Codex · on pace, free slot", "Worktree created from main",
    "Commit 3f2a91c", "Testing"). It is built from the task's activity
    entries plus phase changes and commits the supervisor already sees.
- **Changes so far.** `task.diff` works on a running task too: it diffs the
  task's worktree against its base as it is now. The Session view's
  "Changes so far · 6" tab uses it, refreshed when `progress.files` or
  `progress.commits` changes.
- **`task.diff` additions.** `{ files: [{ path, status: "added" | "modified" |
  "deleted" | "renamed", added, removed, binary }], patch, truncated }`. The
  patch is capped at 1 MiB; `task.diff { id, path }` returns one file's patch
  uncapped up to 4 MiB. "Open in editor" is a client action on `worktree`.
- **Verdicts.** `task.review` gains a `verdict` field and keeps `accepted` for
  older clients:

  | Verdict | Effect |
  | --- | --- |
  | `accept` | Records the verdict and kind. For a remote run the branch is already fetched into the local review worktree (remote-hosts flow), so "Accept and bring back" is accept; the UI text explains the user merges it. |
  | `reject` | Records the verdict; the task's worktree is kept for `pacer clean`. |
  | `send_back` | Records a rejected verdict with the note, then calls `task.retry` on the same executor with the note added to the brief as "Review feedback". |
  | `retry` (with `executor`) | Records a rejected verdict and retries on that executor. |

  Every verdict returns `{ task, retry? }`: the reviewed task as it is now,
  and the new task when the verdict started one.
  `kind` corrects the classifier as today (`appendLabel` in
  `src/tasks/labels.ts`); `kindSource` becomes `review`.
- **Retry choices.** `task.retry_options { id }` returns the executors that
  could take the task, in routing order, each with `{ id, state, reason }`
  ("available", "busy", "ahead of pace"). Review, Session and the failed
  attention item all use it for their "Retry on" pickers.
- **Today's verdict counts** are in `today` (section 6).

### 4. Running, Capacity and the planner meter

```ts
interface ExecutorRow {
  id: string;                    // "codex#team@devbox"
  agent: string; account: string; host: string | null; model: string | null;
  rank: number | "planner";      // routing order; "next in line" is the first ready one
  enabled: boolean;
  state: "ready" | "busy" | "full" | "failing" | "down" | "blocked" | "exhausted" | "disabled" | "checking";
  tone: "good" | "info" | "warn" | "bad" | "muted";
  sub: string;                   // "on pace · this Mac + devbox", written by the service
  reason?: string;               // "2 recent failures", "no subscription"
  usedPct: number | null; pacePct: number | null;   // from the account, repeated for the row
  paceReason?: string;           // why pace is null: "unmetered", "no limit reported"
  slots: { used: number; max: number };
  lastCheck: { at: number; passed: boolean; detail?: string } | null;
  recentFailures: number;        // last 24 h
  next: boolean;                 // true for the executor the next default-kind task would go to
}
interface AccountSummary {
  name: string; agent: string; source: string;
  usedPct: number | null; pacePct: number | null; window: string | null; resetsAt: number | null;
  verdict: string; signedIn: boolean | null; executors: string[];
}
interface PlannerMeter {
  runner: string; agent: string;  // any of PLANNERS
  usedPct: number | null; pacePct: number | null; deltaPts: number | null;
  verdict: "behind" | "on_pace" | "ahead" | "out" | "unknown";
  activeHoursLeft: number | null; resetsAt: number | null; window: string | null; stale: boolean;
  advice: string;                 // "14 pts under pace — spend it."
  mode: string; modeHeldUntil?: number;
}
```

- **Slots.**
  - Hosts already have `max_tasks` (1–16, default 2).
  - This machine gets `execution.local_max_tasks` (default 2), shared by all
    local executors, and each executor gets an optional `max_tasks`
    (default 1 for a local executor, the host's value for a remote one).
  - `slots.used` counts this executor's running tasks.
  - **A full executor is skipped, as a busy host is today.**
    `remoteExclusion` in `src/remote/eligibility.ts` already excludes a host
    at `max_tasks` ("devbox busy (2/2)") and the runner falls through to the
    next candidate. Executor and machine limits work the same way. A task
    waits as `queue.reason: "no_slot"` only when no executor in its kind's
    chain has a slot, or when the brief pins one executor that is full.
  - **Draining the queue.** With `pacer serve` running, the service starts
    queued tasks when a slot frees. Without it, each runner starts the oldest
    eligible queued task as it exits, and any CLI or API call checks the
    queue too, so a queued task never waits for a daemon that is not there.
  - **Gap:** only host capacity exists today; executor and machine slots,
    the queue and its draining are phase 3.
- **Usage per account, not per executor.** Two executors on one account share
  its quota, so the Capacity row's used % comes from `accounts[]`. The row's
  sub-label lists where the account runs ("this Mac + devbox").
- **Next in line.** The service sets `next` on the executor the default rule
  would pick now, and `counts.ready` / `counts.executors` give "4/5 executors
  ready". The panel's "next: Codex" and quick delegate's "Goes to Codex now"
  both read this; for a specific kind the client calls `routing.route`.
- **Planner meter.** Built from the planner's provider line plus the pace clock
  (`src/pace`). `advice` is chosen by the service from the verdict and mode,
  so every surface says the same thing. A planner with no usage source
  (`unknown`) shows its name and mode only.
- **Running rows** come from `tasks` with state `queued` or `running`. Phase,
  elapsed, files, commits, `lastOutputAt` and `idleS` are in `TaskData`. The
  "idle 6m" amber text is `idleS >= 300`, the same threshold that raises
  `stuck`.

### 5. Delegating from any surface

The UI delegates on the user's behalf, with no planner in the loop. This must
work whatever planner is configured, including none yet.

- **`task.delegate`** stays the one call. The UI sends `goal`, `repo` (a
  path), optional `acceptance`, `kind`, `executor` and `worktree`. Additions:
  - `repo` also accepts a `RepoRef.key`; the service resolves it to the main
    checkout path.
  - `base?: string`, the branch or commit to start from (the "acme/api ·
    main" picker); default the repo's current branch.
  - `source: "planner" | "ui" | "cli"` and `client?: string`, recorded on the
    task and shown in the activity log ("Delegated from the Orca panel").
  - `request_id?: string`. The same id within 10 minutes returns the first
    task instead of creating a second one, so a double click or two clients
    do not delegate twice. The check runs in `task.delegate` before a task
    record exists. The runner's existing guard on repo, goal and acceptance
    (`src/tasks/runner.ts`, which settles a duplicate as `failed`) stays for
    briefs without a `request_id`.
- **Kind.** When the UI sends no `kind`, the classifier picks one as it does
  for planner briefs; the task records `kindSource: "classifier"`.
- **Preview.** `routing.route { repo, goal, kind? }` returns the executor and
  the reason, so quick delegate can say "Goes to Codex now (next in line)"
  before the user presses. It already exists; it gains `goal` so the
  classifier can run.
- **Current worktree.** The Orca panel sends `worktree: "current"` and the
  worktree path as `repo`. The service resolves the main checkout for
  `repo.key` but runs in the given worktree, as today.
- **Repos.** `repo.list {}` returns `repos` with `branches` (local branch
  names, current first) for the picker; `repo.add { path }` registers a repo
  the service has not seen; `repo.remove { key }` forgets it (tasks keep
  their copy).
- **No planner needed.** Quick delegate does not ask a planner to write the
  brief. A planner that wants a UI-started task can read it like any other.
  Asking the configured planner to expand a goal into a brief is out of scope.
- **Executor sessions still cannot delegate.** The existing refusal for an API
  process that is itself an executor session stays.

### 6. Activity and done today

- **Activity log.** The service appends notable events to
  `PACER_HOME/state/activity.jsonl`:
  `{ id, at, kind, level, text, repo?, taskId?, executor?, host? }`.
  - Kinds: `task_started`, `task_settled`, `verdict`, `retry`, `mode`,
    `budget_refreshed` (at most one per 15 minutes per account), `executor_state`,
    `host_state`, `account_state`, `config`, `update`.
  - `text` is written by the service ("Codex finished “Add SSH keepalive” ·
    waiting for review") so every surface reads the same sentence.
  - Kept for 30 days or 20 000 lines, whichever is smaller, rotated daily.
  - `activity.list { before?, limit?, repo?, kinds? }` pages it newest first.
    New entries arrive as `activity` events. The snapshot does not include
    the log.
- **Done today.** `today = { since, done, accepted, rejected, failed, byRepo }`
  where `since` is local midnight in the user's time zone (the pace clock's
  zone). The rows are the snapshot's settled tasks with `updatedAt >= since`.
- **All tasks.** `task.list` gains `before` (cursor), `repo`, `states`,
  `executor` and `since`, and returns `{ tasks, next }`. Today it takes only
  `limit`.

### 7. Settings and setup as API

Most settings operations exist. This section lists only what changes.

#### Planner and pacing

No new operations. `config.get` returns `planners` (runner ids that can plan);
the UI must not hard-code the list. The planner row in Executors is
`rank: "planner"` and cannot be removed or disabled (`not_allowed` with a
hint).

#### Accounts

- `account.list` rows gain `executors: string[]` and `locked?: string`
  ("Planner — can't remove", "In use by 2 executors") so the UI shows why
  Remove is unavailable without working it out.
- **Sign-in.** Logging in runs the agent's own login, which needs a terminal.
  `account.signin { name, target?: "terminal" | "orca" | "tmux" }` opens one
  with the right environment (`CODEX_HOME=…`, `CLAUDE_CONFIG_DIR=…`) through
  the same viewer-opening code as `task.attach`, and returns
  `{ opened, command }`. When nothing can be opened (headless), it returns
  the command for the user to run. The `account_signin` item clears on the
  next successful usage read; the service re-reads that account every 15 s
  for 10 minutes after `account.signin`.
- Endpoint accounts keep the endpoint fields in `account.add`.

#### Executors

- `runner.add` gains `rank?: number`, `kinds?: string[]` (added to an existing
  or new routing rule), `max_tasks?` and `test?: boolean` (default true).
- `runner.set { id, enabled?, model?, max_tasks?, rank? }` is new.
  `enabled: false` keeps the executor in config but out of routing. It is
  different from `runner.block`, which is time-limited and quota-driven.
- `runner.reorder { ids }` sets the whole order in one call (today
  `config.set pacing.order`); the planner is not in the list.
- `agent.detect { host? }` returns, for each agent in `AGENTS`,
  `{ agent, found, version, path, install_hint }` on this machine or on a host.
  It never installs anything.
- **Readiness check.** `runner.check { id }` starts a job (section 8) with the
  steps from the canvas: CLI found, signed in, usage readable, test task. The
  test task runs a fixed one-line brief in a scratch worktree under
  `PACER_HOME/scratch`, never in a user repo, with a 3-minute timeout. A new
  executor is `checking` until the job passes, then `ready`; a failed check
  makes it `failing` and raises `executor_down`. `runner.add { test: true }`
  starts this job and returns `{ id, job }`.
- The add-executor wizard saves nothing until its last step: it calls
  `agent.detect`, `account.list`, `host.list`, `host.check` (for "Test
  connection") while browsing, then one `runner.add`. If the account is new,
  `account.add` (and `account.signin`) come first, and the wizard keeps the
  account if the user cancels later; the account shows as unused.

#### Routing and strategies

`routing.get/set`, `strategy.*` are unchanged. "New from a brief" needs an
agent session; `strategy.build { agent, from, brief }` opens one through the
same viewer code as `account.signin` and returns `{ opened, command }`. Any
planner agent can build, not only Claude Code and Codex (`strategy-build` in
the link envelope accepts only those two today).

#### Remote hosts

| Operation | Does |
| --- | --- |
| `host.suggest {}` | SSH aliases from `~/.ssh/config` (and `Include`s) that are not yet hosts. Read-only. |
| `host.add { alias, ssh }` | Unchanged; returns `{ alias, job }` and runs `host.check` as a job. |
| `host.get { alias }` | The detail screen: facts (OS, arch, git, setsid, agent versions), `checkedAt`, `reachableAt`, `paused`, slots, executors, done this week / accepted, repos (key, path, origin, identity), account homes (name, home, signedIn), worktrees (branch, state, fate). |
| `host.check { alias, repo? }` | Now a job; result also stored for `host.get`. |
| `host.set { alias, max_tasks?, paused? }` | Capacity and "Pause new work". A paused host takes no new tasks; running ones finish. |
| `host.repo.map { alias, key, path }` | Adds `hosts.<alias>.repos.<key>`. |
| `host.repo.setup { alias, key, clone?: boolean, identity?: boolean, consent: true }` | What `pacer host setup` does: clone if missing, set `user.name`/`user.email` to match this machine. A job. Refuses without `consent: true`. |
| `host.account.add { alias, account, home }` | Adds an account folder; returns the login command for the host (`CODEX_HOME=~/.codex-team codex login`). pacer never logs in on a host. |
| `host.clean { alias, dry_run?: boolean }` | What `pacer host clean` does. `dry_run` returns the fate per worktree; otherwise a job. Keeps any branch not yet brought back. |
| `host.terminal { alias }` | Opens an SSH terminal through the viewer code; returns `{ opened, command }`. |
| `host.remove { alias }` | Unchanged; refused while an executor uses the host. Leaves files on the host. |

`host_down` and the host's `HostSummary.state` (`ready`, `needs_setup`,
`down`, `paused`, `checking`) come from a reachability probe the service runs
every 5 minutes for hosts with an enabled executor, over the existing
ControlMaster, and from every task attempt on that host.

#### Updates, notifications, service

- `update.check`, `update.apply` unchanged; `update.apply` becomes a job so its
  progress is a `job` event rather than alerts.
- `notifications.get/set` move from the Orca plugin settings to
  `PACER_HOME/settings.json`, so the level works without Orca. The plugin
  reads the same level, and the first read copies an existing plugin value
  across. The enum stays `off | important | all` (the board's "Never" is
  `off`): `important` shows attention items with `notify: "important"`,
  `all` adds items with `notify: "all"`, mode changes and every settled task.
- `service.status` unchanged.

### 8. Long-running work as jobs

Host checks, the executor test task, repo clone, host clean-up and updates take
seconds to minutes. They become jobs so every client can show the same
progress and a second client sees work already in flight.

```ts
interface Job {
  id: string; kind: "host.check" | "runner.check" | "host.repo.setup" | "host.clean" | "update.apply";
  target: string;                // host alias, executor id, "pacer"
  state: "running" | "passed" | "failed" | "cancelled";
  steps: { name: string; state: "pending" | "running" | "passed" | "failed" | "skipped"; detail?: string }[];
  startedAt: number; endedAt?: number; error?: { code: string; message: string; hint?: string };
}
```

- The starting op returns `{ job }`. Progress arrives as `job` events.
  `job.get { id }` and `job.list { target? }` read them; `job.cancel { id }`
  stops one that supports it.
- One job per `kind` and `target` at a time. Starting a second returns the
  running one rather than `conflict`, so two clients pressing "Run checks"
  watch the same job.
- Jobs are kept for 24 hours in `PACER_HOME/state/jobs/`.

### 9. Pause and mode hold

Two small controls from the tray and notifications:

- `delegation.pause { for: "1h" | ..., reason? }` and `delegation.resume {}`.
  While paused, `task.delegate` queues new tasks with `queue.reason:
  "paused"` instead of starting them, and planners see the pause in their
  status (the pacer skill's budget block) so they do the work themselves or
  wait. `snapshot.pause` is `{ until, reason, by }`.
- `mode.hold { mode, until? }` keeps the current mode instead of the one pace
  would choose ("Keep normal" on the planner notification), until the next
  window reset by default. `mode.release {}` ends it. The meter shows
  `modeHeldUntil`.

### 10. Notifications

- **Needs the daemon.** Notifications, the host probe, the post-sign-in
  re-reads and jobs that outlive a call need `pacer serve`. Without it,
  `pacer api --stdio` runs a job inside the call that started it and returns
  when it ends, and nothing is notified; `setup.check` already reports the
  service as a required item.
- **The service decides; one notifier delivers.** The service picks what to
  notify from attention items and the level, and assigns each notification a
  key (the attention id). It delivers each key at most once.
- **Who delivers.** A client that can show system notifications (the desktop
  app, the tray helper, the Orca plugin) registers as notifier with
  `client.register { kind, version, notifier: true }` and renews it with
  `client.heartbeat` every 30 s. The service sends `notify` events only to
  the most recently registered live notifier. With none, the service shows
  the notification itself (`osascript` on macOS, `notify-send` on Linux) with
  an "Open pacer" action. This answers the open question in the clients
  decision: no double notifications when several clients are open.
- **Actions.** A notification carries the item's first two actions. The
  notifier calls the op directly; a notifier that cannot run ops (the
  built-in fallback) opens the app at the item.
- **Badges.** Rail, tray dot, status-line ⚑ and the Orca panel all read
  `counts`:
  `{ attention, review, problems, running, queued, ready, executors, setupOpen, hostsWithProblems, byRepo: { [key]: { attention, running } } }`.

### 11. The client contract

- **Transports.** Unchanged: HTTP + SSE from `pacer serve` on 127.0.0.1, and
  JSON-RPC over stdio from `pacer api --stdio` with no daemon. The same
  operation registry serves both, and every new operation here goes into
  `src/api/ops.ts` and `docs/protocol.md`.
- **Clients.**

  | Client | Reads | Writes | Auth |
  | --- | --- | --- | --- |
  | Web app (browser, Orca browser pane, desktop app) | HTTP snapshot + SSE | HTTP ops, session WebSocket | `pacer_session` cookie from `pacer open` |
  | Desktop app (Tauri shell) | as web app | as web app, plus `client.register` as notifier | Reads the token file (same OS user) at launch and exchanges it for a session cookie, so the web bundle needs no token handling |
  | Orca panel worker | HTTP when `pacer serve` runs, else stdio | ops | bearer token |
  | TUI `pacer dashboard` | `ApiClient` (HTTP or in-process) | ops | bearer token or in-process |
  | Status line `pacer status --line` | `GET /v2/snapshot` with a 300 ms timeout, else the last stored snapshot file | none | bearer token |
  | Tray helper | HTTP snapshot + SSE | ops | bearer token |

- **Hello and capabilities.** `GET /v2/hello` keeps `{ protocol, pacer, ops,
  events }`. A client checks `ops` before showing a button for an operation
  added in a later minor, and hides it if absent. This is how a 2.1 client
  talks to a 2.0 service.
- **Client identity.** Every request may carry `X-Pacer-Client:
  <kind>/<version>` (`app`, `desktop`, `orca`, `tui`, `status`, `tray`, `cli`,
  `planner:<agent>`). The service records it on tasks it creates and in the
  activity log. It is a label, not authentication. The existing
  `X-Pacer-Client: app` check for cookie writes stays.
- **Concurrency.**
  - Mutating task operations accept `expect_rev?`. When the task has moved
    on, they return `conflict` with the current task in `hint`-free data, and
    the client redraws from the next event.
  - Without `expect_rev`, operations check the state they need (a review on a
    running task is `conflict`) as today.
  - Delegation is idempotent with `request_id`; jobs are shared per target.
- **Versioning.**
  - This design is protocol **2.1** (additive) for the read model, attention,
    review, delegate and activity changes, and **2.2** for jobs, hosts,
    executors and notifier changes. Each minor bumps `PROTOCOL_VERSION` and
    regenerates `docs/protocol.md`.
  - The v1 link envelope (`src/link/envelope.ts`) is frozen: no new fields
    except those the live-sessions spec adds for one minor release. The Orca
    panel moves fully to v2 (it already reads v2 for data); its commands
    stop going through the console terminal and become direct ops in
    phase 4. The `CMD_NAMES` line protocol is then retired.
  - Panel commands without a v2 op get one before the switch:
    `task.retry_all { ids }` for `retry-all`; `strategy.build` (section 7)
    for `strategy-build`; `account.signin` and `task.attach` for
    `open-terminal` and `focus`.
  - `/state` and `/console/*` are removed in phase 4. The legacy bearer-only
    `/link` and `/events` routes carry `Deprecation: true` and `Sunset: 3.0`; they are removed in 3.0; the status
    line and Orca worker move to `/v2` first.
  - **3.0** removes the v1-shaped snapshot fields (`v`, `budget`, `alerts`,
    `console`) in favour of `planner`, `accounts`, `attention` and the
    client registry, and renames `accepted` to `verdict` in `task.review`.
    The previous major is served for one minor release, as
    `docs/protocol.md` already promises.
- **Auth on 127.0.0.1.** Unchanged and kept strict: Host header check, bearer
  token in a 0600 file, cookie only via the `pacer open` single-use code,
  Origin and `Sec-Fetch-Site` checks on cookie writes and on the session
  WebSocket, no CORS. New for the desktop app: `POST /v2/session/exchange`
  takes the bearer token and returns the cookie for its own webview, so the
  app does not need the browser code flow. No API key or token ever appears
  in a snapshot, event, job or activity entry; endpoint keys stay redacted as
  today.
- **Status line offline state.** When the service is not running, the status
  line prints "pacer not running · pacer serve" from the stored snapshot age,
  as the board shows. It never starts the service.

## Requirements from the UI implementation spec

The companion spec lists 15 needs in its "Needs from the service" section.
Where each one is met:

| # | Need | Here |
| --- | --- | --- |
| 1 | Needs-you items with kind, severity, entity, detail, actions | §2 |
| 2 | Capacity rows with sub-line, tone, used/pace or a reason, slots, state | §4 `ExecutorRow` |
| 3 | Planner meter with stale flag and mode | §4 `PlannerMeter` |
| 4 | Badge counts, including setup items and hosts with problems | §10 `counts` |
| 5 | Repos with key and label, `repo` on every task | §1 `RepoRef` |
| 6 | Entity events; jobs with progress | §1 events, §8 |
| 7 | Review detail in one op, retry targets | §3 `task.get` |
| 8 | Verdict ops returning the resulting state | §3 verdicts |
| 9 | Done today and activity | §6 |
| 10 | Desktop sign-in without a terminal; tell the service a desktop is connected | §11 token exchange; §10 `client.register`. `pacer open --print` also still works for a shell that prefers the code flow |
| 11 | No double notifications while a desktop client is connected; actions and click target | §10 notifier lease; `ui.open` actions |
| 12 | Session endpoint, changes so far, timeline | live-sessions spec; §3 |
| 13 | Executor order, enabled flag, last check; host detail | §7 |
| 14 | Pause delegation; switch strategy | §9; `strategy.use` (exists) |
| 15 | Protocol version in `/v2/hello` to gate features | §11 |

## What exists today and the gaps

Built (from `docs/protocol.md` and `src/api/ops.ts`, 52 operations): snapshot and events with
`reset`; task delegate, diff, dismiss, get, list, log, retry, review, stop,
wait; config, notifications, accounts (add, adopt, edit, list, models, remove,
test), agents (connect, disconnect, preview), hosts (add, check, list,
remove), limits, routing (get, route, set, status), runners (add, block, list,
remove, unblock), setup, strategies, service, plugin, update, version.

Gaps this design fills, by area:

| Area | Gap |
| --- | --- |
| Read model | No repo on tasks (`brief.repo` is not in `TaskData` or `summarizeTask`); tasks capped at 20; no counts, executors with slots, accounts summary, planner advice, hosts summary or today; event `at` is the read time, not when the event happened (`src/api/events.ts`) |
| Task detail | `summarizeTask` drops timestamps, progress, retry links, dismissal and the full brief, so clients merge it with snapshot `TaskData` |
| Needs you | No attention concept. Two client heuristics disagree: `attentionGroups` in `src/view-model/panel.ts` (failed, limit, partial, stuck queued) and `needsReview` in the app's `app/src/model/tasks.ts` (done or partial, unreviewed). Alerts are notification-shaped, capped at 10 and carry no actions |
| Sign-in | `signedIn` is only `true` or `null`; nothing detects a logged-out account |
| Questions | Executors cannot ask; no `blocked` state |
| Review | No verdict variants (send back, retry elsewhere), routing explanation, cost, diffstat, acceptance duration |
| Scheduling | No slot accounting per executor or for this machine; no queue reason |
| Delegate | No repo list, base branch, idempotency key or source |
| Activity | No readable log; outbox holds 200 machine events |
| Settings | No enabled flag, model edit, reorder op, agent detection, readiness test task, sign-in launcher, strategy build launcher for all planners |
| Hosts | No detail op, pause, capacity op, repo map/setup, account folders, clean-up or terminal as v2 ops; no background reachability probe |
| Long work | No job model; progress is ad hoc alerts |
| Notifications | Level and delivery tied to the Orca plugin; no notifier ownership |
| Contract | No client identity, `expect_rev`, desktop token exchange, retirement plan for v1 commands. Panel commands `retry-all`, `strategy-build`, `open-terminal` and `focus` have no v2 op. Legacy bearer-only routes `/state`, `/link`, `/events` (unversioned v1 SSE) and `/console/*` remain beside `/v2` |

## Risks

- **Snapshot size.** 200 tasks plus attention, executors and repos can reach
  a few hundred KiB. Mitigation: tasks in the snapshot carry no brief or
  report (only `task.get` does), and events are per entity.
- **Derived state drifting from stored state.** Attention items are derived;
  a rule bug could leave an item stuck. Mitigation: rules are pure functions
  of the snapshot inputs with table tests, and the store only remembers
  dismissals and snoozes.
- **Cost attribution is approximate.** Shared accounts and coarse usage
  readings make `deltaPct` noisy. It is shown only when unambiguous.
- **Slot scheduling changes routing behaviour.** Tasks that start at once
  today may queue. Defaults (local 2, executor 1, host 2) are chosen to
  match today's typical use; the change is called out in the release notes.
- **Notifier lease edge cases.** A desktop app that sleeps keeps its lease
  for up to 30 s; a notification in that window is delayed, not lost, because
  the service falls back after the lease lapses and delivers once per key.
- **`pacer ask` misuse.** An executor could ask instead of trying. The prompt
  limits it to "cannot continue" and the item shows the question verbatim
  so the user sees a lazy ask for what it is.
- **v1 retirement.** Older Orca plugins keep working only while the v1
  commands exist; phase 4 needs a plugin update first, through the existing
  plugin refresh after `pacer update`.

## Phases

Each phase ships on its own, regenerates `docs/protocol.md` and comes with
tests in `test/api` against a temp `PACER_HOME`.

1. **Read model (2.1).** `RepoRef` on tasks, `repos`, widened `tasks`,
   `counts`, `executors` (without slots), `accounts`, `planner`, `hosts`
   summary, `today`, `setup` summary; new event types; outbox 1000;
   `X-Pacer-Client`. Unblocks Overview, panel, TUI, status line and tray
   reading the same data.
2. **Needs you and review (2.1).** Attention store and rules (without
   `question`), `attention.dismiss/snooze`, actions, routing explanation,
   diffstat, acceptance details, verdict variants, `task.retry_options`,
   `task.list` filters, activity log, delegate `request_id`, `base`,
   `source`, repo ops. The panel's `attentionGroups` and the app's
   `needsReview` are replaced by `snapshot.attention`.
3. **Capacity and settings (2.2).** Slot scheduling and `queue`, jobs,
   `runner.set/reorder/check`, `agent.detect`, `account.signin`,
   `strategy.build` for any planner, host ops and reachability probe,
   notifications level in pacer's own settings, `delegation.pause`,
   `mode.hold`.
4. **Notifications and clients (2.2).** Notifier registration, built-in
   fallback notifier, desktop token exchange, Orca panel commands as direct
   ops, `expect_rev`.
5. **Questions (2.2).** `pacer ask`, `blocked` state, `task.answer`, the
   `question` item; interactive answers follow live-sessions phase 3.
6. **3.0.** Remove v1-shaped fields and the `CMD_NAMES` line protocol after
   one minor release with both.

## Testing

- Attention rules as table tests: input (tasks, executors, hosts, accounts,
  pace) → items, including clear-on-change and dismiss-survives-repoll.
- Two clients: two HTTP clients review the same task (one gets `conflict`),
  delegate with the same `request_id` (one task), press "Run checks" together
  (one job).
- Reconnect after a gap longer than the outbox: one `reset`, then a
  consistent snapshot.
- A 2.0 client against a 2.2 service sees no errors and ignores new fields
  and events; a 2.2 client against a 2.0 service hides buttons whose ops are
  missing from `hello.ops`.
- Repo identity: a worktree, a main checkout and a remote mapping of the same
  repo resolve to one `RepoRef.key`; two repos with the same `owner/repo`
  label on different hosts get distinct labels.
- Notifier: two registered notifiers deliver once; none registered uses the
  built-in fallback; level `off` sends nothing.
- No secrets: snapshot, events, jobs and activity contain no tokens or
  endpoint keys (a redaction test seeds known secrets).
- Planner-agnostic: the read model and attention tests run with each of
  `claude-code`, `codex`, `cursor` and `opencode` as planner.

## Calls made in this design

These were not settled with the owner and are the author's calls:

- Attention items are derived from state, not stored events; only dismissals
  and snoozes are stored.
- Planner-delegated tasks raise a review item only after 10 minutes without a
  planner verdict; a planner's verdict and the user's count the same.
- A full executor is skipped like a busy host today; tasks queue only when
  nothing in the chain has a slot.
- Reviews are attention items, so "Needs you" counts include them (the
  prototype's Overview badge "3 need you" includes two reviews); the Review
  badge counts reviews only.
- The repo filter is applied by clients over the snapshot, not by the server.
- "Accept and bring back" is `accept`; remote branches are already fetched
  when the run settles.
- `send_back` retries on the same executor with the note; "Retry on" is a
  separate verdict.
- Executors ask questions only by stopping (`blocked`) in headless runs.
- Slot defaults: this machine 2, each local executor 1, hosts keep 2.
- The service shows notifications itself when no notifier client is
  registered.
- The desktop app reads the token file and exchanges it for a cookie.
- Two protocol minors (2.1, 2.2) before a 3.0 that drops v1 shapes.

## Open questions

- Whether the planner's own cost per brief can be measured for planners other
  than Claude Code; until then the review screen shows only executor cost.
- Whether `stuck` should also look at CPU or file activity, not just output,
  for agents that think silently for long periods.
- How long "Done today" should reach back for users who work past midnight
  (the pace clock's active hours might be a better boundary than midnight).
