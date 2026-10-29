import type { z } from "zod";
import { resolveRunner } from "../config/runner-id";
import { KINDS, loadStrategy, type Strategy } from "../config/strategy";
import { classifierConfig } from "../config/classifier";
import { rulesClassifier } from "../classify/rules";
import { evaluateLadder } from "../dispatch/ladder";
import { decisionHash } from "../dispatch/engines";
import { openReadOnlyStore, reservationsReadOnly } from "../dispatch/readonly";
import { reason, reasonCodeSchema, type Reason, type ReasonCode } from "../dispatch/reasons";
import { type Candidate, type DispatchPreview } from "../dispatch/types";
import { explainInputSchema } from "../dispatch/explain-input";
import { draftStrategy } from "../strategy/service";
import { StrategyError } from "../config/strategy";
import { readPause } from "./pause";
import { CoreError } from "./errors";
import { previewDispatch, type DispatchDependencies, type ReadOnlyDispatch } from "./dispatch";
import { isExecutorSession } from "../install/role";
import type { Ctx } from "../types";
import { explainRankedDispatch } from "./dispatch-explain-ranked";

export { explainInputSchema };
export type ExplainInput = z.input<typeof explainInputSchema>;

export { reasonCodeSchema };
export interface Choice { executor: string; account: string; runner: string; model: { kind: "exact"; id: string } | { kind: "executor-default" }; host: string | null }
export interface Fallback { executor: string; runner: string; account: string; state: "eligible" | "excluded"; step?: string; reason?: Reason }
export type PlannerCost =
  | { state: "unknown"; reason: ReasonCode }
  | { state: "estimate"; tokens: { median: number; p80: number }; samples: number; basis: "kind" | "kind+repo"; window: PlannerWindow | null };
export interface PlannerWindow { account: string; usedPct: number; pacePct: number | null; mode: string }
export interface RouteExplanation {
  schemaVersion: 1; revision: string; at: number; observedAt: number | null;
  mode: "ranked" | "ladder";
  outcome: "select" | "queue" | "fail" | "override";
  kind: { value: string | null; source: "given" | "detected" | "unknown" };
  strategy: { name: string; draft: boolean; source: "project" | "strategy" | "built-in" };
  engine: { id: string; version: string; fallback?: { from: string; reason: "invalid" | "timeout" | "engine_not_running" } };
  chosen: Choice | null;
  step: { id: string; index: number; skipped: { id: string; reason: ReasonCode }[] } | null;
  reasons: Reason[]; fallbacks: Fallback[];
  planner: PlannerCost & { window?: PlannerWindow | null };
  uncertainty: Reason[];
}

async function detectKind(goal: string): Promise<string | null> {
  const answer = await rulesClassifier.ask(JSON.stringify({ goal }), { type: "choice", id: "task_kind", instructions: "", criteria: {} });
  return typeof answer.value === "string" && (KINDS as readonly string[]).includes(answer.value) ? answer.value : null;
}
function chosenOf(c: Candidate, strategy: Strategy): Choice {
  return { executor: c.executor, account: c.account, runner: c.runner, model: c.binding.kind === "exact" ? { kind: "exact", id: c.binding.id } : { kind: "executor-default" }, host: strategy.runners[c.runner]?.host ?? null };
}
/** Distinct runners in proposal order, each represented by its best-ranked candidate, as the runner does. */
function rankedRunners(preview: DispatchPreview): Candidate[] {
  if (preview.proposal?.state !== "ranked") return [];
  const seen = new Set<string>(), out: Candidate[] = [];
  for (const choice of preview.proposal.choices) {
    const c = preview.request.candidates.find(x => x.id === choice.id);
    if (c && !seen.has(c.runner)) { seen.add(c.runner); out.push(c); }
  }
  return out;
}

/**
 * Read-only "where would this go" explanation. Unmanaged work uses executor ranking; managed work
 * runs `previewDispatch` in its read-only form with the dispatcher's candidate and ladder code. Nothing is started,
 * reserved, probed, refreshed or written.
 */
export async function explainDispatch(ctx: Ctx, input: unknown, deps: Pick<DispatchDependencies, "strategy" | "status" | "adapters" | "engine"> = {}): Promise<RouteExplanation> {
  const parsed = explainInputSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid dispatch explain input", parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const p = parsed.data;
  if (isExecutorSession(ctx) || ctx.env.PACER_WORK_GRANT) throw new CoreError("not_allowed", "Route explanations are not available to executor sessions");
  ctx = { ...ctx, readOnly: true };
  if (p.kind !== undefined && !(KINDS as readonly string[]).includes(p.kind)) throw new CoreError("invalid_input", `Unknown kind "${p.kind}"`, `Allowed kinds: ${KINDS.join(", ")}`);
  let strategy: Strategy;
  if (p.strategyDraft) {
    try { strategy = draftStrategy(ctx, p.strategyDraft); }
    catch (e) { throw new CoreError("invalid_input", "Invalid strategy draft", e instanceof StrategyError ? e.problems.join("; ") : String((e as Error).message)); }
  } else strategy = deps.strategy ?? loadStrategy(ctx);
  const requested = p.executor ? resolveRunner(strategy, p.executor)?.id ?? null : null;
  if (p.executor && !requested) throw new CoreError("unknown_executor", `Unknown executor "${p.executor}"`, `Configured: ${Object.keys(strategy.runners).join(", ")}`);

  const kind: RouteExplanation["kind"] = p.kind !== undefined ? { value: p.kind, source: "given" } : await detectKind(p.goal).then(v => v ? { value: v, source: "detected" as const } : { value: null, source: "unknown" as const });
  const store = openReadOnlyStore(ctx);
  try {
    if (p.via === "delegate") return await explainRankedDispatch(ctx, strategy, p, kind, requested, store, deps);
    const ro: ReadOnlyDispatch = { store, exclusions: [], uncertainty: [] };
    const preview = await previewDispatch(ctx, {
      repo: p.repo, goal: p.goal.slice(0, 8000), ...(kind.value ? { kind: kind.value } : {}), requirements: p.requirements, preferences: p.preferences,
      ...(p.model ? { model: p.model } : {}), ...(p.delegationEnforcement ? { delegationEnforcement: p.delegationEnforcement } : {}),
    }, { ...deps, strategy, readOnly: ro, difficulty: p.difficulty ?? "standard", includePlanner: !!p.allowDelegation });
    return build(ctx, strategy, p, kind, requested, preview, ro, !!p.strategyDraft);
  } finally { store.close(); }
}

function build(ctx: Ctx, strategy: Strategy, p: z.output<typeof explainInputSchema>, kind: RouteExplanation["kind"], requested: string | null, preview: DispatchPreview, ro: ReadOnlyDispatch, draft: boolean): RouteExplanation {
  const config = preview.request.config, status = ro.status!;
  const reasons: Reason[] = [];
  const uncertainty: Reason[] = [reason("cached_preview", "info"), ...ro.uncertainty];
  const ranked = rankedRunners(preview);
  const ladder = preview.engine.id === "ladder";

  // Ranked executors, then those the ladder reaches in a later step. Later steps are re-evaluated with the same pure ladder.
  const eligible: { candidate: Candidate; step?: string }[] = ranked.map(c => ({ candidate: c }));
  let step: RouteExplanation["step"] = null;
  if (preview.proposal?.state === "ranked") {
    const id = preview.proposal.step, index = config.steps.findIndex(s => s.id === id);
    step = { id, index, skipped: preview.proposal.skipped.map(s => ({ id: s, reason: stepSkipReason(config.steps.find(x => x.id === s), preview.request.task.kind) })) };
    if (ladder) {
      const seen = new Set(ranked.map(c => c.runner));
      for (let i = index + 1; i < config.steps.length; i++) {
        const later = evaluateLadder(preview.request, { ...config, steps: config.steps.slice(i) });
        if (later.state !== "ranked") break;
        for (const choice of later.choices) {
          const c = preview.request.candidates.find(x => x.id === choice.id);
          if (c && !seen.has(c.runner)) { seen.add(c.runner); eligible.push({ candidate: c, step: later.step }); }
        }
      }
    }
  }

  let top: Candidate | null = eligible[0]?.candidate ?? null, outcome: RouteExplanation["outcome"] = top ? "select" : preview.recommendedAction === "fail" ? "fail" : "queue";
  const excludedByRunner = new Map<string, Reason>();
  for (const e of ro.exclusions) if (!excludedByRunner.has(e.runner)) excludedByRunner.set(e.runner, e.reason);

  let refused = false;
  if (requested) reasons.push(reason("override", "info", { executor: requested }, requested));
  if (requested) {
    const hit = eligible.find(e => e.candidate.runner === requested && e.step === undefined);
    if (hit) { top = hit.candidate; outcome = "override"; eligible.splice(eligible.indexOf(hit), 1); eligible.unshift(hit); }
    else {
      const why = excludedByRunner.get(requested);
      if (why && (why.code === "blocked_by_user" || why.code === "quota_exhausted")) { reasons.push(why); top = null; outcome = "fail"; refused = true; }
      // A full slot makes the runner queue the task for that executor rather than fall back.
      else if (why && (why.code === "executor_busy" || why.code === "machine_busy")) { reasons.push(why); top = null; outcome = "queue"; refused = true; }
      else reasons.push(reason("override_unavailable", "fail", { requested, reason: why?.code ?? "not_ranked" }, requested), ...(why ? [why] : []));
    }
  }

  const pause = readPause(ctx);
  let chosen: Choice | null = null;
  if (pause) { outcome = "queue"; top = null; reasons.push(reason("paused", "fail", { until: pause.until }, undefined)); }
  else if (preview.validation !== "valid") { outcome = preview.recommendedAction === "fail" ? "fail" : "queue"; reasons.push(reason("engine_failed", "fail", { validation: preview.validation })); }
  if (top && outcome !== "fail") {
    chosen = chosenOf(top, strategy);
    reasons.push(reason("step_match", "pass", { stepId: step?.id ?? "", kind: kind.value }));
    const free = top.headroom === null ? null : top.headroom - config.reservePct;
    const pace = status.accounts?.find(a => a.name === top!.account)?.pacePct ?? null;
    if (top.headroom === null) reasons.push(reason("capacity_unknown", "info", {}, top.runner));
    else if (free !== null && free >= config.comfortablePct) reasons.push(reason("capacity_comfortable", "pass", { headroomPct: top.headroom, pacePct: pace }, top.runner));
    else reasons.push(reason("capacity_usable", "pass", { headroomPct: top.headroom, pacePct: pace }, top.runner));
  } else if (!pause && !refused && preview.validation === "valid" && !top) {
    reasons.push(reason("no_step_matched", "fail", { skipped: preview.proposal?.skipped.length ?? 0 }));
  }

  const fallbacks: Fallback[] = [];
  const listed = new Set<string>(chosen ? [chosen.runner] : []);
  if (!pause) for (const e of eligible) {
    if (listed.has(e.candidate.runner)) continue;
    listed.add(e.candidate.runner);
    fallbacks.push({ executor: e.candidate.executor, runner: e.candidate.runner, account: e.candidate.account, state: "eligible", ...(e.step ? { step: e.step } : step ? { step: step.id } : {}) });
  }
  for (const [runner, why] of excludedByRunner) {
    if (listed.has(runner) || !strategy.runners[runner]) continue;
    listed.add(runner);
    fallbacks.push({ executor: strategy.runners[runner].agent, runner, account: strategy.runners[runner].account, state: "excluded", reason: why });
  }

  // With nothing chosen, unmeasured capacity is the likeliest reason, so every candidate counts.
  const inPlay = [...(top ? [top] : []), ...eligible.map(e => e.candidate), ...(top ? [] : preview.request.candidates)];
  for (const c of new Map(inPlay.map(c => [c.runner, c])).values()) {
    if (!c.capacityKnown) uncertainty.push(reason("capacity_unmeasured", "info", {}, c.runner));
    if (c.binding.kind === "executor-default") uncertainty.push(reason("default_model_unresolved", "info", {}, c.runner));
  }
  const pools = new Set(inPlay.flatMap(c => c.poolIds));
  if (reservationsReadOnly(ro.store).some(r => r.poolIds.some(pool => pools.has(pool)))) uncertainty.push(reason("reserved_capacity", "info"));
  try { if (classifierConfig(strategy).configured) uncertainty.push(reason("admission_hooks", "info")); } catch { /* no classifier config */ }

  const fallback = preview.fallback ?? (ro.engineNotRunning ? { from: ro.engineNotRunning, reason: "engine_not_running" as const } : undefined);
  if (ro.engineNotRunning) uncertainty.push(reason("engine_not_running", "info", { engine: ro.engineNotRunning }));

  const plannerAccount = strategy.planner.account;
  const account = status.accounts?.find(a => a.name === plannerAccount);
  const window: PlannerWindow | null = account && account.usedPct !== null ? { account: plannerAccount, usedPct: account.usedPct, pacePct: account.pacePct, mode: status.mode } : null;
  const planner: RouteExplanation["planner"] = { state: "unknown", reason: chosen?.account === plannerAccount ? "planner_is_executor" : "planner_not_measured", window };

  const observed = preview.request.observations.filter(o => o.state === "known").map(o => o.observedAt);
  // Time passing alone must not change the revision: drop the clock-derived fields (hoursLeft, burn) and the
  // timestamps of observations that are not known.
  const stripped = preview.request.observations.map(o => o.state === "known"
    ? { ...o, value: o.value && { ...o.value, windows: o.value.windows?.map(({ hoursLeft: _h, ...w }) => w) }, observedAt: 0, expiresAt: 0 }
    : { ...o, observedAt: 0, expiresAt: 0 });
  const candidates = preview.request.candidates.map(({ burn: _b, ...c }) => c);
  const revision = decisionHash({ task: preview.request.task, candidates, strategyHash: preview.request.strategyHash, observations: stripped,
    exclusions: ro.exclusions.map(e => [e.runner, e.reason.code, e.reason.facts]), paused: pause?.until ?? null, requested });
  const source = strategy.dispatch ? "strategy" : "built-in";
  return {
    schemaVersion: 1, mode: "ladder", revision, at: Math.floor(ctx.now), observedAt: observed.length ? Math.min(...observed) : null, outcome, kind,
    strategy: { name: strategy.name, draft, source },
    engine: { ...preview.engine, ...(fallback ? { fallback } : {}) },
    chosen, step, reasons, fallbacks, planner, uncertainty,
  };
}
function stepSkipReason(step: { match: { kind?: string } } | undefined, kind: string | null): ReasonCode {
  return step?.match.kind !== undefined && step.match.kind !== kind ? "step_kind_mismatch" : "step_no_candidates";
}
