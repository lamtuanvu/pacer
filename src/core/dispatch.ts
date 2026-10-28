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
import { listTasksWhere, readTask } from "../tasks/store";
import { readHostReachability, remoteExclusion } from "../remote/eligibility";
import { projectSnapshot, resolvePolicyRepoInput, resolvePolicyRepoInputReadOnly } from "./project-policy";
import { CoreError } from "./errors";
import { pluginDecisionEngine } from "../dispatch/plugin-adapters";
import { storedObservations } from "../dispatch/refresh";
import { applyLearnedFit } from "../dispatch/learning";
import { getWork } from "../dispatch/work";
import { enforcementExclusion, enforcementExclusionCached } from "../dispatch/enforcement";
import { executorExclusion } from "../executors/availability";
import { exclusionReason, reason as makeReason, type Reason } from "../dispatch/reasons";
import { readOnlyReviewReader } from "../dispatch/learning";
import { runningTasksReadOnly, storedObservationsReadOnly, type ReadOnlyStore } from "../dispatch/readonly";
import { pluginRegistry } from "../plugins";

/**
 * Switches previewDispatch to its read-only form for `dispatch.explain`: no `--version` spawn, no plugin start,
 * no DDL, no WAL or legacy import. The fields after `store` are filled in as outputs for the caller.
 */
export interface ReadOnlyDispatch {
  store: ReadOnlyStore;
  exclusions: { runner: string; reason: Reason }[];
  uncertainty: Reason[];
  engineNotRunning?: string;
  status?: Status;
  strategy?: Strategy;
  repoPath?: string;
}
export interface DispatchDependencies {
  readOnly?: ReadOnlyDispatch;
  strategy?: Strategy;
  status?: (ctx: Ctx, strategy: Strategy) => Promise<Status>;
  adapters?: readonly ObservationAdapter[];
  engine?: DecisionEngine;
  taskId?: string; includePlanner?: boolean; excludeCandidates?: ReadonlySet<string>;
  difficulty?: "simple"|"standard"|"complex";
}

/** Read-only recommendation. Does not reserve capacity, activate strategies or launch work. */
export async function previewDispatch(ctx: Ctx, input: unknown, deps: DispatchDependencies = {}): Promise<DispatchPreview> {
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid dispatch preview input");
  const brief = parsed.data;
  const strategy = deps.strategy ?? loadStrategy(ctx);
  const config = strategy.dispatch ?? dispatchConfigSchema.parse({});
  const repo = await (deps.readOnly ? resolvePolicyRepoInputReadOnly(ctx, brief.repo) : resolvePolicyRepoInput(ctx, brief.repo));
  const selection = projectSnapshot(ctx, strategy, repo.key).selection;
  const status = await (deps.status ?? ((c, s) => computeStatus({ ...c, readOnly: true }, s, {cacheOnly: true})))(ctx, strategy);
  const existing = rankExecutors(brief.kind ?? null, strategy, Object.fromEntries(status.providers.map(p => [p.id, p])), selection && {executors: selection.executors, order: "configured"}, {includePlanner:deps.includePlanner});
  const ro = deps.readOnly;
  if (ro) { ro.status = status; ro.strategy = strategy; ro.repoPath = repo.path; }
  const excluded: DispatchPreview["excluded"] = existing.excluded.map(e => ({id: e.id, reason: e.reason}));
  if (ro) {
    for (const e of existing.excluded) ro.exclusions.push({runner: e.id, reason: exclusionReason(e.id, e.reason, e.eligibility)});
    // The runner re-reads these guardrails at admission; a blocked or exhausted executor is skipped there.
    existing.ranked = existing.ranked.filter(r => {
      const guard = executorExclusion(ctx, strategy, r.id);
      if (!guard) return true;
      excluded.push({id: r.id, reason: guard});
      ro.exclusions.push({runner: r.id, reason: exclusionReason(r.id, guard)});
      return false;
    });
    if (!ro.store.available) ro.uncertainty.push(makeReason("tasks_unavailable", "info"));
  }
  const strict = deps.taskId ? getWork(ctx,deps.taskId)?.options.delegationEnforcement === "strict" : brief.delegationEnforcement !== "cooperative";
  const use = slotUse((ro ? runningTasksReadOnly(ro.store) : listTasksWhere(ctx, {states: ["running"], all: true})).filter(t=>t.id!==deps.taskId));
  const allowed = new Set<string>();
  for (const runner of existing.ranked) {
    const host = strategy.runners[runner.id].host;
    const cached = host ? readHostReachability(ctx, strategy.hosts[host]) : null;
    const unknownHost = host && (!cached || cached.at > ctx.now || ctx.now - cached.at >= 60);
    let reason: string | null = null;
    if (strict && ro) {
      const checked = await enforcementExclusionCached(ctx, strategy, runner.id, repo.path, ro.store);
      reason = checked.reason;
      if (checked.unverified) ro.uncertainty.push(makeReason("enforcement_unverified", "info", {agent: checked.unverified}, runner.id));
    } else if (strict) reason = await enforcementExclusion(ctx,strategy,runner.id,repo.path,deps.taskId?readTask(ctx,deps.taskId)?.interactionMode==="conversation":false);
    const otherReason = deps.includePlanner && host ? "scoped child delegation requires local grant transport" : slotBlock(strategy, runner.id, use) ?? (unknownHost ? `host ${host} reachability unknown (cached preview)` : await remoteExclusion({ ...ctx, readOnly: true }, strategy, runner.id, {repo: repo.path, placement: "new"}, {reachable: async () => cached?.reachable === true, skipSlots: true}));
    if (reason || otherReason) {
      excluded.push({id: runner.id, reason: reason ?? otherReason!});
      if (ro) ro.exclusions.push({runner: runner.id, reason: exclusionReason(runner.id, reason ?? otherReason!)});
    }
    if (!(reason || otherReason)) allowed.add(runner.id);
  }
  const declaredInventory = buildModelInventory(strategy, [], ctx.now).filter(m => allowed.has(m.runner));
  const scopes = [
    ...[...allowed].map(id => ({runner: id, account: strategy.runners[id].account})),
    ...declaredInventory.map(m => ({runner: m.runner, account: m.account, binding: m.binding})),
  ];
  const observations: Observation[] = [...(ro ? storedObservationsReadOnly(ro.store, ctx.now) : storedObservations(ctx)),...await collectObservations(ctx, deps.adapters ?? [statusObservationAdapter(status)], scopes, config.timeoutMs)];
  const task = {kind: brief.kind ?? null, difficulty:deps.difficulty??"standard",requirements: brief.requirements, preferences: brief.preferences, provenance: "request" as const, ...(brief.model ? {model: brief.model} : {})};
  const inventory = buildModelInventory(strategy, observations, ctx.now).filter(m => allowed.has(m.runner));
  const built = buildCandidates(strategy, task, inventory, observations, ctx.now);
  const strategyHash = decisionHash({dispatch: config, inventory, project: selection?.references ?? null});
  const observationRevision = decisionHash(observations);
  const request = {schemaVersion: 1 as const, requestId: decisionHash({task, strategyHash, observationRevision, now: ctx.now}), now: ctx.now,
    deadline: ctx.now + config.timeoutMs / 1000, task, candidates: applyLearnedFit(ctx,strategy,built.candidates.filter(c=>!deps.excludeCandidates?.has(c.id)),task.kind,task.difficulty,ro&&readOnlyReviewReader(ro.store)), observations, observationRevision, strategyHash, config};
  if (ro && config.learning.enabled && !ro.store.has("work_reviews")) ro.uncertainty.push(makeReason("learning_unavailable", "info"));
  if (ro) for (const e of built.excluded) ro.exclusions.push({runner: (JSON.parse(e.id) as [string])[0], reason: exclusionReason(e.id, e.reason)});
  const pluginId = config.engine.startsWith("plugin:") ? config.engine.slice(7) : null;
  // A plugin engine is called read-only only when its plugin is already running; peek publishes no event and starts nothing.
  if (ro && pluginId && pluginRegistry(ctx).peek(pluginId) !== "ready") ro.engineNotRunning = config.engine;
  const selectedEngine=deps.engine??(pluginId&&!ro?.engineNotRunning?pluginDecisionEngine(ctx,pluginId):ladderEngine);
  const decisionStart=performance.now();
  let preview = await runDecision(request,selectedEngine,() => ctx.now + (performance.now() - decisionStart) / 1000);
  if(preview.validation!=="valid"&&config.engineFallback==="ladder"&&selectedEngine.id!=="ladder"){
    const fallbackStart=performance.now();
    const fallback=await runDecision(request,ladderEngine,() => ctx.now + (performance.now() - fallbackStart) / 1000);
    preview={...fallback,fallback:{from:selectedEngine.id,reason:preview.validation}};
  }
  return { ...preview, excluded: [...excluded, ...built.excluded], uncertainty: [
    ...built.candidates.filter(c => !c.capacityKnown).map(c => `${c.id}: capacity unknown`),
    ...inventory.filter(m => m.binding.kind === "executor-default").map(m => `${m.runner}: executor default model unresolved`),
    "Preview uses cached observations and makes no reservation; dispatch may differ.",
  ] };
}
