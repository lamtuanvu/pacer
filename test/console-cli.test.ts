import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listStrategies, openConsoleArgv, resolveWorktreePath, runConsoleCli, selfHandle } from "../src/console/cli";
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
