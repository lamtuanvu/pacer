import { expect, test } from "bun:test";
import { authorizeRoute } from "../src/tasks/policy-route";
import { readTask, touchTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { queueStrategy, queueTask } from "./queue-helpers";

async function admission() {
  const ctx = fakeCtx(), task = queueTask(ctx, "route me", null);
  const route = await authorizeRoute(ctx, task.id, ["codex"], { strategy: () => queueStrategy(), contextFingerprint: () => "fixed" });
  return { ctx, task, route };
}

test("a selection write that changes nothing still passes its route checkpoint", async () => {
  const { ctx, task, route } = await admission();
  // An update in the same clock tick can leave the record unchanged, so no revision is written.
  const same = updateTask(ctx, task.id, t => { t.state = t.state; });
  expect(same.rev).toBe(task.rev);
  expect(() => route.checkpoint(same)).not.toThrow();
  expect(() => route.checkpoint(updateTask(ctx, task.id, t => { t.executor = "codex"; }))).not.toThrow();
});

test("an unchanged task that someone else moved on still fails the route checkpoint", async () => {
  const { ctx, task, route } = await admission();
  touchTask(ctx, task.id);
  // The operation's own no-op write returns the record it read before the other writer.
  expect(() => route.checkpoint(task)).toThrow("Task changed during route selection");
  touchTask(ctx, task.id);
  expect(() => route.checkpoint(readTask(ctx, task.id)!)).toThrow("Task changed during route selection");
});
