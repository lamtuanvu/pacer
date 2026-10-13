#!/usr/bin/env bun
import { markExhausted } from "./usage/reactive";
import { readFileSync } from "node:fs";
import { isExecutorSession } from "./install/role";
import { executorCommand } from "./executors/command";
import { use as switchStrategy } from "./strategy/service";
import { hookInput, plannerPolicyApplies } from "./install/role";
import { io } from "./install/stdin";
import { resolve } from "node:path";
import { EXTRA_COMMANDS, findCommand } from "./commands/index";
import type { Result } from "./commands/types";
import { MissingStrategyError, PLANNERS, StrategyError, loadStrategy } from "./config/strategy";
import { makeCtx } from "./ctx";
import { rankExecutors } from "./engine/rank";
import { computeStatus, displayName } from "./engine/status";
import { runMcpStdio } from "./mcp/server";
import { renderHook } from "./render/hook";
import { renderLine } from "./render/line";
import { renderText } from "./render/text";
import { DEFAULT_PORT, startServer } from "./serve/http";
import { DelegateError, EXECUTOR_DELEGATE_ERROR, parseDelegateBrief, summarizeTask, taskReview, taskDismiss, delegate, taskStatus, taskStop, taskWait } from "./tasks/api";
import { runTask } from "./tasks/runner";
import { listTasks } from "./tasks/store";
import { TERMINAL_STATES, type TaskRecord } from "./tasks/types";
import type { Ctx } from "./types";

const USAGE = `usage: pacer <command>
  status [--line | --json | --hook <planner>]   budget status (default: text report)
  route [kind] [--json]                          executors pacer would use, in order
  delegate [--brief-file <path|->] [--goal <text>] [--repo <dir>] [--kind <k>] [--scope <s>] [--acceptance <cmd>]
           [--constraints <s>] [--context <s>] [--executor <id>] [--timeout-min <n>] [--wait] [--json] [--force]
           [--worktree current|new|auto] [--worktree-reason <text>]
  wait <task-id> [--timeout <seconds>] [--json]   wait (default 600, max 3000); exit 2 on timeout
  review <task-id> --accept|--reject [--kind <k>] [--json] record review
  dismiss <task-id...>                           hide settled tasks
  tasks [<task-id>] [--json]                     recent tasks, or one task in detail
  executor block <id> [--for <duration>] [--reason <text>] | unblock <id> | list
  stop <task-id> [--json]                         stop a running task
  report-limit <provider> [--until <unix-seconds>] record an executor limit
  mcp                                            run the MCP server on stdio
  serve [--port <n>]                             local HTTP status endpoint (default ${DEFAULT_PORT})
  use <strategy>                                 switch to ~/.pacer/strategies/<strategy>.yaml ("default" = strategy.yaml)
  help                                           this message
JSON: status: generatedAt, strategy, planner, mode, disabled, calendarPace, providers, executors.
route: kind, ranked, excluded. delegate: TaskRecord (id, createdAt, kind, requestedExecutor, timeoutS, brief, state, attempts, placement; optional runtime fields).
tasks <id>, wait, stop: task_id, state, kind, requested_executor, placement, attempts, result, review, resolved.
tasks: array of those task summaries. review: recorded. Flags override brief-file fields; repo defaults to cwd.
install <planner> [--mcp|--no-mcp]: skill and hooks; MCP is optional.
update refreshes installed skills, policy and hooks; --no-reinstall skips refresh.
Cursor and OpenCode also read ~/.claude/skills; Cursor also reads ~/.codex/skills.
Identical pacer skill copies may appear; update refresh keeps them identical.`;

function help(): string {
  const builtins = new Set(["status", "route", "delegate", "tasks", "stop", "mcp", "serve", "use", "help", "--help", "-h", "_run"]);
  const extras = EXTRA_COMMANDS.filter((c) => !builtins.has(c.name));
  return extras.length ? `${USAGE}\n${extras.map((c) => `  ${c.usage}`).join("\n")}` : USAGE;
}

function explain(e: unknown): string {
  if (e instanceof MissingStrategyError) {
    return `pacer: ${e.message}\nCopy examples/strategy.yaml from the pacer repo to ${e.path} and edit it.`;
  }
  if (e instanceof StrategyError || e instanceof DelegateError) return `pacer: ${e.message}`;
  return `pacer: ${(e as Error).message ?? String(e)}`;
}

/** --key value pairs; names in `booleans` take no value. */
function parseFlags(args: string[], booleans: string[]): { opts: Record<string, string | true>; pos: string[] } {
  const opts: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (booleans.includes(key) || i + 1 >= args.length) opts[key] = true;
    else opts[key] = args[++i];
  }
  return { opts, pos };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const fresh = (ctx: Ctx): Ctx => ({ ...ctx, now: Date.now() / 1000 });

async function status(args: string[], ctx: Ctx): Promise<Result> {
  const modes: ("line" | "json" | "hook")[] = [];
  let planner: string | undefined;
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--line") modes.push("line");
    else if (a === "--json") modes.push("json");
    else if (a === "--hook") {
      modes.push("hook");
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        planner = v;
        i++;
      }
    } else bad.push(a);
  }
  const usage = "usage: pacer status [--line | --json | --hook <planner>]";
  if (bad.length) return { code: 2, out: "", err: `pacer status: unknown argument ${bad.map((b) => `"${b}"`).join(", ")}\n${usage}` };
  if (modes.length > 1) return { code: 2, out: "", err: `pacer status: give only one of --line, --json, --hook <planner>\n${usage}` };
  const mode = modes[0] ?? "text";
  if (mode === "hook" && !(PLANNERS as readonly string[]).includes(planner ?? "")) {
    return { code: 2, out: "", err: `pacer status: --hook needs a planner: ${PLANNERS.join(", ")}` };
  }
  try {
    if (mode === "hook" && !plannerPolicyApplies(ctx, planner!, hookInput(process.stdin.isTTY ? "" : await io.readStdin().catch(() => "")))) {
      return { code: 0, out: "", err: "" };
    }
    const st = await computeStatus(ctx, loadStrategy(ctx));
    if (mode === "line") return { code: 0, out: renderLine(st), err: "" };
    if (mode === "json") return { code: 0, out: JSON.stringify(st, null, 1), err: "" };
    if (mode === "hook") return { code: 0, out: renderHook(st, planner!), err: "" };
    return { code: 0, out: renderText(st), err: "" };
  } catch (e) {
    // Status line and hooks run inside other tools: never fail them.
    if (mode === "line") return { code: 0, out: `◆ Budget ? (${explain(e).split("\n")[0].replace(/^pacer: /, "")})`, err: "" };
    if (mode === "hook") return { code: 0, out: "{}", err: "" };
    return { code: 2, out: "", err: explain(e) };
  }
}

async function route(args: string[], ctx: Ctx): Promise<Result> {
  const { opts, pos } = parseFlags(args, ["json"]);
  try {
    const s = loadStrategy(ctx);
    const st = await computeStatus(ctx, s);
    const r = rankExecutors(pos[0] ?? null, s, Object.fromEntries(st.providers.map((p) => [p.id, p])));
    if (opts.json) return { code: 0, out: JSON.stringify({kind:pos[0]??null,...r}, null, 1), err: "" };
    const lines = r.ranked.map((e, i) => `${i + 1}. ${e.id} (${displayName(e.id)}): ${e.reason}`);
    if (!lines.length) lines.push("no executor available");
    if (r.excluded.length) lines.push(`excluded: ${r.excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}`);
    return { code: 0, out: lines.join("\n"), err: "" };
  } catch (e) {
    return { code: 2, out: "", err: explain(e) };
  }
}

function renderTask(t: TaskRecord): string {
  const r = t.result;
  const lines = [
    `${t.id}  ${t.state}  executor: ${r?.executor ?? t.executor ?? t.attempts.at(-1)?.executor ?? "-"}`,
    `goal: ${t.brief.goal}`,
    `repo: ${t.brief.repo}`,
  ];
  if(t.placement?.mode)lines.push(`placement: ${t.placement.mode} (${t.placement.why})`);
  if (t.attempts.length) {
    lines.push(`attempts: ${t.attempts.map((a) => `${a.executor} (exit ${a.exitCode}${a.limitHit ? ", limit" : ""}${a.timedOut ? ", timed out" : ""})`).join(" > ")}`);
  }
  if (r) {
    lines.push(`files:\n${r.files || "(none)"}`);
    if (r.acceptance) lines.push(`acceptance: ${r.acceptance.cmd} -> ${r.acceptance.passed ? "pass" : "FAIL"}`);
    lines.push(`report:\n${r.report.slice(-1500)}`);
  }
  return lines.join("\n");
}

async function delegateCmd(args: string[], ctx: Ctx): Promise<Result> {
  const { opts } = parseFlags(args, ["wait", "json", "force"]);
  try {
    if(isExecutorSession(ctx))throw new DelegateError(EXECUTOR_DELEGATE_ERROR);
    if(opts["brief-file"]===true)throw new DelegateError("--brief-file needs a path or -");
    const file=str(opts["brief-file"]);
    let raw:Record<string,unknown>={};
    if(file){const parsed=JSON.parse(file==="-" ? await io.readBriefStdin() : readFileSync(file,"utf8"));
      if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))throw new DelegateError("brief must be a JSON object");raw=parsed;}
    for(const key of ["goal","repo","scope","acceptance","constraints","context","kind","executor","worktree"]){if(str(opts[key])!==undefined)raw[key]=str(opts[key]);}
    if(str(opts.repo)!==undefined)raw.repo=resolve(str(opts.repo)!);
    if(str(opts["timeout-min"])!==undefined)raw.timeout_min=Number(str(opts["timeout-min"]));
    if(str(opts["worktree-reason"])!==undefined)raw.worktree_reason=str(opts["worktree-reason"]);
    const t=delegate(ctx,{...parseDelegateBrief(raw,process.cwd()),force:opts.force===true});
    if (!opts.wait) return { code: 0, out: opts.json ? JSON.stringify(t, null, 1) : `${t.id} queued`, err: "" };
    const done = (await taskWait(ctx, t.id, t.timeoutS * 3 + 60)) ?? t;
    return { code: done.state === "done" ? 0 : 1, out: opts.json ? JSON.stringify(done, null, 1) : renderTask(done), err: "" };
  } catch (e) {
    return { code: 2, out: "", err: explain(e) };
  }
}

function tasksCmd(args: string[], ctx: Ctx): Result {
  const { opts, pos } = parseFlags(args, ["json"]);
  if (pos[0]) {
    const t = taskStatus(ctx, pos[0]);
    if (!t) return { code: 2, out: "", err: `pacer: unknown task ${pos[0]}` };
    return { code: 0, out: opts.json ? JSON.stringify(summarizeTask(t), null, 1) : renderTask(t), err: "" };
  }
  const list = listTasks(ctx).map((t) => taskStatus(ctx, t.id) ?? t);
  if (opts.json) return { code: 0, out: JSON.stringify(list.map(summarizeTask), null, 1), err: "" };
  if (!list.length) return { code: 0, out: "no tasks yet", err: "" };
  return {
    code: 0,
    out: list.map((t) => `${t.id}  ${t.state.padEnd(8)}  ${(t.result?.executor ?? t.attempts.at(-1)?.executor ?? "-").padEnd(12)}  ${t.brief.goal.slice(0, 60)}${t.placement?.mode?`  ${t.placement.mode} (${t.placement.why})`:""}`).join("\n"),
    err: "",
  };
}

export async function main(argv: string[], ctx: Ctx = makeCtx()): Promise<Result> {
  const [cmd = "status", ...rest] = argv;
  switch (cmd) {
    case "report-limit": {
      const {opts,pos}=parseFlags(rest,[]);
      try{const cfg=loadStrategy(ctx).providers[pos[0]];if(!cfg)throw new Error(`unknown provider "${pos[0]}"`);
        const until=Number(str(opts.until)??ctx.now+cfg.cooldownS);if(!Number.isFinite(until))throw new Error("until must be unix seconds");
        markExhausted(ctx,pos[0],until);return {code:0,out:`${pos[0]} exhausted until ${until}`,err:""};
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "executor": return executorCommand(rest,ctx);
    case "status":
      return status(rest, ctx);
    case "route":
      return route(rest, ctx);
    case "delegate":
      return delegateCmd(rest, ctx);
    case "tasks":
      return tasksCmd(rest, ctx);
    case "wait":
    case "review":
    case "dismiss":
    case "stop": {
      const {opts,pos}=parseFlags(rest,["json","accept","reject"]);
      if(!pos[0])return {code:2,out:"",err:USAGE};
      try {
        if(cmd==="review") {
          if(!!opts.accept===!!opts.reject)throw new Error("give exactly one of --accept or --reject");
          const result=taskReview(ctx,pos[0],!!opts.accept,str(opts.kind));
          return {code:0,out:opts.json?JSON.stringify(result):`${pos[0]} reviewed`,err:""};
        }
        if(cmd==="dismiss") {
          for(const id of pos)if(!taskDismiss(ctx,id))throw new Error(`unknown task ${id}`);
          return {code:0,out:pos.map(id=>`${id} dismissed`).join("\n"),err:""};
        }
        const timeout=Number(str(opts.timeout)??600);
        if(cmd==="wait" && (!Number.isInteger(timeout)||timeout<1||timeout>3000))throw new Error("timeout must be between 1 and 3000 seconds");
        const t=cmd==="wait" ? await taskWait(ctx,pos[0],timeout) : taskStop(ctx,pos[0]);
        if(!t)throw new Error(`unknown task ${pos[0]}`);
        return {code:cmd==="wait"&&!TERMINAL_STATES.includes(t.state)?2:0,out:opts.json?JSON.stringify(summarizeTask(t),null,1):cmd==="stop"?`${t.id} ${t.state}`:renderTask(t),err:""};
      }catch(e){return {code:2,out:"",err:explain(e)};}
    }
    case "mcp":
      await runMcpStdio(() => fresh(ctx));
      return { code: 0, out: "", err: "", keepAlive: true };
    case "serve": {
      const { opts } = parseFlags(rest, []);
      try {
        const s = startServer(() => fresh(ctx), { port: Number(str(opts.port) ?? ctx.env.PACER_PORT ?? DEFAULT_PORT) });
        return { code: 0, out: `pacer serve listening on http://127.0.0.1:${s.port} (token: ${ctx.pacerHome}/token)`, err: "", keepAlive: true };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    }
    case "_run":
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      try {
        const t = await runTask(fresh(ctx), rest[0]);
        return { code: t.state === "done" ? 0 : 1, out: "", err: "" };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    case "use":
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      try {
        return { code: 0, out: `active strategy: ${rest[0]} (${await switchStrategy(ctx, rest[0])})`, err: "" };
      } catch (e) {
        return { code: 2, out: "", err: explain(e) };
      }
    case "help":
    case "--help":
    case "-h":
      return { code: 0, out: help(), err: "" };
    default: {
      const extra = findCommand(cmd);
      if (extra) return extra.run(rest, ctx);
      return { code: 2, out: "", err: `pacer: unknown command "${cmd}"\n${help()}` };
    }
  }
}

if (import.meta.main) {
  const r = await main(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
  if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
  if (!r.keepAlive) process.exit(r.code);
}
