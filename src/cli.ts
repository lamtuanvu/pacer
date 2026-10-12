#!/usr/bin/env bun
import { resolve } from "node:path";
import { EXTRA_COMMANDS, findCommand } from "./commands/index";
import type { Result } from "./commands/types";
import { MissingStrategyError, StrategyError, loadStrategy, useStrategy } from "./config/strategy";
import { makeCtx } from "./ctx";
import { rankExecutors } from "./engine/rank";
import { computeStatus, displayName } from "./engine/status";
import { runMcpStdio } from "./mcp/server";
import { renderHook } from "./render/hook";
import { renderLine } from "./render/line";
import { renderText } from "./render/text";
import { DEFAULT_PORT, startServer } from "./serve/http";
import { DelegateError, delegate, taskStatus, taskStop, taskWait } from "./tasks/api";
import { runTask } from "./tasks/runner";
import { listTasks } from "./tasks/store";
import type { TaskRecord } from "./tasks/types";
import type { Ctx } from "./types";

const USAGE = `usage: pacer <command>
  status [--line | --json | --hook <planner>]   budget status (default: text report)
  route [kind] [--json]                          executors pacer would use, in order
  delegate --goal <text> [--repo <dir>] [--kind <k>] [--scope <s>] [--acceptance <cmd>]
           [--constraints <s>] [--context <s>] [--executor <id>] [--timeout-min <n>] [--wait] [--json]
  tasks [<task-id>] [--json]                     recent tasks, or one task in detail
  stop <task-id>                                 stop a running task
  mcp                                            run the MCP server on stdio
  serve [--port <n>]                             local HTTP status endpoint (default ${DEFAULT_PORT})
  use <strategy>                                 switch to ~/.pacer/strategies/<strategy>.yaml ("default" = strategy.yaml)
  help                                           this message`;

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
  const mode = args.includes("--line") ? "line" : args.includes("--json") ? "json" : args.includes("--hook") ? "hook" : "text";
  try {
    const st = await computeStatus(ctx, loadStrategy(ctx));
    if (mode === "line") return { code: 0, out: renderLine(st), err: "" };
    if (mode === "json") return { code: 0, out: JSON.stringify(st, null, 1), err: "" };
    if (mode === "hook") return { code: 0, out: renderHook(st, args[args.indexOf("--hook") + 1] ?? "claude-code"), err: "" };
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
    if (opts.json) return { code: 0, out: JSON.stringify(r, null, 1), err: "" };
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
    `${t.id}  ${t.state}  executor: ${r?.executor ?? t.attempts.at(-1)?.executor ?? "-"}`,
    `goal: ${t.brief.goal}`,
    `repo: ${t.brief.repo}`,
  ];
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
  const { opts } = parseFlags(args, ["wait", "json"]);
  try {
    const timeout = str(opts["timeout-min"]);
    const t = delegate(ctx, {
      brief: {
        goal: str(opts.goal) ?? "",
        repo: resolve(str(opts.repo) ?? process.cwd()),
        scope: str(opts.scope),
        acceptance: str(opts.acceptance),
        constraints: str(opts.constraints),
        context: str(opts.context),
      },
      kind: str(opts.kind) ?? null,
      executor: str(opts.executor) ?? null,
      timeoutMin: timeout === undefined ? undefined : Number(timeout),
    });
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
    return { code: 0, out: opts.json ? JSON.stringify(t, null, 1) : renderTask(t), err: "" };
  }
  const list = listTasks(ctx).map((t) => taskStatus(ctx, t.id) ?? t);
  if (opts.json) return { code: 0, out: JSON.stringify(list, null, 1), err: "" };
  if (!list.length) return { code: 0, out: "no tasks yet", err: "" };
  return {
    code: 0,
    out: list.map((t) => `${t.id}  ${t.state.padEnd(8)}  ${(t.result?.executor ?? t.attempts.at(-1)?.executor ?? "-").padEnd(12)}  ${t.brief.goal.slice(0, 60)}`).join("\n"),
    err: "",
  };
}

export async function main(argv: string[], ctx: Ctx = makeCtx()): Promise<Result> {
  const [cmd = "status", ...rest] = argv;
  switch (cmd) {
    case "status":
      return status(rest, ctx);
    case "route":
      return route(rest, ctx);
    case "delegate":
      return delegateCmd(rest, ctx);
    case "tasks":
      return tasksCmd(rest, ctx);
    case "stop": {
      if (!rest[0]) return { code: 2, out: "", err: USAGE };
      const t = taskStop(ctx, rest[0]);
      return t ? { code: 0, out: `${t.id} ${t.state}`, err: "" } : { code: 2, out: "", err: `pacer: unknown task ${rest[0]}` };
    }
    case "mcp":
      await runMcpStdio(() => fresh(ctx));
      return { code: 0, out: "", err: "", keepAlive: true };
    case "serve": {
      const { opts } = parseFlags(rest, []);
      try {
        const s = startServer(() => fresh(ctx), { port: Number(str(opts.port) ?? DEFAULT_PORT) });
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
        return { code: 0, out: `active strategy: ${rest[0]} (${useStrategy(ctx, rest[0])})`, err: "" };
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
