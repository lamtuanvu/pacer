import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { currentSnapshot, writeConsole } from "../src/link/store";
import { consolePath, linkDir } from "../src/link/paths";
import { parseSnapshot, emptySnapshot } from "../src/link/envelope";
const c=(handle:string,pid:number,heartbeatAt:number)=>({handle,pid,heartbeatAt,startedAt:1,paneKey:null});
test("snapshot combines per-handle registrations with legacy console and removes dead pids",()=>{
 const ctx=fakeCtx({now:100});writeConsole(ctx,c("term_a",1,98));writeConsole(ctx,c("term_b",2,99));
 const dead=join(linkDir(ctx),"consoles","term_dead.json");mkdirSync(join(linkDir(ctx),"consoles"),{recursive:true});writeFileSync(dead,JSON.stringify(c("term_dead",3,100)));
 writeFileSync(consolePath(ctx),JSON.stringify(c("legacy",4,97)));
 const s=currentSnapshot(ctx,pid=>pid!==3);expect(s.consoles?.map(x=>x.handle)).toEqual(["term_b","term_a","legacy"]);expect(s.console?.handle).toBe("term_b");expect(existsSync(dead)).toBe(false);
});
test("console shutdown removes only its own registration",()=>{
 const ctx=fakeCtx({now:100});writeConsole(ctx,c("term_a",1,98));writeConsole(ctx,c("term_b",2,99));writeConsole(ctx,null,"term_a");
 expect(currentSnapshot(ctx,()=>true).consoles?.map(x=>x.handle)).toEqual(["term_b"]);
});
test("old snapshots parse and new console and strategy lists survive validation",()=>{
 const s=parseSnapshot({v:1,seq:0,at:100,console:c("old",1,100)});expect(s?.consoles).toEqual([]);
 const next=parseSnapshot({...emptySnapshot(),consoles:[c("a",1,100),{bad:true}],strategies:["default","custom",42]});
 expect(next?.consoles?.map(x=>x.handle)).toEqual(["a"]);expect(next?.strategies).toEqual(["default","custom"]);
});
test("current snapshot lists available strategies for the panel",()=>{
 const ctx=fakeCtx();mkdirSync(join(ctx.pacerHome,"strategies"),{recursive:true});writeFileSync(join(ctx.pacerHome,"strategies","custom.yaml"),"");
 expect(currentSnapshot(ctx,()=>true).strategies?.map(x=>typeof x==="string"?x:x.name)).toEqual(["default","custom"]);
});

test("shutdown without a handle preserves another process registrations",()=>{
 const ctx=fakeCtx({now:100});writeConsole(ctx,c("other",process.pid+1,100));
 writeConsole(ctx,null);
 expect(existsSync(join(linkDir(ctx),"consoles","other.json"))).toBe(true);
 expect(existsSync(consolePath(ctx))).toBe(true);
});
test("shutdown without a handle removes only registrations owned by this pid",()=>{
 const ctx=fakeCtx({now:100});writeConsole(ctx,c("owned",process.pid,100));writeConsole(ctx,c("other",process.pid+1,100));
 writeConsole(ctx,null);
 expect(existsSync(join(linkDir(ctx),"consoles","owned.json"))).toBe(false);
 expect(existsSync(join(linkDir(ctx),"consoles","other.json"))).toBe(true);
 expect(existsSync(consolePath(ctx))).toBe(true);
 writeConsole(ctx,c("owned",process.pid,100));writeConsole(ctx,null);
 expect(existsSync(consolePath(ctx))).toBe(false);
});
test("registrations over ten minutes old are deleted even with a reused live pid",()=>{
 const ctx=fakeCtx({now:1000});writeConsole(ctx,c("expired",process.pid,399));
 const s=currentSnapshot(ctx,()=>true);
 expect(s.consoles).toEqual([]);
 expect(existsSync(join(linkDir(ctx),"consoles","expired.json"))).toBe(false);
 expect(existsSync(consolePath(ctx))).toBe(false);
 writeConsole(ctx,c("boundary",process.pid,400));expect(currentSnapshot(ctx,()=>true).consoles?.map(c=>c.handle)).toEqual(["boundary"]);
});
