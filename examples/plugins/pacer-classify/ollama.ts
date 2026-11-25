import { isLocalUrl, joinUrl, postJson } from "./http";
import type { Answer, Classifier, ClassifierHost, Question } from "./http";

function answerField(q: Question): "choice" | "score" | "answer" {
  return q.type === "yesno" ? "answer" : q.type;
}

export function schemaFor(q: Question) {
  const property = q.type === "choice"
    ? { type: "string", enum: Object.keys(q.criteria) }
    : q.type === "score"
      ? { type: "number", minimum: q.min, maximum: q.max }
      : { type: "boolean" };
  const field = answerField(q);
  return {
    type: "object",
    properties: { [field]: property, confidence: { type: "number", minimum: 0, maximum: 1 } },
    required: [field, "confidence"],
    additionalProperties: false,
  };
}

export function promptFor(q: Question, state: string): string {
  const criteria = q.type === "choice"
    ? `Criteria: ${JSON.stringify(q.criteria)}`
    : q.type === "score"
      ? `Score must be between ${q.min} and ${q.max}.`
      : "Answer must be a boolean.";
  return `${q.instructions}\n${criteria}\nReturn only JSON with ${answerField(q)} and confidence (a number between 0 and 1).\nState:\n${state}`;
}

export function parseLocalAnswer(q: Question, content: string): Pick<Answer, "value" | "confidence"> {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const raw: unknown = JSON.parse(fenced ? fenced[1].trim() : trimmed);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON answer object");
  const data = raw as Record<string, unknown>;
  const confidence = data.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Confidence must be a number between 0 and 1");
  }
  const value = data[answerField(q)];
  if (q.type === "choice") {
    if (typeof value !== "string" || !Object.hasOwn(q.criteria, value)) throw new Error("Choice must be one of the criteria");
  } else if (q.type === "score") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < q.min || value > q.max) {
      throw new Error(`Score must be a number between ${q.min} and ${q.max}`);
    }
  } else if (typeof value !== "boolean") {
    throw new Error("Answer must be a boolean");
  }
  return { value: value as Answer["value"], confidence };
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  maxTokens: number;
  keyRef: string | null;
  nowMs?: () => number;
}

export function ollamaClassifier(options: OllamaOptions, host: ClassifierHost): Classifier {
  const nowMs = options.nowMs ?? Date.now;
  return {
    id: "ollama",
    external: !isLocalUrl(options.baseUrl),
    async ask(state, q, timeoutMs) {
      // Missing optional local credentials historically issue an anonymous request.
      const keyRef = options.keyRef && await host.secrets.present(options.keyRef) ? options.keyRef : undefined;
      const started = nowMs();
      const raw = await postJson<{ choices?: { message?: { content?: unknown } }[] }>(
        host, joinUrl(options.baseUrl, "/chat/completions"),
        {
          model: options.model,
          temperature: 0,
          stream: false,
          max_tokens: options.maxTokens,
          messages: [{ role: "user", content: promptFor(q, state) }],
          response_format: { type: "json_schema", json_schema: { name: q.id, schema: schemaFor(q) } },
        },
        { timeoutMs, keyRef },
      );
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("Missing chat completion message content");
      return { ...parseLocalAnswer(q, content), latencyMs: nowMs() - started, costUsd: 0 };
    },
  };
}
