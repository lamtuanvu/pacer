/** pacer brain <-> Orca plugin link. Dependency-free: the Orca plugin bundles this file. */
export const PLUGIN_KEY = "pacer.pacer";
export const LIMITS = { providers: 32, tasks: 20, alerts: 10, goal: 200, title: 120, body: 1000, id: 128, cmdLine: 4096, heartbeatS: 30 } as const;
export type Level = "info" | "warn" | "error";
export interface ProviderLine { id: string; verdict: string; usedPct: number | null; resetsAt: number | null; window: string | null; stale: boolean }
export interface BudgetData { generatedAt: number; strategy: string; planner: string; mode: string; providers: ProviderLine[]; ranked: { id: string; verdict: string }[] }
export interface TaskData { id: string; state: string; goal: string; executor: string | null; backend: string | null; worktree: string | null; updatedAt: number }
export interface ModeData { mode: string; previous: string | null; strategy: string; at: number }
export interface AlertData { key: string; level: Level; title: string; body: string; at: number; error?: string }
export type Envelope = { v: 1; type: "budget"; data: BudgetData } | { v: 1; type: "task"; data: TaskData } | { v: 1; type: "mode"; data: ModeData } | { v: 1; type: "alert"; data: AlertData };
export interface ConsoleData { handle: string | null; paneKey: string | null; pid: number; startedAt: number; heartbeatAt: number }
export interface LinkSnapshot { v: 1; seq: number; at: number; budget: BudgetData | null; mode: ModeData | null; tasks: TaskData[]; alerts: AlertData[]; console: ConsoleData | null }
export const CMD_NAMES = ["delegate", "use", "refresh", "agent-done", "worktree-created"] as const;
export type CmdName = (typeof CMD_NAMES)[number];
export interface CmdData { cmd: CmdName; branch?: string; displayName?: string; paneKey?: string; worktreeId?: string; path?: string; strategy?: string }
export interface Cmd { v: 1; type: "cmd"; data: CmdData }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => typeof v === "string" ? v.slice(0, max) : null;
const optStr = (v: unknown, max: number): string | null => typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const LEVELS: readonly Level[] = ["info", "warn", "error"];
export function clip(s: string, max: number): string { return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`; }
function parseBudget(d: unknown): BudgetData | null {
  if (!isObj(d)) return null;
  const generatedAt = num(d.generatedAt), strategy = str(d.strategy, 128), planner = str(d.planner, 64), mode = str(d.mode, 32);
  if (generatedAt === null || strategy === null || planner === null || mode === null) return null;
  const providers = (Array.isArray(d.providers) ? d.providers : []).slice(0, LIMITS.providers).flatMap((p): ProviderLine[] => {
    if (!isObj(p)) return []; const id = str(p.id, 64), verdict = str(p.verdict, 32); if (id === null || verdict === null) return [];
    return [{ id, verdict, usedPct: num(p.usedPct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true }];
  });
  const ranked = (Array.isArray(d.ranked) ? d.ranked : []).slice(0, LIMITS.providers).flatMap((r) => {
    if (!isObj(r)) return []; const id = str(r.id, 64), verdict = str(r.verdict, 32); return id === null || verdict === null ? [] : [{ id, verdict }];
  });
  return { generatedAt, strategy, planner, mode, providers, ranked };
}
function parseTask(d: unknown): TaskData | null {
  if (!isObj(d)) return null; const id = str(d.id, LIMITS.id), state = str(d.state, 16), updatedAt = num(d.updatedAt);
  if (!id || !state || updatedAt === null) return null;
  return { id, state, updatedAt, goal: str(d.goal, LIMITS.goal) ?? "", executor: optStr(d.executor, 64), backend: optStr(d.backend, 32), worktree: optStr(d.worktree, 4096) };
}
function parseMode(d: unknown): ModeData | null {
  if (!isObj(d)) return null; const mode = str(d.mode, 32), strategy = str(d.strategy, 128), at = num(d.at);
  if (!mode || strategy === null || at === null) return null; return { mode, strategy, at, previous: optStr(d.previous, 32) };
}
function parseAlert(d: unknown): AlertData | null {
  if (!isObj(d)) return null; const error = optStr(d.error, LIMITS.body), level = LEVELS.includes(d.level as Level) ? d.level as Level : error ? "error" : "info";
  const alert: AlertData = { key: optStr(d.key, LIMITS.id) ?? "alert", level, title: clip(optStr(d.title, 4096) ?? "pacer", LIMITS.title), body: clip(str(d.body, 4096) ?? error ?? "", LIMITS.body), at: num(d.at) ?? 0 };
  if (error) alert.error = error; return alert;
}
function parseConsole(d: unknown): ConsoleData | null {
  if (!isObj(d)) return null; const pid = num(d.pid), startedAt = num(d.startedAt), heartbeatAt = num(d.heartbeatAt);
  if (pid === null || startedAt === null || heartbeatAt === null) return null; return { pid, startedAt, heartbeatAt, handle: optStr(d.handle, 1024), paneKey: optStr(d.paneKey, 2048) };
}
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  switch (raw.type) {
    case "budget": { const data = parseBudget(raw.data); return data && { v: 1, type: "budget", data }; }
    case "task": { const data = parseTask(raw.data); return data && { v: 1, type: "task", data }; }
    case "mode": { const data = parseMode(raw.data); return data && { v: 1, type: "mode", data }; }
    case "alert": { const data = parseAlert(raw.data); return data && { v: 1, type: "alert", data }; }
    default: return null;
  }
}
export function emptySnapshot(): LinkSnapshot { return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null }; }
export function parseSnapshot(raw: unknown): LinkSnapshot | null {
  if (!isObj(raw) || raw.v !== 1) return null; const seq = num(raw.seq), at = num(raw.at); if (seq === null || at === null) return null;
  const list = <T>(v: unknown, f: (x: unknown) => T | null, max: number): T[] => (Array.isArray(v) ? v : []).map(f).filter((x): x is T => x !== null).slice(0, max);
  return { v: 1, seq, at, budget: raw.budget == null ? null : parseBudget(raw.budget), mode: raw.mode == null ? null : parseMode(raw.mode), tasks: list(raw.tasks, parseTask, LIMITS.tasks), alerts: list(raw.alerts, parseAlert, LIMITS.alerts), console: raw.console == null ? null : parseConsole(raw.console) };
}
/** Pure. `at` is the caller's clock (unix seconds). */
export function reduce(s: LinkSnapshot, e: Envelope, at: number): LinkSnapshot {
  const next: LinkSnapshot = { ...s, seq: s.seq + 1, at };
  switch (e.type) {
    case "budget": next.budget = e.data; break;
    case "mode": next.mode = e.data; break;
    case "task": next.tasks = [e.data, ...s.tasks.filter(t => t.id !== e.data.id)].sort((a,b) => b.updatedAt-a.updatedAt).slice(0,LIMITS.tasks); break;
    case "alert": next.alerts = [e.data, ...s.alerts.filter(a => a.key !== e.data.key)].sort((a,b) => b.at-a.at).slice(0,LIMITS.alerts); break;
  } return next;
}
export function contentKey(s: LinkSnapshot): string { return JSON.stringify({ budget:s.budget, mode:s.mode, tasks:s.tasks, alerts:s.alerts, console:s.console }); }
export function liveConsole(s: LinkSnapshot, nowS: number): ConsoleData | null { const c=s.console; return c && c.handle && nowS-c.heartbeatAt<=LIMITS.heartbeatS ? c : null; }
const CMD_PREFIX = ": pacer '";
export function encodeCmdLine(data: CmdData): string {
  const json = JSON.stringify({ v:1, type:"cmd", data }).replace(/'/g,"\\u0027"), line = `${CMD_PREFIX}${json}'`;
  if (line.length > LIMITS.cmdLine) throw new Error(`pacer command line exceeds ${LIMITS.cmdLine} characters`); return line;
}
export function parseCmd(raw: unknown): Cmd | null {
  if (!isObj(raw) || raw.v !== 1 || raw.type !== "cmd" || !isObj(raw.data)) return null; const d=raw.data;
  if (!CMD_NAMES.includes(d.cmd as CmdName)) return null; const data: CmdData = { cmd:d.cmd as CmdName };
  for (const k of ["branch","displayName","paneKey","worktreeId","strategy"] as const) { const v=optStr(d[k],1024); if(v) data[k]=v; }
  const path=optStr(d.path,4096); if(path) data.path=path; return {v:1,type:"cmd",data};
}
export function decodeCmdLine(line: string): { before: string; cmd: Cmd | null } {
  const i=line.lastIndexOf(CMD_PREFIX); if(i<0) return {before:line,cmd:null}; const rest=line.slice(i+CMD_PREFIX.length), end=rest.lastIndexOf("'"); if(end<0) return {before:line,cmd:null};
  let raw: unknown; try { raw=JSON.parse(rest.slice(0,end)); } catch { return {before:line,cmd:null}; } const cmd=parseCmd(raw); return cmd ? {before:line.slice(0,i).trim(),cmd} : {before:line,cmd:null};
}
export function summaryLine(b: BudgetData | null): string {
  if(!b) return "pacer: no budget data yet"; const p=b.providers.find(x=>x.id===b.planner), pct=p?.usedPct==null?"?":`${Math.round(p.usedPct)}%`;
  return clip(`pacer ${b.mode} | ${b.planner} ${pct} ${p?.verdict??"UNKNOWN"} | next: ${b.ranked[0]?.id??"none"}`,LIMITS.title);
}
