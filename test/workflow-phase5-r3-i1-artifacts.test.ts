import { expect, test } from "bun:test";
import {
  closeSync, constants, existsSync, openSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, updateTask } from "../src/tasks/store";
import { insertRun, insertStep, workflowDatabase } from "../src/workflow/store";
import {
  ARTIFACT_FILE_LIMIT, copyFdCapped, storeArtifact,
} from "../src/workflow/artifacts";

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

test("R3-I1: copyFdCapped refuses an oversized regular file (fstat gate bypassed)", () => {
  const dir = tmpDir();
  const src = join(dir, "big.bin");
  const out = join(dir, "out.bin");
  // Cap is tiny so we prove the loop itself enforces it, independent of ARTIFACT_FILE_LIMIT fstat.
  const cap = 8 * 1024;
  writeFileSync(src, Buffer.alloc(cap + 4096, 7));
  const srcFd = openSync(src, constants.O_RDONLY);
  const outFd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let threw: unknown;
  try {
    try {
      copyFdCapped(srcFd, outFd, cap);
    } catch (error) {
      threw = error;
    }
  } finally {
    try { closeSync(srcFd); } catch { /* */ }
    try { closeSync(outFd); } catch { /* */ }
  }
  expect(threw).toBeInstanceOf(CoreError);
  expect((threw as CoreError).code).toBe("too_large");
  // Helper leaves the temp for the caller to unlink (storeArtifact does).
  expect(existsSync(out)).toBe(true);
  unlinkSync(out);
});

test("R3-I1: copyFdCapped refuses a nonblocking FIFO fd without hanging", () => {
  const dir = tmpDir();
  const fifo = join(dir, "pipe.dat");
  const out = join(dir, "out.bin");
  expect(Bun.spawnSync(["mkfifo", "-m", "0600", fifo]).exitCode).toBe(0);
  // Open reader first (macOS ENXIO if writer opens alone), then a writer so read → EAGAIN.
  const srcFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writeFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  const outFd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const started = Date.now();
  let threw: unknown;
  try {
    try {
      copyFdCapped(srcFd, outFd, ARTIFACT_FILE_LIMIT);
    } catch (error) {
      threw = error;
    }
  } finally {
    try { closeSync(srcFd); } catch { /* */ }
    try { closeSync(writeFd); } catch { /* */ }
    try { closeSync(outFd); } catch { /* */ }
    try { unlinkSync(out); } catch { /* */ }
  }
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(threw).toBeInstanceOf(CoreError);
  expect((threw as CoreError).code).toBe("not_allowed");
});

test("R3-I1: end-to-end storeArtifact still refuses a FIFO source", () => {
  const { ctx, taskId, wt } = seededArtifactTask();
  const fifo = join(wt, "pipe.dat");
  expect(Bun.spawnSync(["mkfifo", "-m", "0600", fifo]).exitCode).toBe(0);
  const started = Date.now();
  expect(() => storeArtifact(ctx, taskId, { path: fifo, label: "fifo" })).toThrow(CoreError);
  expect(Date.now() - started).toBeLessThan(2_000);
});
