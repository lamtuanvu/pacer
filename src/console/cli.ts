import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadStrategy, useStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { parseOrcaOutput } from "../exec/orca/client";
import { pacerArgv } from "../install/self";
import { shellCommand } from "../install/fsx";
import { pumpOnce } from "../link/pump";
import { refreshBridge } from "../link/publish";
import { writeConsole } from "../link/store";
import { renderText } from "../render/text";
import { delegate } from "../tasks/api";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { isObj } from "../util";
import { runConsole, type ConsoleDeps } from "./console";

export function listStrategies(ctx: Ctx): string[] {
  const dir = join(ctx.pacerHome, "strategies");
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith(".yaml")).map(f => f.name.slice(0, -5)) : [];
  return ["default", ...names.filter(name => name !== "default").sort()];
}

export async function selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null }> {
  const paneKey = ctx.env.ORCA_PANE_KEY ?? null;
  if (!paneKey) return { handle: null, paneKey: null };
  try {
    const r = await ctx.run(["orca", "terminal", "list", "--json"], 30_000);
    const reply = parseOrcaOutput(r.stdout);
    if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && Array.isArray(reply.result.terminals)) {
      const row = reply.result.terminals.find(row => isObj(row) && `${row.tabId}:${row.leafId}` === paneKey);
      if (isObj(row) && typeof row.handle === "string") return { handle: row.handle, paneKey };
    }
  } catch { /* An ordinary terminal can still run the console. */ }
  return { handle: null, paneKey };
}

export async function resolveWorktreePath(ctx: Ctx, branch: string): Promise<string | null> {
  try {
    const r = await ctx.run(["orca", "worktree", "show", "--worktree", `branch:${branch}`, "--json"], 30_000);
    const reply = parseOrcaOutput(r.stdout);
    if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && isObj(reply.result.worktree) && typeof reply.result.worktree.path === "string") return reply.result.worktree.path;
  } catch { /* Fall back to the console's cwd. */ }
  return null;
}

export function openConsoleArgv(ctx: Ctx, worktree: string): string[] {
  return ["orca", "terminal", "create", "--worktree", worktree, "--title", "pacer console", "--command", shellCommand([...pacerArgv(ctx.env), "console"]), "--json"];
}

export async function runConsoleCli(args: string[], ctx: Ctx): Promise<Result> {
  let open = false, worktree: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--open") open = true;
    else if (args[i] === "--worktree" && args[i + 1] && !args[i + 1].startsWith("--")) worktree = args[++i];
    else return { code: 2, out: "", err: "usage: pacer console [--open [--worktree <sel>]]\n" };
  }
  if (worktree && !open) return { code: 2, out: "", err: "usage: pacer console [--open [--worktree <sel>]]\n" };
  if (open) {
    let message = "invalid Orca response";
    try {
      const r = await ctx.run(openConsoleArgv(ctx, worktree ?? "active"), 30_000);
      const reply = parseOrcaOutput(r.stdout);
      if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && isObj(reply.result.terminal) && typeof reply.result.terminal.handle === "string") {
        return { code: 0, out: `pacer console opened in terminal ${reply.result.terminal.handle}\n`, err: "" };
      }
      message = isObj(reply) && isObj(reply.error) && typeof reply.error.message === "string" ? reply.error.message : r.stderr.trim() || r.stdout.trim() || `orca exited ${r.code}`;
    } catch (e) { message = e instanceof Error ? e.message : String(e); }
    return { code: 1, out: "", err: `pacer: could not open the console in Orca: ${message}; run \`pacer console\` in any terminal\n` };
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const deps: ConsoleDeps = {
    delegate, useStrategy, listStrategies, selfHandle, resolveWorktreePath,
    statusText: async c => renderText(await computeStatus(c, loadStrategy(c))),
    pump: pumpOnce,
    heartbeat: (c, data) => { writeConsole(c, data); refreshBridge(c); },
    every: (ms, fn) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
    pid: process.pid, cwd: process.cwd(),
  };
  try { return { code: await runConsole(ctx, { lines, write: text => { process.stdout.write(text); } }, deps), out: "", err: "" }; }
  finally { lines.close(); }
}
