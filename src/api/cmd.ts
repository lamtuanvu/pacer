import { isTerminalPreset, TERMINAL_PRESET_ERROR } from '../session/terminal-presets';
import { setupText, type SetupChecklist } from "../setup/checklist";
import { ApiError } from "./client-types";
import { CoreError } from "../core/errors";
import type { CmdData } from "../link/envelope";

export function cmdToOp(data: CmdData, options: { fromPanel?: boolean } = {}): { op: string; params: Record<string, unknown> } | null {
  switch (data.cmd) {
    case "check-setup": return {op:"setup.check",params:{}};
    case "check-updates": return {op:"update.check",params:{}};
    case "update": return {op:"update.apply",params:{}};
    case "config-set": return {op:"config.set",params:{key:data.key,value:data.value,...(data.key==="planner"?{integrations:"install"}:{})}};
    case "account-remove": return {op:"account.remove",params:{name:data.name}};
    case "runner-remove": return {op:"runner.remove",params:{id:data.name}};
    case "notify-level": return {op:"notifications.set",params:{level:data.level}};
    case "delegate": return {op:"task.delegate",params:{goal:data.goal,repo:data.path,source:"ui",...(data.acceptance?.trim()?{acceptance:data.acceptance}:{}),...(data.executor?{executor:data.executor}:{})}};
    case "retry-all": return {op:"task.retry_all",params:{ids:data.taskIds??(data.taskId?[data.taskId]:[]),...(options.fromPanel?{from_panel:true}:{}),...(data.executor?{executor:data.executor}:{})}};
    case "strategy-build": return {op:"strategy.build",params:{agent:data.agent,from:data.from,brief:data.brief,...(data.worktreeId?{worktree:`id:${data.worktreeId}`}:data.branch?{worktree:`branch:${data.branch}`}:{})}};
    case "open-terminal": return {op:data.command==="runner-add"?"runner.add":"account.signin",params:{interactive:data.command,...(data.worktreeId?{worktree:`id:${data.worktreeId}`}:data.branch?{worktree:`branch:${data.branch}`}:{})}};
    case "stop": return { op: "task.stop", params: { id: data.taskId } };
    case "retry": return { op: "task.retry", params: { id: data.taskId, ...(options.fromPanel ? { from_panel: true } : {}), ...(data.executor !== undefined ? { executor: data.executor } : {}) } };
    case "dismiss": return { op: "task.dismiss", params: { ids: data.taskIds ?? (data.taskId ? [data.taskId] : []) } };
    case "block": return { op: "runner.block", params: {
      id: data.executor,
      ...(data.for !== undefined ? { for: data.for } : {}),
      ...("reason" in data && typeof data.reason === "string" ? { reason: data.reason } : {}),
    } };
    case "unblock": return { op: "runner.unblock", params: { id: data.executor } };
    case "use": return { op: "strategy.use", params: { name: data.strategy } };
    default: return null;
  }
}


const terminalMessage = (_params: Record<string, unknown>, result: unknown) => {
 const r=result as {opened:boolean;command:string;message?:string};
 return r.message ?? (r.opened?"pacer settings opened in terminal":`Run: ${r.command}`);
};
export const CMD_SUCCESS: Record<string, (params: Record<string, unknown>, result: unknown) => string> = {
  "setup.check": (_p,r) => setupText(r as SetupChecklist),
  "update.check": (_p,r) => {const v=r as {current:string;latest:string|null;error?:string};return v.error??`pacer ${v.current}${v.latest?` · latest ${v.latest}`:""}`;},
  "update.apply": (_p,r) => `update job: ${(r as {job:{id:string}}).job.id}`,
  "config.set": (_p,r) => {const v=r as {key:string;value:unknown;undo:string};return `${v.key}: ${Array.isArray(v.value)?v.value.join(", "):v.value}\nUndo: ${v.undo}`;},
  "account.remove": p => `Removed account ${p.name}`,
  "runner.remove": p => `Removed runner ${p.id}`,
  "notifications.set": p => `notifications: ${p.level}`,
  "task.delegate": (_p,r) => `${(r as {task_id:string}).task_id} queued`,
  "task.retry_all": (_p,r) => {const v=r as {retried:{of:{task_id:string};retry:{task_id:string}}[];skipped:{id:string;reason:string}[]};return [...v.retried.map(x=>`${x.retry.task_id} queued (retry of ${x.of.task_id})`),...v.skipped.map(x=>`pacer: ${x.id}: ${x.reason}`)].join("\n");},
  "strategy.build": (_p,r) => {const v=r as {opened:boolean;command:string};return v.opened?"Session opened in a new terminal":`Run: ${v.command}`;},
  "account.signin": terminalMessage,
  "runner.add": terminalMessage,
  "task.stop": (_params, result) => {
    const task = result as { task_id: string; state: string; stop_pending?: unknown };
    return `${task.task_id} ${task.stop_pending && task.state === "running" ? "stop pending" : "stopped"}`;
  },
  "task.retry": (_params, result) => {
    const r = result as { retry: { task_id: string }; of: { task_id: string } };
    return `${r.retry.task_id} queued (retry of ${r.of.task_id})`;
  },
  "task.dismiss": (_params, result) => {
    const r = result as { dismissed: string[]; unknown: string[] };
    return `dismissed ${r.dismissed.length}${r.unknown.length ? `; unknown: ${r.unknown.join(", ")}` : ""}`;
  },
  "runner.block": params => `blocked ${params.id}`,
  "runner.unblock": params => `unblocked ${params.id}`,
  "strategy.use": params => `active strategy: ${params.name}`,
};

export async function runMappedCmd(
  call: (op: string, params: unknown) => Promise<unknown>,
  data: CmdData,
  options: { fromPanel?: boolean } = {},
): Promise<{ handled: false } | { handled: true; ok: boolean; message: string }> {
  if(data.cmd==='config-set' && data.key==='terminal.open' && !isTerminalPreset(data.value??''))
    return {handled:true,ok:false,message:`pacer: ${TERMINAL_PRESET_ERROR}`};
  const command = cmdToOp(data, options);
  if (!command) return { handled: false };
  try {
    const result = await call(command.op, command.params);
    return { handled: true, ok: true, message: CMD_SUCCESS[command.op](command.params, result) };
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof CoreError)) throw error;
    return { handled: true, ok: false, message: `pacer: ${error.message}${error.hint ? ` (${error.hint})` : ""}` };
  }
}
