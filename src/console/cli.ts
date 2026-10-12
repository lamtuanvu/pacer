import { binaryChanged, binaryStamp, consoleRestarter } from "./restart";
import { createInterface } from "node:readline";
import { use as switchStrategy } from "../strategy/service";
import { loadStrategy, useStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { parseOrcaOutput } from "../exec/orca/client";
import { pacerArgv } from "../install/self";
import { shellCommand } from "../install/fsx";
import { pumpOnce } from "../link/pump";
import { refreshBridge } from "../link/publish";
import { writeConsole } from "../link/store";
import { renderText } from "../render/text";
import { readTask } from "../tasks/store";
import { delegate, taskStop } from "../tasks/api";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { isObj } from "../util";
import { listStrategies } from "../link/strategies";
import { runConsole, type ConsoleDeps } from "./console";

export { listStrategies } from "../link/strategies";

export async function selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null; worktreeId?: string }> {
  // Orca 1.4.224 main bundle exports ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY, and ORCA_WORKTREE_ID.
  // The terminal environment identifies this console even when another worktree is focused.
  const ownWorktree = ctx.env.ORCA_WORKTREE_ID ? { worktreeId: ctx.env.ORCA_WORKTREE_ID } : {};
  const paneKey = ctx.env.ORCA_PANE_KEY ?? null;
  const handle = ctx.env.ORCA_TERMINAL_HANDLE;
  if (handle && /^term_[A-Za-z0-9-]{1,100}$/.test(handle)) return { handle, paneKey, ...ownWorktree };
  if (!paneKey) return { handle: null, paneKey: null, ...ownWorktree };
  try {
    const r = await ctx.run(["orca", "terminal", "list", "--json"], 30_000);
    const reply = parseOrcaOutput(r.stdout);
    if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && Array.isArray(reply.result.terminals)) {
      const row = reply.result.terminals.find(row => isObj(row) && `${row.tabId}:${row.leafId}` === paneKey);
      if (isObj(row) && typeof row.handle === "string") return { handle: row.handle, paneKey, ...(typeof row.worktreeId === "string" ? { worktreeId: row.worktreeId } : {}), ...ownWorktree };
    }
  } catch { /* An ordinary terminal can still run the console. */ }
  return { handle: null, paneKey, ...ownWorktree };
}

export async function resolveWorktreePath(ctx: Ctx, branch: string, worktreeId?: string): Promise<string | null> {
  const selectors = [...(worktreeId ? [`id:${worktreeId}`] : []), ...(branch ? [`branch:${branch}`] : [])];
  for (const selector of selectors) {
    try {
      const r = await ctx.run(["orca", "worktree", "show", "--worktree", selector, "--json"], 30_000);
      const reply = parseOrcaOutput(r.stdout);
      if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && isObj(reply.result.worktree) && typeof reply.result.worktree.path === "string") return reply.result.worktree.path;
    } catch { /* Try the branch for hosts that cannot resolve the id. */ }
  }
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
  let registeredHandle: string | null = null;
  let registration: import("../link/envelope").ConsoleData | null = null;
  let consoleIdle = false;
  const deps: ConsoleDeps = {
    delegate, taskStop, readTask, configuredExecutors: c => Object.keys(loadStrategy(c).providers), useStrategy: switchStrategy, listStrategies, selfHandle, resolveWorktreePath,
    statusText: async c => renderText(await computeStatus(c, loadStrategy(c))),
    pump: pumpOnce,
    heartbeat: (c, data) => { if (data) { registeredHandle = data.handle; registration = data; } writeConsole(c, data, registeredHandle ?? undefined); refreshBridge(c); },
    every: (ms, fn) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
    pid: process.pid, cwd: process.cwd(),
  };
  const stop = (code: number) => {
    try { deps.heartbeat({ ...ctx, now: Date.now() / 1000 }, null); }
    finally { process.exit(code); }
  };
  const watchedBinary = Bun.isStandaloneExecutable ? process.execPath : process.argv[1];
  const stamp = binaryStamp(watchedBinary);
  const reexec = consoleRestarter({
    idle: () => consoleIdle,
    unregister: () => deps.heartbeat({ ...ctx, now: Date.now() / 1000 }, null),
    register: () => { if (registration) { const now = Date.now() / 1000; deps.heartbeat({ ...ctx, now }, { ...registration, heartbeatAt: now }); } },
    exec: () => {
      if (!process.execve) throw new Error("this runtime does not support process.execve");
      process.execve(process.execPath, Bun.isStandaloneExecutable ? [process.execPath, ...process.argv.slice(2)] : [process.execPath, ...process.argv.slice(1)], process.env);
    },
    report: message => { (message.startsWith("pacer: ") ? process.stderr : process.stdout).write(message + "\n"); },
  });
  deps.onIdle = idle => { consoleIdle = idle; if (idle) reexec.retry(); };
  const restart = () => reexec.request();
  const versionTimer = setInterval(() => { if (binaryChanged(watchedBinary, stamp)) restart(); }, 30000);
  process.on("SIGUSR1", restart);
  const interrupt = () => stop(130), terminate = () => stop(143), hangup = () => stop(129);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", hangup);
  try { return { code: await runConsole(ctx, { lines, write: text => { process.stdout.write(text); } }, deps), out: "", err: "" }; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); process.off("SIGUSR1", restart); clearInterval(versionTimer); lines.close(); }
}
