import type { ClassifierConfig } from "../config/classifier";
import type { Ctx } from "../types";
import { appendDecision, loggedState, newDecisionId } from "./log";
import type { AdapterSet } from "./registry";
import { stateHash } from "./state";
import type { AdapterId, Answer, DecisionEntry, DecisionName, Question } from "./types";

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function decide(ctx: Ctx, cfg: ClassifierConfig, adapters: AdapterSet, input: {
  decision: DecisionName;
  state: string;
  question: Question;
  actedOn: boolean;
  taskId?: string;
  use?: AdapterId;
}): Promise<{ answer: Answer; adapter: string; fallback: boolean }> {
  const use = input.use ?? cfg.decisions[input.decision].use;
  const base = {
    ts: ctx.now,
    decision: input.decision,
    state_hash: stateHash(input.state),
    question: input.question,
    ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
  };
  const log = (fields: Pick<DecisionEntry, "adapter" | "answer" | "acted_on" | "fallback"> & Partial<DecisionEntry>) => {
    try {
      appendDecision(ctx, { ...base, id: newDecisionId(), state: loggedState(input.state, cfg.logState, ctx.home), ...fields });
    } catch { /* Logging must never fail a decision. */ }
  };
  const ask = (id: AdapterId) => withTimeout(
    Promise.resolve().then(() => adapters[id].ask(input.state, input.question)), cfg.timeoutMs, id,
  );
  const shadows = [...new Set(cfg.shadow)]
    .filter(id => id !== use && (!adapters[id].external || cfg.shadowExternal))
    .map(async id => {
      try {
        log({ adapter: adapters[id].id, answer: await ask(id), acted_on: false, fallback: false, shadow: true });
      } catch (error) {
        log({ adapter: adapters[id].id, answer: null, acted_on: false, fallback: false, shadow: true, error: errorMessage(error) });
      }
    });

  let answer: Answer;
  let adapter = adapters[use].id;
  let fallback = false;
  let attempted: Answer | undefined;
  let fallbackReason: string | undefined;
  try {
    answer = await ask(use);
    if (use !== "rules" && answer.confidence < cfg.decisions[input.decision].minConfidence) {
      attempted = answer;
      fallbackReason = `confidence ${answer.confidence} below ${cfg.decisions[input.decision].minConfidence}`;
    }
  } catch (error) {
    if (use === "rules") {
      if (input.decision !== "guard") await Promise.all(shadows);
      throw error;
    }
    fallbackReason = errorMessage(error);
  }
  if (fallbackReason !== undefined) {
    answer = await ask("rules");
    adapter = adapters.rules.id;
    fallback = true;
  }
  log({ adapter, answer: answer!, acted_on: input.actedOn, fallback,
    ...(fallback ? { fallback_from: adapters[use].id, fallback_reason: fallbackReason } : {}),
    ...(attempted ? { attempted } : {}),
  });
  if (input.decision !== "guard") await Promise.all(shadows);
  return { answer: answer!, adapter, fallback };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .slice(0, 200);
}
