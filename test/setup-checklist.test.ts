import { ManualTimers,flush } from "./plugin-transports.test";
import { expect, test } from "bun:test";
import { setupChecklist, setupKey } from "../src/setup/checklist";
import { renderPanel } from "../orca-plugin/src/panel";
import { emptySnapshot } from "../src/link/envelope";
import { renderDashboard } from "../src/dashboard/render";
const facts = { version: "0.1.22", planner: "codex", service: { installed:true, running:true }, link:true, live:true, agents:[{id:"codex",name:"Codex",installed:false}] };
test("required checks gate readiness; optional agents and live panel do not",()=>{
 const ready=setupChecklist(facts,10);
 expect(ready.complete).toBe(true);expect(ready.items.find(i=>i.id==="agent:codex")?.status).toBe("pending");
 for(const patch of [{version:null},{planner:null},{service:{installed:true,running:false}},{link:false}]) expect(setupChecklist({...facts,...patch},10).complete).toBe(false);
 expect(setupChecklist({...facts,live:false},10).complete).toBe(true);
 expect(setupKey(ready)).toBe(setupKey(setupChecklist(facts,70)));
});
test("status page shows incomplete setup and optional agent details",()=>{
 const render=(link:boolean)=>renderPanel(emptySnapshot(),{nowS:10,transport:"http",reachable:true,setup:setupChecklist({...facts,link},10)});
 const incomplete=render(false);
 expect(incomplete).toContain("<h2>Setup</h2>");expect(incomplete).toContain("Optional");expect(incomplete).toContain("Codex");expect(incomplete).toContain("pacer init");
 expect(incomplete).not.toContain("data-command");
 expect(render(true)).not.toContain("<h2>Setup</h2>");expect(render(true)).toContain("<h2>Running</h2>");
});
test("dashboard puts the same incomplete checklist above budgets",()=>{
 const html=renderDashboard(emptySnapshot(),100,30,10,{selected:0,setup:setupChecklist({...facts,link:false},10)});
 expect(html).toContain("Setup");expect(html).toContain("Link");expect(html).toContain("pacer init");
 expect(html.indexOf("Setup")).toBeLessThan(html.indexOf("Planner"));
});

test("worker polls incomplete setup at 5 seconds, complete at 60 and does not reload unchanged checks",async()=>{
 const {createPlugin}=await import("../orca-plugin/src/plugin");
 const timers=new ManualTimers(),writes:string[]=[],checked:number[]=[];let complete=false,request:string|null=null,snapshot=emptySnapshot();
 const plugin=createPlugin({home:"/tmp/setup-fixture",pluginRoot:"/tmp/setup-fixture/plugin",nowS:()=>timers.now/1000,timers,
  bootstrap:{state:{install:{status:"done"},start:{status:"done"},agents:[]},async checkSetup(){checked.push(timers.now);return setupChecklist({...facts,link:complete},timers.now/1000);},stop(){}} as any,
  fs:{exists:p=>p.endsWith(".pacer-managed"),readText:p=>p.endsWith("check-setup-request.json")?request:null,writeTextAtomic:(_p,s)=>writes.push(s)},
  http:{get:async()=>({status:503,body:""}),stream:()=>()=>{}}});
 const ctx={host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge",autoConsole:false}}:m==="storage.get"?{value:snapshot}:{terminals:[]}},commands:{register(){}},events:{on(){}},log(){}} as any;
 await plugin.activate(ctx);await flush();await timers.advance(1000);expect(writes).toHaveLength(1);
 await timers.advance(10000);expect(checked).toEqual([0,5000,10000]);expect(writes).toHaveLength(1);
 await timers.advance(3000);expect(writes).toHaveLength(1);
 complete=true;await timers.advance(2000);expect(writes).toHaveLength(2);expect(writes[1]).not.toContain("<h2>Setup</h2>");expect(writes[1]).toContain("<h2>Running</h2>");
 await timers.advance(58000);expect(checked).toHaveLength(4);expect(writes).toHaveLength(2);
 await timers.advance(2000);expect(checked.at(-1)).toBe(75000);expect(writes).toHaveLength(2);
 request="force";await timers.advance(5000);expect(checked.at(-1)).toBe(80000);expect(writes).toHaveLength(2);
 await plugin.deactivate();
});
