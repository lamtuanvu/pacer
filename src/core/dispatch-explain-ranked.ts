import type { z } from "zod";
import type { Strategy } from "../config/strategy";
import { classifierConfig } from "../config/classifier";
import { decisionHash } from "../dispatch/engines";
import type { explainInputSchema } from "../dispatch/explain-input";
import { slotTasksReadOnly, type ReadOnlyStore } from "../dispatch/readonly";
import { exclusionReason, reason, type Reason } from "../dispatch/reasons";
import { conversationFallback, rankExecutors } from "../engine/rank";
import { slotBlock, slotUse } from "../engine/slots";
import { computeStatus } from "../engine/status";
import { executorExclusion } from "../executors/availability";
import { readHostReachability, remoteExclusion } from "../remote/eligibility";
import type { Ctx } from "../types";
import type { DispatchDependencies } from "./dispatch";
import type { Choice, Fallback, RouteExplanation } from "./dispatch-explain";
import { readPause } from "./pause";
import { projectSnapshot, resolvePolicyRepoInputReadOnly } from "./project-policy";

/** Unmanaged tasks use executor ranking, without model candidates or native-control enforcement. */
export async function explainRankedDispatch(
  ctx: Ctx, strategy: Strategy, p: z.output<typeof explainInputSchema>, kind: RouteExplanation["kind"],
  requested: string | null, store: ReadOnlyStore, deps: Pick<DispatchDependencies, "status">,
): Promise<RouteExplanation> {
  const repo = await resolvePolicyRepoInputReadOnly(ctx, p.repo);
  const selection = projectSnapshot(ctx, strategy, repo.key).selection;
  const status = await (deps.status ?? ((c, s) => computeStatus({ ...c, readOnly: true }, s, { cacheOnly: true, includePlannerSignIn: p.interactionMode === "conversation" })))(ctx, strategy);
  // As in the runner, a conversation's requested executor is a preference, not a narrower candidate set.
  const byId = Object.fromEntries(status.providers.map(s => [s.id, s]));
  const ranking = rankExecutors(kind.value, strategy, byId,
    selection && { executors: selection.executors, order: "configured" }, { includePlanner: p.interactionMode === "conversation" });
  if (p.interactionMode === "conversation" && !selection) conversationFallback(ranking, kind.value, strategy, byId, requested);
  const exclusions = new Map(ranking.excluded.map(e => [e.id, exclusionReason(e.id, e.reason, e.eligibility)]));
  const use = slotUse(slotTasksReadOnly(store));
  const eligible: typeof ranking.ranked = [];
  for (const candidate of ranking.ranked) {
    const host = strategy.runners[candidate.id].host;
    const cached = host ? readHostReachability(ctx, strategy.hosts[host]) : null;
    const unknownHost = host && (!cached || cached.at > ctx.now || ctx.now - cached.at >= 60);
    const guard = executorExclusion(ctx, strategy, candidate.id) ?? slotBlock(strategy, candidate.id, use)
      ?? (unknownHost ? `host ${host} reachability unknown (cached preview)` : await remoteExclusion(ctx, strategy, candidate.id,
        { repo: repo.path, placement: "new" }, { reachable: async () => cached?.reachable === true, skipSlots: true }));
    if (guard) exclusions.set(candidate.id, exclusionReason(candidate.id, guard));
    else eligible.push(candidate);
  }
  const reasons: Reason[] = [];
  const uncertainty: Reason[] = [reason("cached_preview", "info")];
  const ignored = Object.entries({ requirements: Object.keys(p.requirements).length > 0,
    preferences: p.preferences.models.length > 0 || p.preferences.strengths.length > 0, model: !!p.model, difficulty: !!p.difficulty })
    .filter(([, supplied]) => supplied).map(([field]) => field);
  if (ignored.length) uncertainty.push(reason("ranked_inputs_ignored", "info", { fields: ignored.join(", ") }));
  if (!store.available) uncertainty.push(reason("tasks_unavailable", "info"));
  try { if (classifierConfig(strategy).configured) uncertainty.push(reason("admission_hooks", "info")); } catch { /* no classifier config */ }
  let top: (typeof eligible)[number] | undefined = eligible[0];
  let outcome: RouteExplanation["outcome"] = top ? "select" : "queue";
  if (requested) {
    reasons.push(reason("override", "info", { executor: requested }, requested));
    const hit = eligible.find(e => e.id === requested);
    const why = exclusions.get(requested);
    if (hit) { top = hit; outcome = "override"; }
    else if (why && ["blocked_by_user", "quota_exhausted", "executor_busy", "machine_busy"].includes(why.code)) {
      top = undefined;
      outcome = why.code === "blocked_by_user" || why.code === "quota_exhausted" ? "fail" : "queue";
      reasons.push(why);
    } else reasons.push(reason("override_unavailable", "fail", { requested, reason: why?.code ?? "not_ranked" }, requested,
      `${requested} cannot take the task; the ranked pick is used instead.`), ...(why ? [why] : []));
  }
  const pause = readPause(ctx);
  if (pause) { top = undefined; outcome = "queue"; reasons.push(reason("paused", "fail", { until: pause.until })); }
  const choice = (id: string): Choice => {
    const runner = strategy.runners[id];
    return { executor: runner.agent, runner: id, account: runner.account, model: { kind: "executor-default" }, host: runner.host ?? null };
  };
  const chosen = top ? choice(top.id) : null;
  if (top) reasons.push(reason("rank_match", "pass", { policy: strategy.pacing.policy, score: top.score, reason: top.reason }, top.id, top.reason));
  else if (!pause && reasons.length === 0) reasons.push(reason("no_executor_ranked", "fail"));
  const fallbacks: Fallback[] = pause ? [] : eligible.filter(e => e.id !== top?.id).map(e => {
    const c = choice(e.id);
    return { executor: c.executor, runner: c.runner, account: c.account, state: "eligible",
      reason: reason("rank_match", "pass", { policy: strategy.pacing.policy, score: e.score, reason: e.reason }, e.id, e.reason) };
  });
  for (const [id, why] of exclusions) {
    if (!strategy.runners[id]) continue;
    const c = choice(id);
    fallbacks.push({ executor: c.executor, runner: id, account: c.account, state: "excluded", reason: why });
  }
  for (const e of eligible) uncertainty.push(reason("default_model_unresolved", "info", {}, e.id));
  const plannerAccount = strategy.planner.account;
  const account = status.accounts?.find(a => a.name === plannerAccount);
  const window = account && account.usedPct !== null
    ? { account: plannerAccount, usedPct: account.usedPct, pacePct: account.pacePct, mode: status.mode } : null;
  const captured = status.accounts?.flatMap(a => a.capturedAt === null ? [] : [a.capturedAt]) ?? [];
  const revision = decisionHash({ mode: "ranked", kind,
    ranked: ranking.ranked.map(({ eligibility: _eligibility, ...r }) => r),
    exclusions: [...exclusions].map(([id, why]) => [id, why.code, why.facts]), requested, paused: pause?.until ?? null,
    runners: strategy.runners, pacing: strategy.pacing, selection: selection?.references ?? null, planner: window, accounts: status.accounts?.map(a => ({ name: a.name, usedPct: a.usedPct, pacePct: a.pacePct })) });
  return {
    schemaVersion: 1, mode: "ranked", revision, at: Math.floor(ctx.now), observedAt: captured.length ? Math.min(...captured) : null,
    outcome, kind, strategy: { name: strategy.name, draft: !!p.strategyDraft, source: selection ? "project" : "strategy" },
    engine: { id: "rankExecutors", version: "1" }, chosen, step: null, reasons, fallbacks,
    planner: { state: "unknown", reason: chosen?.account === plannerAccount ? "planner_is_executor" : "planner_not_measured", window }, uncertainty,
  };
}
