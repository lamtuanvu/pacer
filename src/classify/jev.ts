import { joinUrl, postJson } from "./http";
import type { Answer, Classifier, Question } from "./types";

export function jevRequest(state: string, q: Question, model: string) {
  const criteria = q.type === "choice" ? q.criteria : q.type === "score"
    ? { min: `${q.min} is the lowest score`, max: `${q.max} is the highest score` }
    : { yes: "The answer is yes", no: "The answer is no" };
  return { state, model, questions: { [q.id]: { type: q.type === "yesno" ? "probability" : q.type, instructions: q.instructions, criteria } } };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Jev answer object");
  return value as Record<string, unknown>;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Jev ${name}`);
  return value;
}

function probability(value: unknown, name: string): number {
  const result = number(value, name);
  if (result < 0 || result > 1) throw new Error(`Invalid Jev ${name}: expected [0,1]`);
  return result;
}

export function mapJevAnswer(q: Question, raw: unknown): Answer {
  const answer = record(raw);
  const expectedType = q.type === "yesno" ? "probability" : q.type;
  if (answer.type !== expectedType) throw new Error(`Invalid Jev answer type for ${q.id}`);
  const confidence = (fallback: number) => answer.confidence == null ? fallback : probability(answer.confidence, "confidence");
  if (q.type === "choice") {
    if (typeof answer.choice !== "string" || !Object.hasOwn(q.criteria, answer.choice)) throw new Error(`Invalid Jev choice for ${q.id}`);
    let probabilities: Record<string, number> | undefined;
    if (answer.probabilities != null) {
      probabilities = Object.fromEntries(Object.entries(record(answer.probabilities)).map(([key, value]) => [key, probability(value, "choice probability")]));
    }
    return { value: answer.choice, ...(probabilities ? { probabilities } : {}), confidence: confidence(Math.max(0, ...Object.values(probabilities ?? {}))), latencyMs: 0 };
  }
  if (q.type === "score") {
    return { value: Math.min(q.max, Math.max(q.min, number(answer.score, "score"))), confidence: confidence(0.5), latencyMs: 0 };
  }
  const p = probability(answer.probability, "probability");
  return { value: p >= 0.5, probabilities: { yes: p, no: 1 - p }, confidence: confidence(Math.max(p, 1 - p)), latencyMs: 0 };
}

export function jevClassifier(options: {
  baseUrl: string;
  model: string;
  apiKey: () => string | null;
  keyName: string;
  timeoutMs: number;
  usdPerMtokIn: number | null;
  usdPerMtokOut: number | null;
  nowMs?: () => number;
}): Classifier {
  const nowMs = options.nowMs ?? Date.now;
  return {
    id: "jev",
    external: true,
    async ask(state, q) {
      const key = options.apiKey();
      if (!key) throw new Error(`Missing Jev API key: ${options.keyName}`);
      const start = nowMs();
      const response = record(await postJson(joinUrl(options.baseUrl, "/v1/systemone"), jevRequest(state, q, options.model), {
        headers: { Authorization: `Bearer ${key}` }, timeoutMs: options.timeoutMs,
      }));
      const answers = record(response.answers);
      if (!Object.hasOwn(answers, q.id)) throw new Error(`Missing Jev answer for ${q.id}`);
      const answer = mapJevAnswer(q, answers[q.id]);
      answer.latencyMs = nowMs() - start;
      if (options.usdPerMtokIn != null && options.usdPerMtokOut != null && response.usage != null) {
        const usage = record(response.usage);
        const input = number(usage.input_tokens, "input_tokens");
        const output = number(usage.output_tokens, "output_tokens");
        if (input < 0 || output < 0) throw new Error("Invalid Jev token usage");
        answer.costUsd = (input * options.usdPerMtokIn + output * options.usdPerMtokOut) / 1_000_000;
      }
      return answer;
    },
  };
}
