import { z } from "zod";
import * as core from "../core";
import { KINDS } from "../config/strategy";
import { CoreError, toCoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import * as strategy from "../strategy/service";
import { EXECUTOR_DELEGATE_ERROR, type SpawnRunner, delegateSchema, parseDelegateBrief, spawnRunner, summarizeTask } from "../tasks/api";
import type { Ctx } from "../types";

export interface OpDeps { spawnRunner?: SpawnRunner }
export interface OpDef<P extends z.ZodTypeAny = z.ZodTypeAny> { description: string; params: P; handler: (ctx: Ctx, p: z.infer<P>, deps: OpDeps) => unknown }

const id = z.string().min(1).max(128);
const op = <P extends z.ZodTypeAny>(d: OpDef<P>) => d as unknown as OpDef;

export const OPS: Record<string, OpDef> = {
  "host.list": op({ description: "Configured SSH hosts and running task counts.", params: z.object({}), handler: ctx => core.hosts.list(ctx) }),
  "host.check": op({ description: "Check SSH host prerequisites, checkouts and identity.", params: z.object({ alias: id, repo: z.string().min(1).optional() }), handler: (ctx, p) => core.hosts.check(ctx, p.alias, { repo: p.repo }) }),
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
    params: z.object({ id, executor: z.string().min(1).max(128).optional(), from_panel: z.boolean().optional() }),
    handler: async (ctx, p, deps) => {
      if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
      const r = await core.tasks.retry(ctx, p.id, { executor: p.executor, fromPanel: p.from_panel }, { delegate: (c, input) => core.tasks.delegate(c, input, deps.spawnRunner ?? spawnRunner) });
      return { retry: summarizeTask(r.retry), of: summarizeTask(r.of) };
    },
  }),
  "task.review": op({ description: "Record the planner's verdict on a task.", params: z.object({ id, accepted: z.boolean(), kind: z.string().optional(), note: z.string().max(2000).optional() }), handler: (ctx, p) => core.tasks.review(ctx, p.id, { accepted: p.accepted, kind: p.kind, note: p.note }) }),
  "task.dismiss": op({ description: "Hide settled tasks; unknown ids are reported.", params: z.object({ ids: z.array(id).min(1).max(100) }), handler: (ctx, p) => { const r = core.tasks.dismiss(ctx, p.ids); return { dismissed: r.dismissed.map((t) => t.id), unknown: r.unknown }; } }),
  "task.log": op({ description: "Read up to 256 KiB per output stream from byte offsets.", params: z.object({ id, stdout: z.number().int().nonnegative().optional(), stderr: z.number().int().nonnegative().optional() }), handler: (ctx, p) => core.tasks.log(ctx, p.id, p) }),
  "task.diff": op({ description: "Tracked changes against the task's base, plus untracked filenames.", params: z.object({ id }), handler: (ctx, p) => core.tasks.diff(ctx, p.id) }),
  "runner.list": op({ description: "Configured executors and their availability.", params: z.object({}), handler: (ctx) => core.runners.list(ctx) }),
  "runner.block": op({ description: "Block an executor for a duration, with an optional reason.", params: z.object({ id, for: z.string().optional(), reason: z.string().optional() }), handler: (ctx, p) => { core.runners.block(ctx, p.id, p); return { ok: true }; } }),
  "runner.unblock": op({ description: "Remove an executor's manual block.", params: z.object({ id }), handler: (ctx, p) => { core.runners.unblock(ctx, p.id); return { ok: true }; } }),
  "limits.check": op({ description: "Provider limits, freshness and usage sources.", params: z.object({}), handler: (ctx) => core.limits.check(ctx) }),
  "limits.report": op({ description: "Mark a provider's account exhausted until unix seconds or its cooldown.", params: z.object({ provider: id, until: z.number().optional() }), handler: (ctx, p) => core.limits.report(ctx, p.provider, p.until) }),
  "routing.status": op({ description: "Current budget and routing status.", params: z.object({}), handler: (ctx) => core.routing.status(ctx) }),
  "routing.route": op({ description: "Rank executors for an optional task kind.", params: z.object({ kind: z.enum(KINDS).optional() }), handler: (ctx, p) => core.routing.route(ctx, p.kind ?? null) }),
  "strategy.list": op({ description: "Available strategies and the active strategy.", params: z.object({}), handler: (ctx) => { try { return strategy.list(ctx); } catch (e) { throw toCoreError(e); } } }),
  "strategy.use": op({ description: "Activate a named strategy.", params: z.object({ name: z.string().min(1) }), handler: async (ctx, p) => { try { return { name: p.name, path: await strategy.use(ctx, p.name) }; } catch (e) { throw toCoreError(e); } } }),
};

export const opNames = (): string[] => Object.keys(OPS).sort();

export function opJsonSchemas(): Record<string, { description: string; params: unknown }> {
  return Object.fromEntries(opNames().map((name) => {
    const def = OPS[name];
    return [name, { description: def.description, params: z.toJSONSchema(def.params) }];
  }));
}

export async function callOp(ctx: Ctx, name: string, params: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (!Object.hasOwn(OPS, name)) throw new CoreError("unknown_op", `unknown operation "${name}"`, `operations: ${opNames().join(", ")}`);
  const def = OPS[name];
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  return await def.handler(ctx, parsed.data, deps);
}
