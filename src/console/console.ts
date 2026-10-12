import type { Ctx } from "../types";
import type { DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { decodeCmdLine, summaryLine, type CmdData, type ConsoleData, type Envelope } from "../link/envelope";
import { currentSnapshot } from "../link/store";
import { isTaskId, listTasks } from "../tasks/store";
export interface ConsoleIO { lines: AsyncIterable<string>; write(text: string): void }
export interface ConsoleDeps {
  delegate(ctx: Ctx, input: DelegateInput): TaskRecord;
  useStrategy(ctx: Ctx, name: string): string;
  listStrategies(ctx: Ctx): string[];
  statusText(ctx: Ctx): Promise<string>;
  pump(ctx: Ctx): Promise<Envelope[]>;
  heartbeat(ctx: Ctx, c: ConsoleData | null): void;
  resolveWorktreePath(ctx: Ctx, branch: string): Promise<string | null>;
  selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null }>;
  every(ms: number, fn: () => void): () => void;
  pid: number;
  cwd: string;
}
export const HEARTBEAT_MS = 10_000;
export const PUMP_MS = 15_000;
type Prompt = { type: "strategy"; names: string[] } | {
  type: "delegate"; step: number; repo: string; goal: string; scope: string; acceptance: string;
};

export async function runConsole(ctx: Ctx, io: ConsoleIO, deps: ConsoleDeps): Promise<number> {
  const print = (text: string) => io.write(`${text}\n`);
  const error = (e: unknown) => print(`pacer: ${e instanceof Error ? e.message : String(e)}`);
  const fresh = (): Ctx => ({ ...ctx, now: Date.now() / 1000 });
  let prompt: Prompt | null = null;
  const queue: CmdData[] = [];
  const cancels: (() => void)[] = [];
  let ticking: Promise<void> | null = null;
  let closed = false;
  let consoleData: ConsoleData = { handle: null, paneKey: null, pid: deps.pid, startedAt: ctx.now, heartbeatAt: ctx.now };

  const showPrompt = () => {
    if (!prompt) io.write("pacer> ");
    else if (prompt.type === "strategy") io.write("strategy (number or name, empty to cancel)> ");
    else io.write(["goal> ", `repo [${prompt.repo}]> `, "scope (optional)> ", "acceptance (optional)> ", "kind (optional)> "][prompt.step]);
  };
  const startDelegate = (repo: string) => { prompt = { type: "delegate", step: 0, repo, goal: "", scope: "", acceptance: "" }; };
  const use = async (name: string) => {
    const path = deps.useStrategy(fresh(), name);
    print(`active strategy: ${name} (${path})`);
    await deps.pump(fresh());
  };
  const chooseStrategy = () => {
    const names = deps.listStrategies(fresh());
    names.forEach((name, i) => print(`${i + 1}. ${name}`));
    prompt = { type: "strategy", names };
  };
  const refresh = async () => {
    const c = fresh(), updates = await deps.pump(c);
    print(summaryLine(currentSnapshot(c).budget));
    print(`published ${updates.length} update(s)`);
  };
  const plugin = async (data: CmdData) => {
    switch (data.cmd) {
      case "delegate": {
        const repo = data.branch ? await deps.resolveWorktreePath(fresh(), data.branch) : null;
        print(`delegate requested from Orca (${data.displayName || data.branch || "focused worktree"})`);
        startDelegate(repo || deps.cwd);
        break;
      }
      case "use": if (data.strategy) await use(data.strategy); else chooseStrategy(); break;
      case "refresh": await refresh(); break;
      case "agent-done": print(`agent finished (${data.paneKey ?? ""}); refreshing`); await deps.pump(fresh()); break;
      case "worktree-created": {
        const branch = data.branch ?? "";
        const match = /^pacer-(t-\d{8}-\d{6}-[0-9a-f]{4})-/.exec(branch);
        const task = match && isTaskId(match[1]) ? ` (task ${match[1]})` : "";
        print(`worktree created: ${branch} ${data.path ?? ""}${task}`);
        break;
      }
    }
  };
  const answer = async (line: string) => {
    const p = prompt!;
    const value = line.trim();
    if (p.type === "strategy") {
      prompt = null;
      if (value) await use(/^\d+$/.test(value) ? p.names[Number(value) - 1] ?? value : value);
      return;
    }
    switch (p.step) {
      case 0:
        if (!value) { prompt = null; print("delegate cancelled"); return; }
        p.goal = value; break;
      case 1: p.repo = value || p.repo; break;
      case 2: p.scope = value; break;
      case 3: p.acceptance = value; break;
      case 4: {
        prompt = null;
        const brief = { goal: p.goal, repo: p.repo, ...(p.scope ? { scope: p.scope } : {}), ...(p.acceptance ? { acceptance: p.acceptance } : {}) };
        const task = deps.delegate(fresh(), { brief, kind: value || null });
        print(`${task.id} queued`);
        await deps.pump(fresh());
        return;
      }
    }
    p.step++;
  };
  const human = async (line: string) => {
    const text = line.trim(), [command, ...rest] = text.split(/\s+/);
    switch (command) {
      case "": break;
      case "help": print("help | status | tasks | refresh | use [name] | delegate | quit | exit"); break;
      case "status": print(await deps.statusText(fresh())); break;
      case "tasks":
        for (const task of listTasks(fresh(), 10)) print(`${task.id} ${task.state} ${task.result?.executor ?? task.attempts.at(-1)?.executor ?? task.requestedExecutor ?? "-"} ${task.brief.goal}`);
        break;
      case "refresh": await refresh(); break;
      case "use": if (rest.length) await use(rest.join(" ")); else chooseStrategy(); break;
      case "delegate": startDelegate(deps.cwd); break;
      case "quit": case "exit": closed = true; break;
      default: print(`unknown command ${text}; type help`);
    }
  };
  const safe = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { prompt = null; error(e); }
  };
  try {
    try { consoleData = { ...consoleData, ...await deps.selfHandle(ctx) }; } catch (e) { error(e); }
    try { deps.heartbeat(ctx, consoleData); } catch (e) { error(e); }
    print(`pacer console (handle ${consoleData.handle ?? "not in Orca"}). Type help.`);
    for (const [ms, fn] of [
      [HEARTBEAT_MS, () => {
        if (closed) return;
        const c = fresh(); consoleData = { ...consoleData, heartbeatAt: c.now };
        try { deps.heartbeat(c, consoleData); } catch (e) { error(e); }
      }],
      [PUMP_MS, () => {
        if (closed || ticking) return;
        ticking = Promise.resolve().then(() => deps.pump(fresh())).then(() => {}, error).finally(() => { ticking = null; });
      }],
    ] as const) {
      try { cancels.push(deps.every(ms, fn)); } catch (e) { error(e); }
    }
    showPrompt();
    for await (const line of io.lines) {
      const decoded = decodeCmdLine(line);
      if (decoded.cmd) {
        if (decoded.before) print(`(discarded partial input: ${decoded.before})`);
        if (prompt) queue.push(decoded.cmd.data);
        else await safe(() => plugin(decoded.cmd!.data));
      } else if (line.includes(": pacer '")) print("ignored malformed plugin command");
      else await safe(() => prompt ? answer(line) : human(line));
      while (!closed && !prompt && queue.length) await safe(() => plugin(queue.shift()!));
      if (closed) break;
      showPrompt();
    }
  } catch (e) { error(e); }
  finally {
    closed = true;
    for (const cancel of cancels) { try { cancel(); } catch (e) { error(e); } }
    if (ticking) await ticking;
    try { deps.heartbeat(fresh(), null); } catch (e) { error(e); }
  }
  return 0;
}
