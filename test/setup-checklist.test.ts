import { expect, test } from "bun:test";
import { setupChecklist, setupKey } from "../src/setup/checklist";
import { emptySnapshot } from "../src/link/envelope";
import { renderDashboard } from "../src/dashboard/render";
const facts = { version: "0.1.22", planner: "codex", service: { installed:true, running:true }, link:true,signedIn:true,connected:true,executors:{ranked:[{id:"claude-code"}],excluded:[]},reviewed:true, agents:[{id:"claude-code",name:"Claude Code",installed:false}] };
test("required checks gate readiness; optional agents do not",()=>{
 const ready=setupChecklist(facts,10);
 expect(ready.complete).toBe(true);expect(ready.items.find(i=>i.id==="agent:claude-code")?.status).toBe("pending");
 for(const patch of [{version:null},{planner:null},{service:{installed:true,running:false}},{link:false}]) expect(setupChecklist({...facts,...patch},10).complete).toBe(false);
 expect(setupKey(ready)).toBe(setupKey(setupChecklist(facts,70)));
});
test("dashboard puts the same incomplete checklist above budgets",()=>{
 const html=renderDashboard(emptySnapshot(),100,30,10,{selected:0,setup:setupChecklist({...facts,link:false},10)});
 expect(html).toContain("Setup");expect(html).toContain("Link");expect(html).toContain("pacer init");
 expect(html.indexOf("Setup")).toBeLessThan(html.indexOf("Planner"));
});

test("missing strategy offers only installed planner CLIs with plain detail", () => {
 const checklist = setupChecklist({...facts, planner:null, errors:{strategy:"No strategy at /private/example/strategy.yaml"}, agents:[
  {id:"claude-code",name:"Claude Code",installed:false,cliInstalled:true},
  {id:"codex",name:"Codex",installed:true,cliInstalled:false},
  {id:"cursor",name:"Cursor",installed:false,cliInstalled:true},
  {id:"opencode",name:"OpenCode",installed:false,cliInstalled:true},
  {id:"agy",name:"Other",installed:true,cliInstalled:true},
 ]}, 10);
 expect(checklist.items.find(i=>i.id==="planner")).toMatchObject({status:"pending",detail:"Choose which agent plans your work",action:"setup.init",command:"pacer init",options:["claude-code","cursor","opencode"]});
 expect(checklist.items.find(i=>i.id==="link")).toBeDefined();
});
test("missing strategy with no installed planners has no choices", () => {
 expect(setupChecklist({...facts,planner:null,agents:[]},10).items.find(i=>i.id==="planner")).toMatchObject({options:[],detail:"Choose which agent plans your work"});
});
