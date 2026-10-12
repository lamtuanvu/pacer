import type { ClassifierConfig } from "../config/classifier";
import type { Ctx } from "../types";
import { withTimeout } from "./decide";
import { readDecisions } from "./log";
import { agree, auc, calibration, isCorrect, percentile, probYes, type CalibrationBucket } from "./metrics";
import type { AdapterSet } from "./registry";
import { redactState, withoutPlannerKind } from "./state";
import { buildTruth, truthFor } from "./truth";
import { DECISIONS, type AdapterId, type Answer, type DecisionEntry, type DecisionName } from "./types";

export interface BenchMetrics {
  n: number;
  errors: number;
  labelled: number;
  accuracy: number | null;
  auc: number | null;
  calibration: CalibrationBucket[];
  p50: number | null;
  p95: number | null;
  costPer1k: number | null;
  agreement: number | null;
  counterfactual?: { cheapFailures: number; avoided: number; cheapSuccesses: number; diverted: number };
}
export interface BenchReport {
  decisions: Partial<Record<DecisionName, Record<string, BenchMetrics>>>;
}
export interface BenchOptions {
  decision?: DecisionName;
  adapters: readonly AdapterId[];
  sinceS: number;
  limit?: number;
}

/** Replay a bounded, deduplicated sample without changing the decision log. */
export async function runBench(ctx: Ctx, cfg: ClassifierConfig, adapters: AdapterSet, options: BenchOptions): Promise<BenchReport> {
  const entries = readDecisions(ctx, options.sinceS > 0 ? ctx.now - options.sinceS : 0);
  const truth = buildTruth(ctx, entries);
  const unique = new Map<string, DecisionEntry>();
  for (const entry of entries) {
    if (!entry.acted_on || !entry.state || !DECISIONS.includes(entry.decision)
      || (options.decision && options.decision !== entry.decision)) continue;
    const key = `${entry.decision}:${entry.state_hash}`;
    unique.delete(key);
    unique.set(key, entry);
  }
  const report: BenchReport = { decisions: {} };
  const ids = [...new Set(options.adapters)];
  const threshold = cfg.decisions.difficulty.maxForCheap || 0.6;
  for (const decision of options.decision ? [options.decision] : DECISIONS) {
    const sample = [...unique.values()].filter(e => e.decision === decision).slice(-(options.limit ?? 500));
    if (!sample.length) continue;
    const answers = new Map<AdapterId, (Answer | null)[]>();
    for (const id of new Set<AdapterId>(["rules", ...ids])) answers.set(id, []);
    // Sequential calls bound concurrency and let slow local models finish loading.
    for (const entry of sample) {
      for (const [id, results] of answers) {
        try {
          let state = decision === "task_kind" ? withoutPlannerKind(entry.state!) : entry.state!;
          if (adapters[id].external && cfg.bench.redact) state = redactState(state, ctx.home);
          results.push(await withTimeout(Promise.resolve().then(() => adapters[id].ask(state, entry.question)), cfg.bench.timeoutMs, id));
        } catch { results.push(null); }
      }
    }
    const rows: Record<string, BenchMetrics> = {};
    report.decisions[decision] = rows;
    for (const id of ids) {
      const results = answers.get(id)!;
      const successful = results.filter((a): a is Answer => a !== null);
      const labelled: { answer: Answer; correct: boolean; truth: string | boolean }[] = [];
      let agreements = 0;
      let comparable = 0;
      const counterfactual = { cheapFailures: 0, avoided: 0, cheapSuccesses: 0, diverted: 0 };
      results.forEach((answer, i) => {
        if (!answer) return;
        const entry = sample[i];
        const label = truthFor(truth, entry);
        if (label !== undefined) labelled.push({ answer, truth: label, correct: isCorrect(entry.question, answer, label, threshold) });
        const baseline = answers.get("rules")![i];
        if (baseline) { comparable++; if (agree(entry.question, answer, baseline, threshold)) agreements++; }
        const outcome = entry.task_id ? truth.difficulty[entry.task_id] : undefined;
        if (decision === "difficulty" && outcome?.executor && cfg.tiers[outcome.executor] === "cheap") {
          const diverted = typeof answer.value === "number" && answer.value < threshold;
          if (outcome.reliable) { counterfactual.cheapSuccesses++; if (diverted) counterfactual.diverted++; }
          else { counterfactual.cheapFailures++; if (diverted) counterfactual.avoided++; }
        }
      });
      rows[id] = {
        n: sample.length, errors: sample.length - successful.length, labelled: labelled.length,
        accuracy: labelled.length ? labelled.filter(s => s.correct).length / labelled.length : null,
        auc: sample[0].question.type === "choice" ? null : auc(labelled.map(s => ({ score: probYes(s.answer), positive: s.truth === true }))),
        calibration: calibration(labelled.map(s => ({ confidence: s.answer.confidence, correct: s.correct }))),
        p50: percentile(successful.map(a => a.latencyMs), 50),
        p95: percentile(successful.map(a => a.latencyMs), 95),
        costPer1k: successful.length && successful.every(a => a.costUsd !== undefined)
          ? successful.reduce((sum, a) => sum + a.costUsd!, 0) / successful.length * 1000 : null,
        agreement: comparable ? agreements / comparable : null,
        ...(decision === "difficulty" ? { counterfactual } : {}),
      };
    }
  }
  return report;
}

export function renderBench(report: BenchReport): string {
  const number = (n: number | null) => n === null ? "-" : String(Number(n.toFixed(4)));
  const lines = ["decision adapter n errors labelled accuracy auc p50(ms) p95(ms) cost/1k(USD) agreement"];
  for (const decision of DECISIONS) {
    for (const [id, row] of Object.entries(report.decisions[decision] ?? {})) {
      lines.push(`${decision} ${id} ${row.n} ${row.errors} ${row.labelled} ${number(row.accuracy)} ${number(row.auc)} ${number(row.p50)} ${number(row.p95)} ${number(row.costPer1k)} ${number(row.agreement)}`);
      if (row.counterfactual) {
        const c = row.counterfactual;
        lines.push(`  cheap failures: ${c.cheapFailures}, avoided: ${c.avoided}; cheap successes: ${c.cheapSuccesses}, diverted: ${c.diverted}`);
      }
      for (const bucket of row.calibration.filter(b => b.n)) {
        lines.push(`  calibration ${bucket.min}-${bucket.max}: n=${bucket.n} confidence=${number(bucket.confidence)} accuracy=${number(bucket.accuracy)}`);
      }
    }
  }
  if (!Object.keys(report.decisions).length) lines.push("No replayable decisions.");
  return lines.join("\n") + "\n";
}
