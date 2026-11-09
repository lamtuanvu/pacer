import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, listActiveAndRecentTasks, listLiveTasks, listTasksWhere, readTask, taskDatabase, tasksDir, taskStoreVersion, updateTask } from "../src/tasks/store";
import { eligibleForRetention, pruneTasks, restoreTask } from "../src/tasks/retention";

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

test.skipIf(!binary || !existsSync(binary))("Rust TaskStore and TS independently import the numeric field matrix", () => {
  const tokens = ["1", "2.0", "2e0", "1.25", "0.99999999999999999", "1.0000000000000001", "0", "-0", "-1", "9007199254740991",
    "9007199254740991.0", "9007199254740992", "9007199254740993", "9007199254740990.5",
    "1e308", "1.7976931348623157e308", "1e309", "-1e309", "5e-324", "1e-324", "1e-400", "null", "true", '"2"', "[]", "{}", "MISSING"];
  for (const field of ["rev", "createdAt", "startedAt", "endedAt"] as const) {
    const native = fakeCtx(), reference = fakeCtx();
    for (const ctx of [native, reference]) {
      mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
      writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
    }
    for (const [index, token] of tokens.entries()) {
      const label = `${field}=${token}`;
      const id = `t-20261102-155652-${index.toString(16).padStart(4, "0")}`;
      const task = { id, rev: 2, state: "done", createdAt: 1000, brief: { repo: "repo" }, attempts: [{ startedAt: 1, endedAt: 2 }] };
      const target = field === "startedAt" || field === "endedAt" ? task.attempts[0]! : task;
      if (token === "MISSING") delete (target as Record<string, unknown>)[field];
      else (target as Record<string, unknown>)[field] = "NUMBER_TOKEN";
      const bytes = JSON.stringify(task).replace('"NUMBER_TOKEN"', token);
      for (const ctx of [native, reference]) {
        const temp = join(ctx.pacerHome, "tasks", "record.tmp");
        writeFileSync(temp, bytes);
        renameSync(temp, join(ctx.pacerHome, "tasks", `${id}.json`));
      }
      // Distinct homes: TS must never import on behalf of Rust.
      const actual = rust("read", native.pacerHome, id);
      const expected = readTask(reference, id);
      expect(actual, label).toEqual(expected);
      // SQLite may need to recreate WAL/SHM after the probe closes its last handle.
      // This raw SQL connection performs no compatibility imports.
      const db = new Database(join(native.pacerHome, "state/tasks.db"));
      try {
        const row = db.query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id=?").get(id);
        expect(row ? JSON.parse(row.record) : null, `${label} persisted`).toEqual(expected);
      } finally { db.close(); }
      // Pin acceptance independently too: both implementations rejecting is not parity.
      const value = token === "MISSING" ? undefined : JSON.parse(token);
      const accepted = field === "rev"
        ? value == null || (Number.isSafeInteger(value) && value >= 1)
        : Number.isFinite(value);
      expect(expected !== null, `${label} accepted`).toBe(accepted);
    }
  }
});

test.skipIf(!binary || !existsSync(binary))("no-op update leaves rev unchanged in both runtimes", () => {
  const rustCtx = fakeCtx();
  const rustTask = createTask(rustCtx, { brief: { goal: "rust no-op", repo: rustCtx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(rustCtx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  const rustFile = join(tasksDir(rustCtx), `${rustTask.id}.json`);
  const rustMtimeBefore = statSync(rustFile).mtimeMs;
  const rustVersionBefore = taskStoreVersion(rustCtx);
  const rustResult = rust("noop-update", rustCtx.pacerHome, rustTask.id);
  expect(rustResult.rev).toBe(rustTask.rev);
  expect(statSync(rustFile).mtimeMs).toBe(rustMtimeBefore);
  expect(taskStoreVersion(rustCtx)).toBe(rustVersionBefore);
  expect(readTask(rustCtx, rustTask.id)).toEqual(rustTask);

  const tsCtx = fakeCtx();
  const tsTask = createTask(tsCtx, { brief: { goal: "ts no-op", repo: tsCtx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(tsCtx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  const tsFile = join(tasksDir(tsCtx), `${tsTask.id}.json`);
  const tsMtimeBefore = statSync(tsFile).mtimeMs;
  const tsVersionBefore = taskStoreVersion(tsCtx);
  const tsResult = updateTask(tsCtx, tsTask.id, t => { t.state = t.state; });
  expect(tsResult.rev).toBe(tsTask.rev);
  expect(statSync(tsFile).mtimeMs).toBe(tsMtimeBefore);
  expect(taskStoreVersion(tsCtx)).toBe(tsVersionBefore);
  // Independently confirm the Rust reader agrees nothing changed.
  expect(rust("read", tsCtx.pacerHome, tsTask.id)).toEqual(readTask(tsCtx, tsTask.id));
});

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

test.skipIf(!binary || !existsSync(binary))("review false never authorizes retention in either runtime", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "retention gate", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(ctx, task.id, t => { t.state = "done"; (t as unknown as Record<string, unknown>).review = false; });
  const later = ctx.now + 2 * 86400;
  expect((await pruneTasks({ ...ctx, now: later }, { days: 1, dryRun: true })).tasks).toEqual([]);
  expect(rust("prune-dry", ctx.pacerHome, String(later)).tasks).toEqual([]);
  expect(rust("prune-result", ctx.pacerHome, String(later)).tasks).toEqual([]);
  expect(readTask(ctx, task.id)?.archived).toBeUndefined();
});

test.skipIf(!binary || !existsSync(binary))("seeded retention predicates agree for structured records", () => {
  let seed = 572;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const reviews: unknown[] = [undefined, null, false, true, 0, 1, "", "reviewed", {}, { at: 1 }];
  const dismissed: unknown[] = [undefined, false, true, 0, 1, "", "yes"];
  const states = ["queued", "running", "done", "partial", "failed", "limit", "stopped", "needs_input"] as const;
  for (let i = 0; i < 32; i++) {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "predicate parity", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
    const review = reviews[next() % reviews.length];
    const dismiss = dismissed[next() % dismissed.length];
    const state = states[next() % states.length]!;
    const archived = [undefined, false][next() % 2];
    const remote = [undefined, "", "/remote/worktree"][next() % 3];
    updateTask(ctx, task.id, t => {
      t.state = state;
      const value = t as unknown as Record<string, unknown>;
      value.review = review;
      value.dismissed = dismiss;
      value.archived = archived;
      t.run = { ...t.run, remoteWorktree: remote } as typeof t.run;
    });
    const later = ctx.now + (next() % 3 + 1) * 86400;
    const current = readTask(ctx, task.id)!;
    const expected = eligibleForRetention({ ...ctx, now: later }, current, 1);
    const actual = rust("prune-dry", ctx.pacerHome, String(later)).tasks.some((item: { id: string }) => item.id === task.id);
    expect(actual).toBe(expected);
  }
});

test.skipIf(!binary || !existsSync(binary))("archive gzip size and saved bytes agree for dry and real runs", async () => {
  const payloads = [
    Buffer.from("abcde12345\n".repeat(10000)),
    Buffer.alloc(0),
    Buffer.from("short log\n"),
    Buffer.from(Array.from({ length: 16384 }, (_, i) => (i * 73 + 19) & 255)),
    Buffer.from("🐟 archive\n".repeat(4096)),
  ];
  const bunSizes: number[] = [];
  for (const [index, payload] of payloads.entries()) for (const runtime of ["bun", "rust"] as const) {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "archive accounting", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
    updateTask(ctx, task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
    writeFileSync(join(ctx.pacerHome, "tasks", `${task.id}.log`), payload);
    const later = ctx.now + 2 * 86400;
    const actual = runtime === "bun"
      ? await pruneTasks({ ...ctx, now: later }, { days: 1, dryRun: true })
      : rust("prune-dry", ctx.pacerHome, String(later));
    expect(actual.tasks).toHaveLength(1);
    if (index === 0) expect(actual.tasks[0].bytesSaved).toBe(payload.length - 584);
    const real = runtime === "bun"
      ? await pruneTasks({ ...ctx, now: later }, { days: 1 })
      : rust("prune-result", ctx.pacerHome, String(later));
    expect(real.tasks[0].bytesSaved).toBe(actual.tasks[0].bytesSaved);
    expect(real.bytesSaved).toBe(actual.bytesSaved);
    const gzipSize = statSync(join(ctx.pacerHome, "archive", new Date(task.createdAt * 1000).toISOString().slice(0, 7), task.id, `${task.id}.log.gz`)).size;
    expect(actual.tasks[0].bytesSaved).toBe(payload.length - gzipSize);
    if (runtime === "bun") bunSizes[index] = gzipSize;
    else expect(gzipSize).toBe(bunSizes[index]);
    if (index === 0) expect(gzipSize).toBe(584);
  }
});

test.skipIf(!binary || !existsSync(binary))("archive artifact order is deterministic across runtimes", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "artifact order", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
  updateTask(ctx, task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
  for (const name of ["z.log", "a.md", "b.bundle", "y.log"]) writeFileSync(join(ctx.pacerHome, "tasks", `${task.id}.${name}`), name);
  const later = ctx.now + 2 * 86400;
  const bunFiles = (await pruneTasks({ ...ctx, now: later }, { days: 1, dryRun: true })).tasks[0]!.files;
  const rustFiles = rust("prune-dry", ctx.pacerHome, String(later)).tasks[0].files;
  expect(rustFiles).toEqual(bunFiles);
});

test.skipIf(!binary || !existsSync(binary))("Rust archive writers use private modes under either umask", () => {
  for (const mask of [0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const ctx = fakeCtx();
      mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
      chmodSync(join(ctx.pacerHome, "tasks"), 0o755);
      const task = createTask(ctx, { brief: { goal: "archive modes", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
      writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
      updateTask(ctx, task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
      const log = join(ctx.pacerHome, "tasks", `${task.id}.log`);
      writeFileSync(log, "mode check\n");
      const archiveRoot = join(ctx.pacerHome, "archive");
      const month = join(archiveRoot, new Date(task.createdAt * 1000).toISOString().slice(0, 7));
      mkdirSync(month, { recursive: true });
      chmodSync(archiveRoot, 0o755);
      chmodSync(month, 0o755);
      const later = ctx.now + 2 * 86400;
      rust("prune-result", ctx.pacerHome, String(later));
      for (const path of [archiveRoot, month, join(month, task.id)]) {
        expect(statSync(path).mode & 0o777).toBe(0o700);
      }
      for (const path of [join(month, task.id, `${task.id}.log.gz`), join(month, task.id, `${task.id}.json`)]) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      for (const path of [archiveRoot, month, join(month, task.id)]) chmodSync(path, 0o755);
      rust("increment", ctx.pacerHome, task.id);
      for (const path of [archiveRoot, month, join(month, task.id)]) {
        expect(statSync(path).mode & 0o777).toBe(0o700);
      }
      expect(statSync(join(month, task.id, `${task.id}.json`)).mode & 0o777).toBe(0o600);
      chmodSync(join(ctx.pacerHome, "tasks"), 0o755);
      rust("restore", ctx.pacerHome, task.id, String(later));
      expect(statSync(join(ctx.pacerHome, "tasks")).mode & 0o777).toBe(0o700);
      expect(statSync(join(ctx.pacerHome, "tasks", `${task.id}.json`)).mode & 0o777).toBe(0o600);
    } finally { process.umask(previous); }
  }
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
    value => { value.rev = Number.MAX_SAFE_INTEGER; },
    value => { value.rev = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.createdAt = 3.0; },
    value => { value.attempts = [{ startedAt: 3.0, endedAt: 4.0 }]; },
    value => { value.createdAt = "bad"; },
    value => { value.attempts = null; },
    value => { value.attempts = [{ startedAt: 1, endedAt: "bad" }]; },
    value => { value.state = "unknown"; },
    value => { value.brief = { repo: null }; },
    value => { value.id = "wrong"; },
    value => { value.archived = "yes"; },
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
    if (index === variants.length - 1) {
      expect(rust("list", ctx.pacerHome).some((entry: { id: string }) => entry.id === id))
        .toBe(listTasksWhere(ctx).some(entry => entry.id === id));
    }
  }
});

test.skipIf(!binary || !existsSync(binary))("JSON decimal and exponent revisions import as safe integers", () => {
  for (const [index, literal] of ["1.0", "1e0", "9007199254740991.0"].entries()) {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "numeric revision", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
    const id = `t-20261101-191106-${index.toString(16).padStart(4, "0")}`;
    const record = { ...task, id, rev: 1 };
    const text = JSON.stringify(record).replace('"rev":1', `"rev":${literal}`);
    expect(text).toContain(`"rev":${literal}`);
    writeFileSync(join(ctx.pacerHome, "tasks", `${id}.json`), text);
    expect(rust("read", ctx.pacerHome, id)).toEqual(readTask(ctx, id));
    if (index < 2) {
      expect(rust("increment", ctx.pacerHome, id).rev).toBe(2);
    }
  }
});

test.skipIf(!binary || !existsSync(binary))("restore accepts truthy legacy archived values in both runtimes", async () => {
  for (const archived of [1, "yes", [], {}]) for (const runtime of ["bun", "rust"] as const) {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "truthy archive", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    writeFileSync(join(ctx.pacerHome, ".sqlite-proof-home"), "disposable\n");
    updateTask(ctx, task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
    const log = join(ctx.pacerHome, "tasks", `${task.id}.log`);
    writeFileSync(log, "legacy archived\n");
    const later = ctx.now + 2 * 86400;
    rust("prune-result", ctx.pacerHome, String(later));
    updateTask(ctx, task.id, t => { (t as unknown as Record<string, unknown>).archived = archived; });
    const restored = runtime === "bun"
      ? await restoreTask({ ...ctx, now: later }, task.id)
      : rust("restore", ctx.pacerHome, task.id, String(later));
    expect(restored.archived).toBeUndefined();
    expect(readFileSync(log, "utf8")).toBe("legacy archived\n");
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
