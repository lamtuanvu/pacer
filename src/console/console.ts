/** Direct TUI fallback handlers; the console CLI and line transport are retired. */
import { openSession } from "../session/service";
import { runMappedCmd } from "../api/cmd";
import { callOp } from "../api/ops";
import { loadOrcaState } from "../exec/orca/state";
import { OrcaClient } from "../exec/orca/client";
import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import type { DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { type CmdData, type ConsoleData, type OutboxEvent } from "../link/envelope";
import { loadStrategy } from "../config/strategy";
import { spawnRunner, type taskStop } from "../tasks/api";
import { readTask } from "../tasks/store";
export interface ConsoleDeps {
  delegate(ctx: Ctx, input: DelegateInput): Promise<TaskRecord>;
  readTask?: typeof readTask;
  taskStop?: typeof taskStop;
  configuredExecutors?(ctx: Ctx): string[];
  useStrategy(ctx: Ctx, name: string): string | Promise<string>;
  listStrategies(ctx: Ctx): string[];
  statusText(ctx: Ctx): Promise<string>;
  pump(ctx: Ctx): Promise<OutboxEvent[]>;
  heartbeat(ctx: Ctx, c: ConsoleData | null): void;
  resolveWorktreePath(ctx: Ctx, branch: string, worktreeId?: string): Promise<string | null>;
  selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null; worktreeId?: string }>;
  every(ms: number, fn: () => void): () => void;
  onIdle?(idle: boolean): void;
  pid: number;
  cwd: string;
}
const displayText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
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
          await publish(fresh(), [{ type: "alert", data: { key: `retry-${data.taskId}`, level: "warn", title: "Retry already running", body: e.message, at: fresh().now } }]);
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
          if(result.ok){print("Opened task session.");await publish(fresh(),[{type:"alert",data:{key:`focus-${data.taskId}`,level:"info",title:"Task session opened",body:"Opened task session.",at:fresh().now}}]);break;}
          message="Could not open this task session; its terminal may have closed.";
        }catch{message="Could not open this task session; try again.";}}
        print(message);
        await publish(fresh(),[{type:"alert",data:{key:`focus-${data.taskId}`,level:"warn",title:"Task session unavailable",body:message,at:fresh().now}}]);break;
      }
      case "refresh": await refresh(); break;
      default: print("pacer: unknown plugin command"); break;

    }
  };
}
