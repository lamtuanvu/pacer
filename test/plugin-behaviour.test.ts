import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, type PluginDeps } from "../orca-plugin/src/plugin";
import type { ApiClient } from "../src/api/client-types";
import { readSettings } from "../orca-plugin/src/settings";
import { notifyNewAlerts } from "../orca-plugin/src/notify";
import { emptySnapshot, type LinkSnapshot } from "../src/link/envelope";
import type { OrcaHost, OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { ManualTimers, flush } from "./plugin-transports.test";
import { renderPanel } from "../orca-plugin/src/panel";
import { LinkStore } from "../orca-plugin/src/store";
import { contentKey, reduce, type OutboxEvent } from "../src/link/envelope";
function fixture(heartbeat: number|null=100, marker=true, connect?: PluginDeps["connect"], transport="auto") {
 const root=mkdtempSync(join(tmpdir(),"pacer-plugin-"));const timers=new ManualTimers();let now=100;
 let snapshot:LinkSnapshot={...emptySnapshot(),console:heartbeat===null?null:{handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:heartbeat}};
 const calls:{method:string;params:any}[]=[];const commands=new Map<string,(args?:unknown)=>unknown>();const events=new Map<string,(p:unknown)=>void|Promise<void>>();const writes:{path:string;text:string}[]=[];
 let ownerText:string|null=null;
 let accepted=true,throwSend=false,pending=false,context:any={branch:"pacer-task",displayName:"Project",terminals:[{id:"term"}]};
 const host={call:async(method:string,params:any)=>{calls.push({method,params});switch(method){case "settings.get":return {settings:{notifications:"all",transport}};case "events.subscribe":throw Error("invalid enum");case "storage.get":return {value:snapshot};case "workspace.readContext":return context;case "terminal.sendText":if(throwSend)throw Object.assign(Error("denied"),{code:"capability_denied"});return {accepted};case "notifications.show":return {delivered:true};case "settings.set":return {ok:true};default:throw Error(method);}}} as OrcaHost;
 const plugin=createPlugin({connect:connect??(async()=>({kind:"http",hello:async()=>({protocol:"2.8.0",pacer:"1",ops:[],events:[]}),snapshot:async()=>({protocol:"2.8.0",seq:snapshot.seq,snapshot}),call:async<T>()=>null as T,subscribe:()=>()=>{},close(){}})),home:root,pluginRoot:root,nowS:()=>now,timers,http:{get:async()=>pending?await new Promise(()=>{}):{status:401,body:""},stream:()=>()=>{}},fs:{readText:p=>p.endsWith(".pacer-panel-serve.json")?ownerText:"token",exists:p=>marker && p===join(root,".pacer-managed"),writeTextAtomic:(path,text)=>writes.push({path,text})}});
 const ctx:OrcaWorkerContext={host,commands:{register:(id,h)=>commands.set(id,h)},events:{on:(id,h)=>events.set(id,h)},grantedCapabilities:[],log:()=>{}};
 return {plugin,ctx,host,timers,calls,commands,events,writes,get snapshot(){return snapshot;},set snapshot(s){snapshot=s;},set ownerText(v:string|null){ownerText=v;},set accepted(v:boolean){accepted=v;},set throwSend(v:boolean){throwSend=v;},set pending(v:boolean){pending=v;},set context(v:any){context=v;},set now(v:number){now=v;},async start(){await plugin.activate(ctx);await flush();},async cleanup(){await plugin.deactivate();rmSync(root,{recursive:true,force:true});}};
}
const sends=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="terminal.sendText");
const notes=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="notifications.show");
test("settings validate defaults, forced transport and clamped poll range",()=> {expect(readSettings({},"/tmp/home")).toEqual({transport:"auto",port:4317,pacerHome:"/tmp/home/.pacer",pollSeconds:10,lastAlertAt:0,notifications:"important"});expect(readSettings({transport:"api",pollSeconds:1,port:-1,lastAlertAt:NaN},"/tmp")).toMatchObject({transport:"api",pollSeconds:5,port:4317,lastAlertAt:0});expect(readSettings({transport:"invalid",pollSeconds:999},"/tmp")).toMatchObject({transport:"auto",pollSeconds:300});});
test("activation registers all commands without awaiting transport probes",async()=> {const f=fixture();f.pending=true;try{await f.plugin.activate(f.ctx);expect([...f.commands.keys()].sort()).toEqual(["open"]);expect(f.events.has("plugin.message")).toBe(false);}finally{await f.cleanup();}});
test("alerts persist delivery ids and throttle batches",async()=>{const f=fixture();try{const settings=readSettings({notifications:"all"},"/tmp");const s=emptySnapshot();s.alerts=[{key:"a",level:"warn",title:"A",body:"",at:1001}];await notifyNewAlerts(f.host,s,settings,1000,1001);await notifyNewAlerts(f.host,s,settings,1000,1002);expect(notes(f)).toHaveLength(1);expect(settings.deliveredAlerts).toEqual([{key:"a",at:1001}]);expect(settings.lastAlertAt).toBe(1001);}finally{await f.cleanup();}});

test("activation remains under one second when settings host never responds",async()=> {
 const f=fixture();
 const original=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?new Promise(()=>{}):original(method,params)) as OrcaHost["call"]};
 let activated=false;
 try {void f.plugin.activate(f.ctx).then(()=>activated=true);await flush();await f.timers.advance(500);expect(activated).toBe(true);expect(f.commands.size).toBe(1);}finally{await f.cleanup();}
});

test("status page escapes script injection in goals and alerts", () => {
 const attack = "</script><img src=x onerror=alert(1)>\u2028\u2029";
 const s: LinkSnapshot = {...emptySnapshot(),
  console:{handle:attack,paneKey:null,pid:1,startedAt:100,heartbeatAt:100},
  tasks:[{id:"t",state:"running",goal:attack,executor:attack,backend:null,worktree:attack,updatedAt:100}],
  alerts:[{key:"a",level:"error",title:attack,body:attack,at:100}],
 };
 const html = renderPanel(s,{nowS:100,transport:"api",reachable:true});
 expect(html).not.toContain("<img src=x");
 expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
 expect(html).toContain("Running");expect(html).toContain("Alerts");
 expect(html).not.toContain("<script");
});

test("activation tolerates hosts that throw for unknown event names", async () => {
 const f=fixture();
 f.ctx.events.on=(name,h)=>{if(name==="plugin.message")throw Error("unknown event");f.events.set(name,h);};
 try {await f.start(); expect(f.commands.size).toBe(1); expect(await f.commands.get("open")!()).toEqual({ok:true});} finally {await f.cleanup();}
});
test("equal timestamp alerts are queued before advancing the watermark",async()=>{
 const f=fixture(),settings=readSettings({notifications:"all"},"/tmp"),s=emptySnapshot();s.alerts=Array.from({length:7},(_,i)=>({key:`same-${i}`,level:"warn",title:`Same ${i}`,body:"",at:101}));
 try{for(let i=0;i<8;i++)await notifyNewAlerts(f.host,s,settings,100,101+i*5);expect(notes(f)).toHaveLength(7);expect(settings.deliveredAlerts).toHaveLength(7);}finally{await f.cleanup();}
});

for (const heartbeat of [null, 100]) test(`API polls update the status page without console IPC (heartbeat ${heartbeat})`, async () => {
 let connections = 0, snapshots = 0;
 const client: ApiClient = {
  kind: "stdio",
  hello: async () => ({protocol:"2.0.0",pacer:"0",ops:[],events:[]}),
  snapshot: async () => { snapshots++; return {protocol:"2.0.0",seq:snapshots,snapshot:f.snapshot}; },
  call: async <T>() => null as T,
  subscribe: () => () => {},
  close: () => {},
 };
 const f = fixture(heartbeat, true, async () => { connections++; return client; });
 try {
  await f.start();await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("Live · updated");
  const before = snapshots;
  f.snapshot = {...f.snapshot,budget:{generatedAt:100,strategy:"fresh",planner:"codex",mode:"normal",
   providers:[{id:"codex",verdict:"OK",pacePct:null,usedPct:42,resetsAt:null,window:null,stale:false}],ranked:[]}};
  await f.timers.advance(12000);
  expect(snapshots).toBeGreaterThan(before);
  expect(connections).toBe(1);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==="workspace.readContext")).toHaveLength(0);
  await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("42% used");
 } finally { await f.cleanup(); }
});


test("open command shows where to act", async () => {
 for(const managed of [true,false]) {
 const f=fixture(100,managed);try {
  await f.start();expect(await f.commands.get("open")!()).toEqual({ok:true});
  expect(notes(f).at(-1)!.params).toEqual({title:"Open pacer",body:"Run `pacer open` in a terminal to open the pacer app."});
  expect(await f.commands.get("open")!()).toEqual({ok:true});
  expect(notes(f).filter(n=>n.params.title==="Open pacer")).toHaveLength(2);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.some(c=>c.method==="workspace.readContext")).toBe(false);
  // Subscribed only so Orca starts the worker; handling them must not touch terminals or the workspace.
  for(const event of ["agent.status.changed","worktree.created"]){expect(f.events.has(event)).toBe(true);await f.events.get(event)!({state:"done",paneKey:"p"});}
  expect(f.events.has("worktree.removed")).toBe(false);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.some(c=>c.method==="workspace.readContext")).toBe(false);
 }finally{await f.cleanup();}
 }
});

test("panel writes only on visible change", async () => {
 const f=fixture();try {
  await f.start();await f.timers.advance(1000);
  for(let i=0;i<10;i++) {
   f.snapshot={...f.snapshot};await f.timers.advance(15000);
   f.snapshot={...f.snapshot,strategies:[`hidden-${i}`]};
   await f.timers.advance(15000);
  }
  expect(f.writes).toHaveLength(1);
  f.snapshot={...f.snapshot,alerts:[{key:"visible",level:"warn",title:"Visible change",body:"Changed",at:100}]};
  await f.timers.advance(15000);expect(f.writes).toHaveLength(2);
  expect(f.writes[1].text).toContain("Visible change");
 }finally{await f.cleanup();}
});

test("worker leaves the panel to serve until its ownership marker expires", async () => {
 const f=fixture();
 try {
  f.ownerText=JSON.stringify({at:100});
  await f.start();await f.timers.advance(2000);
  expect(f.writes).toHaveLength(0);
  f.now=159;await f.timers.advance(15000);
  expect(f.writes).toHaveLength(0);
  f.now=160;await f.timers.advance(15000);
  expect(f.writes).toHaveLength(1);
 } finally {await f.cleanup();}
});

test("worker can restore its page after serve ownership expires", async () => {
 const f=fixture();
 try {
  await f.start();await f.timers.advance(2000);
  expect(f.writes).toHaveLength(1);
  f.ownerText=JSON.stringify({at:100});
  await f.timers.advance(30000);
  expect(f.writes).toHaveLength(1);
  f.now=160;await f.timers.advance(30000);
  expect(f.writes).toHaveLength(2);
 } finally {await f.cleanup();}
});

for(const transport of ["http","channel","bridge"]) test(`retired transport setting ${transport} selects API automatically`,()=>{
 expect(readSettings({transport},"/tmp").transport).toBe("auto");
});
