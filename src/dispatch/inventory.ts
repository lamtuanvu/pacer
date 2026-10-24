import type { Strategy } from "../config/strategy";
import type { ModelRecord, Observation } from "./types";

/** Inventory is a projection of explicit permission, not of everything a provider advertises. */
export function buildModelInventory(strategy: Strategy, observations: readonly Observation[], now: number = Number.POSITIVE_INFINITY): ModelRecord[] {
  const inventory = Object.values(strategy.runners).flatMap<ModelRecord>(runner => {
    const declared = runner.models ?? (runner.model ? [{ id: runner.model, tier: "unknown" as const, strengths: [] }] : []);
    const common = { runner: runner.id, account: runner.account, executor: runner.agent, actualModel: null, provenance: "declared" as const };
    if (!declared.length) return [{ ...common, binding: { kind: "executor-default" as const }, tier: "unknown" as const, strengths: [] }];
    return declared.map(model => {
      const account = strategy.accounts[runner.account];
      const technical = account.connection?.models.find(m => `pacer-${account.name}/${m.id}` === model.id);
      return { ...common, binding: { kind: "exact" as const, id: model.id }, tier: model.tier, strengths: [...model.strengths],
        ...(model.tools !== undefined || technical ? { tools: model.tools ?? technical!.tools } : {}),
        ...(model.context !== undefined || technical ? { context: model.context ?? technical!.context } : {}) };
    });
  });
  return inventory.map(model => {
    const evidence = observations.filter(o => o.scope.runner === model.runner && o.scope.account === model.account && o.scope.binding !== undefined
      && JSON.stringify(o.scope.binding) === JSON.stringify(model.binding) && o.state === "known" && o.observedAt <= now && o.expiresAt > now).sort((a,b) => a.observedAt - b.observedAt);
    const result = { ...model };
    for (const observation of evidence) {
      if (observation.method === "capabilities") {
        if (observation.value?.tools !== undefined) result.tools = observation.value.tools;
        if (observation.value?.context !== undefined) result.context = observation.value.context;
        result.provenance = "mixed";
      }
      if (observation.method === "actual-model" && observation.value?.model) result.actualModel = observation.value.model;
    }
    return result;
  });
}
