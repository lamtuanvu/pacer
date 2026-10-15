import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, type PluginDeps } from "../orca-plugin/src/plugin";
import type { ApiClient } from "../src/api/client-types";
import { readSettings } from "../orca-plugin/src/settings";
import { notifyNewAlerts } from "../orca-plugin/src/notify";
import { NO_CONSOLE } from "../orca-plugin/src/console-link";
import { emptySnapshot, encodeCmdLine, summaryLine, type LinkSnapshot } from "../src/link/envelope";
import type { OrcaHost, OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { ManualTimers, flush } from "./plugin-transports.test";
import { renderPanel } from "../orca-plugin/src/panel";
import { LinkStore } from "../orca-plugin/src/store";
import { httpTransport } from "../orca-plugin/src/transports/http";
import { bridgeTransport } from "../orca-plugin/src/transports/bridge";
import { channelTransport } from "../orca-plugin/src/transports/channel";
import { contentKey, reduce, type Envelope } from "../src/link/envelope";
function fixture(heartbeat: number|null=100, marker=true, connect?: PluginDeps["connect"]) {
 const root=mkdtempSync(join(tmpdir(),"pacer-plugin-"));const timers=new ManualTimers();let now=100;
 let snapshot:LinkSnapshot={...emptySnapshot(),console:heartbeat===null?null:{handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:heartbeat}};
 const calls:{method:string;params:any}[]=[];const commands=new Map<string,(args?:unknown)=>unknown>();const events=new Map<string,(p:unknown)=>void|Promise<void>>();const writes:{path:string;text:string}[]=[];
 let accepted=true,throwSend=false,pending=false,context:any={branch:"pacer-task",displayName:"Project",terminals:[{id:"term"}]};
 const host={call:async(method:string,params:any)=>{calls.push({method,params});switch(method){case "settings.get":return {settings:{notifications:"all"}};case "events.subscribe":throw Error("invalid enum");case "storage.get":return {value:snapshot};case "workspace.readContext":return context;case "terminal.sendText":if(throwSend)throw Object.assign(Error("denied"),{code:"capability_denied"});return {accepted};case "notifications.show":return {delivered:true};case "settings.set":return {ok:true};default:throw Error(method);}}} as OrcaHost;
 const plugin=createPlugin({connect,home:root,pluginRoot:root,nowS:()=>now,timers,http:{get:async()=>pending?await new Promise(()=>{}):{status:401,body:""},stream:()=>()=>{}},fs:{readText:()=>"token",exists:p=>marker && p===join(root,".pacer-managed"),writeTextAtomic:(path,text)=>writes.push({path,text})}});
 const ctx:OrcaWorkerContext={host,commands:{register:(id,h)=>commands.set(id,h)},events:{on:(id,h)=>events.set(id,h)},grantedCapabilities:[],log:()=>{}};
 return {plugin,ctx,host,timers,calls,commands,events,writes,get snapshot(){return snapshot;},set snapshot(s){snapshot=s;},set accepted(v:boolean){accepted=v;},set throwSend(v:boolean){throwSend=v;},set pending(v:boolean){pending=v;},set context(v:any){context=v;},set now(v:number){now=v;},async start(){await plugin.activate(ctx);await flush();},async cleanup(){await plugin.deactivate();rmSync(root,{recursive:true,force:true});}};
}
const sends=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="terminal.sendText");
const notes=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="notifications.show");
test("settings validate defaults, forced transport and clamped poll range",()=> {expect(readSettings({},"/tmp/home")).toEqual({transport:"auto",port:4317,pacerHome:"/tmp/home/.pacer",pollSeconds:10,lastAlertAt:0,autoConsole:true,notifications:"important"});expect(readSettings({transport:"bridge",pollSeconds:1,port:-1,lastAlertAt:NaN},"/tmp")).toMatchObject({transport:"bridge",pollSeconds:5,port:4317,lastAlertAt:0});expect(readSettings({transport:"invalid",pollSeconds:999},"/tmp")).toMatchObject({transport:"auto",pollSeconds:300});});
test("activation registers all commands without awaiting transport probes",async()=> {const f=fixture();f.pending=true;try{await f.plugin.activate(f.ctx);expect([...f.commands.keys()].sort()).toEqual(["delegate","switch-strategy","refresh-status","open-console"].sort());expect(f.events.has("plugin.message")).toBe(false);}finally{await f.cleanup();}});
for(const heartbeat of [null,69])test(`delegate refuses console heartbeat ${heartbeat}`,async()=> {const f=fixture(heartbeat);try{await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(notes(f).map(c=>c.params.title)).toEqual([NO_CONSOLE.title]);expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
test("delegate uses advertised live handle and shell-inert command with context",async()=> {const f=fixture();try{await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});expect(sends(f)[0].params).toEqual({terminalId:"term",text:encodeCmdLine({cmd:"delegate",branch:"pacer-task",displayName:"Project"}),enter:true});f.context=null;expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(sends(f)).toHaveLength(1);f.context={branch:"pacer-task",displayName:"Project",terminals:[{id:"term"}]};await f.commands.get("switch-strategy")!();expect(sends(f)[1].params.text).toBe(encodeCmdLine({cmd:"use"}));}finally{await f.cleanup();}});
for(const error of [false,true])test(`send rejection ${error?"throws":"accepted false"} notifies without crash`,async()=> {const f=fixture();try{f.accepted=false;f.throwSend=error;await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(notes(f).at(-1)!.params.title).toBe("Orca refused to type into the console");}finally{await f.cleanup();}});
test("refresh reports clipped budget summary and silently skips absent console",async()=> {const f=fixture(null);try{f.snapshot={...f.snapshot,budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:Array.from({length:32},(_,i)=>({id:"p"+i+"x".repeat(60),verdict:"OK",pacePct:null,usedPct:50,resetsAt:null,window:null,stale:false})),ranked:[]}};await f.start();expect(await f.commands.get("refresh-status")!()).toMatchObject({ok:true});expect(notes(f).at(-1)!.params.title).toBe("Budget refreshed");expect(notes(f).at(-1)!.params.body.length).toBeLessThanOrEqual(1000);expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
for(const heartbeat of [null,100])test(`open-console heartbeat ${heartbeat}`,async()=> {const f=fixture(heartbeat);try{await f.start();await f.commands.get("open-console")!();expect(notes(f).at(-1)!.params.title).toBe(heartbeat===null?NO_CONSOLE.title:"console is running");expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
test("agent events filter non-done and debounce per pane and globally",async()=> {const f=fixture();try{await f.start();const event=f.events.get("agent.status.changed")!;const p={worktreeId:"wt",paneKey:"pane",state:"done",receivedAt:100};await event({...p,state:"working"});await event({...p,mainAgent:{state:"working",stateStartedAt:0}});expect(sends(f)).toHaveLength(0);await event(p);await event(p);await event({...p,paneKey:"other"});expect(sends(f)).toHaveLength(1);expect(sends(f)[0].params.text).toBe(encodeCmdLine({cmd:"agent-done",paneKey:"pane",worktreeId:"wt"}));f.now=105;await event(p);expect(sends(f)).toHaveLength(2);}finally{await f.cleanup();}});
test("worktree events send only pacer branches and silently skip absent console",async()=> {const f=fixture();try{await f.start();const event=f.events.get("worktree.created")!;const p={worktreeId:"wt",path:"/tmp/work",branch:"feature/x"};await event(p);expect(sends(f)).toHaveLength(0);await event({...p,branch:"pacer-1"});await event({...p,branch:"feature/pacer-2"});expect(sends(f)).toHaveLength(2);f.snapshot={...f.snapshot,console:null};await f.commands.get("refresh-status")!();await event({...p,branch:"pacer-3"});expect(sends(f)).toHaveLength(2);}finally{await f.cleanup();}});
test("alerts persist delivery ids and throttle batches",async()=>{const f=fixture();try{const settings=readSettings({notifications:"all"},"/tmp");const s=emptySnapshot();s.alerts=[{key:"a",level:"warn",title:"A",body:"",at:1001}];await notifyNewAlerts(f.host,s,settings,1000,1001);await notifyNewAlerts(f.host,s,settings,1000,1002);expect(notes(f)).toHaveLength(1);expect(settings.deliveredAlerts).toEqual([{key:"a",at:1001}]);expect(settings.lastAlertAt).toBe(1001);}finally{await f.cleanup();}});
for(const marker of [false,true])test(`panel writes require managed marker ${marker}`,async()=> {const f=fixture(100,marker);try{f.snapshot={...f.snapshot,alerts:[{key:"a",level:"warn",title:"New alert",body:"body",at:100}]};await f.start();await f.timers.advance(2000);expect(f.writes.length).toBe(marker?1:0);if(marker)await f.commands.get("refresh-status")!();else expect(f.commands.size).toBe(0);await f.timers.advance(2000);expect(f.writes.length).toBe(marker?1:0);expect(notes(f).filter(c=>c.params.title==="New alert")).toHaveLength(marker?1:0);if(marker)expect(f.writes[0].path.endsWith("/panel/live.html")).toBe(true);await f.plugin.deactivate();expect(f.timers.jobs.filter(j=>!j.cancelled)).toHaveLength(0);}finally{await f.cleanup();}});

test("activation remains under one second when settings host never responds",async()=> {
 const f=fixture();
 const original=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?new Promise(()=>{}):original(method,params)) as OrcaHost["call"]};
 let activated=false;
 try {void f.plugin.activate(f.ctx).then(()=>activated=true);await flush();await f.timers.advance(500);expect(activated).toBe(true);expect(f.commands.size).toBe(4);}finally{await f.cleanup();}
});

for (const [label, heartbeat] of [["no console", null], ["stale heartbeat", 69]] as const) test(`${label} blocks every command and event that can type into the console`, async () => {
 const f = fixture(heartbeat);
 try {
  await f.start();
  for (const id of ["delegate", "switch-strategy", "refresh-status", "open-console"]) await f.commands.get(id)!();
  await f.events.get("agent.status.changed")!({worktreeId:"wt",paneKey:"pane",state:"done",receivedAt:100});
  await f.events.get("worktree.created")!({worktreeId:"wt",path:"/tmp/work",branch:"pacer-task"});
  expect(sends(f)).toHaveLength(0);
 } finally { await f.cleanup(); }
});

test("console heartbeat exactly thirty seconds old still permits delegate", async () => {
 const f = fixture(70);
 try {
  await f.start();
  expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});
  expect(sends(f)).toHaveLength(1);
  expect(sends(f)[0].params.terminalId).toBe("term");
 } finally { await f.cleanup(); }
});

test("delegate rechecks console freshness after awaiting workspace context", async () => {
 const f = fixture(70);
 const original = f.host.call.bind(f.host);
 f.host.call = (async (method: any, params: any) => {
  if (method === "workspace.readContext") f.now = 101;
  return original(method, params);
 }) as OrcaHost["call"];
 try {
  await f.start();
  expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});
  expect(sends(f)).toHaveLength(0);
  expect(notes(f).at(-1)!.params.title).toBe(NO_CONSOLE.title);
 } finally { await f.cleanup(); }
});

test("delegate quotes untrusted branch and display name as shell-inert JSON", async () => {
 const f = fixture();
 const branch = "pacer-'; touch /tmp/pacer-injection; $(false)";
 const displayName = "</script><img src=x onerror=alert(1)>";
 f.context = {branch,displayName,terminals:[{id:"term"},{id:"unrelated-shell"}]};
 try {
  await f.start();
  await f.commands.get("delegate")!();
  const {terminalId,text,enter} = sends(f)[0].params;
  expect(terminalId).toBe("term"); expect(enter).toBe(true);
  expect(text.startsWith(": pacer '")).toBe(true);
  expect(text.slice(9,-1)).not.toContain("'");
  expect(JSON.parse(text.slice(9,-1))).toEqual({v:1,type:"cmd",data:{cmd:"delegate",branch,displayName}});
 } finally { await f.cleanup(); }
});

test("panel escapes script injection in goals, alerts and console action JSON", () => {
 const attack = "</script><img src=x onerror=alert(1)>\u2028\u2029";
 const s: LinkSnapshot = {...emptySnapshot(),
  console:{handle:attack,paneKey:null,pid:1,startedAt:100,heartbeatAt:100},
  tasks:[{id:"t",state:"running",goal:attack,executor:attack,backend:null,worktree:attack,updatedAt:100}],
  alerts:[{key:"a",level:"error",title:attack,body:attack,at:100}],
 };
 const html = renderPanel(s,{nowS:100,transport:"bridge",reachable:true});
 expect(html).not.toContain("<img src=x");
 expect(html).toContain("data-page=\"delegate\"");
 const json = html.match(/id="pacer-actions">(.*?)<\/script>/s)![1];
 expect(json).not.toContain("<"); expect(json).not.toMatch(/[\u2028\u2029]/);
 expect(JSON.parse(json).consoles[0].handle).toBe(attack);
});

test("store contract produces the same content through HTTP SSE, bridge and channel", async () => {
 const timers = new ManualTimers();
 const envelopes: Envelope[] = [
  {v:1,type:"budget",data:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]}},
  {v:1,type:"mode",data:{mode:"normal",previous:null,strategy:"s",at:100}},
  ...["running","done"].map(state => ({v:1 as const,type:"task" as const,data:{id:"t",state,goal:"goal",executor:"e",backend:null,worktree:null,updatedAt:100}})),
  {v:1,type:"alert",data:{key:"a",level:"warn",title:"Finished",body:"body",at:100}},
 ];
 let bridgeSnapshot = emptySnapshot();
 let onLine!: (line: string) => void;
 let onMessage!: (payload: unknown) => void;
 const host = {call:async (method:string) => {
  if (method === "storage.get") return {value:bridgeSnapshot};
  if (method === "events.subscribe") return {subscribed:["plugin.message"]};
  throw new Error(method);
 }} as OrcaHost;
 const transports = [
  httpTransport({timers,port:4317,readToken:()=>"test-token",http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(bridgeSnapshot)}),stream:(_url,_token,fn)=>{onLine=fn;return()=>{};}}}),
  bridgeTransport({host,timers,pollMs:5000}),
  channelTransport({host,registerEvent:(_name,fn)=>{onMessage=fn;}}),
 ];
 const stores = transports.map(()=>new LinkStore(()=>100));
 const stops: (()=>void)[] = [];
 try {
  for (const [i,t] of transports.entries()) {
   expect(await t.probe()).toBe(true);
   stops.push(t.watch(e=>stores[i].apply(e),s=>stores[i].replace(s)));
  }
  for (const e of envelopes) {
   bridgeSnapshot = reduce(bridgeSnapshot,e,100);
   onLine(`data: ${JSON.stringify(e)}`); onMessage({data:e});
   await timers.advance(5000);
   for (const store of stores) expect(JSON.parse(contentKey(store.snapshot))).toEqual(JSON.parse(contentKey(bridgeSnapshot)));
   expect(contentKey(stores[0].snapshot)).toBe(contentKey(stores[1].snapshot));
   expect(contentKey(stores[0].snapshot)).toBe(contentKey(stores[2].snapshot));
  }
  expect(stores[0].snapshot.tasks).toMatchObject([{id:"t",state:"done"}]);
  expect(stores[0].snapshot.alerts).toMatchObject([{key:"a",title:"Finished"}]);
 } finally { for (const stop of stops) stop(); }
});

test("activation tolerates hosts that throw for unknown event names", async () => {
 const f=fixture();
 f.ctx.events.on=(name,h)=>{if(name==="plugin.message")throw Error("unknown event");f.events.set(name,h);};
 try {await f.start(); expect(f.commands.size).toBe(4); expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});} finally {await f.cleanup();}
});
for (const action of ["delegate", "switch-strategy", "refresh-status", "agent-done", "worktree-created"]) test(`${action} refreshes HTTP snapshot before checking console liveness`, async () => {
 const f=fixture();
 let requests=0;
 const http={get:async()=>{requests++;return {status:200,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)};},stream:()=>()=>{}};
 const plugin=createPlugin({home:"/tmp/fake",pluginRoot:"/tmp/fake",nowS:()=>140,timers:f.timers,http,fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:()=>{}}});
 try {
  await plugin.activate(f.ctx);await flush();
  const before=requests;
  f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:140}};
  if(action==="agent-done")await f.events.get("agent.status.changed")!({state:"done",paneKey:"pane",receivedAt:140});
  else if(action==="worktree-created")await f.events.get("worktree.created")!({branch:"pacer-task",worktreeId:"wt",path:"/wt"});
  else await f.commands.get(action)!();
  expect(requests).toBeGreaterThan(before);expect(sends(f)).toHaveLength(1);
  f.snapshot={...f.snapshot,console:null};
  await f.commands.get("switch-strategy")!();expect(sends(f)).toHaveLength(1);
 } finally {await plugin.deactivate();await f.cleanup();}
});
test("equal timestamp alerts are queued before advancing the watermark",async()=>{
 const f=fixture(),settings=readSettings({notifications:"all"},"/tmp"),s=emptySnapshot();s.alerts=Array.from({length:7},(_,i)=>({key:`same-${i}`,level:"warn",title:`Same ${i}`,body:"",at:101}));
 try{for(let i=0;i<8;i++)await notifyNewAlerts(f.host,s,settings,100,101+i*5);expect(notes(f)).toHaveLength(7);expect(settings.deliveredAlerts).toHaveLength(7);}finally{await f.cleanup();}
});

test("HTTP heartbeat-only polls leave the panel file unchanged", async () => {
 const f=fixture();let now=100;const panels:string[]=[];
 const plugin=createPlugin({home:"/tmp/fake",pluginRoot:"/tmp/fake",nowS:()=>now,timers:f.timers,
  http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:()=>()=>{}},
  fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_path,text)=>panels.push(text)}});
 try {
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  expect(panels.at(-1)).toContain('data-view="delegate" data-live>');
  now=120;await f.timers.advance(10000);
  expect(panels).toHaveLength(1);
  f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:120}};
  await f.timers.advance(10000);
  expect(panels).toHaveLength(1);
  f.snapshot={...f.snapshot,tasks:[{id:"t",state:"done",goal:"changed",executor:"codex",backend:null,worktree:null,updatedAt:140}]};
  await f.timers.advance(10000);expect(panels).toHaveLength(2);expect(panels.at(-1)).toContain("changed");
 }finally{await plugin.deactivate();await f.cleanup();}
});

test("simultaneous done events still debounce after snapshot refresh", async () => {
 const f=fixture();
 try {
  await f.start();const event=f.events.get("agent.status.changed")!;
  await Promise.all([event({state:"done",paneKey:"pane",receivedAt:100}),event({state:"done",paneKey:"pane",receivedAt:100})]);
  expect(sends(f)).toHaveLength(1);
 }finally{await f.cleanup();}
});

test("channel refresh reads current console liveness from bridge", async () => {
 const f=fixture(null);const original=f.host.call.bind(f.host);
 f.host.call=(async(m:any,p:any)=>m==="events.subscribe"?{subscribed:[]}:original(m,p)) as OrcaHost["call"];
 try {
  await f.start();
  f.snapshot={...f.snapshot,console:{handle:"new-console",paneKey:null,pid:1,startedAt:100,heartbeatAt:140}};f.context={branch:"pacer-task",displayName:"Project",terminals:[{id:"new-console"}]};
  f.now=140;
  expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});
  expect(sends(f).at(-1)!.params.terminalId).toBe("new-console");
 } finally {await f.cleanup();}
});

test("worker subscribes to supported lifecycle events even when channel is unavailable",async()=>{
 const f=fixture();
 try {await f.start();expect(f.calls.some(c=>c.method==="events.subscribe" && c.params.events.includes("agent.status.changed") && c.params.events.includes("worktree.created"))).toBe(true);}
 finally {await f.cleanup();}
});

test("equal budgets with alternating generation times do not rewrite or notify",async()=>{
 const f=fixture();
 try {
  f.snapshot={...f.snapshot,budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]}};
  await f.start();await f.timers.advance(2000);
  const before=f.writes.length;const notices=notes(f).length;
  for(const generatedAt of [200,100,200]){
   f.snapshot={...f.snapshot,budget:{...f.snapshot.budget!,generatedAt}};
   await f.timers.advance(10000);
  }
  expect(f.writes.length).toBe(before);expect(notes(f).length).toBe(notices);
 }finally{await f.cleanup();}
});

test("HTTP failures switch to bridge after three polls and recover when HTTP returns",async()=>{
 const f=fixture();let up=true,stops=0;
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100,timers:f.timers,
  http:{get:async(url)=>up?{status:200,body:url.endsWith("/health")?'{"ok":true}':JSON.stringify(f.snapshot),headers:{"x-pacer":"1"}}:{status:503,body:""},stream:()=>()=>{stops++;}},
  fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(path,text)=>f.writes.push({path,text})}});
 try {
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("http");
  up=false;f.snapshot={...f.snapshot,console:{...f.snapshot.console!,handle:"bridge-console"}};f.context={branch:"x",displayName:"X",terminals:[{id:"bridge-console"}]};
  await f.timers.advance(10000);
  expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});
  expect(sends(f).at(-1)!.params.terminalId).toBe("bridge-console");
  await f.timers.advance(22000);
  expect(stops).toBeGreaterThan(0);
  expect(f.writes.at(-1)!.text).toContain("bridge");
  up=true;await f.timers.advance(12000);
  expect(f.writes.at(-1)!.text).toContain("http");
 }finally{await plugin.deactivate();await f.cleanup();}
});

test("synchronous lifecycle subscription refusal cannot fail activation",async()=>{
 const f=fixture();const original=f.host.call.bind(f.host);
 f.host.call=((m:any,p:any)=>{if(m==="events.subscribe")throw Error("denied");return original(m,p);}) as OrcaHost["call"];
 try{await f.start();expect(f.commands.size).toBe(4);}finally{await f.cleanup();}
});
test("HTTP recovery before failover restores reachable panel state",async()=>{
 const f=fixture();let up=true;const panels:string[]=[];
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100,timers:f.timers,
 http:{get:async()=>({status:up?200:503,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:()=>()=>{}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 try{
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  up=false;await f.timers.advance(10000);expect(panels.at(-1)).toContain("Not connected");
  up=true;await f.timers.advance(10000);expect(panels.at(-1)).toContain('name live good');
 }finally{await plugin.deactivate();await f.cleanup();}
});
test("HTTP SSE and poll generation timestamps do not trigger renders or notifications",async()=>{
 const f=fixture();
 const originalCall=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?Promise.resolve({settings:{autoConsole:false,notifications:"all"}}):originalCall(method,params)) as OrcaHost["call"]};let line!:(s:string)=>void;const panels:string[]=[];
 f.snapshot={...emptySnapshot(),budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]},
 alerts:[{key:"a",level:"info",title:"once",body:"",at:100}]};
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100,timers:f.timers,
 http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:(_u,_t,l)=>{line=l;return()=>{};}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 try{
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  for(let i=0;i<3;i++){line("data: "+JSON.stringify({v:1,type:"budget",data:{...f.snapshot.budget,generatedAt:200+i}}));await f.timers.advance(10000);}
  expect(panels).toHaveLength(1);expect(notes(f)).toHaveLength(1);
 }finally{await plugin.deactivate();await f.cleanup();}
});


test("channel polls bridge console heartbeat without requiring a command",async()=>{
 const f=fixture(null);const original=f.host.call.bind(f.host);
 f.host.call=(async(m:any,p:any)=>m==="events.subscribe"?{subscribed:[]}:original(m,p)) as OrcaHost["call"];
 try{
  await f.start();await f.timers.advance(2000);
  f.snapshot={...f.snapshot,console:{handle:"new-console",paneKey:null,pid:1,startedAt:100,heartbeatAt:100}};
  await f.timers.advance(12000);
  expect(f.writes.at(-1)!.text).toContain("new-console");
 }finally{await f.cleanup();}
});

test("real loopback server shutdown switches HTTP to bridge and restart restores HTTP",async()=>{
 const f=fixture();const panels:string[]=[];
 const serve=(port:number)=>Bun.serve({hostname:"127.0.0.1",port,fetch(req){
  return Response.json(new URL(req.url).pathname==="/health"?{ok:true}:f.snapshot,{headers:{"X-Pacer":"1"}});
 }});
 let server=serve(0);const port=server.port!;
 const original=f.host.call.bind(f.host);
 f.host.call=(async(m:any,p:any)=>m==="settings.get"?{settings:{port}}:original(m,p)) as OrcaHost["call"];
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100,timers:f.timers,
 http:{get:async(url,token)=>{const r=await fetch(url,{headers:token?{Authorization:"Bearer "+token}:{}});return {status:r.status,body:await r.text(),headers:{"x-pacer":r.headers.get("x-pacer")??undefined}};},stream:()=>()=>{}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 const waitForPanel=async(transport:string)=>{
  const deadline=Date.now()+2000;
  while(!panels.at(-1)?.includes(`data-transport="${transport}"`) && Date.now()<deadline){
   await f.timers.advance(1000);await Bun.sleep(10);await flush();
  }
  expect(panels.at(-1)).toContain(`data-transport="${transport}"`);
 };
 const restart=async()=>{
  const deadline=Date.now()+2000;
  while(true){
   try{return serve(port);}catch(e){
    if((e as {code?:string}).code!=="EADDRINUSE" || Date.now()>=deadline)throw e;
    await Bun.sleep(10);
   }
  }
 };
 try{
  await plugin.activate(f.ctx);await waitForPanel("http");
  server.stop(true);await waitForPanel("bridge");
  server=await restart();await waitForPanel("http");
 }finally{server.stop(true);await plugin.deactivate();await f.cleanup();}
});

test("panel metadata-only refresh never rewrites even after five minutes",async()=>{
 const f=fixture();try{
 await f.start();await f.timers.advance(2000);expect(f.writes).toHaveLength(1);
 for(let i=1;i<5;i++){f.now=100+i*60;f.snapshot={...f.snapshot,at:100+i*60,console:{...f.snapshot.console!,heartbeatAt:100+i*60}};await f.timers.advance(60000);expect(f.writes).toHaveLength(1);}
 f.now=402;f.snapshot={...f.snapshot,at:402,console:{...f.snapshot.console!,heartbeatAt:402}};await f.timers.advance(62000);expect(f.writes).toHaveLength(1);
 }finally{await f.cleanup();}
});

test("worker chooses the console registered in the focused worktree",async()=>{
 const f=fixture();try{
 f.snapshot={...f.snapshot,consoles:[f.snapshot.console!,{handle:"focused",paneKey:null,pid:2,startedAt:0,heartbeatAt:100}]};f.context={worktreeId:"wt",branch:"focused",displayName:"Focused",terminals:[{id:"focused"}]};
 await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});expect(sends(f)[0].params.terminalId).toBe("focused");expect(JSON.parse(sends(f)[0].params.text.slice(9,-1)).data.worktreeId).toBe("wt");
 }finally{await f.cleanup();}
});
test("worker never sends to a console outside the focused worktree",async()=>{
 const f=fixture();try{f.context={branch:"other",displayName:"Other",terminals:[{id:"other"}]};await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(sends(f)).toHaveLength(0);expect(notes(f).at(-1)?.params.title).toBe("No console in this worktree");}finally{await f.cleanup();}
});
test("multi-console heartbeat ordering does not rewrite the panel",async()=>{
 const f=fixture();try{
 const other={...f.snapshot.console!,handle:"other",heartbeatAt:99};f.snapshot={...f.snapshot,consoles:[f.snapshot.console!,other]};await f.start();await f.timers.advance(2000);
 f.snapshot={...f.snapshot,console:{...other,heartbeatAt:110},consoles:[{...other,heartbeatAt:110},f.snapshot.console!]};await f.timers.advance(12000);expect(f.writes).toHaveLength(1);
 }finally{await f.cleanup();}
});
test("open-console checks the focused worktree rather than another console",async()=>{
 const f=fixture();try{f.context={branch:"x",displayName:"X",terminals:[{id:"other"}]};await f.start();expect(await f.commands.get("open-console")!()).toMatchObject({ok:false,message:"No console in this worktree"});}finally{await f.cleanup();}
});

test("liveness timer rewrites on live to dead without a new snapshot and on recovery",async()=>{
 const f=fixture();try{
 await f.start();await f.timers.advance(2000);expect(f.writes).toHaveLength(1);
 f.now=130;await f.timers.advance(15000);expect(f.writes).toHaveLength(1);
 f.now=131;await f.timers.advance(15000);expect(f.writes).toHaveLength(2);
 expect(f.writes.at(-1)!.text).toContain('data-view="delegate" data-live disabled');
 await f.timers.advance(15000);expect(f.writes).toHaveLength(2);
 f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:131}};
 await f.timers.advance(12000);expect(f.writes).toHaveLength(3);
 expect(f.writes.at(-1)!.text).toContain('data-view="delegate" data-live>');
 }finally{await f.cleanup();}
});
test("worker console sends include the thirty-second boundary but reject the next second",async()=>{
 const f=fixture();try{
 await f.start();f.now=130;expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});
 f.now=131;expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(sends(f)).toHaveLength(1);
 }finally{await f.cleanup();}
});

test("console sends are serialized while a prior host send is in flight",async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let sending=0,max=0,number=0;
 const call=f.host.call.bind(f.host);
 f.host.call=(async(method:any,params:any)=>{
   if(method==="terminal.sendText"){sending++;max=Math.max(max,sending);if(number++===0)await gate;const r=await call(method,params);sending--;return r;}
   return call(method,params);
 }) as OrcaHost["call"];
 try {await f.start();const a=f.commands.get("delegate")!(),b=f.events.get("worktree.created")!({worktreeId:"wt",path:"/r",branch:"pacer-task"});await flush();expect(max).toBe(1);release();await Promise.all([a,b]);expect(max).toBe(1);expect(sends(f)).toHaveLength(2);}finally{release?.();await f.cleanup();}
});

test("background task renders coalesce at ten seconds, retry outcomes render within two seconds, ages do not rewrite",async()=>{
 const f=fixture();f.snapshot={...f.snapshot,tasks:[{id:"old",state:"running",goal:"task",executor:"codex",backend:"direct",worktree:null,updatedAt:100}]};
 try{await f.start();await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.now=101;f.snapshot={...f.snapshot,tasks:[{...f.snapshot.tasks[0]!,updatedAt:101}]};await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.snapshot={...f.snapshot,tasks:[{...f.snapshot.tasks[0]!,state:"failed"}]};await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.now=102;f.snapshot={...f.snapshot,tasks:[...f.snapshot.tasks,{id:"retry",retryOf:"old",state:"queued",goal:"task",executor:null,backend:null,worktree:null,updatedAt:102}]};await f.timers.advance(2000);expect(f.writes).toHaveLength(2);
 expect(f.writes.at(-1)!.text).toContain("pacer-panel-scroll");
 }finally{await f.cleanup();}
});

test("worker refreshes notification preference after 30 seconds and rerenders without snapshot changes",async()=>{
 const f=fixture();let level="off",reads=0;const original=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?(reads++,Promise.resolve({settings:{notifications:level}})):original(method,params)) as OrcaHost["call"]};
 try{await f.start();await f.timers.advance(200);expect(f.writes.at(-1)!.text).toContain('value="off" selected');
 level="all";f.now=130;await f.timers.advance(29799);expect(reads).toBe(1);
 await f.timers.advance(1);await f.timers.advance(200);expect(reads).toBe(2);expect(f.writes.at(-1)!.text).toContain('value="all" selected');
 }finally{await f.cleanup();}
});

for (const heartbeat of [null, 100]) test(`API refresh updates the summary without console IPC (heartbeat ${heartbeat})`, async () => {
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
  expect(f.writes.at(-1)!.text).toContain('data-transport="api"');
  const before = snapshots;
  f.snapshot = {...f.snapshot,budget:{generatedAt:100,strategy:"fresh",planner:"codex",mode:"normal",
   providers:[{id:"codex",verdict:"OK",pacePct:null,usedPct:42,resetsAt:null,window:null,stale:false}],ranked:[]}};
  expect(await f.commands.get("refresh-status")!()).toEqual({ok:true,message:summaryLine(f.snapshot.budget)});
  expect(snapshots).toBeGreaterThan(before);
  expect(connections).toBe(1);
  expect(notes(f).at(-1)!.params).toMatchObject({title:"Budget refreshed",body:"Open the pacer panel for the current budget."});
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==="workspace.readContext")).toHaveLength(0);
  await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("fresh");
 } finally { await f.cleanup(); }
});
