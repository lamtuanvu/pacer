import type { Ctx } from "../types";
import { loadStrategy, type Strategy } from "../config/strategy";
import { dispatchConfigSchema, previewInputSchema, type DispatchPreview, type Observation } from "../dispatch/types";
import { collectObservations, statusObservationAdapter, type ObservationAdapter } from "../dispatch/observations";
import { buildModelInventory } from "../dispatch/inventory";
import { buildCandidates } from "../dispatch/candidates";
import { decisionHash, ladderEngine, runDecision, type DecisionEngine } from "../dispatch/engines";
import { computeStatus, type Status } from "../engine/status";
import { rankExecutors } from "../engine/rank";
import { slotBlock, slotUse } from "../engine/slots";
import { listTasksWhere } from "../tasks/store";
import { readHostReachability, remoteExclusion } from "../remote/eligibility";
import { projectSnapshot, resolvePolicyRepoInput } from "./project-policy";
import { CoreError } from "./errors";

export interface DispatchDependencies {
  strategy?: Strategy;
  status?: (ctx: Ctx, strategy: Strategy) => Promise<Status>;
  adapters?: readonly ObservationAdapter[];
  engine?: DecisionEngine;
}

/** Read-only recommendation. Does not reserve capacity, activate strategies or launch work. */
export async function previewDispatch(ctx: Ctx, input: unknown, deps: DispatchDependencies = {}): Promise<DispatchPreview> {
  const startedAt = performance.now();
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid dispatch preview input");
  const brief = parsed.data;
  const strategy = deps.strategy ?? loadStrategy(ctx);
  const config = strategy.dispatch ?? dispatchConfigSchema.parse({});
  const repo = await resolvePolicyRepoInput(ctx, brief.repo);
  const selection = projectSnapshot(ctx, strategy, repo.key).selection;
  const status = await (deps.status ?? ((c, s) => computeStatus({ ...c, readOnly: true }, s, {cacheOnly: true})))(ctx, strategy);
  const existing = rankExecutors(brief.kind ?? null, strategy, Object.fromEntries(status.providers.map(p => [p.id, p])), selection && {executors: selection.executors, order: "configured"});
  const excluded: DispatchPreview["excluded"] = existing.excluded.map(e => ({id: e.id, reason: e.reason}));
  const use = slotUse(listTasksWhere(ctx, {states: ["running"], all: true}));
  const allowed = new Set<string>();
  for (const runner of existing.ranked) {
    const host = strategy.runners[runner.id].host;
    const cached = host ? readHostReachability(ctx, strategy.hosts[host]) : null;
    const unknownHost = host && (!cached || cached.at > ctx.now || ctx.now - cached.at >= 60);
    const reason = slotBlock(strategy, runner.id, use) ?? (unknownHost ? `host ${host} reachability unknown (cached preview)` : await remoteExclusion({ ...ctx, readOnly: true }, strategy, runner.id, {repo: repo.path, placement: "new"}, {reachable: async () => cached?.reachable === true, skipSlots: true}));
    if (reason) excluded.push({id: runner.id, reason});
    else allowed.add(runner.id);
  }
  const declaredInventory = buildModelInventory(strategy, [], ctx.now).filter(m => allowed.has(m.runner));
  const scopes = [
    ...[...allowed].map(id => ({runner: id, account: strategy.runners[id].account})),
    ...declaredInventory.map(m => ({runner: m.runner, account: m.account, binding: m.binding})),
  ];
  const observations: Observation[] = await collectObservations(ctx, deps.adapters ?? [statusObservationAdapter(status)], scopes, config.timeoutMs);
  const task = {kind: brief.kind ?? null, requirements: brief.requirements, preferences: brief.preferences, provenance: "request" as const, ...(brief.model ? {model: brief.model} : {})};
  const inventory = buildModelInventory(strategy, observations, ctx.now).filter(m => allowed.has(m.runner));
  const built = buildCandidates(strategy, task, inventory, observations, ctx.now);
  const strategyHash = decisionHash({dispatch: config, inventory, project: selection?.references ?? null});
  const observationRevision = decisionHash(observations);
  const request = {schemaVersion: 1 as const, requestId: decisionHash({task, strategyHash, observationRevision, now: ctx.now}), now: ctx.now,
    deadline: ctx.now + config.timeoutMs / 1000, task, candidates: built.candidates, observations, observationRevision, strategyHash, config};
  const preview = await runDecision(request, deps.engine ?? ladderEngine, () => ctx.now + (performance.now() - startedAt) / 1000);
  return { ...preview, excluded: [...excluded, ...built.excluded], uncertainty: [
    ...built.candidates.filter(c => !c.capacityKnown).map(c => `${c.id}: capacity unknown`),
    ...inventory.filter(m => m.binding.kind === "executor-default").map(m => `${m.runner}: executor default model unresolved`),
    "Preview uses cached observations and makes no reservation; dispatch may differ.",
  ] };
}
