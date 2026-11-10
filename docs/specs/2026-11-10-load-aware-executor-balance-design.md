# Load-aware executor balance

Status: draft, awaiting maintainer approval of the full document (2026-11-10).

## Why

The maintainer has several good executors configured, but pacer keeps most of them idle.

Routing today fills the top executor before it uses the next one:

1. `rankExecutors` (`src/engine/rank.ts`) orders candidates by budget only: the
   `pacing.policy` order or score, verdict tiers, and `pacing.accounts` spread/fill within
   one agent and account kind. It never sees how many tasks each executor is running.
2. At admission, inside the `slots` lock, the runner (`src/tasks/runner.ts`, the
   `slotBlock` filter) and the queue drain (`src/tasks/drain.ts`, `permitted.find`) take
   the **first** ranked candidate that is not at its `max_tasks`.
3. So an executor only gets work once every executor ranked above it is full. With the
   maintainer's strategy, `codex` had `max_tasks: 16`, the same as
   `execution.local_max_tasks: 16`. Codex could take every local slot, so tse, oc-glm and
   cursor almost never got a task.
4. `pacing.accounts: spread` doesn't help. It only reorders accounts of the same
   `agent:kind` group and skips endpoint accounts, and tse and oc-glm are endpoints.

Interim workaround (applied 2026-11-10 to the maintainer's strategy): lower `max_tasks`
on the top executors (codex 3, tse 3, oc-glm 4, cursor 4), so spillover starts after a few
tasks. It is still fill-then-spill and depends on hand-tuned caps.

## Goals

- When several executors can take a task and are equally acceptable on budget, send the
  task to the **least-loaded** one. Under load, work spreads across all executors instead
  of piling onto the first.
- Budget safety stays first. Balance never moves work onto an executor that the policy
  ranks as worse on budget (an AHEAD or uncertain account), and never moves work off an
  EXPIRING one.
- Off by default. Existing strategies behave exactly as before until they opt in.
- The preview (`pacer route`, `dispatch.explain`) and the actual pick agree on the order.

## Non-goals

- No change to `max_tasks`, host or local caps, the machine guard, or how eligibility is
  computed. Caps still filter candidates and balance only reorders the ones left.
- No quality-aware or kind-aware weighting, such as "tse is better at refactors". Kinds
  keep using `routing` rules.
- No cross-machine scheduler or queue rebalancing of tasks that are already running.
- No settings UI in this change. The key goes into the config and settings surface so the
  existing generic setting editors and `pacer config set` can set it. A dedicated control
  is a later UI change and must pass the design-canvas gate.
- No change to how the planner sends work. Planners delegating one task at a time
  is a separate behavior issue.

## Anti-goals (failure even if it "works")

- Balance sends work to an AHEAD, NEAR_LIMIT or uncertain account while a better-tier
  account has free slots, or puts metered ahead of cheaper executors under `cheapest-first`.
- Two tasks admitted at the same moment both see the same "least loaded" executor and pile
  onto it.
- The routing explanation says one thing and the runner does another.
- A user's explicit executor choice (`requestedExecutor`, a conversation's chosen executor)
  gets overridden.

## Design

### Config

New strategy key `pacing.balance`, with values `off` (default) or `least-loaded`.

- TypeScript: parse and validate in `src/config/strategy.ts` next to `pacing.accounts`.
  The error message follows the existing one: `pacing.balance must be off or least-loaded`.
- Rust: mirror it in `crates/config/src/strategy_validation.rs` and add
  `pacing.balance` to the settings keys in `crates/config/src/settings.rs`, then regenerate
  `crates/client-protocol` (the settings-key enum) through the normal codegen. Keep
  `crates/config/tests/strategy_parity.rs` green.

### Balance step

Add a pure function in a new module `src/engine/balance.ts`:

```ts
balanceByLoad(ranked: RankedExecutor[], s: Strategy, use: SlotUse, statuses: Record<string, ProviderStatus>): RankedExecutor[]
```

- If `s.pacing.balance !== "least-loaded"`, return `ranked` unchanged.
- Split `ranked` into **bands** of consecutive candidates that are equally acceptable on
  budget. The band key is:
  - certain vs uncertain (`fallback === "uncertain"`); uncertain stays last, as today;
  - verdict tier: `EXPIRING` / `BEHIND`·`ON_PACE`·`UNKNOWN` / `NEAR_LIMIT` / `AHEAD`.
    This is the `priority` tiers with `NEAR_LIMIT` split out behind the normal band, so
    balance never prefers a near-limit account over one with headroom (planner's call);
  - under `pacing.accounts: fill`, whether the account has yielded (the `yielded` test in
    `rank.ts`: a window BEHIND/AHEAD or at `fill_threshold`). Yielded accounts form a later
    band, so fill still uses one account before the next (planner's call); `statuses`
    is passed in for this and for the verdict tiers;
  - under `cheapest-first` only, also the usage tier (`TIER` in `rank.ts`), so metered
    executors never jump ahead of cheaper ones. Under the other policies, usage kind is
    **not** part of the band. Subscriptions and metered endpoints share work by free capacity.
    Maintainer decision (2026-11-10): with `priority`, the order already says metered
    endpoints are acceptable, and spreading across them is the point.
  
  Bands are formed only from **adjacent** runs with the same key, so the policy's band
  order is never changed.
- Within a band, stable-sort by utilization `used / limit`. `used` is
  `use.byExecutor[id] ?? 0` and `limit` is `slotLimit(s, id).executor`. Ties keep the
  policy order, so the policy still says who goes first when loads are equal. This gives
  round-robin by capacity share: with codex at 3 slots and tse at 3 slots, tasks alternate
  codex, tse, codex, …
- Replace each moved candidate's `reason` with a load note appended, such as
  `on pace, used 0% / pace 0% · load 1/3`, so the routing explanation shows why.

Bands do not depend on the score of score-based policies (`even`, `burn-before-reset`).
Inside a band, load beats the score difference. That is the point of opting in.

Utilization of 1 or more cannot occur after the busy filter; in a preview that does not
filter (see below), such candidates sort to the end of their band.

### Where it runs

The step must run with the **same** `SlotUse` that admission checks, under the `slots`
lock, so two concurrent admissions never see stale load. Each admission writes
`state = "running"` and `executor` before releasing the lock, so the next one counts it.

1. **Runner** (`src/tasks/runner.ts`, inside `withLock(ctx, "slots", …)` where `use` is
   computed): after filtering busy candidates, apply `balanceByLoad(ranking.ranked, s, use)`
   before the first candidate is picked.
2. **Queue drain** (`src/tasks/drain.ts`, inside the `slots` lock where `use` is computed):
   apply the same reorder to `permitted` before `permitted.find(...)`. `permitted` holds ids,
   so either balance on the `RankedExecutor` list it is derived from, or add a thin
   id-list wrapper. That choice is left to the builder.
3. **Drain reservation is kept.** The drain reserves `t.executor` and spawns the runner,
   which ranks again on its fresh start. When the task already holds a drain reservation
   that is still admissible, the runner keeps it first and does not rebalance away from it.
   Otherwise the runner's own load count (which excludes the task itself) could flip the
   choice (planner's call). Tests assert the executor the task finally runs on.
4. **Preview, `dispatch.explain`** (`src/core/dispatch-explain-ranked.ts`): it already
   computes `slotUse(slotTasksReadOnly(store), ctx)` and filters busy candidates with
   `slotBlock`. Apply `balanceByLoad` after that filter. `decisionHash` keeps hashing the
   **budget** order from before the balance step, so the revision does not change every
   time a task starts (planner's call).
5. **Preview, `routing.route`** (`src/core/routing.ts`): today it neither counts load nor
   filters busy executors. With balance on, it computes slot use the same way, applies
   `balanceByLoad`, and leaves full executors in the list after their band (see above).
   It does not move them to `excluded`, so `route` output keeps its meaning (planner's call).
   The conversation preview currently passes all runners as a `configured` selection,
   while the runner passes none. For balance, the conversation preview uses the policy
   bands, as the runner does.
6. **Native Rust route.** Plain `pacer route` (no goal/repo) is answered natively:
   `crates/server/src/native/status_ops.rs` `routing_route` → `usage_broker` →
   `crates/engine/src/status.rs` `rank_route`, which has no slot-use input. When the
   strategy has `pacing.balance: least-loaded`, `routing_route_stays_forwarded` must also
   return true, so the TypeScript path serves the preview. Add a unit test next to
   `routing_route_stays_forwarded_for_goal_or_repo`. Porting the balance step to Rust is
   out of scope.

### What it does not touch

- **Explicit choice wins.** If `task.requestedExecutor` is set and routable, the existing
  `requested` path keeps it first. Balance only reorders the fallback list after it.
  Same for a conversation's chosen executor and `conversationFallback`.
- **Managed work dispatch** (`resolveTaskDispatch` replacing `ranking.ranked` with the
  dispatch engine's choices): leave the engine's order alone in this change. (Planner's
  call; dispatch engines own their own ranking. Revisit if managed work shows the same
  pile-up.)
- **Project selections** (curated `order: "configured"`): balance **does** apply, treating
  the whole selection as one band per certainty tier, because the selection branch has no
  verdict tiers. (Planner's call. The maintainer's complaint is about utilization, and a
  project that wants a strict order can leave balance off. Flagged for review below.)
- **Rust `rank_executors` / `rank_route`** (`crates/engine`): unchanged. They compute the
  budget preference shown in the planner budget block ("Executor preference: …"), which
  stays a budget-only view. Balance is an admission-time step on top of it. Only the
  forwarding check changes (step 6 above).

### Routing explanation

`routing.why` in the task record already starts with the pick reason. When balance
changed the winner (the pick differs from the first candidate in the policy order), it
reads, for example: `least loaded (tse 0/3; codex 2/3 ahead in order)`. Exact wording is
the builder's call within `.project/rules/ui.md` text conventions.

## Testing

- Unit (`test/engine/balance.test.ts`):
  - `off` returns the input untouched;
  - equal-band candidates sort by utilization with policy-order tie-break;
  - EXPIRING, AHEAD and uncertain bands never mix;
  - under `cheapest-first`, metered never passes unmetered;
  - utilization uses each executor's own `max_tasks` (1/3 < 2/4).
- Runner and drain: with two executors with `max_tasks: 3` and balance on, four queued
  tasks drained in one pass land 2/2. With balance off they land 3/1, the current
  behavior and a regression guard.
- Concurrency: two runners admitted back-to-back under the lock pick different executors.
- Config: TS and Rust accept `off`/`least-loaded`, reject other values with matching
  problems; parity test covers the key.
- Live validation (CT-11, `bun run live`, sandbox `PACER_HOME`/`HOME` only): a strategy with
  three fake or fixture executors, balance on, delegate several tasks in parallel, and
  record the executor spread and `pacer route` previews in the evidence report.

## Left to the builder

- Module layout beyond `src/engine/balance.ts`, the helper signatures, and how `drain.ts`
  gets a ranked list.
- Exact reason and explanation wording.
- Whether `pacer route --json` gains a `load` field per candidate (nice to have, additive).

## Planner's calls to check

- NEAR_LIMIT gets its own band behind the normal one.
- `accounts: fill` keeps fill order through a yielded/unyielded band split.
- The runner keeps a still-admissible drain reservation.
- The `dispatch.explain` revision hashes the pre-balance budget order.
- `routing.route` sorts full executors to the end of their band and doesn't exclude them.
- With balance on, the native Rust route forwards to TypeScript.
- Managed-work dispatch engines keep their own order.
- Balance applies to curated project selections.

## Maintainer decisions

- 2026-11-10: balance spreads across subscriptions and metered endpoints, with no usage-kind
  band outside `cheapest-first`.
- Default stays `off`. The maintainer's own strategy sets `least-loaded` after merge.
