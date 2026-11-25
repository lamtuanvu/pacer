# Planner tier fallback

## Problem

Pacing mode (STRICT when the planner is AHEAD of its weekly pace) keeps the planner's account out of the executor pool. Tier targets (`dispatch.tierTargets`, e.g. `complex → frontier`) say which model tier a task needs. When the only eligible executors declare models below the target tier, for example an OpenCode account with one `small` and one `medium` model, a `complex` task goes to an under-qualified executor (`executor-fixed-below-target`). Meanwhile the planner account has a frontier model and quota left, even if it is ahead of pace.

Burning planner quota on a large task is better than handing it to a model that cannot do it.

## Behavior

New strategy setting `pacing.planner_tier_fallback`: `"on" | "off"`, default `"on"`.

When it is on, the fallback guards only **complex** tasks, or a dispatch brief with an explicit `requirements.minTier` (`fallbackTier`). Standard and simple tasks rank exactly as before, so setups whose executors declare no tiers do not send routine work to the planner. For a guarded task with target tier `T` (`targetTier(difficulty, tierTargets, minTier)`), executor selection does this:

1. Rank the normal pool as today (planner excluded unless `includePlanner`).
2. If at least one ranked, admissible executor declares a model whose tier is known and `>= T`, nothing changes.
3. Otherwise, if the planner runner (`findPlannerRunner`) declares a model whose tier is known and `>= T`, the planner becomes a candidate for this task and is ranked **first**. Its reason is `planner tier fallback: no <T> executor available`, and the entry carries `tierFallback: { targetTier, reason }`.
4. The fallback skips the pace verdict (AHEAD) and `pacing.planner_reserve_headroom`. It still honors the hard exclusions: runner disabled, not installed, signed out, broken, blocked by the user, budget exhausted with `allow_paid` off, `max_tasks` slots, and delegation enforcement.
5. A planner whose declared tier is `unknown` (no `models:` block) never qualifies. `docs/configuration.md` explains that declaring `tier: frontier` on the planner runner's model enables the fallback.
6. An explicit `executor` or `model` in the brief wins over the fallback, as today.
7. When every planner slot (`max_tasks`) is busy, the task waits in the queue (`no_slot`) for the planner instead of running on an executor below its tier, in both the runner and the queue drain. A task whose planner attempt already failed this run (for example on a limit) may retry on the next executor; managed dispatch work follows its dispatch engine.

The planner still runs as a **managed** headless executor task (worktree, attempt record, review), never in-process in the planner session.

## Surfaces

- `rankExecutors` (`src/engine/rank.ts`, `applyPlannerTierFallback`) takes an optional `targetTier`. Its Rust twin (`crates/engine/src/lib.rs`, `apply_planner_tier_fallback`) matches it, and shared engine goldens (`tier-fallback*` in `test/fixtures/engine/goldens.json`) check both.
- The fallback runs in both branches: the policy-ordered pool and a project selection. The planner goes first with a score one above the best candidate (a selection renumbers as usual), and the entry carries `tierFallback: { targetTier, reason }`.
- Call sites that pass the target tier:
  - the legacy delegate path (`src/tasks/runner.ts`, both rankings, and the queue drain `src/tasks/drain.ts`, from the task's difficulty);
  - `previewDispatch` and its Rust twin (difficulty plus `requirements.minTier`);
  - `dispatch.explain` for unmanaged tasks (TS `explainRankedDispatch`, Rust `explain_delegate`);
  - `routing.route`.
- `pacer route <kind> --difficulty simple|standard|complex` sets the target tier and shows the fallback reason. `routing.route` with `difficulty` is forwarded to TypeScript, as a `goal` already is.
- Status: `executors.tierFallback: { runner, targetTier, reason }` is present only while the planner is the only executor at the complex-task tier (TS `withTierFallback`, Rust `compose_status`). The session-start budget block then adds `Tier fallback: complex tasks route to <planner> (no other <tier> executor available).`
- Config: `pacing.planner_tier_fallback` (`on`/`off`) in both validators, in `pacer config get/set`, and in strategy-write leaves.

## Known limits

- The planner's sign-in state is measured only for conversation and orchestrate turns, so a signed-out planner can be ranked by the fallback. Its launch then fails like any signed-out executor's.
- `task.retry_options` and the task-detail executor list rank without a target tier.
- Under `pacing.balance: least-loaded`, the fallback pick keeps a band of its own, so load never moves it behind an under-qualified executor.

## Out of scope

- Guessing model tiers. Tiers stay declared by the person.
- Mid-flight stop when the planner's quota runs low.
