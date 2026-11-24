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
