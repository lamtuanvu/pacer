import type { Answer, Question } from "./types";

/** Nearest-rank percentile; p is a percentage in [0, 100]. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil(p / 100 * sorted.length)));
  return sorted[rank - 1];
}

export interface AucSample {
  score: number;
  positive: boolean;
}

/** Mann-Whitney AUC, with equal scores sharing their average rank. */
export function auc(samples: readonly AucSample[]): number | null {
  const positives = samples.filter((sample) => sample.positive).length;
  const negatives = samples.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let positiveRanks = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].score === sorted[start].score) end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) {
      if (sorted[i].positive) positiveRanks += rank;
    }
    start = end;
  }
  return (positiveRanks - positives * (positives + 1) / 2) / (positives * negatives);
}

export interface CalibrationSample {
  confidence: number;
  correct: boolean;
}

export interface CalibrationBucket {
  min: number;
  max: number;
  n: number;
  confidence: number | null;
  accuracy: number | null;
}

export function calibration(samples: readonly CalibrationSample[]): CalibrationBucket[] {
  const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const buckets = edges.slice(0, -1).map((min, i) => ({
    min, max: edges[i + 1], n: 0, confidenceSum: 0, correctCount: 0,
  }));
  for (const sample of samples) {
    const decile = Math.floor(sample.confidence * 10 + 1e-9);
    const index = Math.max(0, Math.min(5, decile - 4));
    const bucket = buckets[index];
    bucket.n++;
    bucket.confidenceSum += sample.confidence;
    if (sample.correct) bucket.correctCount++;
  }
  return buckets.map(({ min, max, n, confidenceSum, correctCount }) => ({
    min, max, n,
    confidence: n ? confidenceSum / n : null,
    accuracy: n ? correctCount / n : null,
  }));
}

export function probYes(answer: Answer): number {
  return answer.probabilities?.yes ??
    (typeof answer.value === "number" ? answer.value : answer.value === true ? 1 : 0);
}

function prediction(q: Question, answer: Answer, threshold: number): Answer["value"] {
  return q.type === "score" ? typeof answer.value === "number" && answer.value >= threshold : answer.value;
}

export function isCorrect(q: Question, answer: Answer, truth: string | boolean, threshold: number): boolean {
  return prediction(q, answer, threshold) === truth;
}

export function agree(q: Question, a: Answer, b: Answer, threshold: number): boolean {
  return prediction(q, a, threshold) === prediction(q, b, threshold);
}
