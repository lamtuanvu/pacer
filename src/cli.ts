#!/usr/bin/env bun
import { MissingStrategyError, StrategyError, loadStrategy, useStrategy } from "./config/strategy";
import { makeCtx } from "./ctx";
import { computeStatus } from "./engine/status";
import { renderHook } from "./render/hook";
import { renderLine } from "./render/line";
import { renderText } from "./render/text";
import type { Ctx } from "./types";

const USAGE = `usage: pacer <command>
  status [--line | --json | --hook <planner>]   budget status (default: text report)
  use <strategy>                                 switch to ~/.pacer/strategies/<strategy>.yaml ("default" = strategy.yaml)
  help                                           this message`;

type Result = { code: number; out: string; err: string };

function explain(e: unknown): string {
  if (e instanceof MissingStrategyError) {
    return `pacer: ${e.message}\nCopy examples/strategy.yaml from the pacer repo to ${e.path} and edit it.`;
  }
  if (e instanceof StrategyError) return `pacer: ${e.message}`;
  return `pacer: ${(e as Error).message ?? String(e)}`;
}

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

export async function main(argv: string[], ctx: Ctx = makeCtx()): Promise<Result> {
  const [cmd = "status", ...rest] = argv;
  switch (cmd) {
    case "status":
      return status(rest, ctx);
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
      return { code: 0, out: USAGE, err: "" };
    default:
      return { code: 2, out: "", err: `pacer: unknown command "${cmd}"\n${USAGE}` };
  }
}

if (import.meta.main) {
  const r = await main(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
  if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
  process.exit(r.code);
}
