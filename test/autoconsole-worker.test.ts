import { expect, test } from "bun:test";
import { createPlugin } from "../orca-plugin/src/plugin";
import { readSettings } from "../orca-plugin/src/settings";
import { parseSetting } from "../src/plugin/cli";
import { emptySnapshot } from "../src/link/envelope";
import { ManualTimers, flush } from "./plugin-transports.test";
import type { OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { selfHandle } from "../src/console/cli";
import { fakeCtx } from "./helpers";
import { fakeRun } from "./fixtures/orca/fake";
function fixture(settings:Record<string,unknown>={}) {
 const timers=new ManualTimers();let now=100;let snap=emptySnapshot();const posts:any[]=[], logs:string[]=[];let fail=false, health=true;let context:any={branch:"feat/x",displayName:"Feature",terminals:[{id:"term_target"}]};
 const ctx={host:{call:async(m:string)=>m==="settings.get"?{settings}:m==="workspace.readContext"?context:m==="storage.get"?{value:snap}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s),grantedCapabilities:[]} as OrcaWorkerContext;
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp/plugin",nowS:()=>now,timers,fs:{readText:()=>"secret",exists:()=>false,writeTextAtomic(){}},http:{get:async(url)=>({status:200,headers:{"x-pacer":health?"1":"0"},body:JSON.stringify(url.endsWith("/health")?{ok:true}:snap)}),post:async(...args:any[])=>{posts.push(args);if(fail)throw Error("offline");return {status:200,body:'{"ok":true}',headers:{"x-pacer":"1"}};},stream:()=>()=>{}}});
 return {plugin,timers,posts,logs,set fail(v:boolean){fail=v;},set health(v:boolean){health=v;},set context(v:any){context=v;},set snap(v:typeof snap){snap=v;},async start(){await plugin.activate(ctx);await flush();},async tick(seconds=5){now+=seconds;await timers.advance(seconds*1000);await flush();}};
}
test("autoConsole setting defaults and on/off validation",()=>{
 expect(readSettings({},"/tmp").autoConsole).toBe(true);expect(readSettings({autoConsole:false},"/tmp").autoConsole).toBe(false);expect(readSettings({autoConsole:"off"},"/tmp").autoConsole).toBe(true);
 expect(parseSetting("autoConsole","on")).toBe(true);expect(parseSetting("autoConsole","off")).toBe(false);expect(()=>parseSetting("autoConsole","true")).toThrow();
});
test("HTTP worker opens focused worktree once per sixty seconds",async()=>{
 const f=fixture();try{await f.start();await f.tick();expect(f.posts).toHaveLength(1);expect(f.posts[0].slice(0,3)).toEqual(["http://127.0.0.1:4317/console/open","secret",{terminal:"term_target",branch:"feat/x"}]);await f.tick(55);expect(f.posts).toHaveLength(1);await f.tick(5);expect(f.posts).toHaveLength(2);}finally{await f.plugin.deactivate();}
});
for(const settings of [{autoConsole:false},{transport:"bridge"},{transport:"channel"}])test(`worker skips auto open ${JSON.stringify(settings)}`,async()=>{
 const f=fixture(settings);try{await f.start();await f.tick(65);expect(f.posts).toHaveLength(0);}finally{await f.plugin.deactivate();}
});
test("worker skips live focused console but ignores other worktree consoles",async()=>{
 const f=fixture();try{f.snap={...emptySnapshot(),consoles:[{handle:"term_target",pid:1,paneKey:null,startedAt:100,heartbeatAt:100}]};await f.start();await f.tick();expect(f.posts).toHaveLength(0);f.snap={...emptySnapshot(),consoles:[{handle:"term_other",pid:1,paneKey:null,startedAt:100,heartbeatAt:100}]};await f.tick(10);expect(f.posts).toHaveLength(1);}finally{await f.plugin.deactivate();}
});
test("worker timer contains failures and logs once per worktree per five minutes",async()=>{
 const f=fixture();try{f.fail=true;await f.start();await f.tick();await f.tick(60);expect(f.logs.filter(s=>s.includes("auto console"))).toHaveLength(1);await f.tick(240);expect(f.logs.filter(s=>s.includes("auto console"))).toHaveLength(2);}finally{await f.plugin.deactivate();}
});
test("auto-created terminal resolves its exported Orca handle without CLI calls",async()=>{
 const f=fakeRun([]);expect(await selfHandle(fakeCtx({env:{ORCA_TERMINAL_HANDLE:"term_created"},run:f.run}))).toEqual({handle:"term_created",paneKey:null});expect(f.calls).toHaveLength(0);
});

test("HTTP worker can open a worktree with no terminals and skips absent context",async()=>{
 const f=fixture();try{f.context=null;await f.start();await f.tick();expect(f.posts).toHaveLength(0);f.context={branch:"empty",displayName:"Empty",terminals:[]};await f.tick();expect(f.posts[0][2]).toEqual({branch:"empty"});}finally{await f.plugin.deactivate();}
});
test("HTTP worker rechecks listener identity before sending bearer token",async()=>{
 const f=fixture();try{await f.start();f.health=false;await f.tick();expect(f.posts).toHaveLength(0);expect(f.logs.some(s=>s.includes("unidentified"))).toBe(true);}finally{await f.plugin.deactivate();}
});
test("worktree switch gets independent request debounce and logs",async()=>{
 const f=fixture();try{f.fail=true;await f.start();await f.tick();f.context={branch:"other",displayName:"Other",terminals:[{id:"term_other"}]};await f.tick();expect(f.posts).toHaveLength(2);expect(f.logs.filter(s=>s.includes("auto console"))).toHaveLength(2);}finally{await f.plugin.deactivate();}
});
