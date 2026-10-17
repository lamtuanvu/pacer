import { resolveRepo } from "../core/repos";
import { openSession } from "../session/service";
import { runMappedCmd } from "../api/cmd";
import { callOp } from "../api/ops";
import { loadOrcaState } from "../exec/orca/state";
import { OrcaClient } from "../exec/orca/client";
import { CoreError } from "../core/errors";
import { currentVersion } from "../update/version";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import type { DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { decodeCmdLine, splitCmdLines, summaryLine, type CmdData, type ConsoleData, type Envelope } from "../link/envelope";
import { currentSnapshot } from "../link/store";
import { loadStrategy } from "../config/strategy";
import { spawnRunner, type taskStop } from "../tasks/api";
import { readTask, isTaskId, listTasks } from "../tasks/store";
export interface ConsoleIO { lines: AsyncIterable<string>; write(text: string): void }
export interface ConsoleDeps {
  delegate(ctx: Ctx, input: DelegateInput): TaskRecord;
  readTask?: typeof readTask;
  taskStop?: typeof taskStop;
  configuredExecutors?(ctx: Ctx): string[];
  useStrategy(ctx: Ctx, name: string): string | Promise<string>;
  listStrategies(ctx: Ctx): string[];
  statusText(ctx: Ctx): Promise<string>;
  pump(ctx: Ctx): Promise<Envelope[]>;
  heartbeat(ctx: Ctx, c: ConsoleData | null): void;
  resolveWorktreePath(ctx: Ctx, branch: string, worktreeId?: string): Promise<string | null>;
  selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null; worktreeId?: string }>;
  every(ms: number, fn: () => void): () => void;
  onIdle?(idle: boolean): void;
  pid: number;
  cwd: string;
}
const displayText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export const HEARTBEAT_MS = 10_000;
export const PUMP_MS = 15_000;
type Prompt = { type: "strategy"; names: string[] } | {
  type: "delegate"; step: number; repo: string; goal: string; scope: string; acceptance: string;
};

export function consoleCommands(ctx: Ctx, deps: ConsoleDeps, print: (text: string) => void, prompts: {
  startDelegate(repo: string): void; chooseStrategy(): void; use(name: string): Promise<void>; refresh(): Promise<void>;
}) {
  const fresh = (): Ctx => ({ ...ctx, now: Date.now() / 1000 });
  const { startDelegate, chooseStrategy, refresh } = prompts;
  const validExecutor = (id?: string) => {
    if (!id) return true;
    const ids = deps.configuredExecutors?.(fresh()) ?? Object.keys(loadStrategy(fresh()).providers);
    if (ids.includes(id)) return true;
    print(`pacer: unknown executor ${displayText(id)}`); return false;
  };
  return async (data: CmdData) => {
    if(data.cmd==="use" && !data.strategy){chooseStrategy();return;}
    if(data.cmd==="delegate") {
      if(!validExecutor(data.executor))return;
      const repo=data.worktreeId||data.branch?await deps.resolveWorktreePath(fresh(),data.branch??"",data.worktreeId):deps.cwd;
      print(`delegate requested from Orca (${displayText(data.displayName||data.branch||"focused worktree")})`);
      if(!repo){print("pacer: focused worktree could not be resolved");return;}
      if(data.goal===undefined){startDelegate(repo);return;}
      if(!data.goal.trim()){print("pacer: goal is required");return;}
      data={...data,path:repo};
    }
    const r = await runMappedCmd(async (op, p) => {
      try { return await callOp(fresh(), op, p, { spawnRunner, delegate: (c,input) => deps.delegate(c,input) }); }
      catch (e) {
        if (e instanceof CoreError && e.code === "unknown_task") throw new CoreError("unknown_task", "unknown task");
        if (data.cmd === "retry" && e instanceof CoreError && e.code === "conflict") {
          await publish(fresh(), [{ v: 1, type: "alert", data: { key: `retry-${data.taskId}`, level: "warn", title: "Retry already running", body: e.message, at: fresh().now } }]);
        }
        throw e;
      }
    }, data, { fromPanel: true });
    if (r.handled) { print(r.message); await refresh(); return; }
    switch (data.cmd) {
      case "attach":
      case "focus": {
        if(data.cmd==='attach'&&data.target==='terminal'){
          const result=await openSession(fresh(),data.taskId!,'terminal');print(result.opened?'Opened task session.':result.command??'Task session unavailable.');break;
        }
        const worker=Object.values(loadOrcaState(fresh()).workers).find(w=>w.taskId===data.taskId);
        if(!worker?.terminal){
          try{const result=await openSession(fresh(),data.taskId!,'orca');if(result.opened){print('Opened task session.');break;}}catch{}
        }
        const handle=Object.values(loadOrcaState(fresh()).workers).find(w=>w.taskId===data.taskId)?.terminal;
        let message="This task no longer has an Orca terminal.";
        if(handle){try{const result=await new OrcaClient(ctx.run,ctx.env).call<{focus?:{navigated?:boolean}}>(["terminal","switch","--terminal",handle]);
          if(result.ok){print("Opened task session.");await publish(fresh(),[{v:1,type:"alert",data:{key:`focus-${data.taskId}`,level:"info",title:"Task session opened",body:"Opened task session.",at:fresh().now}}]);break;}
          message="Could not open this task session; its terminal may have closed.";
        }catch{message="Could not open this task session; try again.";}}
        print(message);
        await publish(fresh(),[{v:1,type:"alert",data:{key:`focus-${data.taskId}`,level:"warn",title:"Task session unavailable",body:message,at:fresh().now}}]);break;
      }
      case "refresh": await refresh(); break;
      case "agent-done": print(`agent finished (${data.paneKey ?? ""}); refreshing`); await deps.pump(fresh()); break;
      default: print("pacer: unknown plugin command"); break;
      case "worktree-created": {
        const branch = data.branch ?? "";
        const match = /^pacer-(t-\d{8}-\d{6}-[0-9a-f]{4})-/.exec(branch);
        const task = match && isTaskId(match[1]) ? ` (task ${match[1]})` : "";
        print(`worktree created: ${displayText(branch)} ${displayText(data.path ?? "")}${task}`);
        break;
      }
    }
  };
}

export async function runConsole(ctx: Ctx, io: ConsoleIO, deps: ConsoleDeps): Promise<number> {
  const print = (text: string) => io.write(`${text}\n`);
  const error = (e: unknown) => print(`pacer: ${e instanceof Error ? e.message : String(e)}`);
  const fresh = (): Ctx => ({ ...ctx, now: Date.now() / 1000 });
  let prompt: Prompt | null = null;
  const queue: CmdData[] = [];
  const cancels: (() => void)[] = [];
  let ticking: Promise<void> | null = null;
  let closed = false;
  let commandBusy = false;
  const notifyIdle = () => deps.onIdle?.(!closed && !commandBusy && !prompt && !ticking && queue.length === 0);
  let consoleData: ConsoleData = { version: currentVersion(), handle: null, paneKey: null, pid: deps.pid, startedAt: ctx.now, heartbeatAt: ctx.now };

  const showPrompt = () => {
    if (!prompt) io.write("pacer> ");
    else if (prompt.type === "strategy") io.write("strategy (number or name, empty to cancel)> ");
    else io.write(["goal> ", `repo [${displayText(prompt.repo)}]> `, "scope (optional)> ", "acceptance (optional)> ", "kind (optional)> "][prompt.step]);
  };
  const startDelegate = (repo: string) => { prompt = { type: "delegate", step: 0, repo, goal: "", scope: "", acceptance: "" }; };
  const use = async (name: string) => {
    if (!deps.listStrategies(fresh()).includes(name)) { print(`pacer: unknown strategy ${displayText(name)}`); return; }
    const path = await deps.useStrategy(fresh(), name);
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
  const plugin = consoleCommands(ctx, deps, print, { startDelegate, chooseStrategy, use, refresh });
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
        const task = deps.delegate(fresh(), { brief, repoRef:await resolveRepo(fresh(),brief.repo), kind: value || null });
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
      case "check-setup": case "check-updates": case "update": await plugin({cmd:command}); break;
      case "help": print("check-setup | check-updates | update | help | status | tasks | refresh | use [name] | delegate | quit | exit"); break;
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
    commandBusy = true; notifyIdle();
    try { await fn(); } catch (e) { prompt = null; error(e); }
    finally { commandBusy = false; }
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
        ticking = Promise.resolve().then(() => deps.pump(fresh())).then(() => {}, error).finally(() => { ticking = null; notifyIdle(); });
        notifyIdle();
      }],
    ] as const) {
      try { cancels.push(deps.every(ms, fn)); } catch (e) { error(e); }
    }
    showPrompt(); notifyIdle();
    for await (const input of io.lines) {
      for(const line of splitCmdLines(input)) {
      const decoded = decodeCmdLine(line);
      if (decoded.cmd) {
        if (decoded.before) print(`discarded input before plugin command: ${decoded.before}`);
        if (prompt) queue.push(decoded.cmd.data);
        else {
          const c=fresh();consoleData={...consoleData,heartbeatAt:c.now,busyUntil:c.now+1};
          try{deps.heartbeat(c,consoleData);}catch(e){error(e);}
          await safe(() => plugin(decoded.cmd!.data));
        }
      } else if (line.includes(": pacer '")) print("ignored malformed plugin command");
      else await safe(() => prompt ? answer(line) : human(line));
      while (!closed && !prompt && queue.length) await safe(() => plugin(queue.shift()!));
      if (closed) break;
      showPrompt(); notifyIdle();
      }
      if(closed)break;
    }
  } catch (e) { error(e); }
  finally {
    closed = true; notifyIdle();
    for (const cancel of cancels) { try { cancel(); } catch (e) { error(e); } }
    if (ticking) await ticking;
    try { deps.heartbeat(fresh(), null); } catch (e) { error(e); }
  }
  return 0;
}
