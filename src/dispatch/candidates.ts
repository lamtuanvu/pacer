import type { Strategy } from "../config/strategy";
import type { Candidate, DecisionRequest, DispatchPreview, ModelRecord, Observation, TaskRequirements } from "./types";

const TIERS = { unknown: -1, small: 0, medium: 1, frontier: 2 };
export function meetsRequirements(model: ModelRecord, requirements: TaskRequirements): boolean {
  return (requirements.minTier === undefined || TIERS[model.tier] >= TIERS[requirements.minTier])
    && (requirements.tools === undefined || model.tools === requirements.tools)
    && (requirements.context === undefined || (model.context ?? 0) >= requirements.context);
}

export function buildCandidates(strategy: Strategy, task: DecisionRequest["task"], inventory: readonly ModelRecord[], observations: readonly Observation[], now: number): { candidates: Candidate[]; excluded: DispatchPreview["excluded"] } {
  const candidates: Candidate[] = [], excluded: DispatchPreview["excluded"] = [];
  for (const model of inventory) {
    const id = JSON.stringify([model.runner, model.binding]);
    const runner = strategy.runners[model.runner];
    const reject = (reason: string) => excluded.push({ id, reason });
    if (!runner || runner.enabled === false) { reject("Runner unavailable or disabled"); continue; }
    if (!meetsRequirements(model, task.requirements)) { reject("Task requirements not satisfied"); continue; }
    if (task.model && (model.binding.kind !== "exact" || model.binding.id !== task.model)) { reject("Different pinned model"); continue; }
    const current = observations.filter(o => o.scope.runner === model.runner && o.scope.account === model.account && (o.scope.binding === undefined || JSON.stringify(o.scope.binding) === JSON.stringify(model.binding)) && o.state === "known" && o.observedAt <= now && o.expiresAt > now);
    const health = current.filter(o => o.method === "health");
    if (health.some(o => o.value?.healthy === false)) { reject("Runner not healthy"); continue; }
    const usage = current.filter(o => o.method === "usage");
    const windows = usage.flatMap(o => o.value?.windows ?? []);
    const pools = new Map<string, number>();
    for (const window of windows) pools.set(window.pool, Math.max(pools.get(window.pool) ?? 0, window.usedPct));
    if ([...pools.values()].some(used => used >= 100)) { reject("Quota exhausted"); continue; }
    const known = health.some(o => o.value?.healthy === true) && usage.length > 0 && (pools.size > 0 || usage.some(o => o.value?.unmetered === true));
    const headroom = known ? (pools.size ? Math.min(...[...pools.values()].map(used => 100 - used)) : 100) : null;
    const burns = windows.filter(w => w.hoursLeft !== undefined).map(w => (100 - w.usedPct) / Math.max(1, w.hoursLeft!));
    const costs = usage.flatMap(o => o.value?.cost === undefined ? [] : [o.value.cost]);
    candidates.push({ ...model, id, poolIds: [...pools.keys()].sort(), headroom, capacityKnown: known,
      burn: burns.length ? Math.min(...burns) : null, cost: costs.length ? Math.max(...costs) : null });
  }
  return { candidates, excluded };
}
