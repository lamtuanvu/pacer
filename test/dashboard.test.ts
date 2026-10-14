import { expect, test } from "bun:test";
import { emptySnapshot, type ProviderLine } from "../src/link/envelope";
import { renderDashboard, budgetBar } from "../src/dashboard/render";
import { cards } from "../src/dashboard/model";
import { Keys, moveSelection, selectionAction } from "../src/dashboard/input";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
const provider=(id:string):ProviderLine=>({id,verdict:"ON_PACE",usedPct:25,pacePct:50,resetsAt:null,window:"week",stale:false});
function snapshot(){return {...emptySnapshot(),at:1000,budget:{generatedAt:1000,strategy:"default",planner:"claude-code",mode:"normal",providers:[provider("claude-code"),provider("codex")],ranked:[{id:"codex",verdict:"ON_PACE"}]}};}
test("dashboard fixed-size rendering",()=>{
 expect(renderDashboard(snapshot(),80,20,1005,{selected:0,noColor:true})).toMatchSnapshot();
 expect(renderDashboard(snapshot(),40,12,1005,{selected:0,noColor:true})).toMatchSnapshot();
});
test("budget bar clamps usage and marks pace",()=>{expect(budgetBar(25,50,8)).toBe("[##--|---]");expect(budgetBar(150,-20,8)).toBe("[|#######]");});
test("dashboard clips control sequences, scrolls selection and honours NO_COLOR",()=>{
 const s=snapshot();s.tasks=Array.from({length:20},(_,i)=>({id:`t${i}`,state:"running",goal:`goal ${i}\x1b[2J`,executor:"codex",backend:null,worktree:null,updatedAt:1000}));
 const view=renderDashboard(s,60,10,1005,{selected:20,noColor:true});expect(view.split("\n")).toHaveLength(10);expect(view).toContain("> goal 19");expect(view).not.toContain("\x1b");expect(view.split("\n").every(line=>line.length<=60)).toBe(true);
 expect(renderDashboard(s,80,20,1005,{selected:0})).toContain("\x1b[7m");
});
test("attention uses panel grouping and exposes suggested retry, dismiss, stop and focus",()=>{
 const s=snapshot();s.tasks=[{id:"failed",state:"failed",goal:"Fix tests",executor:"cursor",backend:null,worktree:null,updatedAt:1000},{id:"running",state:"running",goal:"Build",executor:"codex",backend:null,worktree:null,updatedAt:1000,terminalPresent:true}];
 const groups=cards(s,1005);const attention=groups[2].cards[0];expect(selectionAction("enter",attention)).toEqual({cmd:"retry",taskId:"failed",executor:"codex"});expect(selectionAction("x",attention)).toEqual({cmd:"dismiss",taskIds:["failed"]});
 expect(selectionAction("enter",groups[3].cards[0])).toEqual({cmd:"focus",taskId:"running"});s.tasks[1].terminalPresent=false;expect(cards(s,1005)[3].cards[0].action).toEqual({cmd:"stop",taskId:"running"});
 const p=groups[0].cards[0];expect(selectionAction("b",p)).toEqual({cmd:"block",executor:"codex"});p.provider!.blockedReason="user";expect(selectionAction("b",p)).toEqual({cmd:"unblock",executor:"codex"});
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
