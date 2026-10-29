import { connectClient } from "../api/client";
import {callOp} from "../api/ops";
import { previewInputSchema } from "../dispatch/types";
import { isAbsolute } from "node:path";
import { resolveRepoInput } from "../core/repos";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json";
import { KINDS } from "../config/strategy";
import * as core from "../core";
import { isExecutorSession } from "../install/role";
import { makeCtx } from "../ctx";
import { type SpawnRunner, EXECUTOR_DELEGATE_ERROR, delegateSchema, parseDelegateBrief, summarizeTask, spawnRunner } from "../tasks/api";
import { appendLabel } from "../tasks/labels";
import type { Ctx } from "../types";

import * as strategies from "../strategy/service";

const json = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
  structuredContent: value,
});

export { summarizeTask } from "../tasks/api";

export function createMcpServer(getCtx: () => Ctx, opts: { spawnRunner?: SpawnRunner } = {}): McpServer {
  const server = new McpServer({ name: "pacer", version: pkg.version });
  if (getCtx().env.PACER_WORK_GRANT) {
    const scoped = async (op: string, params: Record<string, unknown>) => {
      try {
        const client = await connectClient(getCtx(), {protocol: 3});
        try { return json(await client.call<Record<string, unknown>>(op, params)); }
        finally { client.close(); }
      } catch (error) { return {...json({error:error instanceof Error?error.message:"Scoped request failed"}),isError:true}; }
    };
    server.registerTool("delegate", {description:"Delegate a scoped child. requestId makes retries safe.",inputSchema:{goal:z.string().min(1),requestId:z.string().min(1),title:z.string().optional(),kind:z.string().optional(),acceptance:z.string().optional(),context:z.string().optional(),constraints:z.string().optional(),executor:z.string().optional()}}, async input=>scoped("dispatch.child",input));
    server.registerTool("task_status", {description:"Read a task in your own work subtree.",inputSchema:{task_id:z.string()}},async({task_id})=>scoped("task.get",{id:task_id}));
    server.registerTool("task_wait", {description:"Wait for a task in your own work subtree.",inputSchema:{task_id:z.string(),timeout_s:z.number().int().min(1).max(3000).optional()}},async({task_id,timeout_s})=>scoped("dispatch.wait",{id:task_id,timeout_s}));
    server.registerTool("task_review", {description:"Review a child task at the revision shown by work_tree; you cannot review yourself.",inputSchema:{task_id:z.string(),accepted:z.boolean(),expect_rev:z.number().int().positive(),note:z.string().optional()}},async({task_id,accepted,note,expect_rev})=>scoped("dispatch.review",{id:task_id,accepted,note,expect_rev}));
    server.registerTool("work_retry", {description:"Retry a settled child in the same work item. Use a stable requestId; you cannot retry yourself.",inputSchema:{task_id:z.string(),expect_rev:z.number().int().positive(),requestId:z.string().min(1),feedback:z.string().max(2000).optional()}},async({task_id,...input})=>scoped("dispatch.retry",{id:task_id,...input}));
    server.registerTool("work_answer", {description:"Answer a question from a child in the same work item. Use a stable requestId.",inputSchema:{task_id:z.string(),expect_rev:z.number().int().positive(),requestId:z.string().min(1),text:z.string().min(1).max(2000)}},async({task_id,...input})=>scoped("dispatch.answer",{id:task_id,...input}));
    server.registerTool("work_tree", {description:"Read your own work subtree and decisions.",inputSchema:{task_id:z.string()}},async({task_id})=>scoped("dispatch.tree",{id:task_id}));
    server.registerTool("work_events", {description:"Read your own work events after a cursor.",inputSchema:{task_id:z.string(),after:z.number().int().nonnegative().optional()}},async({task_id,after})=>scoped("dispatch.events",{id:task_id,after}));
    server.registerTool("task_stop", {description:"Stop a task in your own work subtree.",inputSchema:{task_id:z.string(),expect_rev:z.number().int().positive().optional()}},async({task_id,expect_rev})=>scoped("dispatch.stop",{id:task_id,expect_rev}));
    return server;
  }
  const spawnFn = opts.spawnRunner ?? spawnRunner;

  server.registerTool("budget_status", {
    description: "Budget status for every subscription: usage vs pace, verdicts, the planner's mode and the ranked executors. Call at session start and before large delegation decisions.",
    inputSchema: {},
  }, async () => {
    const ctx = getCtx();
    return json({ ...(await core.routing.status(ctx)) });
  });

  server.registerTool("dispatch_preview", {
    description: "Preview model/account selection with reasons and uncertainty. Uses cached observations; launches nothing and changes no strategy.",
    inputSchema: previewInputSchema.shape,
  }, async input => {
    try {
      const ctx = getCtx();
      const client = await connectClient(ctx, {protocol: 3});
      try {
        const result = client.kind === "inprocess" ? await core.dispatch.previewDispatch(ctx, input) : await client.call<Record<string, unknown>>("dispatch.preview", input);
        return json({ ...result });
      } finally { client.close(); }
    }
    catch (error) { return { ...json({ error: error instanceof Error ? error.message : "Preview failed" }), isError: true }; }
  });
  server.registerTool("work_retry", {description:"Retry settled managed work in the same task and worktree with revision protection.",inputSchema:{task_id:z.string(),expect_rev:z.number().int().positive(),requestId:z.string().min(1),feedback:z.string().max(2000).optional()}},async({task_id,...input})=>json(await callOp(getCtx(),"dispatch.retry",{id:task_id,...input},{spawnRunner:spawnFn}) as Record<string,unknown>));
  server.registerTool("work_answer", {description:"Answer a managed work question and resume the same task.",inputSchema:{task_id:z.string(),expect_rev:z.number().int().positive(),requestId:z.string().min(1),text:z.string().min(1).max(2000)}},async({task_id,...input})=>json(await callOp(getCtx(),"dispatch.answer",{id:task_id,...input},{spawnRunner:spawnFn}) as Record<string,unknown>));

  server.registerTool("route", {
    description: "Which executors pacer would use for a task kind, in order, with reasons and exclusions. Runs nothing.",
    inputSchema: { kind: z.enum(KINDS).optional() },
  }, async ({ kind }) => {
    const ctx = getCtx();
    return json(await core.routing.route(ctx, kind ?? null));
  });

  server.registerTool("delegate", {
    description: "Hand an execution task to an executor (chosen by budget and priority unless `executor` is given). Returns a task_id immediately; poll with task_status or block with task_wait. Review the diff yourself before reporting done, then call task_review.",
    inputSchema: delegateSchema,
  }, async (a) => {
    const ctx = getCtx();
    if (isExecutorSession(ctx)) throw new Error(EXECUTOR_DELEGATE_ERROR);
    const input = parseDelegateBrief(a, process.cwd());
    const repoRef=await resolveRepoInput(ctx,input.brief.repo);
    const t = core.tasks.delegate(ctx, {...input, brief:{...input.brief,repo:isAbsolute(input.brief.repo)?input.brief.repo:repoRef.path}, source:"planner", repoRef}, spawnFn);
    return json(summarizeTask(t));
  });

  server.registerTool("task_status", {
    description: "Current state and result of a delegated task.",
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => json(summarizeTask(core.tasks.get(getCtx(), task_id))));

  server.registerTool("task_wait", {
    description: "Block until a delegated task finishes or timeout_s passes (default 600, max 3000), then return its state.",
    inputSchema: { task_id: z.string(), timeout_s: z.number().int().min(1).max(3000).optional() },
  }, async ({ task_id, timeout_s }) => json(summarizeTask(await core.tasks.wait(getCtx(), task_id, timeout_s ?? 600))));

  server.registerTool("task_answer", {
    description: "Answer an executor question and retry the task on the same executor. Only needs_input tasks can be answered.",
    inputSchema: {task_id:z.string(), text:z.string().min(1).max(2000), expect_rev:z.number().int().positive().optional()},
  }, async ({task_id,text,expect_rev}) => json(await callOp(getCtx(),"task.answer",{id:task_id,text,expect_rev},{spawnRunner:spawnFn}) as Record<string,unknown>));

  server.registerTool("task_send", {
    description: "Send one message into a running interactive lane's live agent (delegate --interactive); a lane waiting on its question is answered with task_answer instead. Refused when the agent is not in its terminal's foreground, or while another client drove the lane in the last 60 seconds unless force.",
    inputSchema: {task_id:z.string(), text:z.string().min(1).max(4000), force:z.boolean().optional(), expect_rev:z.number().int().positive().optional()},
  }, async ({task_id,text,force,expect_rev}) => json(await callOp(getCtx(),"task.send",{id:task_id,text,force,expect_rev},{client:"mcp/stdio"}) as Record<string,unknown>));

  server.registerTool("task_stop", {
    description: "Stop a delegated task and kill its executor.",
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => json(await callOp(getCtx(),"task.stop",{id:task_id}) as Record<string,unknown>));

  server.registerTool("report_limit", {
    description: "Tell pacer an executor hit its plan limit (seen outside pacer). It is skipped until `until` (unix seconds) or its cooldown.",
    inputSchema: { provider: z.string(), until: z.number().optional() },
  }, async ({ provider, until }) => {
    const ctx = getCtx();
    const r = core.limits.report(ctx, provider, until);
    return json({ provider: r.provider, exhausted_until: r.exhaustedUntil });
  });

  server.registerTool("task_request_review", {
    description: "Ask a human to decide about a completed result. Give the specific concern; this does not accept the work.",
    inputSchema: { task_id: z.string(), note: z.string().trim().min(1).max(2000), expect_rev: z.number().int().positive().optional() },
  }, async ({ task_id, note, expect_rev }) => json({ task: summarizeTask(core.tasks.requestReview(getCtx(), task_id, { note, expect_rev })) }));

  server.registerTool("task_review", {
    description: "Record your verdict on a delegated task's result after reviewing it (ground truth for pacer's routing benchmark).",
    inputSchema: { task_id: z.string(), verdict: z.enum(["accept", "reject", "send_back", "retry"]), executor: z.string().optional(), kind: z.enum(KINDS).optional(), note: z.string().optional(), expect_rev:z.number().int().positive().optional() },
  }, async ({ task_id, verdict, executor, kind, note, expect_rev }) => {
    const ctx = getCtx();
    if ((verdict === "send_back" || verdict === "retry") && isExecutorSession(ctx)) throw new Error(EXECUTOR_DELEGATE_ERROR);
    return json(await callOp(ctx,"task.review",{id:task_id,verdict,executor,kind,note,expect_rev},{spawnRunner:spawnFn}) as Record<string,unknown>);
  });

  server.registerTool("guard_feedback", {
    description: "Report that pacer's subagent guard decided wrongly (or rightly) for a given event.",
    inputSchema: { event_id: z.string(), correct: z.boolean(), note: z.string().optional() },
  }, async ({ event_id, correct, note }) => {
    appendLabel(getCtx(), { type: "guard_feedback", event_id, correct, note: note ?? null });
    return json({ recorded: true });
  });

  const guidance = "Always preview first and show the user the ranking change. Save only after the user agrees, with a reason. Never switch unless asked.";
  const nameSchema=z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
  const existingNameSchema=z.string().min(1);
  const draftSchema=z.object({from:existingNameSchema,set:z.record(z.string(),z.json()).optional(),unset:z.array(z.string()).optional(),description:z.string().optional()});
  const safeStrategy=async(fn:()=>unknown|Promise<unknown>)=>{try{return json(await fn() as Record<string,unknown>);}catch(e){return {...json({error:(e as Error).message}),isError:true};}};
  server.registerTool("strategy_list",{description:"List strategies and their summaries. "+guidance,inputSchema:{}},async()=>safeStrategy(()=>({strategies:strategies.list(getCtx())})));
  server.registerTool("strategy_show",{description:"Show a strategy YAML and summary. "+guidance,inputSchema:{name:existingNameSchema}},async({name})=>safeStrategy(()=>strategies.show(getCtx(),name)));
  server.registerTool("strategy_preview",{description:"Validate a draft without writing; compare ranking and routing against current usage. "+guidance,inputSchema:{draft:draftSchema}},async({draft})=>safeStrategy(()=>strategies.preview(getCtx(),draft)));
  server.registerTool("strategy_save",{description:"Save a validated draft. Replacing the active strategy changes live routing and requires overwrite:true and activeOk:true. "+guidance,inputSchema:{name:nameSchema,draft:draftSchema,reason:z.string().min(1),overwrite:z.boolean().optional(),activeOk:z.boolean().optional(),who:z.string().min(1).optional().describe("Agent identity for the creation header")}},async({name,draft,reason,overwrite,activeOk,who})=>safeStrategy(()=>strategies.save(getCtx(),name,draft,reason,{overwrite,activeOk,who})));
  server.registerTool("strategy_use",{description:"Switch the active strategy only when explicitly asked. "+guidance,inputSchema:{name:existingNameSchema}},async({name})=>safeStrategy(async()=>({name,path:await strategies.use(getCtx(),name)})));

  return server;
}

export async function runMcpStdio(getCtx: () => Ctx = () => makeCtx()): Promise<void> {
  await createMcpServer(getCtx).connect(new StdioServerTransport());
}
