# Notification ownership and quiet OS banners

Status: proposed.
Source: planner task t-20261123-220722-ace3 — OS/client notifications should
interrupt the human only for decisions the human owns, instead of flooding the
notification center for every planner-delegated attention item.
Builds on:
[client-owned notification delivery](2026-11-06-client-notification-delivery-design.md)
(delivery path unchanged), attention rules in `src/attention/rules.ts`, and the
host notify pump in `src/notify/decide.ts`.

## Intent

pacer already decides *what* is attention and *who* delivers a notification.
What is wrong today is *which* attention items raise an OS/client banner at the
default `important` level: almost every kind is `notify:"important"`, so stuck,
stalled, failed, executor_down, host_down, message and discovery all interrupt
the human even when a planner owns the task and will answer or review itself.

The service should keep those items on the in-app attention list, but mark only
human-owned decisions as `important`. Delivery, presentation and the 7-day
ledger retention stay as they are.

## Goals

1. Ownership-based `notify` on task attention items: `important` only when the
   human owns the decision (started the root, or the planner handed it over).
2. Quiet operational noise: stuck, stalled (except caller-gone below),
   executor_down, host_down and discovery use `notify:"all"` so level-`all`
   users still see them and level-`important` users do not.
3. Caller-gone fallback: after a documented threshold, stalled
   `caller_decision` items raise **one** important notification per caller
   (`liveness.waitingOn`), not one per task.
4. Flapping cooldown: the same attention item id is not re-notified within a
   cooldown window even when `since` resets because the store deleted and
   re-created the entry.
5. One notification per task per dispatch pass: when several candidates share a
   `taskId`, send only the most severe (`sortItems` order) and ledger-ack the
   rest so they do not fire next pass.

## Non-goals

- Changing client delivery or presentation (desktop / TUI / browser / plugin
  fallback) — that stays on
  [2026-11-06 client-notification-delivery-design](2026-11-06-client-notification-delivery-design.md).
- Redesigning notification copy, actions or deep-link URL rules beyond the
  caller-gone grouped body.
- Changing the in-app attention list membership or severity ordering (only the
  `notify` field and the notify pump’s candidate selection change).
- Making `callerAlive` a hard requirement for caller-gone; when the process
  signal is `unknown`, the time threshold alone is the mechanism.

## Anti-goals

- Treating a missing or unknown `source` as human-owned.
- One OS banner per task when the same caller left several delegated tasks
  waiting past the threshold.
- Re-notifying on every flap of `executor_down` / stuck idle because `since`
  changed.

## Notify rules

| Kind / situation | `notify` | Why |
| --- | --- | --- |
| `account_signin`, `planner_quota` | `important` | Blocks all work; human must act |
| `setup`, `update` | `all` | Unchanged |
| `stuck`, `executor_down`, `host_down`, `discovery`, `discovery-network` | `all` | Operational; in-app list only at default level |
| `stalled` (not caller-gone) | `all` | Same |
| `stalled` + `liveness.reason === "caller_decision"` and age ≥ `CALLER_GONE_AFTER_S` | `important` (grouped in pump) | Caller may be gone; one banner per `waitingOn` |
| `review` (`review_requested`) | `important` | Planner handed the decision to the human |
| `message` with `messages.question` | `important` | Question counted for the human |
| `question` / `failed` / `limit` on a human-owned root | `important` | Human started the root |
| `question` / `failed` / `limit` / `message` when `liveness.escalatedAt` is set | `important` | Escalation handed the decision over |
| Same kinds on planner / work-tree children without handoff | `all` | Planner owns them |

**Human-owned root** (not a work-tree child): `work.userStarted` is true, or
`source` is `ui` \| `onboarding`, or `source` is `cli` **and** `origin` is not
an external agent id (`external:<agent>` / `external:<agent>:<session>`).
Missing/unknown `source` is **not** human-owned. `source` alone is not enough:
CLI `pacer delegate` from a planner session still records `source:"cli"` with
`origin:"external:<agent>:<session>"` — that root is planner-owned.

**Handoff:** `review_requested`, a message question for the human, or
`liveness.escalatedAt` (additive on the read-model liveness object).

## Pump behaviour (`src/notify/decide.ts`)

Constants (documented here; exported from rules/decide):

| Constant | Value | Role |
| --- | --- | --- |
| `CALLER_GONE_AFTER_S` | 1800 (30 min) | Age before stalled `caller_decision` becomes important |
| `NOTIFY_COOLDOWN_S` | 1800 (30 min) | Min gap before the same attention **id** may notify again |

1. **Cooldown:** skip a candidate when any ledger entry for that item id was
   recorded within `NOTIFY_COOLDOWN_S`, even if the `${id}:${since}` key is new.
2. **One per task:** among remaining candidates that share `taskId`, keep the
   first in `sortItems` order; ledger-ack the others without sending.
3. **Caller-gone group:** among important stalled items with `waitingOn`, emit
   one notification per caller (title/body naming the caller and task count);
   ledger-ack every member id. Items without `taskId` are unchanged.

Ledger pruning remains: drop entries older than 7 days on each dispatch.

## Caller alive vs slow

`callerAlive` (`src/messaging/caller-reach.ts`) returns `alive` \| `gone` \|
`unknown` from the recorded process identity. A live but reused pid is `gone`;
missing process metadata is `unknown`. The messaging broker uses that for wake
vs resume. Attention notify does **not** require a hard `gone` signal: when
identity is unknown, `CALLER_GONE_AFTER_S` is the only gate. Report this in the
implementation notes.

## Delegation `source` / `origin` audit

| Path | Sets `source`? | Sets `origin`? | Notes |
| --- | --- | --- | --- |
| CLI `pacer delegate` | yes `"cli"` | yes | `localHuman` → `"human"`; else `callerParticipant` (planner → `external:<agent>[:<session>]`) |
| MCP `task.delegate` | yes `"planner"` | yes | caller participant |
| API `task.delegate` | yes | yes | source: input, else `"ui"` for app/desktop/tui/tray, else `"planner"`; origin from input or caller |
| UI / `api/cmd` delegate | yes `"ui"` | yes | typically human |
| Onboarding try | yes `"onboarding"` | yes | |
| `dispatch.*` / `core/work` children | yes `"planner"` | parent / task origin | work-tree children are never human-owned for notify |
| Default in `tasks/api` when source omitted | yes `"planner"` | caller when no work parent | |

Ownership uses `origin` for CLI roots so a planner shelling out to
`pacer delegate` stays quiet at the default notify level.

## Constraints

- P1 / P4: additive read-model fields (`liveness.escalatedAt`,
  `work.userStarted`, `origin` on snapshot tasks) preferred; clients ignore unknowns.
- P9: no machine-specific paths in tracked files.
- Do not change client delivery/presentation.
- Keep the diff focused on `src/attention`, `src/notify`, needed read-model
  fields, tests and this spec.
- Native Rust attention (`crates/read-model`) should mirror `notify` so
  managed-attention parity stays green; if parity cannot be updated in the
  same change, call that out explicitly (do not silently diverge).

## Thresholds chosen

- Caller-gone: **30 minutes** (`CALLER_GONE_AFTER_S = 1800`).
- Notify cooldown: **30 minutes** (`NOTIFY_COOLDOWN_S = 1800`).
- Ledger retention: **7 days** (unchanged).

## Addendum 2026-11-25 — workflow-run ownership (issue #1278, PR D)

The maintainer decided that a planner-started run's blocking items escalate
after the caller has been silent for `CALLER_GONE_AFTER_S`, the same way a
stalled `caller_decision` task does. The task-ownership rules above are
unchanged; this addendum adds the run case. The maintainer also decided that a
NULL `origin` identifies a pre-upgrade run and stays human-owned (blocking items
were always `important` before origin existed), while every new run must record
an origin: `unknown:<caller id>` is used when the caller is neither the human
nor an identified external agent.

### Run origin

`workflow_runs.origin` is a nullable `TEXT` column, added with the same
idempotent `ALTER TABLE ... ADD COLUMN` pattern as the other run columns in
`workflowDatabase` (inside the write transaction, never on a read, and never
backfilled):

- `"human"` — the run was started by the local human (app-authenticated, or an
  explicit local-human participant).
- `"external:<kind>[:<session>]"` — a planner/external agent started it. The
  value is the caller participant id from `callerParticipant`, so it also names
  the caller for grouping. It is never taken from a `run.start` request field.
- `NULL` — a pre-upgrade row written before the column existed. It **is**
  human-owned at read time so old runs keep the pre-change behavior: blocking
  items were always `important`. New runs never write `NULL`. An unidentified
  local caller (for example a non-TTY CLI `run.start` outside a planner session)
  is recorded as the real participant `external:local` under ADR 0011, not `NULL`.
- `unknown:<caller id>` — a caller id that is neither `human` nor an identified
  external participant (for example `orchestrator` or `task:<id>`). It is an
  explicit non-human value, never an external caller: it carries no `waitingOn`
  and its blocking items wait out `CALLER_GONE_AFTER_S` before escalating.

In `run.start`, the caller participant id is recorded when it is `human` or
`external:...`; any other caller id is recorded as `unknown:<caller id>`, so a
new run is never written with a NULL origin. `startRun` writes `origin` at
insert. Child runs (`parentRunId`) inherit their parent's origin; because every
child does, the origin on any run in the tree is the root's origin and no
ancestry walk is needed. `runEntityValue` and the snapshot run read model expose
`origin` additively (P4). The Rust read model reads the column defensively
(`PRAGMA table_info`) so an older schema stays readable.

### Notify rules for run attention

`src/attention/rules.ts` exports `runOwnedByHuman`, `runExternalCaller` and
`notifyLevelForRun`; `src/workflow/attention.ts` calls them for every run item
instead of hard-coding `notify` (the six values previously hard-coded):

| Situation | `notify` |
| --- | --- |
| `budget_spent`, `budget_msg_spent`, `orchestrator_failed`, `orchestrator_blocked`, unresolved wake, or a blocking `question` on a human-origin root — including a legacy NULL origin | `important` |
| The same blocking kinds on an external-origin or `unknown:<id>` root, age < `CALLER_GONE_AFTER_S` | `all` |
| The same blocking kinds on an external-origin or `unknown:<id>` root once `since` is at least `CALLER_GONE_AFTER_S` old | `important` |
| `budget_warn`, `budget_msg_warn` | `all` (always) |
| `question` with `unblocks:"nothing"` | `all` (always) |

`since` is when the blocking condition was raised (question `createdAt` or the
run's per-kind attention clock), not when the run started. A run item with an
external origin carries `waitingOn: origin`, so once it escalates the existing
caller-gone grouping in `src/notify/decide.ts` emits one banner per caller
instead of one per run. `callerGoneCandidates` therefore groups any important
item with `waitingOn`, not only `stalled` items; human, legacy NULL and
`unknown:<id>` roots and warning items never carry `waitingOn`, so an `unknown:`
run escalates as an ordinary ungrouped banner. Grouping copy and the 7-day
ledger retention are unchanged.

The Rust read model mirrors `notify` and `waitingOn` for run questions
(`crates/read-model/src/attention.rs`), including the legacy-NULL human-owned
rule and the non-human `unknown:` fallback, and exposes `origin` on snapshot
runs (`crates/read-model/src/runs.rs`), keeping managed-attention parity green.

### Live validation (CT-11)

Sandbox `wnorigin` (unseeded, isolated `PACER_HOME`/`HOME`/port, TypeScript core).
Two real runs were started through the service: one with an app-authenticated
HTTP `run.start` (origin `human`), one through the guarded CLI (origin
`external:local`). Blocking person questions were then seeded into the
disposable home so the service's own attention derivation decided `notify`.
Evidence: `.work/live/wnorigin/evidence/report.md`.

| Behavior | Verdict |
| --- | --- |
| `origin` visible in `run.list` for both starts | PASS |
| Human-origin blocking question → `notify:"important"`, no `waitingOn` | PASS |
| External-origin blocking question → `notify:"all"` with `waitingOn:external:local` | PASS |
| After aging past `CALLER_GONE_AFTER_S` → `notify:"important"`, `waitingOn` retained | PASS |
| Caller-gone grouped banner delivery | PASS — second sandbox, registered notifier |

Summary: sandbox `wnorigin` 4 PASS, 0 FAIL; sandbox `wnotify2` 2 PASS, 0 FAIL
(evidence: `.work/live/wnotify2/evidence/report.md`). With an app notifier client
registered, two old blocking questions on an `external:local` run produced one
`notify` event keyed `caller_gone:external:local` ("2 delegated tasks waiting"),
delivered to that client, with both member ids acked in `notified.json`. No live
surface remains UNVERIFIED. The generators for `test/read-model-parity.test.ts`
(`UPDATE_READ_MODEL_GOLDEN=1`, `EXPORT_RUST_READ_MODEL=1`) were run: no golden change
was needed because the shared fixtures have no workflow-run rows; deterministic
origin coverage lives in the Rust and TypeScript tests instead.

The NULL-legacy human-owned rule and the `unknown:<caller id>` fallback recorded
in this addendum were added in the 2026-11-25 fix round and are covered by
TypeScript and Rust tests; those two specific values were not exercised in the
sandboxes above.
