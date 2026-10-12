import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin } from "../orca-plugin/src/plugin";
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
function fixture(heartbeat: number|null=100, marker=true) {
 const root=mkdtempSync(join(tmpdir(),"pacer-plugin-"));const timers=new ManualTimers();let now=100;
 let snapshot:LinkSnapshot={...emptySnapshot(),console:heartbeat===null?null:{handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:heartbeat}};
 const calls:{method:string;params:any}[]=[];const commands=new Map<string,(args?:unknown)=>unknown>();const events=new Map<string,(p:unknown)=>void|Promise<void>>();const writes:{path:string;text:string}[]=[];
 let accepted=true,throwSend=false,pending=false,context:any={branch:"pacer-task",displayName:"Project",terminals:[{id:"term"}]};
 const host={call:async(method:string,params:any)=>{calls.push({method,params});switch(method){case "settings.get":return {settings:{}};case "events.subscribe":throw Error("invalid enum");case "storage.get":return {value:snapshot};case "workspace.readContext":return context;case "terminal.sendText":if(throwSend)throw Object.assign(Error("denied"),{code:"capability_denied"});return {accepted};case "notifications.show":return {delivered:true};case "settings.set":return {ok:true};default:throw Error(method);}}} as OrcaHost;
 const plugin=createPlugin({home:root,pluginRoot:root,nowS:()=>now,timers,http:{get:async()=>pending?await new Promise(()=>{}):{status:401,body:""},stream:()=>()=>{}},fs:{readText:()=>"token",exists:p=>marker && p===join(root,".pacer-managed"),writeTextAtomic:(path,text)=>writes.push({path,text})}});
 const ctx:OrcaWorkerContext={host,commands:{register:(id,h)=>commands.set(id,h)},events:{on:(id,h)=>events.set(id,h)},grantedCapabilities:[],log:()=>{}};
 return {plugin,ctx,host,timers,calls,commands,events,writes,get snapshot(){return snapshot;},set snapshot(s){snapshot=s;},set accepted(v:boolean){accepted=v;},set throwSend(v:boolean){throwSend=v;},set pending(v:boolean){pending=v;},set context(v:any){context=v;},set now(v:number){now=v;},async start(){await plugin.activate(ctx);await flush();},async cleanup(){await plugin.deactivate();rmSync(root,{recursive:true,force:true});}};
}
const sends=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="terminal.sendText");
const notes=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="notifications.show");
test("settings validate defaults, forced transport and clamped poll range",()=> {expect(readSettings({},"/tmp/home")).toEqual({transport:"auto",port:4317,pacerHome:"/tmp/home/.pacer",pollSeconds:10,lastAlertAt:0});expect(readSettings({transport:"bridge",pollSeconds:1,port:-1,lastAlertAt:NaN},"/tmp")).toMatchObject({transport:"bridge",pollSeconds:5,port:4317,lastAlertAt:0});expect(readSettings({transport:"invalid",pollSeconds:999},"/tmp")).toMatchObject({transport:"auto",pollSeconds:300});});
test("activation registers all commands without awaiting transport probes",async()=> {const f=fixture();f.pending=true;try{await f.plugin.activate(f.ctx);expect([...f.commands.keys()].sort()).toEqual(["delegate","switch-strategy","refresh-status","open-console"].sort());expect(f.events.has("plugin.message")).toBe(false);}finally{await f.cleanup();}});
for(const heartbeat of [null,69])test(`delegate refuses console heartbeat ${heartbeat}`,async()=> {const f=fixture(heartbeat);try{await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(notes(f).map(c=>c.params.title)).toEqual([NO_CONSOLE.title]);expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
test("delegate uses advertised live handle and shell-inert command with context",async()=> {const f=fixture();try{await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:true});expect(sends(f)[0].params).toEqual({terminalId:"term",text:encodeCmdLine({cmd:"delegate",branch:"pacer-task",displayName:"Project"}),enter:true});f.context=null;await f.commands.get("delegate")!();expect(sends(f)[1].params.text).toBe(encodeCmdLine({cmd:"delegate"}));await f.commands.get("switch-strategy")!();expect(sends(f)[2].params.text).toBe(encodeCmdLine({cmd:"use"}));}finally{await f.cleanup();}});
for(const error of [false,true])test(`send rejection ${error?"throws":"accepted false"} notifies without crash`,async()=> {const f=fixture();try{f.accepted=false;f.throwSend=error;await f.start();expect(await f.commands.get("delegate")!()).toMatchObject({ok:false});expect(notes(f).at(-1)!.params.title).toBe("Orca refused to type into the pacer console");}finally{await f.cleanup();}});
test("refresh reports clipped budget summary and silently skips absent console",async()=> {const f=fixture(null);try{f.snapshot={...f.snapshot,budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:Array.from({length:32},(_,i)=>({id:"p"+i+"x".repeat(60),verdict:"OK",usedPct:50,resetsAt:null,window:null,stale:false})),ranked:[]}};await f.start();expect(await f.commands.get("refresh-status")!()).toMatchObject({ok:true});expect(notes(f).at(-1)!.params.title).toBe(summaryLine(f.snapshot.budget));expect(notes(f).at(-1)!.params.body.length).toBeLessThanOrEqual(1000);expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
for(const heartbeat of [null,100])test(`open-console heartbeat ${heartbeat}`,async()=> {const f=fixture(heartbeat);try{await f.start();await f.commands.get("open-console")!();expect(notes(f).at(-1)!.params.title).toBe(heartbeat===null?NO_CONSOLE.title:"pacer console is running");expect(sends(f)).toHaveLength(0);}finally{await f.cleanup();}});
test("agent events filter non-done and debounce per pane and globally",async()=> {const f=fixture();try{await f.start();const event=f.events.get("agent.status.changed")!;const p={worktreeId:"wt",paneKey:"pane",state:"done",receivedAt:100};await event({...p,state:"working"});await event({...p,mainAgent:{state:"working",stateStartedAt:0}});expect(sends(f)).toHaveLength(0);await event(p);await event(p);await event({...p,paneKey:"other"});expect(sends(f)).toHaveLength(1);expect(sends(f)[0].params.text).toBe(encodeCmdLine({cmd:"agent-done",paneKey:"pane",worktreeId:"wt"}));f.now=105;await event(p);expect(sends(f)).toHaveLength(2);}finally{await f.cleanup();}});
test("worktree events send only pacer branches and silently skip absent console",async()=> {const f=fixture();try{await f.start();const event=f.events.get("worktree.created")!;const p={worktreeId:"wt",path:"/tmp/work",branch:"feature/x"};await event(p);expect(sends(f)).toHaveLength(0);await event({...p,branch:"pacer-1"});await event({...p,branch:"feature/pacer-2"});expect(sends(f)).toHaveLength(2);f.snapshot={...f.snapshot,console:null};await f.commands.get("refresh-status")!();await event({...p,branch:"pacer-3"});expect(sends(f)).toHaveLength(2);}finally{await f.cleanup();}});
test("alerts suppress old and duplicate notifications, persist watermark and cap at three",async()=> {const f=fixture();try{const settings=readSettings({},"/tmp");const s=emptySnapshot();s.alerts=Array.from({length:6},(_,i)=>({key:`a${i}`,level:"warn",title:`A${i}`,body:"body",at:1000-i}));s.alerts.push({key:"old",level:"info",title:"old",body:"",at:399});const at=await notifyNewAlerts(f.host,s,settings,1000);expect(notes(f).map(c=>c.params.title)).toEqual(["A5","A4","A3"]);expect(at).toBe(997);expect(f.calls.filter(c=>c.method==="settings.set").at(-1)!.params).toEqual({key:"lastAlertAt",value:997});settings.lastAlertAt=at;await notifyNewAlerts(f.host,s,settings,1000);expect(notes(f).map(c=>c.params.title)).toEqual(["A5","A4","A3","A2","A1","A0"]);settings.lastAlertAt=1000;await notifyNewAlerts(f.host,s,settings,1000);expect(notes(f)).toHaveLength(6);}finally{await f.cleanup();}});
for(const marker of [false,true])test(`panel writes require managed marker ${marker}`,async()=> {const f=fixture(100,marker);try{f.snapshot={...f.snapshot,alerts:[{key:"a",level:"warn",title:"New alert",body:"body",at:100}]};await f.start();await f.timers.advance(2000);expect(f.writes.length).toBe(marker?1:0);await f.commands.get("refresh-status")!();await f.timers.advance(2000);expect(f.writes.length).toBe(marker?2:0);expect(notes(f).filter(c=>c.params.title==="New alert")).toHaveLength(1);if(marker)expect(f.writes[0].path.endsWith("/panel/live.html")).toBe(true);await f.plugin.deactivate();expect(f.timers.jobs.filter(j=>!j.cancelled)).toHaveLength(0);}finally{await f.cleanup();}});

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
 f.context = {branch,displayName,terminals:[{id:"unrelated-shell"}]};
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
 expect(html.match(/&lt;img src=x/g)).toHaveLength(4);
 const json = html.match(/id="pacer-actions">(.*?)<\/script>/s)![1];
 expect(json).not.toContain("<"); expect(json).not.toMatch(/[\u2028\u2029]/);
 expect(JSON.parse(json).delegate.terminalId).toBe(attack);
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
  httpTransport({timers,port:4317,readToken:()=>"test-token",http:{get:async()=>({status:200,body:JSON.stringify(bridgeSnapshot)}),stream:(_url,_token,fn)=>{onLine=fn;return()=>{};}}}),
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
 const http={get:async()=>{requests++;return {status:200,body:JSON.stringify(f.snapshot)};},stream:()=>()=>{}};
 const plugin=createPlugin({home:"/tmp/fake",pluginRoot:"/tmp/fake",nowS:()=>140,timers:f.timers,http,fs:{readText:()=>"token",exists:()=>false,writeTextAtomic:()=>{}}});
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
test("equal timestamp alerts beyond the first three are delivered on later updates", async () => {
 const f=fixture();const settings=readSettings({},"/tmp");const s=emptySnapshot();
 s.alerts=Array.from({length:7},(_,i)=>({key:`same-${i}`,level:"warn",title:`same-${i}`,body:"body",at:100}));
 try {
  await notifyNewAlerts(f.host,s,settings,100);expect(notes(f)).toHaveLength(3);
  await notifyNewAlerts(f.host,s,settings,100);expect(notes(f)).toHaveLength(6);
  await notifyNewAlerts(f.host,s,settings,100);expect(notes(f)).toHaveLength(7);
  await notifyNewAlerts(f.host,s,settings,100);expect(notes(f)).toHaveLength(7);
 }finally{await f.cleanup();}
});

test("HTTP snapshot polls re-render panel liveness even when content is unchanged", async () => {
 const f=fixture();let now=100;const panels:string[]=[];
 const plugin=createPlugin({home:"/tmp/fake",pluginRoot:"/tmp/fake",nowS:()=>now,timers:f.timers,
  http:{get:async()=>({status:200,body:JSON.stringify(f.snapshot)}),stream:()=>()=>{}},
  fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_path,text)=>panels.push(text)}});
 try {
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  expect(panels.at(-1)).toContain('data-action="delegate">');
  now=140;await f.timers.advance(10000);
  expect(panels.at(-1)).toContain('data-action="delegate" disabled');
  f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:140}};
  await f.timers.advance(10000);
  expect(panels.at(-1)).toContain('data-action="delegate">');
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
