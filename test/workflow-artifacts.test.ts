import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import { workflowDatabase, type RunRow } from "../src/workflow/store";
import { getArtifact, listArtifacts, storeArtifact } from "../src/workflow/artifacts";
import { artifactRoute } from "../src/serve/artifact-routes";

function stubDeps(): OpDeps {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: OpDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return { delegate };
}

const WF = `
id: t/art
version: 1
steps:
  capture: { type: agent, kind: research, prompt: "Capture" }
  done: { type: end }
edges:
  - [capture, done]
`;

const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

const executorCtx = (ctx: Ctx, taskId: string): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } });

async function startedCapture(ctx: Ctx) {
  await callOp(ctx, "workflow.add", { source: WF });
  const run = await callOp(ctx, "run.start", {
    workflow: "t/art", repo: tmpDir(), brief: "Capture evidence",
  }, stubDeps()) as RunRow;
  const steps = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId: string; stepId: string }[] }).steps;
  const step = steps.find(s => s.stepId === "capture")!;
  const worktree = join(ctx.pacerHome, "task-wt", step.taskId);
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  updateTask(ctx, step.taskId, t => { t.worktree = worktree; return t; });
  return { run, taskId: step.taskId, worktree };
}

test("storeArtifact copies a worktree file and refuses path escape", async () => {
  const ctx = fakeCtx();
  workflowDatabase(ctx);
  const { run, taskId, worktree } = await startedCapture(ctx);
  const file = join(worktree, "shot.png");
  writeFileSync(file, "png-bytes");

  const art = storeArtifact(ctx, taskId, { path: file, label: "web shot" });
  expect(art.id).toMatch(/^art_[a-z2-7]{10}$/);
  expect(art.label).toBe("web shot");
  expect(art.size).toBe(9);
  expect(listArtifacts(ctx, run.id)).toEqual([expect.objectContaining({ id: art.id, stepId: "capture" })]);
  const loaded = getArtifact(ctx, run.id, art.id);
  expect(loaded).not.toBeNull();
  expect(await Bun.file(loaded!.absPath).text()).toBe("png-bytes");

  const outside = join(tmpDir(), "secret.txt");
  writeFileSync(outside, "nope");
  // path.join normalizes ".."; keep the traversal token in the raw string.
  const viaDotDot = await fail(Promise.resolve().then(() =>
    storeArtifact(ctx, taskId, { path: `${worktree}/../secret.txt`, label: "x" })));
  expect(viaDotDot.code).toBe("not_allowed");
  const absEscape = await fail(Promise.resolve().then(() =>
    storeArtifact(ctx, taskId, { path: outside, label: "x" })));
  expect(absEscape.code).toBe("not_allowed");

  const link = join(worktree, "escape");
  symlinkSync(outside, link);
  const viaLink = await fail(Promise.resolve().then(() =>
    storeArtifact(ctx, taskId, { path: link, label: "x" })));
  expect(viaLink.code).toBe("not_allowed");
});

test("storeArtifact enforces size caps", async () => {
  const ctx = fakeCtx();
  const { taskId, worktree } = await startedCapture(ctx);
  const big = join(worktree, "big.bin");
  // 10 MiB + 1 byte
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
  const err = await fail(Promise.resolve().then(() => storeArtifact(ctx, taskId, { path: big, label: "big" })));
  expect(err.code).toBe("too_large");
});

test("step.artifact op: own step only; another executor refused", async () => {
  const ctx = fakeCtx();
  const { taskId, worktree } = await startedCapture(ctx);
  const file = join(worktree, "a.txt");
  writeFileSync(file, "hi");

  const ok = await callOp(executorCtx(ctx, taskId), "step.artifact", {
    path: file, label: "note",
  }) as { id: string };
  expect(ok.id).toMatch(/^art_/);

  await callOp(ctx, "workflow.add", { source: WF.replace("t/art", "t/art2") });
  const run2 = await callOp(ctx, "run.start", {
    workflow: "t/art2", repo: tmpDir(), brief: "Other",
  }, stubDeps()) as RunRow;
  const otherTask = (await callOp(ctx, "run.get", { id: run2.id }) as { steps: { taskId: string }[] }).steps[0]!.taskId;
  const refused = await fail(callOp(executorCtx(ctx, otherTask), "step.artifact", {
    path: file, label: "steal",
  }));
  expect(refused.code).toBe("not_allowed");

  const sibling = createTask(ctx, {
    brief: { goal: "sib", repo: tmpDir() },
    kind: null, requestedExecutor: null, timeoutS: 60,
  });
  const wrong = await fail(callOp(executorCtx(ctx, sibling.id), "step.artifact", {
    path: file, label: "no",
  }));
  expect(wrong.code).toBe("not_found");
});

test("artifact HTTP route serves content with auth headers shape", async () => {
  const ctx = fakeCtx();
  const { run, taskId, worktree } = await startedCapture(ctx);
  const file = join(worktree, "report.html");
  writeFileSync(file, "<html>ok</html>");
  chmodSync(file, 0o600);
  const art = storeArtifact(ctx, taskId, { path: file, label: "report" });

  const res = await artifactRoute(
    new Request(`http://127.0.0.1/v3/runs/${run.id}/artifacts/${art.id}`),
    ctx,
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  expect(res!.headers.get("Content-Type")).toMatch(/html/);
  expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await res!.text()).toBe("<html>ok</html>");

  const missing = await artifactRoute(
    new Request(`http://127.0.0.1/v3/runs/${run.id}/artifacts/art_zzzzzzzzzz`),
    ctx,
  );
  expect(missing!.status).toBe(404);
});

test("run.get lists artifacts", async () => {
  const ctx = fakeCtx();
  const { run, taskId, worktree } = await startedCapture(ctx);
  const file = join(worktree, "x.txt");
  writeFileSync(file, "x");
  const art = storeArtifact(ctx, taskId, { path: file, label: "x" });
  const got = await callOp(ctx, "run.get", { id: run.id }) as { artifacts: { id: string }[] };
  expect(got.artifacts.map(a => a.id)).toContain(art.id);
});
