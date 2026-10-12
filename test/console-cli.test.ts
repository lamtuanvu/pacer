import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listStrategies, openConsoleArgv, resolveWorktreePath, runConsoleCli, selfHandle } from "../src/console/cli";
import { consolePath } from "../src/link/paths";
import { fakeCtx } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";

const receipt = readFileSync(join(import.meta.dir, "fixtures/link/terminal-create.json"), "utf8");
test("open creates console terminal with exact argv and recorded handle", async () => {
  const f = fakeRun([[ ["orca", "terminal", "create"], raw(receipt) ]]);
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer" }, run: f.run });
  const argv = ["orca", "terminal", "create", "--worktree", "active", "--title", "pacer console", "--command", "/opt/pacer console", "--json"];
  expect(openConsoleArgv(ctx, "active")).toEqual(argv);
  const r = await runConsoleCli(["--open"], ctx);
  expect(f.calls).toEqual([argv]); expect(f.timeouts).toEqual([30000]); expect(r.code).toBe(0);
  expect(r.out).toContain("term_1ddadcbd-780e-4951-b184-c51193ff39c6");
});
test("open forwards worktree selection", async () => {
  const f = fakeRun([[ ["orca", "terminal", "create"], raw(receipt) ]]);
  await runConsoleCli(["--open", "--worktree", "branch:feat-x"], fakeCtx({ run: f.run }));
  expect(f.calls[0].slice(3, 5)).toEqual(["--worktree", "branch:feat-x"]);
});
for (const response of [raw("", 1, "Orca down"), raw('{"ok":false,"error":{"message":"not ready"}}')]) {
  test(`open failure provides fallback (${response.code})`, async () => {
    const f = fakeRun([[ ["orca", "terminal", "create"], response ]]);
    const r = await runConsoleCli(["--open"], fakeCtx({ run: f.run }));
    expect(r.code).toBe(1); expect(r.err).toContain("could not open the console in Orca"); expect(r.err).toContain("run `pacer console` in any terminal");
  });
}
test("selfHandle matches pane key against terminal list", async () => {
  const f = fakeRun([[ ["orca", "terminal", "list", "--json"], raw(JSON.stringify({ ok: true, result: { terminals: [{ handle: "wrong", tabId: "T", leafId: "other" }, { handle: "term_x", tabId: "T", leafId: "L" }] } })) ]]);
  expect(await selfHandle(fakeCtx({ env: { ORCA_PANE_KEY: "T:L" }, run: f.run }))).toEqual({ handle: "term_x", paneKey: "T:L" });
});
test("selfHandle outside Orca makes no CLI calls", async () => {
  const f = fakeRun([]); expect(await selfHandle(fakeCtx({ run: f.run }))).toEqual({ handle: null, paneKey: null }); expect(f.calls).toEqual([]);
});
test("selfHandle list failure keeps pane key but has no handle", async () => {
  const f = fakeRun([[ ["orca", "terminal", "list"], raw("", 1) ]]);
  expect(await selfHandle(fakeCtx({ env: { ORCA_PANE_KEY: "T:L" }, run: f.run }))).toEqual({ handle: null, paneKey: "T:L" });
});
test("resolveWorktreePath reads result.worktree.path", async () => {
  const f = fakeRun([[ ["orca", "worktree", "show", "--worktree", "branch:feat-x", "--json"], raw('{"ok":true,"result":{"worktree":{"path":"/wt/feat-x"}}}') ]]);
  expect(await resolveWorktreePath(fakeCtx({ run: f.run }), "feat-x")).toBe("/wt/feat-x");
});
test("resolveWorktreePath failure returns null", async () => {
  const f = fakeRun([[ ["orca", "worktree", "show"], raw("", 1) ]]); expect(await resolveWorktreePath(fakeCtx({ run: f.run }), "missing")).toBeNull();
});
test("listStrategies includes default and sorts YAML basenames", () => {
  const ctx = fakeCtx(), dir = join(ctx.pacerHome, "strategies");
  expect(listStrategies(ctx)).toEqual(["default"]);
  mkdirSync(dir, { recursive: true });
  for (const name of ["z.yaml", "a.yaml", "ignore.yml", "ignore.txt", "default.yaml"]) writeFileSync(join(dir, name), "");
  expect(listStrategies(ctx)).toEqual(["default", "a", "z"]);
});
test("invalid console arguments return usage without opening stdin", async () => {
  expect((await runConsoleCli(["--worktree"], fakeCtx())).code).toBe(2);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`console removes heartbeat and exits on ${signal}`, async () => {
  const ctx = fakeCtx();
  const child = Bun.spawn([process.execPath, join(import.meta.dir,"../src/cli.ts"), "console"], {
    env: {PATH:process.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_ORCA_USER_DATA:join(ctx.home,"orca")},
    stdin:"pipe",stdout:"ignore",stderr:"pipe",
  });
  try {
    const deadline=Date.now()+2000;
    while(!existsSync(consolePath(ctx)) && Date.now()<deadline)await Bun.sleep(5);
    expect(existsSync(consolePath(ctx))).toBe(true);
    child.kill(signal);
    await child.exited;
    expect(existsSync(consolePath(ctx))).toBe(false);
    expect(child.exitCode).toBe(signal==="SIGINT"?130:143);
  } finally {if(child.exitCode===null)child.kill("SIGKILL");child.stdin.end();}
});

test("resolveWorktreePath prefers argv id selector over ambiguous branch", async () => {
 const id="wt-1;$(echo unsafe)";
 const f=fakeRun([[["orca","worktree","show","--worktree",`id:${id}`,"--json"],raw('{"ok":true,"result":{"worktree":{"path":"/wt/id"}}}')]]);
 expect(await resolveWorktreePath(fakeCtx({run:f.run}),"shared",id)).toBe("/wt/id");
 expect(f.calls).toEqual([["orca","worktree","show","--worktree",`id:${id}`,"--json"]]);
});
test("resolveWorktreePath falls back to branch after id lookup fails", async () => {
 const f=fakeRun([[["orca","worktree","show","--worktree","id:missing"],raw("",1)],[["orca","worktree","show","--worktree","branch:shared"],raw('{"ok":true,"result":{"worktree":{"path":"/wt/branch"}}}')]]);
 expect(await resolveWorktreePath(fakeCtx({run:f.run}),"shared","missing")).toBe("/wt/branch");
 expect(f.calls).toEqual([["orca","worktree","show","--worktree","id:missing","--json"],["orca","worktree","show","--worktree","branch:shared","--json"]]);
});

test("auto-created console registers exported handle and unregisters on exit",async()=>{
 const ctx=fakeCtx();
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),"console"],{
  env:{PATH:process.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,ORCA_TERMINAL_HANDLE:"term_autocreated",PACER_ORCA_USER_DATA:join(ctx.home,"orca")},stdin:"pipe",stdout:"ignore",stderr:"pipe",
 });
 try{
  const path=join(ctx.pacerHome,"link/consoles/term_autocreated.json");const deadline=Date.now()+2000;
  while(!existsSync(path)&&Date.now()<deadline)await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);expect(JSON.parse(readFileSync(path,"utf8")).handle).toBe("term_autocreated");
  child.stdin.end();await child.exited;expect(child.exitCode).toBe(0);expect(existsSync(path)).toBe(false);
 }finally{if(child.exitCode===null)child.kill("SIGKILL");}
});
test("console identity prefers exported worktree id over terminal-list metadata",async()=>{
 const f=fakeRun([[["orca","terminal","list"],raw(JSON.stringify({ok:true,result:{terminals:[{handle:"term_x",tabId:"T",leafId:"L",worktreeId:"wrong"}]}}))]]);
 expect(await selfHandle(fakeCtx({env:{ORCA_PANE_KEY:"T:L",ORCA_WORKTREE_ID:"wt-own"},run:f.run}))).toEqual({handle:"term_x",paneKey:"T:L",worktreeId:"wt-own"});
});
