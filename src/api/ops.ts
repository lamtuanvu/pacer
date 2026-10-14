import { z } from "zod";
import * as core from "../core";
import { CoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import { EXECUTOR_DELEGATE_ERROR, type SpawnRunner, delegateSchema, parseDelegateBrief, spawnRunner, summarizeTask } from "../tasks/api";
import type { Ctx } from "../types";

export interface OpDeps { spawnRunner?: SpawnRunner }
export interface OpDef<P extends z.ZodTypeAny = z.ZodTypeAny> { description: string; params: P; handler: (ctx: Ctx, p: z.infer<P>, deps: OpDeps) => unknown }

const id = z.string().min(1).max(128);
const op = <P extends z.ZodTypeAny>(d: OpDef<P>) => d as unknown as OpDef;

export const OPS: Record<string, OpDef> = {
  "task.get": op({ description: "One task's state and result.", params: z.object({ id }), handler: (ctx, p) => summarizeTask(core.tasks.get(ctx, p.id)) }),
  "task.list": op({ description: "Recent tasks, newest first.", params: z.object({ limit: z.number().int().min(1).max(200).optional() }), handler: (ctx, p) => core.tasks.list(ctx, { limit: p.limit }).map(summarizeTask) }),
  "task.delegate": op({
    description: "Hand a brief to an executor chosen by budget and priority (or `executor`).",
    params: z.object({ ...delegateSchema, repo: z.string().min(1) }),
    handler: (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      return summarizeTask(core.tasks.delegate(ctx, parseDelegateBrief(p, p.repo), deps.spawnRunner ?? spawnRunner));
    },
  }),
  "task.wait": op({ description: "Block until the task settles or timeout_s passes.", params: z.object({ id, timeout_s: z.number().int().min(1).max(3000).optional() }), handler: async (ctx, p) => summarizeTask(await core.tasks.wait(ctx, p.id, p.timeout_s ?? 600)) }),
  "task.stop": op({ description: "Stop a task and its executor.", params: z.object({ id }), handler: (ctx, p) => summarizeTask(core.tasks.stop(ctx, p.id)) }),
  "task.retry": op({
    description: "Re-delegate a task's stored brief (one active retry per task).",
    params: z.object({ id, executor: z.string().min(1).max(128).optional() }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const r = await core.tasks.retry(ctx, p.id, { executor: p.executor }, { delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner) });
      return { retry: summarizeTask(r.retry), of: summarizeTask(r.of) };
    },
  }),
  "task.review": op({ description: "Record the planner's verdict on a task.", params: z.object({ id, accepted: z.boolean(), kind: z.string().optional(), note: z.string().max(2000).optional() }), handler: (ctx, p) => core.tasks.review(ctx, p.id, { accepted: p.accepted, kind: p.kind, note: p.note }) }),
  "task.dismiss": op({ description: "Hide settled tasks; unknown ids are reported.", params: z.object({ ids: z.array(id).min(1).max(100) }), handler: (ctx, p) => { const r = core.tasks.dismiss(ctx, p.ids); return { dismissed: r.dismissed.map((t) => t.id), unknown: r.unknown }; } }),
};

export const opNames = (): string[] => Object.keys(OPS).sort();

export async function callOp(ctx: Ctx, name: string, params: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (!Object.hasOwn(OPS, name)) throw new CoreError("unknown_op", `unknown operation "${name}"`, `operations: ${opNames().join(", ")}`);
  const def = OPS[name];
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  return await def.handler(ctx, parsed.data, deps);
}
