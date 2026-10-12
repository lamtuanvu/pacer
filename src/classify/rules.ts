import { KINDS } from "../config/strategy";
import { parseState } from "./state";
import type { Answer, Classifier } from "./types";

const KEYWORDS: [string, RegExp][] = [
  ["tests", /\b(tests?|testing)\b/i],
  ["docs", /\b(docs?|documentation)\b/i],
  ["rename", /\b(rename|renaming)\b/i],
  ["migration", /\b(migrate|migration|migrating)\b/i],
  ["debug", /\b(debug|debugging|bug|bugs|fix)\b/i],
  ["refactor", /\b(refactor|refactoring)\b/i],
  ["performance", /\b(performance|optimize|optimization|optimizing)\b/i],
  ["boilerplate", /\b(boilerplate|scaffold|scaffolding)\b/i],
  ["research", /\b(research|investigate|investigation)\b/i],
];

const BASE_SCORES: Record<string, number> = {
  boilerplate: 0.9, docs: 0.9, rename: 0.9, tests: 0.8,
  migration: 0.7, feature: 0.7, refactor: 0.6, debug: 0.5,
  research: 0.5, performance: 0.45, "unfamiliar-code": 0.4,
};

const ALLOWED_NAMES = ["Explore", "Plan", "claude-code-guide", "statusline-setup"];
const ALLOWED_PATTERNS = [/reviewer/i, /analyzer/i, /^pr-review-toolkit:/, /^pacer[-:]/, /-executor$/];

function briefText(state: Record<string, unknown>): string {
  return [state.goal, state.scope, state.context, state.constraints]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function answer(value: Answer["value"], confidence: number, probabilities?: Record<string, number>): Answer {
  return { value, confidence, latencyMs: 0, costUsd: 0, ...(probabilities && { probabilities }) };
}

export const rulesClassifier: Classifier = {
  id: "rules",
  external: false,
  async ask(state, q) {
    const input = parseState(state);
    switch (q.id) {
      case "task_kind": {
        if (typeof input.planner_kind === "string" && (KINDS as readonly string[]).includes(input.planner_kind)) {
          return answer(input.planner_kind, 1);
        }
        const text = briefText(input);
        const matches = KEYWORDS.filter(([, pattern]) => pattern.test(text));
        if (matches.length === 1) return answer(matches[0][0], 0.7);
        if (matches.length === 0 && /\b(add|implement|build|create|support)\b/i.test(text)) {
          return answer("feature", 0.6);
        }
        return answer("default", 0.5);
      }
      case "difficulty": {
        let score = typeof input.kind === "string" && Object.hasOwn(BASE_SCORES, input.kind)
          ? BASE_SCORES[input.kind] : 0.7;
        if (briefText(input).length > 2000) score -= 0.1;
        const scopeItems = typeof input.scope === "string"
          ? input.scope.split(/[,\n]/).filter((item) => item.trim().length > 0).length : 0;
        if (scopeItems > 5) score -= 0.1;
        if (typeof input.repo_files === "number" && input.repo_files > 5000) score -= 0.1;
        return answer(Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, 0.6);
      }
      case "guard": {
        const type = typeof input.subagent_type === "string" ? input.subagent_type : "";
        const execution = !(ALLOWED_NAMES.includes(type) || ALLOWED_PATTERNS.some((pattern) => pattern.test(type)));
        return answer(execution, 0.9, execution ? { yes: 0.9, no: 0.1 } : { yes: 0.1, no: 0.9 });
      }
      case "result_check": {
        const acceptance = input.acceptance;
        if (acceptance !== null && typeof acceptance === "object" && "passed" in acceptance && typeof acceptance.passed === "boolean") {
          return answer(acceptance.passed, 0.95);
        }
        return answer(input.status === "done", 0.5);
      }
      default:
        throw new Error(`Unknown question id: ${q.id}`);
    }
  },
};
