import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { appendActivity, readActivity } from "../src/activity/log";
import { createTask, readTask } from "../src/tasks/store";
import { cachedMachineId, clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { rotateIdentity } from "../src/identity/rotate";
import type { Ctx } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const newTask = (ctx: Ctx) => createTask(ctx, { title: "t", brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
const lastActivity = (ctx: Ctx) => readActivity(ctx).entries[0]!;

test("activity entries and new tasks carry the machine id once an identity exists", async () => {
  const ctx = fakeCtx();
  const id = await ensureIdentity(ctx);
  appendActivity(ctx, { kind: "config", level: "info", text: "x" });
  expect(lastActivity(ctx).machineId).toBe(id.id);
  const task = newTask(ctx);
  expect(task.machineId).toBe(id.id);
  expect(readTask(ctx, task.id)!.machineId).toBe(id.id);
});

test("stamping never creates an identity", () => {
  const ctx = fakeCtx();
  appendActivity(ctx, { kind: "config", level: "info", text: "x" });
  expect(lastActivity(ctx).machineId).toBeUndefined();
  expect("machineId" in newTask(ctx)).toBe(false);
  expect(cachedMachineId(ctx)).toBeUndefined();
  expect(readActivity(ctx).entries).toHaveLength(1);
});

test("a cold cache reads the id from machine.json without touching the Keychain", async () => {
  let calls = 0;
  const store = new Map<string, string>();
  const ctx = fakeCtx({
    run: async (argv, _t, o) => {
      calls++;
      const m = /-a (\S+) -X ([0-9a-f]+)/.exec(o?.stdin ?? "");
      if (m) { store.set(m[1], m[2]); return { code: 0, stdout: "", stderr: "" }; }
      const v = store.get(argv[argv.indexOf("-a") + 1]);
      if (!v) return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: argv.includes("-w") ? v + "\n" : "", stderr: "" };
    },
  });
  const id = await ensureIdentity(ctx, { platform: "darwin" });
  clearIdentityCache();
  const before = calls;
  expect(cachedMachineId(ctx)).toBe(id.id);
  appendActivity(ctx, { kind: "config", level: "info", text: "x" });
  expect(lastActivity(ctx).machineId).toBe(id.id);
  expect(newTask(ctx).machineId).toBe(id.id);
  expect(calls).toBe(before);
});

test("after rotation new records carry the new id", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx);
  const { newId } = await rotateIdentity(ctx);
  clearIdentityCache();
  expect(cachedMachineId(ctx)).toBe(newId);
  expect(newTask(ctx).machineId).toBe(newId);
});
