import { expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type ProviderCfg, validateStrategy } from "../src/config/strategy";
import { orcaAgentFor } from "../src/exec/orca/agents";
import { OrcaClient } from "../src/exec/orca/client";
import { COORDINATOR_TITLE, RUN_OBJECTIVE, ensureCoordinator, ensureRepo, gitInfo } from "../src/exec/orca/setup";
import { loadOrcaState, updateOrcaState } from "../src/exec/orca/state";
import { fakeCtx, tmpDir } from "./helpers";
import { fail, fakeRun, ok, raw } from "./fixtures/orca/fake";

const O = (...a: string[]) => ["orca", ...a];
const COORD = "term_1ddadcbd-780e-4951-b184-c51193ff39c6";
const RUN = "run_9d54b4f3810a";
const MR = "~/pacer";
const REPO_ID = "40c98aad-c083-4ec9-b82e-a51798a20270";

const s = validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {}, codex: {}, cursor: { model: "auto" }, agy: {},
    byteplus: { via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota", quota_source: "arkcli" },
  },
}, "/x");

test("orcaAgentFor maps providers to Orca agent ids", () => {
  expect(orcaAgentFor(s.providers.codex, "new-child")).toEqual({ agent: "codex", model: null });
  expect(orcaAgentFor(s.providers.cursor, "new-child")).toEqual({ agent: "cursor", model: "auto" });
  expect(orcaAgentFor(s.providers["claude-code"], "new-child")).toEqual({ agent: "claude", model: null });
  expect(orcaAgentFor(s.providers.agy, "current")).toEqual({ agent: "antigravity", model: null });
  expect(orcaAgentFor(s.providers["opencode#byteplus"], "current")).toEqual({ agent: "opencode", model: "coding-plan/dola-seed-2.0-code" });
  const skip = orcaAgentFor(s.providers["opencode#byteplus"], "new-child");
  expect("skip" in skip && skip.skip).toContain("existing worktree");
  const mystery: ProviderCfg = { ...s.providers.codex, id: "mystery" };
  expect(orcaAgentFor(mystery, "new-child")).toEqual({ skip: 'no Orca agent for provider "mystery"' });
});

test("gitInfo reads the top level, branch and dirtiness", async () => {
  const f = fakeRun([
    [["git", "-C", "/work/app", "rev-parse"], raw("/work/app\nmain\n")],
    [["git", "-C", "/work/app", "status"], raw(" M src/a.ts\n")],
  ]);
  expect(await gitInfo(f.run, "/work/app")).toEqual({ top: "/work/app", branch: "main", sub: "", main:"/work/app",linked:false, dirty: true });
  expect(f.calls).toEqual([
    ["git", "-C", "/work/app", "rev-parse", "--path-format=absolute", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"],
    ["git", "-C", "/work/app", "status", "--porcelain"],
  ]);
});

test("gitInfo: a repo subdirectory is reported as sub", async () => {
  const top = realpathSync(tmpDir());
  mkdirSync(join(top, "pkg"));
  const f = fakeRun([
    [["git", "-C", join(top, "pkg"), "rev-parse"], raw(`${top}\nfeature/x\n`)],
    [["git", "-C", top, "status"], raw("")],
  ]);
  expect(await gitInfo(f.run, join(top, "pkg"))).toEqual({ top, branch: "feature/x", sub: "pkg", main:top,linked:false, dirty: false });
});

test("gitInfo: not a git repository is an error", async () => {
  const f = fakeRun([[ ["git"], raw("", 128, "fatal: not a git repository (or any of the parent directories): .git\n") ]]);
  const r = await gitInfo(f.run, "/tmp/plain");
  expect("error" in r && r.error).toContain("/tmp/plain is not a git repository");
  expect("error" in r && r.error).toContain("fatal: not a git repository");
});

test("ensureRepo finds a registered repo, adds a new one, reports list errors", async () => {
  const f = fakeRun([[O("repo", "list"), ok("repo-list.json")], [O("repo", "add"), ok("repo-add.json")]]);
  const c = new OrcaClient(f.run);
  expect(await ensureRepo(c, MR)).toBe(REPO_ID);
  expect(f.count(O("repo", "add"))).toBe(0);
  expect(await ensureRepo(c, "/work/app", {registerRepos:true})).toBe(REPO_ID);
  expect(f.calls.at(-1)).toEqual(["orca", "repo", "add", "--path", "/work/app", "--json"]);
  const broken = new OrcaClient(fakeRun([[O("repo", "list"), raw("", 127)]]).run);
  const r = await ensureRepo(broken, MR);
  expect(typeof r === "object" && r.error).toContain("orca repo list failed: not_installed");
});

test("ensureCoordinator creates a terminal and a run on first use and persists both", async () => {
  const f = fakeRun([
    [O("terminal", "create"), ok("coordinator-terminal.json")],
    [O("orchestration", "run-create"), ok("run-create.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  expect(await ensureCoordinator(ctx, new OrcaClient(f.run), "/work/app")).toEqual({ coordinator: COORD, run: RUN });
  expect(f.calls).toEqual([
    ["orca", "terminal", "create", "--worktree", "path:/work/app", "--title", COORDINATOR_TITLE, "--json"],
    ["orca", "orchestration", "run-create", "--objective", RUN_OBJECTIVE, "--from", COORD, "--json"],
  ]);
  expect(loadOrcaState(ctx)).toMatchObject({ coordinator: COORD, run: RUN });
});

test("a live coordinator and its run are reused", async () => {
  const f = fakeRun([
    [O("terminal", "show"), ok("terminal-show-live.json")],
    [O("orchestration", "run-show"), ok("run-show.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  updateOrcaState(ctx, (st) => { st.coordinator = COORD; st.run = RUN; });
  expect(await ensureCoordinator(ctx, new OrcaClient(f.run), MR)).toEqual({ coordinator: COORD, run: RUN });
  expect(f.calls.map((a) => a[2])).toEqual(["show", "run-show"]);
});

test("stale coordinator is recreated with a new run", async () => {
  const f = fakeRun([
    [O("terminal", "show"), fail("terminal-show-stale.json")],
    [O("terminal", "create"), ok("coordinator-terminal.json")],
    [O("orchestration", "run-create"), ok("run-create.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  updateOrcaState(ctx, (st) => { st.coordinator = "term_old"; st.run = "run_old"; });
  expect(await ensureCoordinator(ctx, new OrcaClient(f.run), MR)).toEqual({ coordinator: COORD, run: RUN });
  expect(f.count(O("orchestration", "run-show"))).toBe(0);
  expect(loadOrcaState(ctx)).toMatchObject({ coordinator: COORD, run: RUN });
});

for (const code of ["timeout", "runtime_unavailable", "runtime_error"]) {
  test(`coordinator terminal show ${code} returns an error without creating resources`, async () => {
    const f = fakeRun([
      [O("terminal", "show"), raw(JSON.stringify({ ok: false, error: { code, message: "terminal status unavailable" } }), 1)],
      [O("terminal", "create"), ok("coordinator-terminal.json")],
      [O("orchestration", "run-create"), ok("run-create.json")],
    ]);
    const ctx = fakeCtx({ run: f.run });
    updateOrcaState(ctx, (st) => { st.coordinator = COORD; st.run = RUN; });
    expect(await ensureCoordinator(ctx, new OrcaClient(f.run), MR)).toEqual({
      error: `orca terminal show failed: ${code} terminal status unavailable`,
    });
    expect(f.count(O("terminal", "create"))).toBe(0);
    expect(f.count(O("orchestration", "run-create"))).toBe(0);
    expect(f.count(O("orchestration", "run-show"))).toBe(0);
    expect(loadOrcaState(ctx)).toMatchObject({ coordinator: COORD, run: RUN });
  });
}

test("closed coordinator (connected: false) is recreated", async () => {
  const f = fakeRun([
    [O("terminal", "show"), ok("terminal-show-closed.json")],
    [O("terminal", "create"), ok("coordinator-terminal.json")],
    [O("orchestration", "run-create"), ok("run-create.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  updateOrcaState(ctx, (st) => { st.coordinator = COORD; st.run = RUN; });
  await ensureCoordinator(ctx, new OrcaClient(f.run), MR);
  expect(f.count(O("terminal", "create"))).toBe(1);
  expect(f.count(O("orchestration", "run-create"))).toBe(1);
});

test("a missing run is recreated for a live coordinator", async () => {
  const f = fakeRun([
    [O("terminal", "show"), ok("terminal-show-live.json")],
    [O("orchestration", "run-show"), fail("run-show-missing.json")],
    [O("orchestration", "run-create"), ok("run-create.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  updateOrcaState(ctx, (st) => { st.coordinator = COORD; st.run = "run_000000000000"; });
  expect(await ensureCoordinator(ctx, new OrcaClient(f.run), MR)).toEqual({ coordinator: COORD, run: RUN });
  expect(f.count(O("terminal", "create"))).toBe(0);
});

test("terminal create failure is an error and leaves no coordinator", async () => {
  const f = fakeRun([[O("terminal", "create"), raw('{"ok":false,"error":{"code":"runtime_error","message":"no worktree"}}', 1)]]);
  const ctx = fakeCtx({ run: f.run });
  const r = await ensureCoordinator(ctx, new OrcaClient(f.run), "/work/app");
  expect("error" in r && r.error).toBe("orca terminal create failed: runtime_error no worktree");
  expect(loadOrcaState(ctx).coordinator).toBeNull();
});

for(const persistent of [false,true]) test(`consumer_fenced recovery is bounded (persistent=${persistent})`,async()=>{
  const fenced=raw(JSON.stringify({ok:false,error:{code:"consumer_fenced",message:"This terminal is attested as term_X and cannot act as term_Y"}}),1);
  const fresh="term_fresh";
  const f=fakeRun([
    [O("terminal","show"),ok("terminal-show-live.json")],
    [O("terminal","create"),raw(JSON.stringify({ok:true,result:{terminal:{handle:fresh}}}))],
    [O("orchestration","run-create"),[fenced,persistent?fenced:ok("run-create.json")]],
  ]);
  const ctx=fakeCtx({run:f.run});updateOrcaState(ctx,s=>{s.coordinator=COORD;s.run=null;});
  const r=await ensureCoordinator(ctx,new OrcaClient(f.run),"/work/app");
  expect(f.count(O("orchestration","run-create"))).toBe(2);
  expect(f.count(O("terminal","create"))).toBe(1);
  expect(f.calls).toContainEqual(["orca","terminal","close","--terminal",COORD,"--json"]);
  expect(f.calls.filter(a=>a[2]==="run-create")[1]).toContain(fresh);
  if(persistent){expect("error" in r && r.error).toContain("consumer_fenced");expect(loadOrcaState(ctx).run).toBeNull();}
  else expect(r).toEqual({coordinator:fresh,run:RUN});
});

test("linked worktree resolves its main repository and never registers the worktree",async()=>{
 const f=fakeRun([[["git","-C","/work/child","rev-parse"],raw("/work/child\nfeature/task\n/projects/main/.git\n")],[["git","-C","/work/child","status"],raw("")],[O("repo","list"),raw(JSON.stringify({ok:true,result:{repos:[{id:"owner",path:"/projects/main"}]}}))]]);
 const info=await gitInfo(f.run,"/work/child");expect(info).toMatchObject({main:"/projects/main",linked:true,branch:"feature/task"});expect(await ensureRepo(new OrcaClient(f.run),"/work/child",{main:"/projects/main",linked:true,registerRepos:true})).toBe("owner");expect(f.count(O("repo","add"))).toBe(0);
});
test("worktree ownership receipt is used and registration requires explicit opt-in for a main repo",async()=>{
 const f=fakeRun([[O("repo","list"),raw('{"ok":true,"result":{"repos":[]}}')],[O("worktree","show"),raw('{"ok":true,"result":{"repo":{"id":"owner"},"worktree":{"path":"/work/child"}}}')]]);
 expect(await ensureRepo(new OrcaClient(f.run),"/work/child")).toBe("owner");expect(f.count(O("repo","add"))).toBe(0);
 const g=fakeRun([[O("repo","list"),raw('{"ok":true,"result":{"repos":[]}}')],[O("worktree","show"),raw('{"ok":false,"error":{"code":"not_found","message":"missing"}}')],[O("repo","add"),ok("repo-add.json")]]);
 expect(await ensureRepo(new OrcaClient(g.run),"/work/child",{linked:true,registerRepos:true})).toEqual({error:"repository is not an Orca project"});expect(await ensureRepo(new OrcaClient(g.run),"/projects/main")).toEqual({error:"repository is not an Orca project"});expect(g.count(O("repo","add"))).toBe(0);
});

 test("nested module asks git for absolute paths relative to the invocation directory", async()=>{
 const nested="/projects/main/packages/module";
 const f=fakeRun([[["git","-C",nested,"rev-parse"],argv=>argv.includes("--path-format=absolute")?raw("/projects/main\nmain\n/projects/main/.git\n"):raw("/projects/main\nmain\n../../.git\n")],[["git","-C","/projects/main","status"],raw("")]]);
 expect(await gitInfo(f.run,nested)).toMatchObject({top:"/projects/main",main:"/projects/main",linked:false,sub:"packages/module"});
 });
