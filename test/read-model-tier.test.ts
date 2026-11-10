import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { taskDetailEnrichment } from "../src/core/task-detail";
import type { Attempt } from "../src/tasks/types";

test("task detail enrichment preserves the complete attempt tier record", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "Tier evidence", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const tier: NonNullable<Attempt["tier"]> = { requestedDifficulty: "standard", difficultySource: "explicit", effectiveDifficulty: "standard", targetTier: "medium", selectedTier: "small", reason: "executor-fixed-below-target" };
  updateTask(ctx, task.id, t => { t.attempts = [{ executor: "codex", model: "small-model", startedAt: ctx.now, endedAt: ctx.now, log: "", tier, exitCode: 0, timedOut: false, limitHit: false }]; });
  const detail = await taskDetailEnrichment(ctx, task.id);
  expect(detail.attempts?.[0]?.tier).toEqual(tier);
});
