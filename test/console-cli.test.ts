import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selfHandle, resolveWorktreePath } from "../src/console/cli";
import { consolePath } from "../src/link/paths";
import { fakeCtx } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";

const receipt = readFileSync(join(import.meta.dir, "fixtures/link/terminal-create.json"), "utf8");
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

test("console identity prefers exported worktree id over terminal-list metadata",async()=>{
 const f=fakeRun([[["orca","terminal","list"],raw(JSON.stringify({ok:true,result:{terminals:[{handle:"term_x",tabId:"T",leafId:"L",worktreeId:"wrong"}]}}))]]);
 expect(await selfHandle(fakeCtx({env:{ORCA_PANE_KEY:"T:L",ORCA_WORKTREE_ID:"wt-own"},run:f.run}))).toEqual({handle:"term_x",paneKey:"T:L",worktreeId:"wt-own"});
});

test("console discovery strips inherited Orca caller attestation", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({
    env: { PATH: "/bin", ORCA_PANE_KEY: "T:L", ORCA_AGENT_SESSION_ID: "foreign", ORCA_AGENT_SESSION_ID_ENV: "CUSTOM_SESSION", CUSTOM_SESSION: "foreign" },
    run: async (argv, _timeout, options) => {
      calls.push(argv);
      expect(options?.env).toEqual({ PATH: "/bin" });
      return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, result: argv[1] === "terminal"
        ? { terminals: [{ handle: "term_x", tabId: "T", leafId: "L" }] }
        : { worktree: { path: "/wt/project" } } }) };
    },
  });
  expect(await selfHandle(ctx)).toMatchObject({ handle: "term_x" });
  expect(await resolveWorktreePath(ctx, "project")).toBe("/wt/project");
  expect(calls.map(argv => argv.slice(0, 3))).toEqual([["orca", "terminal", "list"], ["orca", "worktree", "show"]]);
});
