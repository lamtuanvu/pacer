// Dismissing a workflow-run item only hides it. A task it names keeps waiting on
// its run, so it must not be dismissed (which would hide it and allow cleanup).
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fakeCtx } from "./helpers";
import * as attention from "../src/core/attention";
import * as workflowAttention from "../src/workflow/attention";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { AttentionItem } from "../src/attention/types";

function fixture() {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\n");
  const task = createTask(ctx, { brief: { goal: "step", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, row => { row.state = "done"; });
  return { ctx, id: task.id };
}

for (const prefix of ["run_review:", "budget_spent:", "orchestrator_failed:", "unresolved_wake:"]) {
  test(`dismissing a ${prefix} item hides it and leaves its task alone`, async () => {
    const { ctx, id } = fixture();
    const item: AttentionItem = {
      id: `${prefix}${id}`, kind: "review", severity: "decide", repo: null, taskId: id, title: "Review", detail: "",
      raisedAt: ctx.now, since: ctx.now, notify: "all", actions: [],
    };
    const derive = spyOn(workflowAttention, "deriveWorkflowAttention").mockReturnValue([item]);
    try {
      const before = readTask(ctx, id)!;
      expect(await attention.dismiss(ctx, item.id)).toEqual({ dismissed: true });
      const after = readTask(ctx, id)!;
      expect(after.dismissed).toBeFalsy();
      expect(after.rev).toBe(before.rev);
      const stored = JSON.parse(readFileSync(join(ctx.pacerHome, "state", "attention.json"), "utf8"));
      expect(stored[item.id].dismissedSince).toBe(stored[item.id].since);
    } finally {
      derive.mockRestore();
    }
  });
}

test("dismissing an ordinary task item still dismisses its task", async () => {
  const { ctx, id } = fixture();
  updateTask(ctx, id, row => { row.state = "failed"; });
  await attention.dismiss(ctx, `failed:${id}`);
  expect(readTask(ctx, id)!.dismissed).toBeTruthy();
});
