import { expect, test } from "bun:test";
import { realpathSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { labelsFor, resolveRepo, repoFor } from "../src/core/repos";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

test("repo labels disambiguate hosts", () => {
 expect(labelsFor([{key:"github.com/acme/api",path:"/api"}]).get("github.com/acme/api")).toBe("acme/api");
 const labels=labelsFor(["github.com/acme/api","gitlab.com/acme/api"].map(key=>({key,path:"/api"})));
 expect([...labels.values()]).toEqual(["github.com/acme/api","gitlab.com/acme/api"]);
});
test("resolve origin, linked worktree and registry-only subfolder lookup", async () => {
 const repo=gitRepo(), ctx=fakeCtx({run:realRun});
 await realRun(["git","-C",repo,"remote","add","origin","git@github.com:Acme/API.git"],10000);
 const ref=await resolveRepo(ctx,repo);
 expect(ref).toEqual({key:"github.com/acme/api",label:"acme/api",path:realpathSync(repo)});
 const wt=join(tmpDir(),"linked");
 await realRun(["git","-C",repo,"worktree","add","-b","linked",wt],10000);
 expect(await resolveRepo(ctx,wt)).toEqual(ref);
 expect(repoFor({...ctx,run:async()=>{throw Error("no git on read");}},join(wt,"src"))).toEqual(ref);
});
test("no origin, local origin and missing folder fall back safely", async () => {
 const repo=gitRepo(),ctx=fakeCtx({run:realRun});
 expect(await resolveRepo(ctx,repo)).toMatchObject({label:basename(repo),key:expect.stringMatching(/^local:[0-9a-f]{12}$/)});
 await realRun(["git","-C",repo,"remote","add","origin","/tmp/local.git"],10000);
 expect((await resolveRepo(ctx,repo)).key).toMatch(/^local:/);
 expect(repoFor(ctx,"/missing/repo")).toMatchObject({path:"/missing/repo",label:"repo"});
});

test("delegate persists a supplied repo identity", async () => {
 const { delegate }=await import("../src/tasks/api");
 const { loadStrategy }=await import("../src/config/strategy");
 const ctx=fakeCtx(),ref={key:"github.com/acme/api",label:"acme/api",path:"/api"};
 mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 const t=delegate(ctx,{brief:{goal:"test",repo:ctx.home},repoRef:ref},()=>1,loadStrategy(ctx));
 expect(t.repo).toEqual(ref);
});

test("registry stores main checkouts only and labels stay unique across origins",async()=>{
 const ctx=fakeCtx({run:realRun}),a=gitRepo(),b=gitRepo();
 await realRun(["git","-C",a,"remote","add","origin","git@github.com:acme/api.git"],10000);
 await realRun(["git","-C",b,"remote","add","origin","git@gitlab.com:acme/api.git"],10000);
 await resolveRepo(ctx,a);await resolveRepo(ctx,b);
 const wt=join(tmpDir(),"worktree");await realRun(["git","-C",a,"worktree","add","-b","wt",wt],10000);await resolveRepo(ctx,wt);
 const reg=await Bun.file(join(ctx.pacerHome,"state","repos.json")).json();
 expect(Object.keys(reg)).toHaveLength(2);
 expect(repoFor(ctx,a).label).toBe("github.com/acme/api");
});

test("pump backfills old task repo refs without git during subsequent reads",async()=>{
 const {createTask}=await import("../src/tasks/store");const {apiTask}=await import("../src/api/read-model/tasks");
 const {pumpOnce}=await import("../src/link/pump");const {publish}=await import("../src/link/publish");
 const {capacityFixture}=await import("./read-model-helpers");
 const repo=gitRepo(),ctx=fakeCtx({run:realRun}),{s,st}=capacityFixture();
 await realRun(["git","-C",repo,"remote","add","origin","git@github.com:acme/old.git"],10000);
 const old=createTask(ctx,{brief:{goal:"old task",repo},kind:null,requestedExecutor:null,timeoutS:60});
 expect(apiTask(ctx,old).repo.key).toMatch(/^local:/);
 await pumpOnce(ctx,{status:async()=>st,strategy:()=>s,tasks:()=>[old],setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:(c,e,o)=>publish(c,e,{...o,bridge:false,channel:false})});
 expect(apiTask({...ctx,run:async()=>{throw Error("no git on reads");}},old).repo.key).toBe("github.com/acme/old");
});
