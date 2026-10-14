import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { CoreError } from "../src/core/errors";
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

test("review records the verdict and refuses unknown kinds", () => {
  const { ctx, t } = mk();
  expect(tasks.review(ctx, t.id, { accepted: true })).toEqual({ recorded: true });
  expect(readTask(ctx, t.id)?.review?.accepted).toBe(true);
  expect(() => tasks.review(ctx, t.id, { accepted: true, kind: "dance" })).toThrow(/unknown kind/);
});

test("dismiss reports unknown ids and still dismisses known ones", () => {
  const { ctx, t } = mk();
  const r = tasks.dismiss(ctx, ["missing-1", t.id, "missing-2"]);
  expect(r.dismissed.map((x) => x.id)).toEqual([t.id]);
  expect(r.unknown).toEqual(["missing-1", "missing-2"]);
  expect(readTask(ctx, t.id)?.dismissed).toBe(true);
});
