import type { NotificationData } from "./notification";
/** pacer brain <-> Orca plugin link. Dependency-free: the Orca plugin bundles this file. */
export const PLUGIN_KEY = "lamtuanvu.pacer";
export const LIMITS = { providers: 32, tasks: 20, alerts: 10, goal: 200, title: 120, body: 1000, id: 128, cmdLine: 4096, heartbeatS: 30 } as const;
export type Level = "info" | "warn" | "error";
export interface ProviderLine { id: string; agent?: string; account?: string; unavailableReason?: string; verdict: string; usedPct: number | null; pacePct: number | null; resetsAt: number | null; window: string | null; stale: boolean; brokenReason?: string; blockedReason?: string; blockedUntil?: number | null }
export interface BudgetData { generatedAt: number; strategy: string; planner: string; mode: string; providers: ProviderLine[]; ranked: { id: string; verdict: string }[] }
export interface SessionData { host:"builtin"|"orca"|"none"; live:boolean; controller:string|null; viewers:number }
export interface TaskData { title?: string; session?:SessionData; progress?: { phase: string; lastOutputAt: number | null; files: number; commits: number; logBytes: number }; terminalPresent?: boolean; resolved?: string; review?: {accepted:boolean;kind:string|null;note:string|null;at:number}; id: string; state: string; goal: string; executor: string | null; backend: string | null; worktree: string | null; updatedAt: number; dismissed?: boolean; retryOf?: string; retriedBy?: string; brokenExecutor?: string; brokenReason?: string; attemptStartedAt?: number; runnerAlive?: boolean; placement?: {mode:"current"|"new";why:string} }
export interface ModeData { mode: string; previous: string | null; strategy: string; at: number }
export interface AlertData { key: string; level: Level; title: string; body: string; at: number; error?: string; notification?: NotificationData }
export interface ConfigData { area: string; at: number }
export interface EntityData { kind: "executor" | "account" | "host" | "repo" | "counts" | "attention" | "activity" | "job" | "notify"; id: string; value?: unknown; removed?: true }
export type Envelope = { v: 1; type: "entity"; data: EntityData } | { v: 1; type: "config"; data: ConfigData } | { v: 1; type: "budget"; data: BudgetData } | { v: 1; type: "task"; data: TaskData } | { v: 1; type: "mode"; data: ModeData } | { v: 1; type: "alert"; data: AlertData };
export interface ConsoleData { version?: string; worktreeId?: string; handle: string | null; paneKey: string | null; pid: number; startedAt: number; heartbeatAt: number; busyUntil?: number }
export interface StrategyData { name:string; active:boolean; summary:string; description:string }
export interface LinkSnapshot { attention?: import("../attention/types").AttentionItem[]; counts?: import("../api/read-model/types").Counts; serviceInstalled?: boolean; v: 1; seq: number; at: number; budget: BudgetData | null; mode: ModeData | null; tasks: TaskData[]; alerts: AlertData[]; console: ConsoleData | null; consoles?: ConsoleData[]; strategies?: (string | StrategyData)[] }
export const CMD_NAMES = ["check-setup", "check-updates", "update", "focus", "attach", "delegate", "retry", "retry-all", "dismiss", "block", "unblock", "stop", "use", "refresh", "agent-done", "worktree-created", "strategy-build", "notify-level", "config-set", "account-remove", "runner-remove", "open-terminal"] as const;
export type CmdName = (typeof CMD_NAMES)[number];
export interface CmdData { target?:"orca"|"terminal"; cmd: CmdName; key?: string; value?: string; name?: string; command?: "account-add" | "account-add-orca" | "runner-add" | "init"; level?: "off" | "important" | "all"; branch?: string; displayName?: string; paneKey?: string; worktreeId?: string; path?: string; strategy?: string; goal?: string; acceptance?: string; executor?: string; taskId?: string; taskIds?: string[]; for?: string; agent?: string; from?: string; brief?: string }
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
    return [{ id, ...(optStr(p.agent,64) && optStr(p.account,64) ? {agent:optStr(p.agent,64)!,account:optStr(p.account,64)!} : {}), ...(optStr(p.unavailableReason,500)?{unavailableReason:optStr(p.unavailableReason,500)!}:{}), verdict, usedPct: num(p.usedPct), pacePct: num(p.pacePct), resetsAt: num(p.resetsAt), window: optStr(p.window, 32), stale: p.stale === true, ...(optStr(p.brokenReason,500) ? {brokenReason:optStr(p.brokenReason,500)!} : {}), ...(optStr(p.blockedReason,500) ? {blockedReason:optStr(p.blockedReason,500)!,blockedUntil:num(p.blockedUntil)} : {}) }];
  });
  const ranked = (Array.isArray(d.ranked) ? d.ranked : []).slice(0, LIMITS.providers).flatMap((r) => {
    if (!isObj(r)) return []; const id = str(r.id, 64), verdict = str(r.verdict, 32); return id === null || verdict === null ? [] : [{ id, verdict }];
  });
  return { generatedAt, strategy, planner, mode, providers, ranked };
}
function parseTask(d: unknown): TaskData | null {
  if (!isObj(d)) return null; const id = str(d.id, LIMITS.id), state = str(d.state, 16), updatedAt = num(d.updatedAt);
  if (!id || !state || updatedAt === null) return null;
  return { id, state, updatedAt, ...(optStr(d.title, 60)?.trim() ? {title:optStr(d.title,60)!.trim()} : {}), goal: str(d.goal, LIMITS.goal) ?? "", executor: optStr(d.executor, 64), backend: optStr(d.backend, 32), worktree: optStr(d.worktree, 4096),
    ...(isObj(d.placement) && ["current","new"].includes(String(d.placement.mode)) && typeof d.placement.why==="string" ? {placement:{mode:d.placement.mode as "current"|"new",why:d.placement.why.slice(0,240)}} : {}),
    ...(isObj(d.session) && ["builtin","orca","none"].includes(String(d.session.host)) && typeof d.session.live==='boolean' && num(d.session.viewers)!==null
      ? {session:{host:d.session.host as SessionData['host'],live:d.session.live,controller:optStr(d.session.controller,64),viewers:Math.max(0,Math.min(99,Math.floor(num(d.session.viewers)!)))}} : {}),
    ...(typeof d.terminalPresent==="boolean"?{terminalPresent:d.terminalPresent}:{}),
    ...(optStr(d.resolved,240)?{resolved:optStr(d.resolved,240)!}:{}),
    ...(isObj(d.review)&&typeof d.review.accepted==="boolean"&&num(d.review.at)!==null?{review:{accepted:d.review.accepted,kind:optStr(d.review.kind,64),note:optStr(d.review.note,1000),at:num(d.review.at)!}}:{}),
    ...(d.dismissed === true ? {dismissed:true} : {}),
    ...(optStr(d.retriedBy,128) ? {retriedBy:optStr(d.retriedBy,128)!} : {}),
    ...(optStr(d.retryOf,128) ? {retryOf:optStr(d.retryOf,128)!} : {}),
    ...(optStr(d.brokenExecutor,64) ? {brokenExecutor:optStr(d.brokenExecutor,64)!} : {}),
    ...(optStr(d.brokenReason,500) ? {brokenReason:optStr(d.brokenReason,500)!} : {}),
    ...(num(d.attemptStartedAt) !== null ? {attemptStartedAt:num(d.attemptStartedAt)!} : {}),
    ...(isObj(d.progress) && typeof d.progress.phase === "string" && num(d.progress.files) !== null && num(d.progress.commits) !== null && num(d.progress.logBytes) !== null
      ? { progress: { phase: d.progress.phase.slice(0, 16), lastOutputAt: num(d.progress.lastOutputAt), files: num(d.progress.files)!, commits: num(d.progress.commits)!, logBytes: num(d.progress.logBytes)! } } : {}),
    ...(typeof d.runnerAlive === "boolean" ? {runnerAlive:d.runnerAlive} : {}),
  };
}
function parseMode(d: unknown): ModeData | null {
  if (!isObj(d)) return null; const mode = str(d.mode, 32), strategy = str(d.strategy, 128), at = num(d.at);
  if (!mode || strategy === null || at === null) return null; return { mode, strategy, at, previous: optStr(d.previous, 32) };
}
function parseAlert(d: unknown): AlertData | null {
  if (!isObj(d)) return null; const error = optStr(d.error, LIMITS.body), level = LEVELS.includes(d.level as Level) ? d.level as Level : error ? "error" : "info";
  const alert: AlertData = { key: optStr(d.key, LIMITS.id) ?? "alert", level, title: clip(optStr(d.title, 4096) ?? "pacer", LIMITS.title), body: clip(str(d.body, 4096) ?? error ?? "", LIMITS.body), at: num(d.at) ?? 0 };
  if (error) alert.error = error;
  const n=d.notification;
  if(isObj(n)&&["failed","done","broken","quota","strategy","session"].includes(String(n.kind))) alert.notification={kind:n.kind as NotificationData["kind"],...(n.fromPanel===true?{fromPanel:true}:{}),...(n.near===true?{near:true}:{}),...(optStr(n.executor,64)?{executor:optStr(n.executor,64)!}:{}),...(optStr(n.goal,1000)?{goal:optStr(n.goal,1000)!}:{}),...(optStr(n.nextExecutor,64)?{nextExecutor:optStr(n.nextExecutor,64)!}:{}),...(optStr(n.strategy,128)?{strategy:optStr(n.strategy,128)!}:{}),...(num(n.resetsAt)!==null?{resetsAt:num(n.resetsAt)!}:{})};
  return alert;
}
function parseConsole(d: unknown): ConsoleData | null {
  if (!isObj(d)) return null; const pid = num(d.pid), startedAt = num(d.startedAt), heartbeatAt = num(d.heartbeatAt);
  if (pid === null || startedAt === null || heartbeatAt === null) return null; return { ...(optStr(d.version, 64) ? { version: optStr(d.version, 64)! } : {}), ...(optStr(d.worktreeId, 1024) ? { worktreeId: optStr(d.worktreeId, 1024)! } : {}), pid, startedAt, heartbeatAt, ...(num(d.busyUntil)!==null?{busyUntil:num(d.busyUntil)!}:{}), handle: optStr(d.handle, 1024), paneKey: optStr(d.paneKey, 2048) };
}
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  switch (raw.type) {
    case "entity": {
      const d=raw.data;
      if(!isObj(d) || !["executor","account","host","repo","counts","attention","activity","job","notify"].includes(String(d.kind)) || typeof d.id!=="string" || !d.id.length || d.id.length>(d.kind==="notify"?512:128))return null;
      return {v:1,type:"entity",data:{kind:d.kind as EntityData["kind"],id:d.id,...(d.removed===true?{removed:true}:{value:d.value})}};
    }
    case "config": {
      const d = raw.data;
      if (!isObj(d) || !optStr(d.area, 128) || num(d.at) === null) return null;
      return {v: 1, type: "config", data: {area: optStr(d.area, 128)!, at: num(d.at)!}};
    }
    case "budget": { const data = parseBudget(raw.data); return data && { v: 1, type: "budget", data }; }
    case "task": { const data = parseTask(raw.data); return data && { v: 1, type: "task", data }; }
    case "mode": { const data = parseMode(raw.data); return data && { v: 1, type: "mode", data }; }
    case "alert": { const data = parseAlert(raw.data); return data && { v: 1, type: "alert", data }; }
    default: return null;
  }
}
export function emptySnapshot(): LinkSnapshot { return { v: 1, seq: 0, at: 0, budget: null, mode: null, tasks: [], alerts: [], console: null, consoles: [], strategies: [] }; }
export function parseSnapshot(raw: unknown): LinkSnapshot | null {
  if (!isObj(raw) || raw.v !== 1) return null; const seq = num(raw.seq), at = num(raw.at); if (seq === null || at === null) return null;
  const list = <T>(v: unknown, f: (x: unknown) => T | null, max: number): T[] => (Array.isArray(v) ? v : []).map(f).filter((x): x is T => x !== null).slice(0, max);
  return { v: 1, seq, at, ...(typeof raw.serviceInstalled === "boolean" ? {serviceInstalled: raw.serviceInstalled} : {}), budget: raw.budget == null ? null : parseBudget(raw.budget), mode: raw.mode == null ? null : parseMode(raw.mode), tasks: list(raw.tasks, parseTask, LIMITS.tasks), alerts: list(raw.alerts, parseAlert, LIMITS.alerts), console: raw.console == null ? null : parseConsole(raw.console), consoles: list(raw.consoles, parseConsole, 32), strategies: list<string | StrategyData>(raw.strategies, v => typeof v === "string" ? optStr(v,128) : isObj(v) && optStr(v.name,128) ? {name:optStr(v.name,128)!,active:v.active===true,summary:str(v.summary,1000)??"",description:str(v.description,1000)??""} : null, 32) };
}
/** Pure. `at` is the caller's clock (unix seconds). */
export function reduce(s: LinkSnapshot, e: Envelope, at: number): LinkSnapshot {
  const next: LinkSnapshot = { ...s, seq: s.seq + 1, at };
  switch (e.type) {
    case "entity": break;
    case "config": break; // Refresh signal only; no snapshot content changes.
    case "budget": next.budget = e.data; break;
    case "mode": next.mode = e.data; break;
    case "task": next.tasks = [e.data, ...s.tasks.filter(t => t.id !== e.data.id)].sort((a,b) => b.updatedAt-a.updatedAt).slice(0,LIMITS.tasks); break;
    case "alert": next.alerts = [e.data, ...s.alerts.filter(a => a.key !== e.data.key)].sort((a,b) => b.at-a.at).slice(0,LIMITS.alerts); break;
  } return next;
}
export function contentKey(s: LinkSnapshot): string { return JSON.stringify({ serviceInstalled:s.serviceInstalled, budget:s.budget ? {...s.budget, generatedAt: undefined} : null, mode:s.mode, tasks:s.tasks, alerts:s.alerts, console:s.console, consoles:s.consoles, strategies:s.strategies }); }
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
  for (const [k,max] of [["goal",2000],["acceptance",500]] as const) { const v=str(d[k],max); if(v !== null) data[k]=v; }
  for (const [k,max,pattern] of [["executor",64,/^[a-z0-9-]+(?:#[a-z0-9-]+)?$/],["taskId",128,/^[A-Za-z0-9_-]+$/]] as const) {
    if (d[k] !== undefined && (typeof d[k] !== "string" || !pattern.test(d[k] as string))) return null;
    const v=optStr(d[k],max); if(v) data[k]=v;
  }
  if(data.cmd==="config-set") {
    if(typeof d.key!=="string" || !["planner","pacing.order","pacing.policy","pacing.planner_reserve","pacing.accounts","pacing.fill_threshold","update_check","terminal.open"].includes(d.key) || typeof d.value!=="string" || d.value.length>2000)return null;
    data.key=d.key;data.value=d.value;
  }
  if(data.cmd==="account-remove" || data.cmd==="runner-remove") {
    const pattern=data.cmd==="account-remove" ? /^[a-z0-9][a-z0-9-]*$/ : /^[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?(?:@[a-z0-9][a-z0-9-]*)?$/;
    if(typeof d.name!=="string" || d.name.length>128 || !pattern.test(d.name))return null;
    data.name=d.name;
  }
  if(data.cmd==="open-terminal") {
    if(typeof d.command!=="string" || !["account-add","account-add-orca","runner-add","init"].includes(d.command))return null;
    data.command=d.command as CmdData["command"];
  }
  if((data.cmd==="focus"||data.cmd==="attach") && !data.taskId)return null;
  if(data.cmd==="attach") {
    if(d.target!==undefined && !["orca","terminal"].includes(String(d.target)))return null;
    data.target=d.target===undefined?'orca':d.target as CmdData['target'];
  }
  if(data.cmd==="notify-level") {
    if(typeof d.level!=="string" || !["off","important","all"].includes(d.level))return null;
    data.level=d.level as CmdData["level"];
  }
  if(data.cmd==="strategy-build") {
    if(!["claude-code","codex"].includes(String(d.agent)) || typeof d.from!=="string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(d.from) || typeof d.brief!=="string" || !d.brief.trim() || d.brief.length>2000)return null;
    data.agent=String(d.agent);data.from=d.from;data.brief=d.brief;
  }
  if(d.taskIds !== undefined) {
    if(!Array.isArray(d.taskIds) || !d.taskIds.length || d.taskIds.length>LIMITS.tasks || !d.taskIds.every(id=>typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))return null;
    data.taskIds=[...new Set(d.taskIds)] as string[];
  }
  if(d.for !== undefined) { if(typeof d.for !== "string" || !/^\d+(?:s|m|h|d)$/.test(d.for))return null; data.for=d.for; }
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

/** Split concatenated shell-inert plugin commands while keeping preceding human text attached for the console to discard. */
export function splitCmdLines(line:string):string[] {
 const parts=line.split(CMD_PREFIX);
 if(parts.length===1)return [line];
 const out:string[]=[];
 out.push(parts[0]+CMD_PREFIX+parts[1]);
 for(const part of parts.slice(2))out.push(CMD_PREFIX+part);
 return out;
}
