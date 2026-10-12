import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { binaryChanged, binaryStamp, restartConsoles } from "../src/console/restart";
import { currentSnapshot, writeConsole } from "../src/link/store";
import { parseSnapshot, emptySnapshot } from "../src/link/envelope";
import { currentVersion } from "../src/update/version";
import { serviceCli } from "../src/service/cli";
import { fakeCtx } from "./helpers";

test("binary identity watch detects replacement and ignores missing files", () => {
 const ctx=fakeCtx(), path=join(ctx.home,"pacer");writeFileSync(path,"old");const stamp=binaryStamp(path);expect(binaryChanged(path,stamp)).toBe(false);writeFileSync(path,"new-longer");expect(binaryChanged(path,stamp)).toBe(true);expect(binaryChanged(path,null)).toBe(false);expect(binaryChanged("/nonexistent/pacer",stamp)).toBe(false);
});
test("older console versions are excluded from live snapshots and registration versions survive validation",()=>{
 const ctx=fakeCtx();writeConsole(ctx,{handle:"term_old",pid:process.pid,paneKey:null,heartbeatAt:ctx.now,startedAt:ctx.now,version:"0.1.3"});
 expect(currentSnapshot(ctx).consoles).toEqual([]);expect(currentSnapshot(ctx).console).toBeNull();
 writeConsole(ctx,{handle:"term_new",pid:process.pid,paneKey:null,heartbeatAt:ctx.now,startedAt:ctx.now,version:currentVersion()});expect(currentSnapshot(ctx).console?.version).toBe(currentVersion());
 expect(parseSnapshot({...emptySnapshot(),console:{handle:"term_new",pid:1,paneKey:null,heartbeatAt:1,startedAt:1,version:"0.1.8"}})?.console?.version).toBe("0.1.8");
});
test("restart signals unique capable live registered pids and counts successful signals only",async()=>{
 const calls:string[][]=[];const ctx=fakeCtx({env:{PACER_BIN:"/opt/pacer"},run:async a=>{calls.push(a);return {code:a[0]==="kill" && a.at(-1)==="905"?1:0,stdout:a[0]==="ps"?"/opt/pacer console":"",stderr:""};}});
 for(const [pid,version,age] of [[901,"0.1.8",0],[902,"0.1.3",0],[903,undefined,0],[904,"0.1.8",601],[905,"0.1.8",0],[906,"0.1.8",0]] as const)writeConsole(ctx,{handle:`term_${pid}`,pid,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now-age,...(version?{version}:{})});
 expect(await restartConsoles(ctx,pid=>pid!==906)).toBe(1);expect(calls).toEqual([["ps","-o","command=","-p","901"],["kill","-USR1","901"],["ps","-o","command=","-p","905"],["kill","-USR1","905"]]);
});
test("service restart reports console restart count", async()=>{
 const ctx=fakeCtx({env:{PACER_BIN:"/opt/pacer"},run:async()=>({code:0,stdout:"",stderr:""})});
 expect(await serviceCli(["restart"],ctx,{platform:"darwin",uid:501})).toMatchObject({code:0,out:"restarted pacer serve\nrestarted 0 pacer consoles"});
});

for(const [age,command,code,signals] of [[30,"/opt/pacer console",0,1],[31,"/opt/pacer console",0,0],[0,"/usr/bin/python reused-console-pid",0,0],[0,"/opt/pacer serve",0,0],[0,"/opt/pacer console",1,0],[0,"/opt/pacer-not-real console",0,0],[0,"/opt/pacer console-helper",0,0]] as const)test(`restart checks fresh heartbeat and process identity (${age}, ${command}, ${code})`,async()=>{
 const calls:string[][]=[],reports:string[]=[];
 const ctx=fakeCtx({env:{PACER_BIN:"/opt/pacer"},run:async a=>{calls.push(a);return a[0]==="ps"?{code,stdout:command,stderr:""}:{code:0,stdout:"",stderr:""};}});
 writeConsole(ctx,{handle:"term_check",pid:901,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now-age,version:"0.1.8"});
 expect(await restartConsoles(ctx,()=>true,m=>reports.push(m))).toBe(signals);
 expect(calls.filter(a=>a[0]==="kill")).toHaveLength(signals);
 if(age<=30)expect(calls[0]).toEqual(["ps","-o","command=","-p","901"]);
 if(!signals)expect(reports.join(" ")).toContain("skipped console pid 901");
});

test("console reexec defers while busy and immediately restores registration after exec failure",async()=>{
 const {consoleRestarter}=await import("../src/console/restart");let idle=false;const events:string[]=[];
 const restart=consoleRestarter({idle:()=>idle,unregister:()=>events.push("unregister"),register:()=>events.push("register"),exec:()=>{events.push("exec");throw Error("exec failed");},report:m=>events.push(m)});
 restart.request();restart.request();expect(events).toEqual([]);
 idle=true;restart.retry();expect(events.slice(0,4)).toEqual(["pacer was updated; restarting console","unregister","exec","register"]);
 expect(events.at(-1)).toContain("exec failed");restart.retry();expect(events).toHaveLength(5);
});
