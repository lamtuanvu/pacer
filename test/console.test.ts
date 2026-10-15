import { currentVersion } from "../src/update/version";
import { expect, test } from "bun:test";
import { runConsole, HEARTBEAT_MS, PUMP_MS, type ConsoleDeps } from "../src/console/console";
import { encodeCmdLine, type ConsoleData } from "../src/link/envelope";
import { DelegateError, type DelegateInput } from "../src/tasks/api";
import { createTask, newTaskId } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { fakeCtx } from "./helpers";
import { readBlocked } from "../src/executors/blocked";

function harness(overrides: Partial<ConsoleDeps> = {}) {
  const ctx = fakeCtx();
  const calls: string[] = [], heartbeats: (ConsoleData | null)[] = [], inputs: DelegateInput[] = [];
  const timers = new Map<number, () => void>();
  const cancelled: number[] = [];
  let out = "";
  const task: TaskRecord = { id: "t-20261012-120000-abcd", createdAt: ctx.now, brief: { goal: "fix", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60, state: "queued", attempts: [] };
  const deps: ConsoleDeps = {
    delegate: (_ctx, input) => { calls.push("delegate"); inputs.push(input); return task; },
    useStrategy: (_ctx, name) => { calls.push(`use:${name}`); return `/strategies/${name}.yaml`; },
    listStrategies: () => ["default", "economy"],
    statusText: async () => "STATUS TEXT",
    pump: async () => { calls.push("pump"); return []; },
    heartbeat: (_ctx, c) => { heartbeats.push(c); },
    resolveWorktreePath: async (_ctx, branch) => { calls.push(`resolve:${branch}`); return "/wt/feat-x"; },
    selfHandle: async () => ({ handle: "term_console", paneKey: "T:L" }),
    every: (ms, fn) => { timers.set(ms, fn); return () => { cancelled.push(ms); }; },
    pid: process.pid, cwd: "/cwd", ...overrides,
  };
  const run = async (lines: string[], beforeLine?: (index: number) => void) => {
    async function* source() { for (let i = 0; i < lines.length; i++) { beforeLine?.(i); yield lines[i]; } }
    return runConsole(ctx, { lines: source(), write: text => { out += text; } }, deps);
  };
  return { ctx, deps, run, calls, heartbeats, inputs, timers, cancelled, output: () => out };
}

test("startup advertises self handle and EOF cancels timers and clears heartbeat", async () => {
  const h = harness();
  expect(await h.run([])).toBe(0);
  expect(h.heartbeats[0]).toEqual({ version: currentVersion(), handle: "term_console", paneKey: "T:L", pid: process.pid, startedAt: h.ctx.now, heartbeatAt: h.ctx.now });
  expect(h.heartbeats.at(-1)).toBeNull();
  expect(h.cancelled.sort()).toEqual([HEARTBEAT_MS, PUMP_MS]);
  expect(h.output()).toContain("pacer console (handle term_console). Type help.");
});
test("status and unknown commands print useful output", async () => {
  const h = harness(); await h.run(["status", "wat"]);
  expect(h.output()).toContain("STATUS TEXT"); expect(h.output()).toContain("unknown command wat; type help");
});
test("plugin delegate resolves branch and queues brief before pumping", async () => {
  const h = harness(); await h.run([encodeCmdLine({ cmd: "delegate", branch: "feat-x" }), "fix the flaky test", "", "", "", ""]);
  expect(h.calls).toEqual(["resolve:feat-x", "delegate", "pump"]);
  expect(h.inputs).toEqual([{ brief: { goal: "fix the flaky test", repo: "/wt/feat-x" }, kind: null }]);
  expect(h.output()).toContain("delegate requested from Orca (feat-x)"); expect(h.output()).toContain("queued");
});
test("empty goal cancels delegation", async () => {
  const h = harness(); await h.run(["delegate", ""]);
  expect(h.inputs).toHaveLength(0); expect(h.output()).toContain("delegate cancelled");
});
test("plugin commands queue FIFO while human answers an active prompt", async () => {
  const h = harness(); await h.run(["delegate", encodeCmdLine({ cmd: "refresh" }), encodeCmdLine({ cmd: "agent-done", paneKey: "queued-pane" }), "fix", "", "", "", ""], i => {
    if (i <= 7) expect(h.calls).toEqual([]);
  });
  expect(h.calls).toEqual(["delegate", "pump", "pump", "pump"]);
  expect(h.output().indexOf("published 0 update(s)")).toBeLessThan(h.output().indexOf("agent finished (queued-pane)"));
});
test("mixed plugin input discards human input", async () => {
  const h = harness(); await h.run([`fix th${encodeCmdLine({ cmd: "refresh" })}`]);
  expect(h.output()).toContain("discarded input before plugin command: fix th"); expect(h.calls).toEqual(["pump"]);
});
test("malformed plugin JSON is ignored", async () => {
  const h = harness(); await h.run([": pacer '{broken}'"]);
  expect(h.output()).toContain("ignored malformed plugin command"); expect(h.calls).toEqual([]);
});
test("use selects a numbered strategy and pumps", async () => {
  const h = harness(); await h.run(["use", "2"]);
  expect(h.calls).toEqual(["use:economy", "pump"]); expect(h.output()).toContain("active strategy: economy (/strategies/economy.yaml)");
});
test("strategy errors leave console usable", async () => {
  const h = harness({ useStrategy: () => { throw new Error("unknown strategy bogus"); } }); await h.run(["use bogus", "status"]);
  expect(h.output()).toContain("pacer: unknown strategy bogus"); expect(h.output()).toContain("STATUS TEXT");
});
test("agent-done prints pane key and pumps", async () => {
  const h = harness(); await h.run([encodeCmdLine({ cmd: "agent-done", paneKey: "T:L" })]);
  expect(h.calls).toEqual(["pump"]); expect(h.output()).toContain("agent finished (T:L); refreshing");
});
test("worktree-created recognizes real task IDs in branch names", async () => {
  const h = harness(), id = newTaskId(h.ctx.now);
  await h.run([encodeCmdLine({ cmd: "worktree-created", branch: `pacer-${id}-codex`, path: "/wt/task" })]);
  expect(h.output()).toContain(`worktree created: pacer-${id}-codex /wt/task (task ${id})`);
});
test("heartbeat and pump ticks use refreshed clock", async () => {
  const h = harness(); await h.run(["status"], () => { h.timers.get(HEARTBEAT_MS)!(); h.timers.get(PUMP_MS)!(); });
  expect(h.heartbeats[1]!.heartbeatAt).toBeGreaterThan(h.ctx.now); expect(h.calls).toEqual(["pump"]);
});
test("DelegateError is printed and next command still works", async () => {
  const h = harness({ delegate: () => { throw new DelegateError("invalid repo"); } });
  await h.run(["delegate", "fix", "", "", "", "", "status"]);
  expect(h.output()).toContain("pacer: invalid repo"); expect(h.output()).toContain("STATUS TEXT");
});
test("human delegate captures optional fields and cwd default", async () => {
  const h = harness(); await h.run(["delegate", "fix", "", "src", "bun test", "code"]);
  expect(h.inputs).toEqual([{ brief: { goal: "fix", repo: "/cwd", scope: "src", acceptance: "bun test" }, kind: "code" }]);
});
test("tasks prints newest ten stored tasks", async () => {
  const h = harness();
  for (let i = 0; i < 11; i++) createTask({ ...h.ctx, now: h.ctx.now + i }, { brief: { goal: `goal-${i}`, repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  await h.run(["tasks"]);
  expect(h.output()).toContain("queued - goal-10"); expect(h.output()).not.toContain("queued - goal-0\n");
});
test("quit stops reading human input and cancels timers", async () => {
  const h = harness(); await h.run(["quit", "status"]);
  expect(h.output()).not.toContain("STATUS TEXT"); expect(h.heartbeats.at(-1)).toBeNull(); expect(h.cancelled).toHaveLength(2);
});
test("dependency errors at startup and timer ticks are printed without rejecting", async () => {
  const h = harness({ selfHandle: async () => { throw new Error("lookup failed"); }, pump: async () => { throw new Error("pump failed"); } });
  expect(await h.run(["status"], () => h.timers.get(PUMP_MS)!())).toBe(0);
  expect(h.output()).toContain("pacer: lookup failed"); expect(h.output()).toContain("pacer: pump failed"); expect(h.output()).toContain("STATUS TEXT");
});

for (const strategy of ["../x", "default\nmalicious", "economy ", "missing"]) test(`plugin rejects unlisted strategy ${JSON.stringify(strategy)}`, async () => {
  const h = harness();
  await h.run([encodeCmdLine({ cmd: "use", strategy }), "status"]);
  expect(h.calls).toEqual([]);
  expect(h.output()).toContain("pacer: unknown strategy");
  expect(h.output()).toContain("STATUS TEXT");
});
test("plugin accepts an exact listed strategy", async () => {
  const h = harness(); await h.run([encodeCmdLine({cmd:"use",strategy:"economy"})]);
  expect(h.calls).toEqual(["use:economy", "pump"]);
});
test("plugin display names, branches and paths strip all C0 and C1 controls", async () => {
  const h = harness();
  const controls = Array.from({length:32},(_,i)=>String.fromCharCode(i)).join("") + Array.from({length:33},(_,i)=>String.fromCharCode(127+i)).join("");
  await h.run([encodeCmdLine({cmd:"delegate",displayName:`Project${controls}name`,branch:"feat-x"}), "", encodeCmdLine({cmd:"worktree-created",branch:`pacer-${controls}branch`,path:`/wt/${controls}path`})]);
  expect(h.output()).toContain("delegate requested from Orca (Projectname)");
  expect(h.output()).toContain("worktree created: pacer-branch /wt/path");
  expect(h.output().replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test("delegate repo prompt strips controls from a resolved worktree path", async () => {
 const h=harness({resolveWorktreePath:async()=>"/wt/\u001b[31m\n\u009bpath"});
 await h.run([encodeCmdLine({cmd:"delegate",branch:"feat-x"}),"fix", "", "", "", ""]);
 expect(h.output()).toContain("repo [/wt/[31mpath]>");
 expect(h.inputs[0].brief.repo).toBe("/wt/\u001b[31m\n\u009bpath");
});

test("delegate with goal bypasses prompts and preserves the full brief and selected executor",async()=>{
 const h=harness({configuredExecutors:()=>["codex"]});
 await h.run([encodeCmdLine({cmd:"delegate",branch:"feat-x",goal:"fix this",acceptance:"bun test",executor:"codex"}),"status"]);
 expect(h.inputs).toEqual([{brief:{repo:"/wt/feat-x",goal:"fix this",acceptance:"bun test"},executor:"codex"}]);expect(h.output()).not.toContain("goal> ");expect(h.output()).toContain("STATUS TEXT");expect(h.output()).toContain("t-20261012-120000-abcd queued");
});
test("delegate omits acceptance and refuses unresolved focused worktree",async()=>{
 const h=harness();await h.run([encodeCmdLine({cmd:"delegate",goal:"fix"})]);expect(h.inputs[0].brief).not.toHaveProperty("acceptance");
 const failed=harness({resolveWorktreePath:async()=>null});await failed.run([encodeCmdLine({cmd:"delegate",branch:"missing",goal:"fix"})]);expect(failed.inputs).toHaveLength(0);expect(failed.output()).toContain("could not be resolved");
});
test("retry re-delegates the stored brief with explicit executor or ranking",async()=>{
 const h=harness({configuredExecutors:()=>["codex"]});
 const task=createTask(h.ctx,{brief:{goal:"retry me",repo:"/repo",acceptance:"bun test",scope:"src",constraints:"stay here"},kind:"code",requestedExecutor:"old",timeoutS:120});
 await h.run([encodeCmdLine({cmd:"retry",taskId:task.id,executor:"codex"}),encodeCmdLine({cmd:"retry",taskId:task.id})]);
 expect(h.inputs[0]).toEqual({brief:task.brief,kind:"code",timeoutMin:2,retryOf:task.id,executor:"codex"});expect(h.inputs[1].executor).toBeUndefined();expect(h.inputs[1].brief).toEqual(task.brief);expect(h.calls.filter(c=>c==="pump")).toHaveLength(2);
});
test("stop uses the task API and unknown tasks print an error",async()=>{
 const h=harness();const task=createTask(h.ctx,{brief:{goal:"stop",repo:"/repo"},kind:null,requestedExecutor:null,timeoutS:60});
 await h.run([encodeCmdLine({cmd:"stop",taskId:task.id}),encodeCmdLine({cmd:"stop",taskId:"missing"}),encodeCmdLine({cmd:"retry",taskId:"missing"})]);
 expect(h.output()).toContain(`${task.id} stopped`);expect(h.output().match(/unknown task/g)).toHaveLength(2);expect(h.inputs).toHaveLength(0);
});
test("invalid configured executor causes no delegation or lookup",async()=>{
 const h=harness({configuredExecutors:()=>["codex"],readTask:()=>{throw new Error("must not look up");}});
 await h.run([encodeCmdLine({cmd:"delegate",goal:"fix",branch:"feat-x",executor:"missing"}),encodeCmdLine({cmd:"retry",taskId:"t",executor:"missing"})]);
 expect(h.inputs).toHaveLength(0);expect(h.calls).toEqual([]);expect(h.output().match(/unknown executor missing/g)).toHaveLength(2);
});
test("an explicitly empty goal errors instead of starting the interactive prompt",async()=>{
 const h=harness();await h.run([encodeCmdLine({cmd:"delegate",goal:""}),"status"]);expect(h.output()).toContain("goal is required");expect(h.output()).not.toContain("goal> ");expect(h.inputs).toHaveLength(0);expect(h.output()).toContain("STATUS TEXT");
});

for (const acceptance of ["", " \t\n"]) test(`empty Done when omits acceptance (${JSON.stringify(acceptance)})`, async () => {
 const h=harness(); await h.run([encodeCmdLine({cmd:"delegate",goal:"fix",acceptance})]);
 expect(h.inputs[0].brief).toEqual({repo:"/cwd",goal:"fix"});
});
test("delegate forwards worktree id ahead of branch and refuses unresolved id-only context", async () => {
 const selectors:any[]=[];
 const h=harness({resolveWorktreePath:async (_ctx,branch,id)=>{selectors.push([branch,id]);return "/wt/by-id";}});
 await h.run([encodeCmdLine({cmd:"delegate",goal:"fix",branch:"shared",worktreeId:"wt-1"}),encodeCmdLine({cmd:"delegate",goal:"fix",worktreeId:"wt-2"})]);
 expect(selectors).toEqual([["shared","wt-1"],["","wt-2"]]);expect(h.inputs.map(i=>i.brief.repo)).toEqual(["/wt/by-id","/wt/by-id"]);
 const failed=harness({resolveWorktreePath:async()=>null});await failed.run([encodeCmdLine({cmd:"delegate",goal:"fix",worktreeId:"missing"})]);expect(failed.inputs).toHaveLength(0);
});

test("strategy-build opens a new terminal for the requested worktree and malformed requests do not launch",async()=>{
 const h=harness();await Bun.write(`${h.ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  codex: {usage: reactive}\n");
 const calls:string[][]=[];h.ctx.run=async argv=>{calls.push(argv);return {code:0,stdout:'{"ok":true,"result":{}}',stderr:""};};
 await h.run([encodeCmdLine({cmd:"strategy-build",agent:"codex",from:"default",brief:"Protect planning",worktreeId:"wt",branch:"main"})]);
 expect(calls[0]?.slice(0,8)).toEqual(["orca","terminal","create","--worktree","id:wt","--title","pacer strategy","--command"]);expect(h.output()).toContain("Session opened in a new terminal");
 const bad=harness();await bad.run([encodeCmdLine({cmd:"strategy-build",agent:"agy",from:"default",brief:"x"})]);expect(bad.output()).toContain("ignored malformed plugin command");
});

test("console publishes strategy session success, fallback and failure to the link",async()=>{
 for(const mode of ["success","fallback","failure"]){
  const h=harness();await Bun.write(`${h.ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  codex: {usage: reactive}\n");
  h.ctx.which=()=>mode==="fallback"?null:"/fake/orca";
  h.ctx.run=async()=>mode==="failure"?{code:1,stdout:"",stderr:"Terminal creation refused"}:{code:0,stdout:'{"ok":true,"result":{}}',stderr:""};
  await h.run([encodeCmdLine({cmd:"strategy-build",agent:"codex",from:"default",brief:"Protect planning",worktreeId:"wt"})]);
  const snapshot=JSON.parse(await Bun.file(`${h.ctx.pacerHome}/link/latest.json`).text());
  const alert=snapshot.alerts.find((a:any)=>a.key==="strategy-build");
  expect(alert.level).toBe(mode==="success"?"info":"error");
  expect(alert.title).toBe(mode==="success"?"Strategy session opened":"Strategy session failed");
  if(mode==="failure")expect(alert.body).toContain("Terminal creation refused");
  if(mode==="fallback")expect(alert.body).toContain("Orca unavailable");
 }
});

test("console advertises idle only between completed commands with no active interactive prompt",async()=>{
 const states:boolean[]=[];let h:ReturnType<typeof harness>;
 h=harness({onIdle:idle=>states.push(idle),statusText:async()=>{expect(states.at(-1)).toBe(false);await Promise.resolve();expect(states.at(-1)).toBe(false);return "status";}});
 await h.run(["status","delegate","", "use",""],i=>{if(i===0||i===1)expect(states.at(-1)).toBe(true);if(i===2||i===4)expect(states.at(-1)).toBe(false);if(i===3)expect(states.at(-1)).toBe(true);});
 expect(states.at(-1)).toBe(false);
});

test("dismiss command persists task dismissal and publishes update",async()=>{
  const h=harness();const task=createTask(h.ctx,{brief:{goal:"fix",repo:"/repo"},kind:null,requestedExecutor:null,timeoutS:60});
  await h.run([encodeCmdLine({cmd:"dismiss",taskId:task.id})]);
  const {readTask}=await import("../src/tasks/store");
  expect(readTask(h.ctx,task.id)?.dismissed).toBe(true);expect(h.calls).toContain("pump");
});

test("concatenated panel and worker commands both execute without losing the retry",async()=>{
 const h=harness({configuredExecutors:()=>["codex"]});
 const task=createTask(h.ctx,{brief:{goal:"retry",repo:"/repo"},kind:null,requestedExecutor:null,timeoutS:60});
 await h.run([encodeCmdLine({cmd:"retry",taskId:task.id,executor:"codex"})+encodeCmdLine({cmd:"worktree-created",branch:"pacer-task",path:"/wt/task"})]);
 expect(h.inputs).toHaveLength(1);expect(h.output()).toContain("worktree created");expect(h.output()).not.toContain("discarded");
});
test("retry links both records and rejects a duplicate with an alert",async()=>{
 const h=harness({configuredExecutors:()=>["codex"]});
 const task=createTask(h.ctx,{brief:{goal:"retry",repo:"/repo"},kind:null,requestedExecutor:null,timeoutS:60});
 h.deps.delegate=(ctx,input)=>{h.inputs.push(input);return createTask(ctx,{brief:input.brief,kind:input.kind??null,requestedExecutor:input.executor??null,timeoutS:60});};
 await h.run([encodeCmdLine({cmd:"retry",taskId:task.id,executor:"codex"}),encodeCmdLine({cmd:"retry",taskId:task.id,executor:"codex"})]);
 const {readTask}=await import("../src/tasks/store");const {readOutboxSince}=await import("../src/link/store");
 const old=readTask(h.ctx,task.id)!;expect(old.retriedBy).toBeDefined();expect(readTask(h.ctx,old.retriedBy!)?.retryOf).toBe(task.id);
 expect(h.inputs).toHaveLength(1);expect(h.output()).toContain("already has an active retry");expect(readOutboxSince(h.ctx,0).some(e=>e.envelope.type==="alert")).toBe(true);
});

test("human text glued before a plugin prefix is printed as discarded and never executed",async()=>{
 const h=harness();await h.run(["status"+encodeCmdLine({cmd:"worktree-created",branch:"task",path:"/wt/task"})]);
 expect(h.output()).toContain("discarded");expect(h.output()).toContain("status");expect(h.calls).not.toContain("status");expect(h.output()).toContain("worktree created");
});

test("notify-level writes installed plugin setting through plugin CLI and prints result",async()=>{
 const {writeManifest}=await import("../src/install/manifest");const {pluginDataDir}=await import("../src/link/paths");
 const {readFileSync,rmSync}=await import("node:fs");const {join}=await import("node:path");const h=harness();
 try {
 writeManifest(h.ctx,{version:1,planners:{"orca-plugin":{planner:"orca-plugin",installedAt:1,pacerArgv:[],files:[],commands:[],notes:[]}}});
 await h.run([encodeCmdLine({cmd:"notify-level",level:"off"})]);
 expect(JSON.parse(readFileSync(join(pluginDataDir(h.ctx),"settings.json"),"utf8")).notifications).toBe("off");
 expect(h.output()).toContain('plugin setting notifications = "off"');
 }finally{rmSync(h.ctx.home,{recursive:true,force:true});}
});
test("notify-level failure prints error and console remains usable",async()=>{
 const h=harness();await h.run([encodeCmdLine({cmd:"notify-level",level:"all"}),"status"]);
 expect(h.output()).toContain("plugin is not installed");expect(h.output()).toContain("STATUS TEXT");
});

test("focus finds the task worker terminal and switches with sanitized environment",async()=>{
 const h=harness(), {updateOrcaState}=await import("../src/exec/orca/state");
 const calls:any[]=[];h.ctx.env={ORCA_AGENT_SESSION_ID:"secret",ORCA_TERMINAL_HANDLE:"caller",KEEP:"yes"};
 h.ctx.run=async(argv,_timeout,options)=>{calls.push({argv,env:options?.env});return {code:0,stdout:JSON.stringify({ok:true,result:{focus:{navigated:true}}}),stderr:""};};
 updateOrcaState(h.ctx,s=>{s.workers.d={dispatchId:"d",taskId:"task_a",terminal:"term_worker",executor:"codex",worktree:"/wt",startedAt:0};});
 await h.run([encodeCmdLine({cmd:"focus",taskId:"task_a"})]);
 expect(calls[0]).toEqual({argv:["orca","terminal","switch","--terminal","term_worker","--json"],env:{KEEP:"yes"}});
 expect(h.output()).toContain("Opened task session.");
});
test("focus missing and stale worker terminals report friendly panel errors",async()=>{
 const {updateOrcaState}=await import("../src/exec/orca/state"), {readLatest}=await import("../src/link/store");
 for(const terminal of [null,"closed"]){const h=harness();updateOrcaState(h.ctx,s=>{s.workers.d={dispatchId:"d",taskId:"task_a",terminal,executor:"codex",worktree:null,startedAt:0};});
 await h.run([encodeCmdLine({cmd:"focus",taskId:"task_a"})]);
 expect(h.output()).toContain(terminal?"Could not open":"no longer has");expect(readLatest(h.ctx).alerts.find(a=>a.key==="focus-task_a")?.level).toBe("warn");}
});

test("human and panel update commands share handlers and show the toggle hint only on success",async()=>{
 const calls:string[]=[];
 const h=harness({checkUpdates:async()=>{calls.push("check");return {code:0,out:"Current: 1.0.0",err:""};},update:async()=>{calls.push("update");return {code:0,out:"updated",err:""};}});
 await h.run(["check-updates",encodeCmdLine({cmd:"check-updates"}),"update",encodeCmdLine({cmd:"update"})]);
 expect(calls).toEqual(["check","check","update","update"]);expect(h.output()).toContain("Turn pacer off and on in Orca Settings > Plugins.");
 const failed=harness({update:async()=>({code:1,out:"",err:"offline"})});await failed.run(["update"]);expect(failed.output()).toContain("offline");expect(failed.output()).not.toContain("Turn pacer off");
});

test("update refreshes an older live plugin even when the CLI is already current",async()=>{
 const {mkdirSync,writeFileSync,readFileSync}=await import("node:fs");const {join}=await import("node:path");
 const h=harness({update:async()=>({code:0,out:`pacer ${currentVersion()} is up to date`,err:""})});
 const marker=join(h.ctx.pacerHome,"orca-plugin/.pacer-managed");mkdirSync(join(h.ctx.pacerHome,"orca-plugin"),{recursive:true});writeFileSync(marker,JSON.stringify({version:"0.0.1"}));
 await h.run(["update"]);
 expect(JSON.parse(readFileSync(marker,"utf8")).version).toBe(currentVersion());expect(h.output()).toContain("Turn pacer off and on");
});

test("check-setup console command rechecks and refreshes for panel and human input",async()=>{
 let checks=0;
 const h=harness({checkSetup:async()=>{checks++;return "Setup checked";}});
 await h.run([encodeCmdLine({cmd:"check-setup"}),"check-setup"]);
 expect(checks).toBe(2);expect(h.output()).toContain("Setup checked");expect(h.calls).toEqual(["pump","pump"]);
});

test("console block of an unknown executor writes nothing", async () => {
  // A stale surface list must not override the configured strategy's executors.
  const h = harness({ configuredExecutors: () => ["codex", "gemini"] });
  await Bun.write(`${h.ctx.pacerHome}/strategy.yaml`, "planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  codex: {usage: reactive}\n");
  await h.run([encodeCmdLine({ cmd: "block", executor: "gemini" })]);
  expect(readBlocked(h.ctx)).toEqual({});
  expect(h.output()).toContain("unknown executor gemini");
});
