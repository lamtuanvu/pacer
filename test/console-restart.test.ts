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
 const calls:string[][]=[];const ctx=fakeCtx({run:async a=>{calls.push(a);return {code:a.at(-1)==="905"?1:0,stdout:"",stderr:""};}});
 for(const [pid,version,age] of [[901,"0.1.8",0],[902,"0.1.3",0],[903,undefined,0],[904,"0.1.8",601],[905,"0.1.8",0],[906,"0.1.8",0]] as const)writeConsole(ctx,{handle:`term_${pid}`,pid,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now-age,...(version?{version}:{})});
 expect(await restartConsoles(ctx,pid=>pid!==906)).toBe(1);expect(calls).toEqual([["kill","-USR1","901"],["kill","-USR1","905"]]);
});
test("service restart reports console restart count", async()=>{
 const ctx=fakeCtx({env:{PACER_BIN:"/opt/pacer"},run:async()=>({code:0,stdout:"",stderr:""})});
 expect(await serviceCli(["restart"],ctx,{platform:"darwin",uid:501})).toMatchObject({code:0,out:"restarted pacer serve\nrestarted 0 pacer consoles"});
});
