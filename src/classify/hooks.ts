import type { Strategy } from "../config/strategy";
import type { TaskRecord, TaskResult } from "../tasks/types";
import type { Ctx } from "../types";

export interface ResultCheck { pass: boolean; confidence: number; adapter: string }
export interface GuardInput { subagentType: string; prompt: string; model?: string }
export interface GuardOpinion { allow: boolean; reason?: string; adapter: string; confidence: number }

/** Decision points (spec §3.9). Plan 4 supplies classifier-backed hooks; these defaults keep today's rule-based behaviour. */
export interface DecisionHooks {
  taskKind(ctx: Ctx, task: TaskRecord): Promise<string | null>;
  filterExecutors(ctx: Ctx, task: TaskRecord, ranked: string[], s: Strategy): Promise<string[]>;
  resultCheck(ctx: Ctx, task: TaskRecord, result: TaskResult): Promise<ResultCheck | undefined>;
  /** null = no opinion: the guard (Plan 3) applies its own rules. */
  guard(ctx: Ctx, input: GuardInput): Promise<GuardOpinion | null>;
}

export const defaultHooks: DecisionHooks = {
  taskKind: async (_ctx, task) => task.kind,
  filterExecutors: async (_ctx, _task, ranked) => ranked,
  resultCheck: async () => undefined,
  guard: async () => null,
};
