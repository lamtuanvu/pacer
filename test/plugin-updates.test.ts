import { ManualTimers, flush } from "./plugin-transports.test";
import { expect, test } from "bun:test";
import { notifyUpdates, UPDATE_INTERVAL_MS } from "../orca-plugin/src/updates";
import { createPlugin, type Timers } from "../orca-plugin/src/plugin";
import type { OrcaHost, OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { emptySnapshot } from "../src/link/envelope";
import { renderPanel } from "../orca-plugin/src/panel";
function harness() {
 const saved=new Map<string,unknown>(),notices:{title:string;body?:string}[]=[];
 const host:OrcaHost={async call(method,params):Promise<any>{
  const p=params as any;
  if(method==="storage.get")return {value:saved.get(p.key)};
  if(method==="storage.set"){saved.set(p.key,p.value);return {ok:true};}
  if(method==="notifications.show"){notices.push(p);return {delivered:true};}
  if(method==="settings.get")return {settings:{transport:"bridge"}};
  return {};
 }};
 return {host,saved,notices};
}
for(const mode of ["live","bootstrap"] as const)test(`${mode} update notifications dedupe each release and CLI version across restarts`,async()=>{
 const h=harness(),check={checkedAt:10,current:"1.0.0",latest:"1.1.0"};
 await notifyUpdates(h.host,mode,"1.0.0",check,null);await notifyUpdates(h.host,mode,"1.0.0",check,null);
 expect(h.notices).toHaveLength(1);expect(h.notices[0].body).toBe(`pacer 1.1.0 is available. ${mode==="live"?"Click Update in the pacer panel.":"In Orca Settings > Plugins, click Refresh, then Update plugin."}`);
 await notifyUpdates(h.host,mode,"1.0.0",{...check,latest:"1.2.0"},"1.3.0");expect(h.notices).toHaveLength(3);
 expect(h.notices[2].body).toContain("CLI 1.3.0 is newer");expect(h.notices[2].body).toContain(mode==="live"?"pacer plugin install":"Refresh, then Update plugin");
 await notifyUpdates(h.host,mode,"1.0.0",check,"1.3.0");expect(h.notices).toHaveLength(3);
 await notifyUpdates(h.host,mode,"1.4.0",check,"1.3.0");expect(h.notices).toHaveLength(3);
});
for(const mode of ["live","bootstrap"] as const)test(`${mode} worker starts a check without waiting and cancels six-hour timer on deactivation`,async()=>{
 const h=harness(),jobs:{ms:number;fn:()=>void;cancelled:boolean}[]=[];
 const add=(ms:number,fn:()=>void)=>{const job={ms,fn,cancelled:false};jobs.push(job);return()=>{job.cancelled=true;};};
 const timers:Timers={every:add,after:add};let calls=0;const reports:string[]=[];
 const plugin=createPlugin({version:"1.0.0",checkUpdates:async()=>{calls++;return {check:{checkedAt:0,current:"1.0.0",latest:"1.1.0"},cli:"1.0.0"};},reportVersion:mode=>{reports.push(mode);},timers,nowS:()=>0,home:"/tmp/pacer-fixture",pluginRoot:"/tmp/plugin-fixture",fs:{readText:()=>null,exists:()=>mode==="live",writeTextAtomic(){}},http:{get:async()=>({status:503,body:""}),stream:()=>()=>{}}});
 const ctx:OrcaWorkerContext={host:h.host,commands:{register(){}},events:{on(){}},log(){},grantedCapabilities:[]};
 await plugin.activate(ctx);for(let i=0;i<50;i++)await Promise.resolve();expect(calls).toBe(1);expect(reports).toEqual([mode]);
 const timer=jobs.find(j=>j.ms===UPDATE_INTERVAL_MS)!;expect(timer).toBeDefined();timer.fn();for(let i=0;i<50;i++)await Promise.resolve();expect(calls).toBe(2);expect(h.notices).toHaveLength(1);
 await plugin.deactivate();expect(timer.cancelled).toBe(true);timer.fn();expect(calls).toBe(2);
});
test("status page shows versions and update instructions",()=>{
 const html=renderPanel(emptySnapshot(),{nowS:0,transport:null,reachable:false,updates:{plugin:"1.0.0",cli:"1.0.1",latest:"1.2.0",available:true}});
 expect(html).toContain("Update available: 1.2.0");expect(html).toContain("pacer 1.0.1 · plugin 1.0.0");expect(html).toContain("pacer update");expect(html).not.toContain("data-command");
 const current=renderPanel(emptySnapshot(),{nowS:0,transport:null,reachable:false,updates:{plugin:"1.2.0",cli:"1.2.0",latest:"1.2.0",available:false}});expect(current).toContain("pacer 1.2.0 · plugin 1.2.0");expect(current).not.toContain('data-command="u"');
});
test("live panel sees CLI-forced cache refresh without waiting for the six-hour network timer",async()=>{
 const h=harness(),timers=new ManualTimers();let html="",latest="1.0.0";
 const plugin=createPlugin({version:"1.0.0",cachedUpdate:()=>({checkedAt:timers.now/1000,current:"1.0.0",latest}),timers,nowS:()=>timers.now/1000,home:"/tmp/pacer-fixture",pluginRoot:"/tmp/plugin-fixture",fs:{readText:()=>null,exists:()=>true,writeTextAtomic:(_path,text)=>{html=text;}},http:{get:async()=>({status:503,body:""}),stream:()=>()=>{}}});
 try {
  await plugin.activate({host:h.host,commands:{register(){}},events:{on(){}},log(){},grantedCapabilities:[]});await flush();
  await timers.advance(2000);expect(html).toContain("pacer unknown · plugin 1.0.0");
  latest="1.2.0";await timers.advance(15000);
  expect(html).toContain("Update available: 1.2.0");expect(html).toContain("pacer update");
 } finally { await plugin.deactivate(); }
});
