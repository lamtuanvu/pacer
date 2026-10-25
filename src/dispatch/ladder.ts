import { meetsRequirements } from "./candidates";
import type { Candidate, DecisionRequest, DecisionProposal, DispatchConfig, TaskPreferences } from "./types";

function preference(candidate: Candidate, preferences: TaskPreferences): number {
  const model = candidate.binding.kind === "exact" ? candidate.binding.id : null;
  const index = model === null ? -1 : preferences.models.indexOf(model);
  return index < 0 ? 0 : preferences.models.length - index;
}

/** Pure recommendation only. Hard admission and execution remain owned by Pacer. */
export function evaluateLadder(request: DecisionRequest, config: DispatchConfig): DecisionProposal {
  const skipped: string[] = [];
  for (const step of config.steps) {
    if (step.match.kind !== undefined && step.match.kind !== request.task.kind) { skipped.push(step.id); continue; }
    const eligible = request.candidates.filter(c => {
      if (!meetsRequirements(c, request.task.requirements) || !meetsRequirements(c, step.require)) return false;
      const model = c.binding.kind === "exact" ? c.binding.id : null;
      if (request.task.model && model !== request.task.model) return false;
      if (step.candidates.models && (model === null || !step.candidates.models.includes(model))) return false;
      if (step.candidates.executors && !step.candidates.executors.includes(c.executor)) return false;
      if (c.headroom !== null && c.headroom <= config.reservePct) return false;
      if (step.capacity === "unknown") return true;
      return c.capacityKnown && c.headroom !== null && (step.capacity === "comfortable" ? c.headroom - config.reservePct >= config.comfortablePct : c.headroom - config.reservePct > 0);
    });
    if (!eligible.length) { skipped.push(step.id); continue; }
    const choices = eligible.map(c => {
      const strengths = step.prefer.strengths.length ? step.prefer.strengths : request.task.preferences.strengths;
      const fit = strengths.filter(s => c.strengths.includes(s)).length;
      const factors = [preference(c, step.prefer), preference(c, request.task.preferences), ...step.rank.flatMap(rank => {
        if (rank === "task-fit") return [fit,c.learnedFit?c.learnedFit.successRate-c.learnedFit.uncertainty-0.5:0];
        if (rank === "preference") return [preference(c, step.prefer), preference(c, request.task.preferences)];
        const value = rank === "spare-capacity" ? c.headroom : rank === "burn-before-reset" ? c.burn : c.cost;
        return value === null ? [0, 0] : [1, rank === "cheapest-first" ? -value : value];
      })];
      return { id: c.id, factors, reason: `Step ${step.id}; ${c.headroom === null ? "capacity unknown" : `${c.headroom}% measured headroom`}; configured task-fit ${fit}${c.learnedFit?`; learned fit ${Math.round(c.learnedFit.successRate*100)}% from ${c.learnedFit.sampleCount} comparable reviews (±${Math.round(c.learnedFit.uncertainty*100)}%)`:""}` };
    });
    choices.sort((a, b) => {
      for (let i = 0; i < a.factors.length; i++) if (a.factors[i] !== b.factors[i]) return b.factors[i] - a.factors[i];
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { state: "ranked", choices, step: step.id, skipped };
  }
  return { state: "no-match", reason: "No strategy step has qualifying candidates", skipped };
}
