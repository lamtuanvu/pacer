import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, updateTask } from "../src/tasks/store";
import { insertRun, insertStep, workflowDatabase } from "../src/workflow/store";
import { ARTIFACT_FILE_LIMIT, storeArtifact } from "../src/workflow/artifacts";

function seededArtifactTask() {
  const ctx = fakeCtx();
  const repo = tmpDir();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/art", version: 1, repo, brief: "b", stepMode: "plain" });
  const task = createTask(ctx, {
    brief: { goal: "a", repo }, kind: "feature", requestedExecutor: null, timeoutS: 60,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "running" });
  const wt = tmpDir();
  updateTask(ctx, task.id, t => { t.worktree = wt; t.state = "running"; });
  return { ctx, taskId: task.id, wt };
}

test("R2-F9: FIFO source is refused without hanging the event loop", () => {
  const { ctx, taskId, wt } = seededArtifactTask();
  const fifo = join(wt, "pipe.dat");
  expect(Bun.spawnSync(["mkfifo", "-m", "0600", fifo]).exitCode).toBe(0);
  const started = Date.now();
  expect(() => storeArtifact(ctx, taskId, { path: fifo, label: "fifo" })).toThrow(CoreError);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("R2-F9: growing file is capped by copied bytes, not the earlier size", async () => {
  const { ctx, taskId, wt } = seededArtifactTask();
  const file = join(wt, "grow.bin");
  // Start just under the limit so fstat passes; a concurrent appender pushes past it mid-read.
  writeFileSync(file, Buffer.alloc(ARTIFACT_FILE_LIMIT - 4096, 1));
  const grower = Bun.spawn({
    cmd: ["sh", "-c", `dd if=/dev/zero bs=1048576 count=4 >> "$1" 2>/dev/null; while true; do dd if=/dev/zero bs=1048576 count=1 >> "$1" 2>/dev/null; done`, "sh", file],
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await Bun.sleep(30);
    let threw: unknown;
    try {
      storeArtifact(ctx, taskId, { path: file, label: "grow" });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(CoreError);
    expect((threw as CoreError).code).toBe("too_large");
  } finally {
    grower.kill();
    await grower.exited;
  }
});
