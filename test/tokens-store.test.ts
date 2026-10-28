import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { dispatchDatabase } from "../src/dispatch/store";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { Attempt } from "../src/tasks/types";
import { backfillAttemptUsage, readAttemptUsage, recordAttemptUsage } from "../src/tokens/store";

const fixtures = join(import.meta.dir, "fixtures", "tokens");
const attempt = (executor: string, log: string): Attempt => ({ executor, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log });
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name), s = statSync(path);
    if (s.isFile() && !/tasks\.db/.test(name)) out[name] = `${s.mtimeMs}:${readFileSync(path, "utf8")}`;
  }
  return out;
}
function history() {
  const ctx = fakeCtx(), logs = join(ctx.pacerHome, "runs"); mkdirSync(logs, { recursive: true });
  const make = (executor: string, fixture: string | null) => {
    const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
    const log = join(logs, `${task.id}.${executor}.log`);
    if (fixture) copyFileSync(join(fixtures, fixture), log);
    updateTask(ctx, task.id, t => { t.state = "done"; t.attempts.push(attempt(executor, log)); });
    return task.id;
  };
  return { ctx, logs, make };
}

test("backfill fills partial, measured and unknown rows from existing logs", async () => {
  const { ctx, make } = history();
  const a = make("codex", "codex-complete.log"), b = make("claude-code", null), c = make("codex", null);
  const dir = join(ctx.pacerHome, "runs", b, "1"); mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/usage.jsonl", '{"type":"result","num_turns":3,"usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":5000,"cache_creation_input_tokens":800}}\n');
  expect(await backfillAttemptUsage(ctx)).toMatchObject({ tasks: 3, attempts: 3, written: 3 });
  expect(readAttemptUsage(ctx, a).get(1)).toMatchObject({ coverage: "partial", total: 59460, selfReported: true });
  expect(readAttemptUsage(ctx, b).get(1)).toMatchObject({ coverage: "measured", total: 1540 });
  expect(readAttemptUsage(ctx, c).get(1)).toMatchObject({ coverage: "unknown", total: null, input: null });
});
test("backfill is idempotent and writes nothing but attempt_usage (REPO-14)", async () => {
  const { ctx, make } = history();
  make("codex", "codex-complete.log"); make("claude-code", "claude-killed.log"); // the latter has no usage file
  const before = snapshot(ctx.pacerHome), taskRows = dispatchDatabase(ctx).query("SELECT id,rev,record,json_mtime FROM tasks ORDER BY id").all();
  const first = await backfillAttemptUsage(ctx), second = await backfillAttemptUsage(ctx);
  expect(first.written).toBe(2); expect(second.written).toBe(0);
  expect(dispatchDatabase(ctx).query("SELECT count(*) AS n FROM attempt_usage").get()).toEqual({ n: 2 });
  expect(dispatchDatabase(ctx).query("SELECT id,rev,record,json_mtime FROM tasks ORDER BY id").all()).toEqual(taskRows);
  expect(snapshot(ctx.pacerHome)).toEqual(before);
});
test("backfill reads a gzipped log of an archived task and marks an unreadable archive unknown", async () => {
  const { ctx, logs, make } = history();
  const id = make("codex", "codex-complete.log"), other = make("codex", null);
  const archive = join(ctx.pacerHome, "archive", "2026-10", id); mkdirSync(archive, { recursive: true });
  const log = readdirSync(logs).find(n => n.startsWith(id))!;
  writeFileSync(join(archive, `${log}.gz`), gzipSync(readFileSync(join(logs, log))));
  const gone = join(ctx.pacerHome, "archive", "2026-10", other); mkdirSync(gone, { recursive: true });
  for (const n of readdirSync(logs)) writeFileSync(join(logs, n), "");
  for (const n of readdirSync(logs)) (await import("node:fs")).rmSync(join(logs, n));
  updateTask(ctx, id, t => { t.archived = true; t.archivePath = archive; });
  updateTask(ctx, other, t => { t.archived = true; t.archivePath = gone; });
  await backfillAttemptUsage(ctx);
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ coverage: "partial", total: 59460 });
  const missing = readAttemptUsage(ctx, other).get(1)!;
  expect(missing.coverage).toBe("unknown"); expect(missing.note).toContain("archived");
});
test("backfill prefers the reduced usage file pacer wrote beside a Claude run", async () => {
  const { ctx, make } = history();
  const id = make("claude-code", null);
  const dir = join(ctx.pacerHome, "runs", id, "1"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "usage.jsonl"), '{"type":"result","num_turns":1,"usage":{"input_tokens":7,"output_tokens":8,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n');
  await backfillAttemptUsage(ctx);
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ coverage: "measured", total: 15, cacheRead: 0 });
});
test("a forged result line in a Claude log is not read when no usage file exists", async () => {
  const { ctx, make } = history();
  const id = make("claude-code", "claude-complete.log");
  await backfillAttemptUsage(ctx);
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ coverage: "unknown", total: null });
});
test("an upsert never replaces a measured row with lower coverage, but may improve one", async () => {
  const { ctx, make } = history();
  const id = make("claude-code", null);
  const dir = join(ctx.pacerHome, "runs", id, "1"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "usage.jsonl"), '{"type":"result","num_turns":3,"usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":5000,"cache_creation_input_tokens":800}}\n');
  await backfillAttemptUsage(ctx);
  const task = readTask(ctx, id)!;
  recordAttemptUsage(ctx, task, 1, { coverage: "unknown", input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null, turns: null, source: "executor-json", selfReported: false, extractor: "claude-stream-json@2", capturedAt: 5, note: "x" });
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ coverage: "measured", total: 1540, extractor: "claude-stream-json@1" });
  recordAttemptUsage(ctx, task, 1, { coverage: "measured", input: 1, cacheRead: null, cacheWrite: null, output: 2, reasoning: null, total: 3, turns: null, source: "executor-json", selfReported: false, extractor: "claude-stream-json@2", capturedAt: 6 });
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ total: 3, extractor: "claude-stream-json@2" });
});
test("the usage index carries routing fields and never prompt or output text", async () => {
  const { ctx, make } = history();
  const id = make("codex", "codex-complete.log");
  updateTask(ctx, id, t => { t.attempts[0]!.routing = { kind: "feature", kindSource: "brief", rule: "ladder-1", chosen: "codex", why: "w", skipped: [] }; t.attempts[0]!.model = "gpt-x"; });
  await backfillAttemptUsage(ctx);
  const row = dispatchDatabase(ctx).query<Record<string, unknown>, [string]>("SELECT * FROM attempt_usage WHERE task_id=?").get(id)!;
  expect(row).toMatchObject({ root_id: id, executor: "codex", model: "gpt-x", kind: "feature", ladder_rule: "ladder-1", outcome: "done" });
  expect(JSON.stringify(row)).not.toContain("Changed two files");
});
test("backfill ignores log paths outside pacer home and non-regular files", async () => {
  const { ctx, make } = history();
  const outside = join(tmpDir(), "outside.log");
  writeFileSync(outside, readFileSync(join(fixtures, "codex-complete.log")));
  const id = make("codex", null);
  updateTask(ctx, id, t => { t.attempts[0]!.log = outside; });
  await backfillAttemptUsage(ctx);
  expect(readAttemptUsage(ctx, id).get(1)).toMatchObject({ coverage: "unknown", total: null });
});
