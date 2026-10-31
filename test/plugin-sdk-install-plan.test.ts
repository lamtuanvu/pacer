import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InstallPlan, InstallError, type PlanIO } from "../packages/plugin-sdk/src/install/plan";
import { upsertBlock } from "../packages/plugin-sdk/src/install/blocks";
import { sha256 } from "../packages/plugin-sdk/src/install/helpers";
import { Txn } from "../src/install/txn";
import type { PlannerRecord, UndoOp } from "../packages/plugin-sdk/src/install/undo";
import { fakeCtx } from "./helpers";
const now = 1700000000, block: UndoOp[] = [{ kind: "block", style: "md" }];
function memory(initial: Record<string, { text: string; mode: number }> = {}, signal?: AbortSignal) {
  const files = new Map(Object.entries(initial)), reads: string[] = [];
  const io: PlanIO = { signal, read: async path => { reads.push(path); return files.get(path) ?? null; } };
  return { files, reads, io, plan: new InstallPlan(io, { now, pacerArgv: ["pacer"] }, "codex") };
}
test("async staging matches current host pending bytes, modes, metadata and records", async () => {
  const ctx = fakeCtx(), path = join(ctx.home, "AGENTS.md"), legacy = join(ctx.home, "legacy.sh");
  writeFileSync(path, "mine\n", { mode: 0o600 }); writeFileSync(legacy, "legacy\n", { mode: 0o700 });
  const io: PlanIO = { read: async file => {
    try { return { text: readFileSync(file, "utf8"), mode: statSync(file).mode }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  } };
  const env = { now: ctx.now, pacerArgv: ["pacer"], mcp: true, plannerAccount: "account", folder: ctx.home, configEnv: { CODEX_HOME: ctx.home } };
  const sdk = new InstallPlan(io, env, "codex"), host = new Txn({ ...env, ctx }, "codex");
  for (const body of ["one", "two"]) {
    expect(await sdk.edit(path, old => upsertBlock(old!, body, "md"), block)).toBe(host.edit(path, old => upsertBlock(old!, body, "md"), block));
  }
  await sdk.moveAside(legacy); host.moveAside(legacy);
  await sdk.moveAside(legacy); host.moveAside(legacy);
  const created = join(ctx.home, "new");
  await sdk.edit(created, () => "new\n", []); host.edit(created, () => "new\n", []);
  expect(sdk.record).toEqual(host.record);
  expect([...sdk.pending]).toEqual([...host.pending]);
  expect(sdk.touched).toEqual(host.touched); expect(sdk.notes).toEqual(host.notes);
  expect(readFileSync(path, "utf8")).toBe("mine\n"); expect(readFileSync(legacy, "utf8")).toBe("legacy\n");
});
test("backup collisions are probed asynchronously and pending reservations cannot overwrite each other", async () => {
  const f = memory({ "/a/same": { text: "a", mode: 0o755 }, "/b/same": { text: "b", mode: 0o600 } });
  await f.plan.edit("/a/same", () => "new-a", [], "/backup");
  await f.plan.edit("/b/same", () => "new-b", [], "/backup");
  const first = f.plan.record.files[0]!.backup!, second = f.plan.record.files[1]!.backup!;
  expect(second).toBe(first + "-2");
  expect(f.plan.pending.get(first)).toEqual({ path: first, before: null, after: "a", mode: 0o700 });
  expect(f.plan.pending.get(second)).toEqual({ path: second, before: null, after: "b", mode: 0o600 });
  expect(f.files.size).toBe(2);
  const occupied = memory({ "/file": { text: "old", mode: 0o600 }, [first.replace("/backup/same", "/file")]: { text: "occupied", mode: 0o600 } });
  await occupied.plan.moveAside("/file");
  expect(occupied.plan.record.files[0]!.backup).toEndWith("-2");
});
test("only null means missing, IO errors propagate and no-op unowned edit stages nothing", async () => {
  const f = memory({ "/empty": { text: "", mode: 0o600 } });
  expect(await f.plan.read("/missing")).toBeNull(); expect(await f.plan.read("/empty")).toBe("");
  expect(await f.plan.edit("/empty", old => old!, [])).toBe(false); expect(f.plan.pending.size).toBe(0);
  const error = Error("owned unreadable fixture");
  const plan = new InstallPlan({ read: async () => { throw error; } }, { now, pacerArgv: ["pacer"] }, "codex");
  await expect(plan.read("/unreadable")).rejects.toBe(error);
  await expect(plan.edit("/unreadable", () => "new", [])).rejects.toBe(error);
  expect(plan.pending.size).toBe(0);
});
test("prior user edits mark exact false, retain original backup and include unchanged owned asset", async () => {
  const prior: PlannerRecord = { planner: "codex", installedAt: 1, pacerArgv: ["old"], files: [{ path: "/file", action: "edited", backup: "/original-backup", exact: true, undo: block, afterHash: sha256("original") }], commands: [], notes: [] };
  const before = JSON.stringify(prior), f = memory({ "/file": { text: "user-edited", mode: 0o700 } });
  const plan = new InstallPlan(f.io, { now, pacerArgv: ["new"] }, "codex", prior);
  expect(await plan.edit("/file", old => old!, [])).toBe(false);
  expect(plan.record.files[0]).toMatchObject({ exact: false, backup: "/original-backup", afterHash: sha256("user-edited") });
  expect(plan.pending.get("/file")).toMatchObject({ before: "user-edited", after: "user-edited", beforeMode: 0o700 });
  expect(plan.touched).toEqual([]); expect(plan.record.installedAt).toBe(1); expect(JSON.stringify(prior)).toBe(before);
});
test("re-edits preserve the first external conflict precondition and serialize concurrent changes", async () => {
  const f = memory({ "/file": { text: "before", mode: 0o700 } });
  await Promise.all([f.plan.edit("/file", old => old + "-one", []), f.plan.edit("/file", old => old + "-two", [])]);
  f.files.set("/file", { text: "external", mode: 0o600 });
  expect(await f.plan.read("/file")).toBe("before-one-two");
  expect(f.plan.pending.get("/file")).toMatchObject({ before: "before", after: "before-one-two", beforeMode: 0o700 });
  expect(f.plan.record.files).toHaveLength(1); expect(f.plan.touched).toEqual(["/file"]);
});
test("reconcile skips moves without reading and preserves prior mcp metadata", async () => {
  const f = memory(), prior: PlannerRecord = { planner: "codex", installedAt: 1, pacerArgv: [], mcp: true, files: [], commands: [], notes: [] };
  const plan = new InstallPlan(f.io, { now, pacerArgv: ["pacer"], mode: "reconcile", mcp: false }, "codex", prior);
  await plan.moveAside("/legacy"); expect(f.reads).toEqual([]); expect(plan.record.mcp).toBe(true);
});
test("callback failure is InstallError and a moved file cannot be edited", async () => {
  const f = memory({ "/file": { text: "old", mode: 0o700 } });
  await expect(f.plan.edit("/broken", () => { throw Error("bad JSON"); }, [])).rejects.toBeInstanceOf(InstallError);
  await f.plan.moveAside("/file");
  await expect(f.plan.edit("/file", () => "new", [])).rejects.toThrow("already moved aside");
  expect(f.files.get("/file")!.text).toBe("old");
});
test("cancellation after async read or backup probe cannot publish staging", async () => {
  for (const abortOn of [1, 2]) {
    const controller = new AbortController(); let reads = 0;
    const plan = new InstallPlan({ signal: controller.signal, read: async () => {
      reads++; if (reads === abortOn) controller.abort();
      return reads === 1 ? { text: "old", mode: 0o700 } : null;
    } }, { now, pacerArgv: ["pacer"] }, "codex");
    await expect(plan.edit("/file", () => "new", [])).rejects.toThrow("cancelled");
    expect(plan.pending.size).toBe(0); expect(plan.record.files).toEqual([]);
  }
});

test("invalid IO result cannot silently become a missing file", async () => {
  const plan = new InstallPlan({ read: async () => undefined as never }, { now, pacerArgv: ["pacer"] }, "codex");
  await expect(plan.read("/file")).rejects.toThrow("invalid installation file image");
  expect(plan.pending.size).toBe(0);
});
test("captured file mode cannot change while awaiting backup occupancy", async () => {
  const image = { text: "before", mode: 0o700 };
  const plan = new InstallPlan({ read: async path => {
    if (path === "/file") return image;
    image.mode = 0o600;
    return null;
  } }, { now, pacerArgv: ["pacer"] }, "codex");
  await plan.edit("/file", () => "after", []);
  expect(plan.pending.get("/file")!.beforeMode).toBe(0o700);
  expect(plan.pending.get(plan.record.files[0]!.backup!)!.mode).toBe(0o700);
});
