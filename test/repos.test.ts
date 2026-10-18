import { expect, test } from "bun:test";
import { realpathSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { labelsFor, resolveRepo, resolveRepoInput, repoFor, listRepos, backfillRepos } from "../src/core/repos";
import { cachedPath, refreshPath } from "../src/core/path-probe";
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
 await pumpOnce(ctx,{status:async()=>st,strategy:()=>s,tasks:()=>[old],setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:(c,e)=>publish(c,e)});
 expect(apiTask({...ctx,run:async()=>{throw Error("no git on reads");}},old).repo.key).toBe("github.com/acme/old");
});

test("repo ops list current branch first, cap branches and remove registrations",async()=>{
 const {callOp}=await import("../src/api/ops");
 const repo=gitRepo(),ctx=fakeCtx({run:realRun});
 for(let i=0;i<52;i++)await realRun(["git","-C",repo,"branch",`a-${i}`],10000);
 const ref=await callOp(ctx,"repo.add",{path:repo}) as any;
 const rows=await callOp(ctx,"repo.list",{}) as any[];
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject(ref);
 expect(rows[0].branches[0]).toBe("main");expect(rows[0].branches).toHaveLength(50);
 expect(await callOp(ctx,"repo.remove",{key:ref.key})).toEqual({removed:true});
 expect(await callOp(ctx,"repo.list",{})).toEqual([]);
 await expect(callOp(ctx,"repo.add",{path:tmpDir()})).rejects.toMatchObject({code:"invalid_input"});
});


test("deleted linked worktrees retain the main repo identity on resolution and reads",async()=>{
 const repo=gitRepo(),ctx=fakeCtx({run:realRun});
 await realRun(["git","-C",repo,"remote","add","origin","git@github.com:acme/main.git"],10000);
 const main=await resolveRepo(ctx,repo),wt=join(tmpDir(),"linked");
 expect((await realRun(["git","-C",repo,"worktree","add","-b","deleted",wt],10000)).code).toBe(0);
 expect(await resolveRepo(ctx,join(wt,"."))).toEqual(main);
 rmSync(wt,{recursive:true});
 const offline={...ctx,run:async()=>{throw Error("no git for deleted paths");}};
 expect(await resolveRepo(offline,wt)).toEqual(main);
 expect(repoFor(offline,join(wt,"src"))).toEqual(main);
 expect(listRepos(ctx)).toEqual([main]);
 expect(Object.keys(await Bun.file(join(ctx.pacerHome,"state","repos.json")).json())).toEqual([realpathSync(repo)]);
});

test("missing unknown paths never create registry entries during resolution or backfill",async()=>{
 const ctx=fakeCtx({run:realRun}),folder=tmpDir();rmSync(folder,{recursive:true});
 expect(await resolveRepo(ctx,folder)).toEqual(repoFor(ctx,folder));
 await backfillRepos(ctx,[folder]);
 expect(listRepos(ctx)).toEqual([]);
 expect(await Bun.file(join(ctx.pacerHome,"state","repos.json")).exists()).toBe(false);
});

test("unresolved paths fall back without recording or pruning the registry",async()=>{
 for(const mode of ["missing","non-git","git-fails"]){
  const ctx=fakeCtx({run:realRun}),registered=gitRepo();
  await resolveRepo(ctx,registered);
  rmSync(registered,{recursive:true});
  const registryFile=Bun.file(join(ctx.pacerHome,"state","repos.json")),before=await registryFile.text();
  const folder=mode==="git-fails"?gitRepo():tmpDir();
  if(mode==="missing")rmSync(folder,{recursive:true});
  if(mode==="git-fails")ctx.run=async()=>{throw Error("git unavailable");};
  const ref=await resolveRepoInput(ctx,folder);
  expect(ref).toEqual(repoFor(ctx,folder));
  expect(ref.key).toMatch(/^local:[0-9a-f]{12}$/);
  expect(await registryFile.text()).toBe(before);
 }
});

test("deleted local folders disappear and registry cleanup is throttled to once a minute",async()=>{
 const ctx=fakeCtx({run:realRun}),folder=gitRepo(),ref=await resolveRepo(ctx,folder);
 expect(ref.key).toMatch(/^local:/);
 rmSync(folder,{recursive:true});await refreshPath(cachedPath(folder).real);
 expect(listRepos(ctx)).toEqual([]);
 const registryFile=Bun.file(join(ctx.pacerHome,"state","repos.json"));
 expect(await registryFile.json()).toEqual({});
 const other=gitRepo();await resolveRepo(ctx,other);rmSync(other,{recursive:true});await refreshPath(cachedPath(other).real);
 expect(listRepos({...ctx,now:ctx.now+59})).toEqual([]);
 expect(Object.keys(await registryFile.json())).toHaveLength(1);
 expect(listRepos({...ctx,now:ctx.now+60})).toEqual([]);
 expect(await registryFile.json()).toEqual({});
});

test("missing repo registrations stay for running or recently settled tasks",async()=>{
 const {createTask,updateTask}=await import("../src/tasks/store");
 for(const state of ["running","done"] as const){
  const ctx=fakeCtx({run:realRun}),folder=gitRepo(),ref=await resolveRepo(ctx,folder);
  const task=createTask(ctx,{brief:{repo:folder,goal:"retain repo"},kind:null,requestedExecutor:null,timeoutS:60});
  updateTask(ctx,task.id,t=>{t.state=state;});rmSync(folder,{recursive:true});await refreshPath(cachedPath(folder).real);
  expect(listRepos(ctx)).toEqual([ref]);
  expect(Object.keys(await Bun.file(join(ctx.pacerHome,"state","repos.json")).json())).toHaveLength(1);
  expect(listRepos({...ctx,now:ctx.now+86401})).toEqual(state==="running"?[ref]:[]);
 }
});

test("linked checkout identity does not require a successful git status",async()=>{
 const repo=gitRepo(),wt=join(tmpDir(),"linked"),ctx=fakeCtx({run:realRun});
 const main=await resolveRepo(ctx,repo);
 expect((await realRun(["git","-C",repo,"worktree","add","-b","status-fails",wt],10000)).code).toBe(0);
 const run:typeof realRun=(args,...rest)=>args.includes("status")?Promise.resolve({code:1,stdout:"",stderr:"cannot inspect"}):realRun(args,...rest);
 expect(await resolveRepo({...ctx,run},wt)).toEqual(main);
});
