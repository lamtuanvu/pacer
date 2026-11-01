import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, listActiveAndRecentTasks, listLiveTasks, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import { pruneTasks, restoreTask } from "../src/tasks/retention";

const binary = process.env.PACER_STORE_PROBE_BIN;
if (process.env.CI === "true" && (!binary || !existsSync(binary))) {
  throw Error("CI must build and supply PACER_STORE_PROBE_BIN");
}
const rust = (command: string, home: string, ...args: string[]) => {
  if (!binary) throw Error("PACER_STORE_PROBE_BIN required");
  const result = Bun.spawnSync([binary, command, home, ...args]);
  if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
};

test.skipIf(!binary || !existsSync(binary))("Rust adapter alternates with Bun across revisions, unknown fields, and JSON mtime", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "parity", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(ctx, task.id, t => { (t as typeof t & { futureField: unknown }).futureField = { nested: [1, 2] }; t.title = "0"; });
  const before = rust("read", ctx.pacerHome, task.id);
  expect(before).toEqual(readTask(ctx, task.id));
  for (let i = 1; i <= 4; i++) {
    if (i % 2) rust("increment", ctx.pacerHome, task.id);
    else updateTask(ctx, task.id, t => { t.title = String(Number(t.title) + 1); });
    const current = readTask(ctx, task.id)!;
    expect(current.rev).toBe(i + 2);
    expect(current.title).toBe(String(i));
    expect(rust("read", ctx.pacerHome, task.id)).toEqual(current);
    expect(rust("list", ctx.pacerHome)).toEqual([current]);
    expect(JSON.parse(readFileSync(join(ctx.pacerHome, "tasks", `${task.id}.json`), "utf8"))).toEqual(current);
    expect(taskDatabase(ctx).query<{ json_mtime: number }, [string]>("SELECT json_mtime FROM tasks WHERE id=?").get(task.id)?.json_mtime)
      .toBe(statSync(join(ctx.pacerHome, "tasks", `${task.id}.json`)).mtimeMs);
  }
});

test.skipIf(!binary || !existsSync(binary))("archive and restore cross the TS/Rust boundary without losing files", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "retention", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(ctx, task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
  const log = join(ctx.pacerHome, "tasks", `${task.id}.log`);
  writeFileSync(log, "artifact log\n");
  const later = ctx.now + 2 * 86400;
  expect(rust("prune", ctx.pacerHome, String(later))).toEqual([task.id]);
  expect(readTask(ctx, task.id)?.archived).toBe(true);
  expect(rust("read", ctx.pacerHome, task.id)).toEqual(readTask(ctx, task.id));
  const restored = await restoreTask({ ...ctx, now: later }, task.id);
  expect(restored.id).toBe(task.id);
  expect(readFileSync(log, "utf8")).toBe("artifact log\n");
  expect(rust("read", ctx.pacerHome, task.id)).toEqual(restored);

  const second = fakeCtx();
  const task2 = createTask(second, { brief: { goal: "retention", repo: second.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(second.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(second, task2.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: second.now }; });
  const log2 = join(second.pacerHome, "tasks", `${task2.id}.log`);
  writeFileSync(log2, "second log\n");
  const later2 = second.now + 2 * 86400;
  expect((await pruneTasks({ ...second, now: later2 }, { days: 1 })).tasks.map(t => t.id)).toEqual([task2.id]);
  const restored2 = rust("restore", second.pacerHome, task2.id, String(later2));
  expect(restored2).toEqual(readTask(second, task2.id));
  expect(readFileSync(log2, "utf8")).toBe("second log\n");
});

test.skipIf(!binary || !existsSync(binary))("structured JSON imports have the same acceptance branches", () => {
  const ctx = fakeCtx();
  const template = createTask(ctx, { brief: { goal: "import", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  const variants: ((value: Record<string, unknown>) => void)[] = [
    value => { value.futureField = { nested: [1, 2] }; },
    value => { delete value.rev; },
    value => { value.rev = 0; },
    value => { value.rev = 1.5; },
    value => { value.createdAt = "bad"; },
    value => { value.attempts = null; },
    value => { value.attempts = [{ startedAt: 1, endedAt: "bad" }]; },
    value => { value.state = "unknown"; },
    value => { value.brief = { repo: null }; },
    value => { value.id = "wrong"; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const id = `t-20261101-191106-${index.toString(16).padStart(4, "0")}`;
    const value = structuredClone(template) as unknown as Record<string, unknown>;
    value.id = id;
    mutate(value);
    const tmp = join(ctx.pacerHome, "tasks", `${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, join(ctx.pacerHome, "tasks", `${id}.json`));
    expect(rust("read", ctx.pacerHome, id)).toEqual(readTask(ctx, id));
  }
});

test.skipIf(!binary || !existsSync(binary))("concurrent Bun and Rust writes preserve every revision", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "concurrent", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(ctx, task.id, t => { t.title = "0"; t.live = { backend: "test", worker: "w", terminal: "term", executor: "test", agent: "test", since: ctx.now }; });
  const children = Array.from({ length: 4 }, () => Bun.spawn([binary!, "increment", ctx.pacerHome, task.id], { stdout: "pipe", stderr: "pipe" }));
  for (let i = 0; i < 4; i++) updateTask(ctx, task.id, t => { t.title = String(Number(t.title) + 1); });
  for (const child of children) {
    expect(await child.exited).toBe(0);
  }
  const final = readTask(ctx, task.id)!;
  expect(final.rev).toBe(10);
  expect(final.title).toBe("8");
  expect(rust("read", ctx.pacerHome, task.id)).toEqual(final);
  expect(rust("list-recent", ctx.pacerHome, String(ctx.now + 100))).toEqual(listActiveAndRecentTasks(ctx, ctx.now + 100));
  expect(rust("list-live", ctx.pacerHome)).toEqual(listLiveTasks(ctx));
});
