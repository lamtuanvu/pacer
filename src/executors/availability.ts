import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { Ctx } from "../types";
import { readMarks } from "../usage/reactive";
import { readBlocked } from "./blocked";

/** Re-read persisted guardrails at dispatch, including aliases and shared accounts. */
export function executorExclusion(ctx: Ctx, s: Strategy | undefined, id: string): string | undefined {
  const runner = s ? resolveRunner(s, id) : null;
  const parsed = parseRunnerId(id);
  const account = runner?.account ?? parsed?.account ?? parsed?.agent;
  const matches = (key: string) => key === id || key === account || (!!s && !!runner && resolveRunner(s, key)?.id === runner.id);
  if (Object.keys(readBlocked(ctx)).some(matches)) return "Blocked by you";
  if (Object.entries(readMarks(ctx)).some(([key, until]) => until > ctx.now && matches(key))) return "exhausted";
}
