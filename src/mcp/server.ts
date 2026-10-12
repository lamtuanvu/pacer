import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KINDS, loadStrategy } from "../config/strategy";
import { makeCtx } from "../ctx";
import { rankExecutors } from "../engine/rank";
import { computeStatus } from "../engine/status";
import { type SpawnRunner, delegate, spawnRunner, taskStatus, taskStop, taskWait } from "../tasks/api";
import { appendLabel } from "../tasks/labels";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { markExhausted } from "../usage/reactive";

const json = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
  structuredContent: value,
});

export function summarizeTask(t: TaskRecord): Record<string, unknown> {
  return {
    task_id: t.id,
    state: t.state,
    kind: t.kind,
    requested_executor: t.requestedExecutor,
    attempts: t.attempts.map((a) => ({ executor: a.executor, exit_code: a.exitCode, limit_hit: a.limitHit, timed_out: a.timedOut, log: a.log })),
    result: t.result ?? null,
  };
}

function mustTask(t: TaskRecord | null, id: string): TaskRecord {
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export function createMcpServer(getCtx: () => Ctx, opts: { spawnRunner?: SpawnRunner } = {}): McpServer {
  const server = new McpServer({ name: "pacer", version: "0.2.0" });
  const spawnFn = opts.spawnRunner ?? spawnRunner;

  server.registerTool("budget_status", {
    description: "Budget status for every subscription: usage vs pace, verdicts, the planner's mode and the ranked executors. Call at session start and before large delegation decisions.",
    inputSchema: {},
  }, async () => {
    const ctx = getCtx();
    return json({ ...(await computeStatus(ctx, loadStrategy(ctx))) });
  });

  server.registerTool("route", {
    description: "Which executors pacer would use for a task kind, in order, with reasons and exclusions. Runs nothing.",
    inputSchema: { kind: z.enum(KINDS).optional() },
  }, async ({ kind }) => {
    const ctx = getCtx();
    const s = loadStrategy(ctx);
    const st = await computeStatus(ctx, s);
    const r = rankExecutors(kind ?? null, s, Object.fromEntries(st.providers.map((p) => [p.id, p])));
    return json({ kind: kind ?? null, ranked: r.ranked, excluded: r.excluded });
  });

  server.registerTool("delegate", {
    description: "Hand an execution task to an executor (chosen by budget and priority unless `executor` is given). Returns a task_id immediately; poll with task_status or block with task_wait. Review the diff yourself before reporting done, then call task_review.",
    inputSchema: {
      goal: z.string().min(1).describe("One or two sentences on the outcome"),
      repo: z.string().min(1).describe("Absolute path of the repository to work in"),
      scope: z.string().optional().describe("Files or areas that may change, and what must not"),
      acceptance: z.string().optional().describe("Shell command that proves the task is done, run in repo"),
      constraints: z.string().optional(),
      context: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      executor: z.string().optional().describe("Force a specific executor id"),
      timeout_min: z.number().min(1).max(240).optional(),
    },
  }, async (a) => {
    const ctx = getCtx();
    if (ctx.env.PACER_ROLE === "executor") throw new Error("PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.");
    const t = delegate(ctx, {
      brief: { goal: a.goal, repo: a.repo, scope: a.scope, acceptance: a.acceptance, constraints: a.constraints, context: a.context },
      kind: a.kind ?? null,
      executor: a.executor ?? null,
      timeoutMin: a.timeout_min,
    }, spawnFn);
    return json(summarizeTask(t));
  });

  server.registerTool("task_status", {
    description: "Current state and result of a delegated task.",
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => json(summarizeTask(mustTask(taskStatus(getCtx(), task_id), task_id))));

  server.registerTool("task_wait", {
    description: "Block until a delegated task finishes or timeout_s passes (default 600, max 3000), then return its state.",
    inputSchema: { task_id: z.string(), timeout_s: z.number().int().min(1).max(3000).optional() },
  }, async ({ task_id, timeout_s }) => json(summarizeTask(mustTask(await taskWait(getCtx(), task_id, timeout_s ?? 600), task_id))));

  server.registerTool("task_stop", {
    description: "Stop a delegated task and kill its executor.",
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => json(summarizeTask(mustTask(taskStop(getCtx(), task_id), task_id))));

  server.registerTool("report_limit", {
    description: "Tell pacer an executor hit its plan limit (seen outside pacer). It is skipped until `until` (unix seconds) or its cooldown.",
    inputSchema: { provider: z.string(), until: z.number().optional() },
  }, async ({ provider, until }) => {
    const ctx = getCtx();
    const cfg = loadStrategy(ctx).providers[provider];
    if (!cfg) throw new Error(`unknown provider "${provider}"`);
    const at = until ?? ctx.now + cfg.cooldownS;
    markExhausted(ctx, provider, at);
    return json({ provider, exhausted_until: at });
  });

  server.registerTool("task_review", {
    description: "Record your verdict on a delegated task's result after reviewing it (ground truth for pacer's routing benchmark).",
    inputSchema: { task_id: z.string(), accepted: z.boolean(), kind: z.enum(KINDS).optional(), note: z.string().optional() },
  }, async ({ task_id, accepted, kind, note }) => {
    const ctx = getCtx();
    const t = mustTask(taskStatus(ctx, task_id), task_id);
    appendLabel(ctx, { type: "task_review", task_id, accepted, kind: kind ?? t.kind, note: note ?? null, executor: t.result?.executor ?? null });
    return json({ recorded: true });
  });

  server.registerTool("guard_feedback", {
    description: "Report that pacer's subagent guard decided wrongly (or rightly) for a given event.",
    inputSchema: { event_id: z.string(), correct: z.boolean(), note: z.string().optional() },
  }, async ({ event_id, correct, note }) => {
    appendLabel(getCtx(), { type: "guard_feedback", event_id, correct, note: note ?? null });
    return json({ recorded: true });
  });

  return server;
}

export async function runMcpStdio(getCtx: () => Ctx = () => makeCtx()): Promise<void> {
  await createMcpServer(getCtx).connect(new StdioServerTransport());
}
