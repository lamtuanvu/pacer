import { expect, test } from "bun:test";
import { agree, auc, calibration, isCorrect, percentile, probYes } from "../src/classify/metrics";
import type { Answer, Question } from "../src/classify/types";

const choice: Question = { type: "choice", id: "task_kind", instructions: "", criteria: { docs: "Documentation", tests: "Tests" } };
const score: Question = { type: "score", id: "difficulty", instructions: "", min: 0, max: 1 };
const yesno: Question = { type: "yesno", id: "guard", instructions: "" };
const answer = (value: Answer["value"], probabilities?: Record<string, number>): Answer => ({ value, probabilities, confidence: 0.8, latencyMs: 0 });

test("percentile uses nearest rank on sorted values without mutating input", () => {
  const values = [50, 10, 40, 20, 30];
  expect(percentile(values, 50)).toBe(30);
  expect(percentile(values, 95)).toBe(50);
  expect(percentile(values, 0)).toBe(10);
  expect(percentile(values, 100)).toBe(50);
  expect(percentile([20, 10], 50)).toBe(10);
  expect(percentile([42], 95)).toBe(42);
  expect(percentile([], 50)).toBeNull();
  expect(values).toEqual([50, 10, 40, 20, 30]);
});

test("auc counts tied positive-negative pairs as half a win", () => {
  expect(auc([
    { score: 0.9, positive: true }, { score: 0.6, positive: false },
    { score: 0.6, positive: true }, { score: 0.1, positive: false },
  ])).toBe(0.875);
  expect(auc([{ score: 0.5, positive: true }, { score: 0.5, positive: false }])).toBe(0.5);
  expect(auc([{ score: 0.1, positive: true }, { score: 0.9, positive: false }])).toBe(0);
  expect(auc([{ score: 0.9, positive: true }, { score: 0.1, positive: false }])).toBe(1);
});

test("auc is null unless both classes are present", () => {
  expect(auc([])).toBeNull();
  expect(auc([{ score: 0.9, positive: true }])).toBeNull();
  expect(auc([{ score: 0.1, positive: false }])).toBeNull();
});

test("calibration assigns exactly 0.6 and 1.0 to the correct buckets", () => {
  const buckets = calibration([
    { confidence: 0, correct: true }, { confidence: 0.49, correct: false },
    { confidence: 0.5, correct: true }, { confidence: 0.59, correct: false },
    { confidence: 0.6, correct: true }, { confidence: 0.7, correct: false },
    { confidence: 0.8, correct: true }, { confidence: 0.9, correct: false },
    { confidence: 1, correct: true },
  ]);
  expect(buckets).toMatchObject([
    { min: 0, max: 0.5, n: 2, confidence: 0.245, accuracy: 0.5 },
    { min: 0.5, max: 0.6, n: 2, accuracy: 0.5 },
    { min: 0.6, max: 0.7, n: 1, confidence: 0.6, accuracy: 1 },
    { min: 0.7, max: 0.8, n: 1, confidence: 0.7, accuracy: 0 },
    { min: 0.8, max: 0.9, n: 1, confidence: 0.8, accuracy: 1 },
    { min: 0.9, max: 1, n: 2, confidence: 0.95, accuracy: 0.5 },
  ]);
  expect(buckets[1].confidence).toBeCloseTo(0.545, 12);
  expect(calibration([]).map((bucket) => [bucket.n, bucket.confidence, bucket.accuracy]))
    .toEqual(Array(6).fill([0, null, null]));
});

test("calibration tolerates floating-point error at a bucket boundary", () => {
  expect(calibration([{ confidence: 0.7 - Number.EPSILON, correct: true }])[3].n).toBe(1);
});

test("probYes uses yes probabilities or a numeric or boolean answer", () => {
  expect(probYes(answer(true, { yes: 0.8, no: 0.2 }))).toBe(0.8);
  expect(probYes(answer(false, { yes: 0.4, no: 0.6 }))).toBe(0.4);
  expect(probYes(answer(true))).toBe(1);
  expect(probYes(answer(false))).toBe(0);
  expect(probYes(answer(0.65))).toBe(0.65);
});

test("isCorrect compares choice and yesno values and thresholds scores inclusively", () => {
  expect(isCorrect(choice, answer("docs"), "docs", 0.6)).toBe(true);
  expect(isCorrect(choice, answer("tests"), "docs", 0.6)).toBe(false);
  expect(isCorrect(yesno, answer(true), true, 0.6)).toBe(true);
  expect(isCorrect(yesno, answer(false), true, 0.6)).toBe(false);
  expect(isCorrect(yesno, answer(false), false, 0.6)).toBe(true);
  expect(isCorrect(score, answer(0.6), true, 0.6)).toBe(true);
  expect(isCorrect(score, answer(0.59), false, 0.6)).toBe(true);
  expect(isCorrect(score, answer(0.9), false, 0.6)).toBe(false);
  expect(isCorrect(score, answer(0.65), true, 0.7)).toBe(false);
});

test("agree compares categorical answers and thresholded score predictions", () => {
  expect(agree(choice, answer("docs"), answer("docs"), 0.6)).toBe(true);
  expect(agree(choice, answer("docs"), answer("tests"), 0.6)).toBe(false);
  expect(agree(yesno, answer(false), answer(false), 0.6)).toBe(true);
  expect(agree(yesno, answer(true), answer(false), 0.6)).toBe(false);
  expect(agree(score, answer(0.6), answer(0.9), 0.6)).toBe(true);
  expect(agree(score, answer(0.2), answer(0.59), 0.6)).toBe(true);
  expect(agree(score, answer(0.59), answer(0.6), 0.6)).toBe(false);
  expect(agree(score, answer(0.65), answer(0.8), 0.7)).toBe(false);
});
