import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { CoreError } from "../src/core/errors";
import { withLock } from "../src/core/lock";
import * as tasks from "../src/core/tasks";
import { readTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
const mk = (ctx = fakeCtx()) => ({ ctx, t: tasks.delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s) });

test("get throws unknown_task for a missing id", () => {
  const { ctx } = mk();
  expect(() => tasks.get(ctx, "t-20261014-000000-0000")).toThrow(CoreError);
  try { tasks.get(ctx, "nope"); } catch (e) { expect((e as CoreError).code).toBe("unknown_task"); }
});

test("delegate maps validation failures to invalid_input", () => {
  const ctx = fakeCtx();
  try { tasks.delegate(ctx, { brief: { goal: "", repo: "rel" } }, () => 1, s); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("invalid_input"); }
});

test("list is newest first and honours limit", () => {
  const ctx = fakeCtx();
  const a = tasks.delegate(ctx, { brief: { goal: "a", repo: tmpDir() } }, () => 1, s);
  const b = tasks.delegate(ctx, { brief: { goal: "b", repo: tmpDir() } }, () => 1, s);
  expect(tasks.list(ctx).map((t) => t.id).slice(0, 2)).toEqual([b.id, a.id].sort().reverse());
  expect(tasks.list(ctx, { limit: 1 })).toHaveLength(1);
});

test("wait refuses timeouts outside 1..3000", async () => {
  const { ctx, t } = mk();
  for (const bad of [0, 0.5, 3001, Number.NaN]) {
    await expect(tasks.wait(ctx, t.id, bad)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test("stop marks a queued task stopped", () => {
  const { ctx, t } = mk();
  expect(tasks.stop(ctx, t.id).state).toBe("stopped");
});

test("review records the verdict and refuses unknown kinds", async () => {
  const { ctx, t } = mk();
  tasks.stop(ctx, t.id);
  expect(await tasks.review(ctx, t.id, { accepted: true })).toMatchObject({ task: { task_id: t.id, review: { accepted: true } } });
  expect(readTask(ctx, t.id)?.review?.accepted).toBe(true);
  await expect(tasks.review(ctx, t.id, { accepted: true, kind: "dance" })).rejects.toThrow(/unknown kind/);
});

test("dismiss reports unknown ids and still dismisses known ones", () => {
  const { ctx, t } = mk();
  const r = tasks.dismiss(ctx, ["missing-1", t.id, "missing-2"]);
  expect(r.dismissed.map((x) => x.id)).toEqual([t.id]);
  expect(r.unknown).toEqual(["missing-1", "missing-2"]);
  expect(readTask(ctx, t.id)?.dismissed).toBe(true);
});

test("retry re-delegates the stored brief, links both tasks, and passes the executor", async () => {
  const { ctx, t } = mk();
  const inputs: unknown[] = [];
  const r = await tasks.retry(ctx, t.id, { executor: "codex" }, { delegate: (c, input) => { inputs.push(input); return tasks.delegate(c, input, () => 1, s); } });
  expect(inputs[0]).toMatchObject({ brief: t.brief, kind: t.kind, timeoutMin: t.timeoutS / 60, retryOf: t.id, executor: "codex" });
  expect(readTask(ctx, t.id)?.retriedBy).toBe(r.retry.id);
  expect(readTask(ctx, r.retry.id)?.retryOf).toBe(t.id);
});

test("retry without executor lets routing choose", async () => {
  const { ctx, t } = mk();
  const inputs: Parameters<typeof tasks.delegate>[1][] = [];
  await tasks.retry(ctx, t.id, {}, { delegate: (c, input) => { inputs.push(input); return tasks.delegate(c, input, () => 1, s); } });
  expect(inputs[0].executor).toBeUndefined();
});

for (const worktree of ["current", "new"] as const) {
  test(`retry preserves explicit ${worktree} placement and its reason`, async () => {
    const ctx = fakeCtx();
    const t = tasks.delegate(ctx, {
      brief: { goal: "g", repo: tmpDir() }, worktree, worktree_reason: "keep this placement",
    }, () => 1, s);
    const inputs: Parameters<typeof tasks.delegate>[1][] = [];
    const r = await tasks.retry(ctx, t.id, {}, { delegate: (c, input) => {
      inputs.push(input);
      return tasks.delegate(c, input, () => 1, s);
    } });
    expect(inputs[0]).toMatchObject({ worktree, worktree_reason: "keep this placement" });
    expect(r.retry.placement).toEqual(t.placement);
  });
}

test("retry preserves force", async () => {
  const ctx = fakeCtx();
  const t = tasks.delegate(ctx, { brief: { goal: "g", repo: tmpDir() }, force: true }, () => 1, s);
  const r = await tasks.retry(ctx, t.id, {}, { delegate: (c, input) => tasks.delegate(c, input, () => 1, s) });
  expect(r.retry.force).toBe(true);
});

test("retry rejects traversal ids before creating a lock or files outside pacerHome", async () => {
  const ctx = fakeCtx();
  const before = readdirSync(ctx.home, { recursive: true });
  await expect(tasks.retry(ctx, "../../x")).rejects.toMatchObject({ code: "unknown_task" });
  expect(readdirSync(ctx.home, { recursive: true })).toEqual(before);
  expect(existsSync(join(ctx.pacerHome, "orca"))).toBe(false);
});

for (const name of ["../escape", "nested/lock", "nested\\lock", "retry-..-lock"]) {
  test(`withLock rejects unsafe name ${JSON.stringify(name)} before filesystem access`, async () => {
    const ctx = fakeCtx();
    let called = false;
    await expect(withLock(ctx, name, async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
    expect(existsSync(ctx.pacerHome)).toBe(false);
  });
}

test("concurrent retries create exactly one retry", async () => {
  const { ctx, t } = mk();
  let created = 0;
  const d = (c: typeof ctx, input: Parameters<typeof tasks.delegate>[1]) => { created++; return tasks.delegate(c, input, () => 1, s); };
  const results = await Promise.allSettled([tasks.retry(ctx, t.id, {}, { delegate: d }), tasks.retry(ctx, t.id, {}, { delegate: d })]);
  expect(created).toBe(1);
  expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["conflict"]);
});

test("retry of an unknown task is unknown_task", async () => {
  const ctx = fakeCtx();
  await expect(tasks.retry(ctx, "missing")).rejects.toMatchObject({ code: "unknown_task" });
});
