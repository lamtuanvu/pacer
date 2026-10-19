import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { renderDashboard, budgetBar } from "../src/dashboard/render";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { cards, dashboardModel } from "../src/dashboard/model";
import { Keys, moveSelection, selectionAction } from "../src/dashboard/input";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
function snapshot():ClientSnapshot { return structuredClone(fixture) as unknown as ClientSnapshot; }
test("dashboard fixture at 80 and 120 columns",()=>{
 for(const width of [80,120]){
  const text=renderDashboard(snapshot(),width,50,fixture.at,{selected:0,noColor:true,repo:"acme/api",branch:"main",version:"0.2.3",ops:["host.check","host.set","task.retry","task.review"]});
  expect(text).toMatchSnapshot();
  expect(text.split("\n").every(line=>line.length<=width)).toBe(true);
 }
});
test("budget bar clamps usage and marks pace",()=>{expect(budgetBar(25,50,8)).toBe("[##--|---]");expect(budgetBar(150,-20,8)).toBe("[|#######]");});
test("dashboard clips control sequences, scrolls selection and honours NO_COLOR",()=>{
 const s:ClientSnapshot={...emptySnapshot(),at:1000};s.tasks=Array.from({length:20},(_,i)=>({id:`t${i}`,state:"running",goal:`goal ${i}\x1b[2J`,executor:"codex",backend:null,worktree:null,updatedAt:1000}));
 const view=renderDashboard(s,60,10,1005,{selected:19,noColor:true});expect(view.split("\n")).toHaveLength(10);expect(view).toContain("> goal 19");expect(view).not.toContain("\x1b");expect(view.split("\n").every(line=>line.length<=60)).toBe(true);
 expect(renderDashboard(s,80,20,1005,{selected:0})).toContain("\x1b[7m");
});
test("attention preserves service actions and capacity supports blocking",()=>{
 const s=snapshot();
 const groups=cards(s,s.at,["host.check","host.set","task.retry","task.review"]);
 expect(selectionAction("enter",groups[0].cards[0])).toEqual(s.attention![0]!.actions[0]);
 expect(selectionAction("2",groups[0].cards[0])).toEqual(s.attention![0]!.actions[1]);
 expect(selectionAction("enter",groups[0].cards[1])).toEqual(s.attention![1]!.actions[0]);
 const executor=groups[1].cards[1];expect(selectionAction("b",executor)).toEqual({cmd:"block",executor:executor.executor!.id});
 executor.executor!.state="blocked";expect(selectionAction("b",executor)).toEqual({cmd:"unblock",executor:executor.executor!.id});
});
test("dashboard selections and counts equal app selectors, without a legacy budget read",async()=>{
 const selectors=await import("../src/view-model/selectors");
 const s=snapshot();Object.defineProperty(s,"budget",{get(){throw Error("legacy budget");}});
 const model=dashboardModel(s),scope={repo:null};
 expect(model.counts).toBe(selectors.counts(s));
 expect(cards(s,s.at)[0].cards.map(c=>c.id)).toEqual(selectors.needsYou(s,scope).map(a=>a.id));
 expect(model.running).toBe(selectors.running(s,scope));expect(model.capacity).toBe(selectors.capacity(s));expect(model.doneToday).toBe(selectors.doneToday(s,scope));
 const text=renderDashboard(s,120,50,s.at,{selected:0,noColor:true});
 expect(text).toContain(`WHO RUNS NEXT ${model.counts!.executors}`);
 expect(text).toContain("NEEDS YOU 4");expect(text).toContain("RUNNING 2 · QUEUED 1");
});
test("terminal keys support split arrows, escape, control-C, paste and navigation limits",()=>{
 const keys=new Keys();expect(keys.feed("\x1b[")).toEqual([]);expect(keys.feed("Ajk\r\x7f\x03")).toEqual(["up","j","k","enter","backspace","interrupt"]);expect(keys.feed("\x1b")).toEqual([]);expect(keys.flush()).toEqual(["escape"]);expect(keys.feed("goal text")).toEqual(Array.from("goal text"));
 expect(moveSelection("k",0,2)).toBe(0);expect(moveSelection("j",1,2)).toBe(1);expect(moveSelection("down",0,2)).toBe(1);expect(moveSelection("up",1,2)).toBe(0);
});
test("dashboard command is advertised and rejects invalid args without touching state",async()=>{
 expect((await main(["help"],fakeCtx())).out).toContain("dashboard");expect(await main(["dashboard","--bad"],fakeCtx())).toEqual({code:2,out:"",err:"usage: pacer dashboard\n"});
});

test("dashboard update keys require explicit confirmation and header/help show updates",async()=>{
 const {updateKey,UPDATE_PROMPT}=await import("../src/dashboard/input");
 expect(updateKey("c")).toEqual({cmd:"check-updates"});expect(updateKey("u")).toBe("confirm");
 expect(UPDATE_PROMPT).toContain("(y/n)");expect(updateKey("y",true)).toEqual({cmd:"update"});
 for(const key of ["n","escape","enter"])expect(updateKey(key,true)).toBe("cancel");expect(updateKey("u",true)).toBeUndefined();
 const output=renderDashboard(snapshot(),120,20,1005,{selected:0,help:true,updateLine:"Update available: pacer 1.2.0"});
 expect(output).toContain("Update available: pacer 1.2.0");expect(output).toContain("c: check updates");expect(output).toContain("u: update");
});

test("running card shows progress: phase, files and last output", () => {
  const now = 10_000;
  const s = { ...emptySnapshot(), tasks: [{ id: "t-1", state: "running", goal: "fix", executor: "codex", backend: "direct", worktree: null, updatedAt: now - 120, attemptStartedAt: now - 120,
    progress: { phase: "working", lastOutputAt: now - 30, files: 3, commits: 0, logBytes: 100 } }] };
  const card = cards(s, now).find((g) => g.title === "RUNNING")!.cards[0];
  expect(card.text).toBe("fix");
  expect(card.detail).toBe("Codex · Editing · 2m · 3 files · 0 commits · output 30s ago");
});

test("session actions respect capability gates, including finished replay",async()=>{
 const s=snapshot();s.tasks[0]!.session={host:"builtin",live:true,controller:null,viewers:0};s.tasks[3]!.session={host:"builtin",live:false,controller:null,viewers:0};
 for(const id of ["running:t-0420","done:t-0412"]){
  expect(cards(s,s.at,[]).flatMap(g=>g.cards).find(c=>c.id===id)?.sessionTaskId).toBeUndefined();
  expect(cards(s,s.at,[]).flatMap(g=>g.cards).find(c=>c.id===id)?.action).toBeUndefined();
  expect(cards(s,s.at,["task.attach"]).flatMap(g=>g.cards).find(c=>c.id===id)?.sessionTaskId).toBe(id.split(":")[1]);
 }
});
test("untrusted text cannot inject reverse video escapes and wide text stays bounded",async()=>{
 const {clip}=await import("../src/dashboard/render");
 expect(clip("界界界",5)).toBe("界界…");
 const s=snapshot();s.planner!.advice="unsafe\x1b[7mreverse\x1b[0m";
 const text=renderDashboard(s,80,30,s.at,{selected:0,noColor:true});
 expect(text).not.toContain("\x1b");
});


test("board rows keep actions, columns, idle tone and responsive done layout",()=>{
 const s=snapshot();
 s.tasks[3]!.attemptStartedAt=s.tasks[3]!.updatedAt-22*60;
 for(const width of [80,120]){
  const text=renderDashboard(s,width,45,s.at,{selected:0,noColor:true,repo:"acme/api",branch:"main",version:"9.8.7"});
  const lines=text.split("\n");
  expect(lines[0]).toContain("[NORMAL]  strategy default  acme/api · main");
  expect(lines[0]).toEndWith("● live 08:00:00");
  const needs=lines.slice(lines.indexOf("NEEDS YOU 4")+1,lines.indexOf("WHO RUNS NEXT 4")).filter(Boolean);
  expect(needs).toHaveLength(4);
  expect(needs[0]).toContain("[⏎ run checks] [2 pause host]");
  expect(needs[2]).toContain("Codex ·");
  const capacity=lines.slice(lines.indexOf("WHO RUNS NEXT 4")+2,lines.indexOf("RUNNING 2 · QUEUED 1")).filter(Boolean);
  expect(capacity).toHaveLength(s.executors!.length);
  expect(capacity[1]).toContain("team");expect(capacity[1]).toContain("week");
  expect(capacity[1]).toContain("3%");expect(capacity[1]).toContain("1/3");
  expect(capacity[4]).toContain("LM Studio is not running");
  const tasks=lines.slice(lines.indexOf("RUNNING 2 · QUEUED 1")+2,lines.indexOf("DONE TODAY 7 · 6 accepted")).filter(Boolean);
  expect(tasks).toHaveLength(3);
  expect(tasks[0]).toContain("6 files 2");expect(tasks[0]).toContain("8s ago");
  expect(tasks[1]).toContain("idle 6m");expect(tasks[2]).toContain("waiting");
  const done=lines.slice(lines.indexOf("DONE TODAY 7 · 6 accepted")+1).filter(l=>/[✓✕◐]/.test(l));
  expect(done).toHaveLength(width===120?3:5);
  expect(done.join("\n")).toContain("Codex 22m · 07:30");
  expect(lines.at(-1)).toEndWith("v9.8.7 · up to date");
  expect(lines.slice(-2).join(" ")).toContain("r refresh  ? help");
 }
 const color=renderDashboard(s,120,45,s.at,{selected:0});
 expect(color).toContain("\x1b[33midle 6m");
 expect(color).toContain("\x1b[2m");
 const update=renderDashboard(s,120,45,s.at,{selected:0,noColor:true,updateLine:"Update available: pacer 1.2.0"});
 expect(update.split("\n").at(-1)).toEndWith("update available");
});

test("ellipsis clipping and both done columns preserve navigation within terminal cells",async()=>{
 const {clip,cellWidth}=await import("../src/dashboard/render");
 expect(clip("longword",5)).toBe("long…");expect(clip("okay",4)).toBe("okay");expect(clip("x",0)).toBe("");
 const s=snapshot();s.tasks[0]!.goal="界".repeat(60);
 const firstDone=cards(s,s.at).slice(0,3).reduce((n,g)=>n+g.cards.length,0);
 for(const width of [80,120]){
  const text=renderDashboard(s,width,18,s.at,{selected:firstDone+1,noColor:true});
  expect(text.split("\n")).toHaveLength(18);
  expect(text).toContain("> ◐");
  expect(text.split("\n").every(line=>cellWidth(line)<=width)).toBe(true);
 }
});
