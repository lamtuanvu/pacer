import { z } from "zod";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { createRedactor, type Redactor } from "./redact";
import type { AssistantScope } from "./types";

/** Calls one existing read op in-process. Injected in tests. */
export type ReadOp = (ctx: Ctx, op: string, params: Record<string, unknown>) => Promise<unknown>;

export const RESULT_CAP_BYTES = 32 * 1024;

/**
 * Tool results are projected, not filtered: numbers, booleans and null pass, and a string passes only under a key that
 * holds a short pacer-owned value (ids, states, names). Goals, context, reports, summaries, commands, paths and every
 * other free-text field are dropped by default, so a field added to an op later stays out until it is listed here.
 */
const STRING_KEYS = new Set(["id", "task_id", "taskId", "title", "state", "kind", "executor", "requested_executor", "backend", "runner", "account", "name", "verdict", "mode", "severity", "window", "status", "phase", "label", "version", "strategy", "planner", "agent", "model", "step", "rule", "ladder_rule", "next", "before", "host", "source", "tone", "acceptanceState", "protocol", "previous", "level", "outcome", "relation"]);
/** Extra short keys that only the route explanation uses; they never widen the other tools. */
const EXPLAIN_KEYS = new Set(["code", "subject", "of", "value", "revision"]);
const ENUM_KEYS = new Set(["reason", "note", "resolved"]);
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const clipText = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function project(value: unknown, o: { text?: boolean; keys?: ReadonlySet<string> } = {}, depth = 0): unknown {
  if (depth > 10) return undefined;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => project(v, o, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "number" || typeof value === "boolean" ? value : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!SAFE_KEY.test(key)) continue;
    if (typeof v === "string") {
      if (STRING_KEYS.has(key) || o.keys?.has(key)) out[key] = clipText(v, key === "title" ? 80 : 160);
      else if (ENUM_KEYS.has(key) && /^[a-z][a-z0-9_]{0,31}$/.test(v)) out[key] = v;
      else if (o.text && key === "text") out[key] = clipText(v, 240);
    } else if (v === null || typeof v === "number" || typeof v === "boolean") out[key] = v;
    else { const nested = project(v, o, depth + 1); if (nested !== undefined) out[key] = nested; }
  }
  return out;
}
const stripFreeText = (value: unknown) => project(value);

export interface ReadTool { name: string; description: string; params: z.ZodTypeAny; run: (ctx: Ctx, params: Record<string, unknown>, read: ReadOp, scope: AssistantScope) => Promise<unknown> }
const id = z.string().min(1).max(128);
const out = (note: string) => ({ empty: true, note });

/** A repository scope admits a task only if the task list for that repository holds it. */
async function inChosenScope(ctx: Ctx, read: ReadOp, scope: AssistantScope, taskId: string): Promise<boolean> {
  if (scope.kind === "task") return scope.id === taskId;
  if (scope.kind !== "repo") return true;
  const page = await read(ctx, "task.list", { repo: scope.repo, limit: 200 }) as { tasks?: { id?: string }[] };
  return !!page.tasks?.some(t => t.id === taskId);
}
const recent = (value: unknown, since: number): unknown => {
  const page = value as { tasks?: { updatedAt?: number; createdAt?: number }[] };
  return page && Array.isArray(page.tasks) ? { ...page, tasks: page.tasks.filter(t => { const at = t.updatedAt ?? t.createdAt; return typeof at !== "number" || at >= since; }) } : value;
};

export const READ_TOOLS: ReadTool[] = [
  { name: "snapshot", description: "Counts, attention items, mode and pause state.", params: z.object({}), run: async (ctx, _p, read, scope) => {
    if (scope.kind === "task") return out("The snapshot is outside a single-task scope.");
    const raw = await read(ctx, "snapshot.get", {}) as { snapshot?: Record<string, unknown> };
    const s = raw.snapshot ?? {};
    return stripFreeText({ counts: s.counts, attention: s.attention, mode: s.mode, pause: s.pause, planner: s.planner });
  } },
  { name: "tasks_list", description: "Titles, states, executors and times of work items. At most 100.", params: z.object({ state: z.enum(["queued", "running", "done", "partial", "failed", "limit", "stopped", "needs_input"]).optional(), repo: z.string().min(1).optional(), before: id.optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (ctx, p, read, scope) => {
      if (scope.kind === "task") return out("The scope is a single task; use task_get.");
      const filter = { ...(p.state ? { state: p.state } : {}), ...(scope.kind === "repo" ? { repo: scope.repo } : p.repo ? { repo: p.repo } : {}), ...(p.before ? { before: p.before } : {}) };
      const limit = Math.min(Number(p.limit ?? 50), 100);
      // Managed work and plain tasks live in different lists; show both.
      const [work, tasks] = await Promise.all([
        read(ctx, "dispatch.list", { relation: "all", limit, ...filter }),
        read(ctx, "task.list", { limit, ...(filter.state ? { states: [filter.state] } : {}), ...(filter.repo ? { repo: filter.repo } : {}) }),
      ]);
      const since = scope.kind === "dispatch" ? ctx.now - scope.days * 86400 : 0;
      return stripFreeText({ work: recent(work, since), tasks: recent(tasks, since) });
    } },
  { name: "task_get", description: "Summary fields, decisions, attempts and review state of one work item. No goal or task text.", params: z.object({ id }), run: async (ctx, p, read, scope) => {
    const taskId = String(p.id);
    if (!await inChosenScope(ctx, read, scope, taskId)) return out("That task is outside the chosen scope.");
    // Managed work has a tree; a plain task has only its detail.
    try { return stripFreeText(await read(ctx, "dispatch.tree", { id: taskId })); }
    catch { return stripFreeText(await read(ctx, "task.get", { id: taskId })); }
  } },
  { name: "task_events", description: "The timeline of a work item after a cursor.", params: z.object({ id, after: z.number().int().nonnegative().optional() }), run: async (ctx, p, read, scope) => {
    const taskId = String(p.id);
    if (!await inChosenScope(ctx, read, scope, taskId)) return out("That task is outside the chosen scope.");
    return stripFreeText(await read(ctx, "dispatch.events", { id: taskId, ...(p.after !== undefined ? { after: p.after } : {}) }));
  } },
  { name: "budget", description: "Cached usage, pace and resets per account. Never triggers a live usage read.", params: z.object({}), run: async (ctx, _p, read, scope) => {
    if (scope.kind === "task") return out("Budget is outside a single-task scope.");
    return stripFreeText(await read(ctx, "assistant.budget", {}));
  } },
  { name: "analytics", description: "Reviewed outcomes with sample sizes.", params: z.object({ repo: z.string().optional(), kind: id.optional() }), run: async (ctx, p, read, scope) => {
    if (scope.kind === "task") return out("Analytics are outside a single-task scope.");
    return stripFreeText(await read(ctx, "dispatch.analytics", { ...p, ...(scope.kind === "repo" ? { repo: scope.repo } : {}) }));
  } },
  { name: "activity", description: "Recent activity log entries.", params: z.object({ limit: z.number().int().min(1).max(100).optional() }), run: async (ctx, p, read, scope) => {
    const params: Record<string, unknown> = { limit: p.limit ?? 50 };
    if (scope.kind === "task") params.taskId = scope.id;
    if (scope.kind === "repo") params.repo = scope.repo;
    return project(await read(ctx, "activity.list", params), { text: true });
  } },
  { name: "route_explain", description: "Which executor work like this would go to, and why: the ladder step, the reasons, the fallbacks. Read-only; starts and reserves nothing.", params: z.object({ repo: z.string().min(1).max(4096), kind: z.string().min(1).max(64).optional(), executor: z.string().min(1).max(128).optional() }),
    run: async (ctx, p, read, scope) => {
      if (scope.kind === "task") return out("Route explanations are outside a single-task scope; task_get shows where this task went.");
      const repo = scope.kind === "repo" ? scope.repo : String(p.repo);
      // pacer's own sentences ("Dispatch is paused until …") are safe text; the request itself is a neutral placeholder.
      return project(await read(ctx, "dispatch.explain", { repo, goal: "Explain how work like this would be routed.", ...(p.kind ? { kind: p.kind } : {}), ...(p.executor ? { executor: p.executor } : {}) }), { text: true, keys: EXPLAIN_KEYS });
    } },
  { name: "strategies", description: "Strategy names and summaries.", params: z.object({}), run: async (ctx, _p, read, scope) => {
    if (scope.kind === "task") return out("Strategies are outside a single-task scope.");
    const list = await read(ctx, "strategy.list", {}) as { name: string; active: boolean; summary: string }[];
    return list.map(s => ({ name: s.name, active: s.active, summary: s.summary }));
  } },
];

export interface ToolRunResult { name: string; content: string; ok: boolean }

/** Run one read tool: validate, scope, redact and cap. The result is data, never instructions. */
export async function runReadTool(ctx: Ctx, name: string, args: unknown, o: { read: ReadOp; scope: AssistantScope; redactor: Redactor }): Promise<ToolRunResult> {
  const tool = READ_TOOLS.find(t => t.name === name);
  if (!tool) return { name, ok: false, content: JSON.stringify({ error: `Unknown tool ${name}.` }) };
  const parsed = tool.params.safeParse(args ?? {});
  if (!parsed.success) return { name, ok: false, content: JSON.stringify({ error: "Invalid tool arguments." }) };
  try {
    const result = o.redactor.json(await tool.run(ctx, parsed.data as Record<string, unknown>, o.read, o.scope));
    // `<` is escaped so data can never close the <data> block that carries it.
    let text = JSON.stringify(result ?? null).replaceAll("<", "\\u003c");
    if (Buffer.byteLength(text) > RESULT_CAP_BYTES) {
      // Cut on a UTF-8 boundary and say so, shrinking until the escaped wrapper itself fits the cap.
      const full = Buffer.from(text);
      let keep = RESULT_CAP_BYTES - 300;
      do {
        text = JSON.stringify({ truncated: true, note: "The result was larger than 32 KiB and was cut.", partial: full.subarray(0, keep).toString("utf8").replace(/\uFFFD$/, "") }).replaceAll("<", "\\u003c");
        keep = Math.floor(keep * 0.8);
      } while (Buffer.byteLength(text) > RESULT_CAP_BYTES);
    }
    return { name, ok: true, content: text };
  } catch (error) {
    const message = error instanceof CoreError ? error.message : "The tool could not read that data.";
    return { name, ok: false, content: JSON.stringify({ error: o.redactor.text(message) }).replaceAll("<", "\\u003c") };
  }
}

/** Definitions handed to the backend. The host runs the tools; the backend only asks. */
export function toolDefinitions(): { name: string; description: string; parameters: unknown }[] {
  return [
    ...READ_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.params) })),
    { name: "propose_action", description: "Suggest one action for the user to confirm. It never runs on its own.", parameters: { type: "object", additionalProperties: false, required: ["op", "params", "why"], properties: { op: { type: "string" }, params: { type: "object" }, why: { type: "string", maxLength: 600 } } } },
  ];
}

export const defaultRedactor = (secrets: readonly string[], home: string) => createRedactor(secrets, home);
