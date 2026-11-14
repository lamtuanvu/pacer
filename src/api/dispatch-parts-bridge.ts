import { z } from "zod";
import { classifierConfig } from "../config/classifier";
import { loadStrategy, StrategyError } from "../config/strategy";
import { CoreError } from "../core/errors";
import { enforcementExclusion, enforcementExclusionCached } from "../dispatch/enforcement";
import { draftSchema } from "../dispatch/explain-input";
import { openReadOnlyStore } from "../dispatch/readonly";
import { executorExclusion } from "../executors/availability";
import { draftStrategy } from "../strategy/service";
import type { Ctx } from "../types";

const runners = z.array(z.string().min(1).max(256)).max(512);
/**
 * Params of the sealed dispatch parts route: the HTTP `/_internal/dispatch-parts` body and the stdio
 * `_internal.dispatch.parts` params beside `key`. Each kind reads what native `dispatch.preview` and
 * `dispatch.explain` cannot compute, for the active strategy or an explain's `draft`.
 * - `dispatch.executor-guards`: `executorExclusion` for each runner and whether the classifier is configured,
 *   read-only.
 * - `dispatch.enforcement-exclusions`: native-control enforcement for each runner in `repo`. `cached: true` is
 *   explain's read-only `enforcementExclusionCached`; `false` is preview's `enforcementExclusion`, which may run
 *   `--version` and fills the version cache. A `draft` is read only, so it requires `cached: true`.
 */
const params = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dispatch.executor-guards"), runners, draft: draftSchema.optional() }).strict(),
  z.object({ kind: z.literal("dispatch.enforcement-exclusions"), repo: z.string().min(1).max(4096), runners,
    cached: z.boolean(), draft: draftSchema.optional() }).strict()
    .refine(p => !p.draft || p.cached, { path: ["draft"], message: "requires cached: true" }),
]);

/** The largest request either route accepts: an explain's draft (64 KiB) and the strategy's runner ids. */
export const DISPATCH_PARTS_MAX = 256 * 1024;

function draft(ctx: Ctx, input: z.output<typeof draftSchema>) {
  try { return draftStrategy(ctx, input); }
  catch (e) { throw new CoreError("invalid_input", "Invalid strategy draft", e instanceof StrategyError ? e.problems.join("; ") : String((e as Error).message)); }
}

export async function dispatchPartsFor(ctx: Ctx, input: unknown) {
  const parsed = params.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  const p = parsed.data;
  const ro = { ...ctx, readOnly: true };
  const strategy = p.draft ? draft(ro, p.draft) : loadStrategy(ctx);
  if (p.kind === "dispatch.executor-guards") {
    let admissionHooks = false;
    try { admissionHooks = classifierConfig(strategy).configured; } catch { /* no classifier config */ }
    return { guards: p.runners.map(runner => ({ runner, reason: executorExclusion(ro, strategy, runner) ?? null })), admissionHooks };
  }
  if (!p.cached) return Promise.all(p.runners.map(async runner => ({ runner, reason: await enforcementExclusion(ctx, strategy, runner, p.repo), unverified: null })));
  const store = openReadOnlyStore(ro);
  try {
    return await Promise.all(p.runners.map(async runner => ({ runner, ...await enforcementExclusionCached(ro, strategy, runner, p.repo, store) })));
  } finally { store.close(); }
}
