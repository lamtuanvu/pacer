import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import { checkWorkflowShape } from "../src/workflow/schema";
import { validateEvidenceResult } from "../src/workflow/evidence";
import { storeArtifact } from "../src/workflow/artifacts";
import { evalCondition, parseCondition } from "../src/workflow/condition";
import type { RunRow } from "../src/workflow/store";

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
id: t/ev
version: 1
steps:
  test: { type: agent, kind: research, prompt: "Test", result: evidence, needs: [browser] }
  done: { type: end }
edges:
  - [test, done, "result.failed == 0 and result.unverified == 0"]
`;

const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

const executorCtx = (ctx: Ctx, taskId: string): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } });

async function startedTest(ctx: Ctx) {
  await callOp(ctx, "workflow.add", { source: WF });
  const run = await callOp(ctx, "run.start", {
    workflow: "t/ev", repo: tmpDir(), brief: "Evidence",
  }, stubDeps()) as RunRow;
  const step = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId: string }[] }).steps[0]!;
  const worktree = join(ctx.pacerHome, "task-wt", step.taskId);
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  updateTask(ctx, step.taskId, t => { t.worktree = worktree; return t; });
  return { run, taskId: step.taskId, worktree };
}

test("schema accepts result: evidence and needs", () => {
  const shape = checkWorkflowShape({
    id: "t/e",
    version: 1,
    entry: "t",
    steps: {
      t: { type: "agent", kind: "research", prompt: "go", result: "evidence", needs: ["browser", "desktop"] },
      done: { type: "end" },
    },
    edges: [{ from: "t", to: "done" }],
  });
  expect(shape.errors).toEqual([]);
  expect(shape.def?.steps.t).toMatchObject({ result: "evidence", needs: ["browser", "desktop"] });
});

test("validateEvidenceResult refuses count mismatch and unknown artifacts", () => {
  const ctx = fakeCtx();
  const badCounts = validateEvidenceResult(ctx, "run_aaaaaaaaaa", {
    summary: "x",
    passed: 1,
    failed: 0,
    unverified: 0,
    surfaces: [{ name: "web", status: "unverified", steps: ["a"], artifacts: [] }],
  });
  expect(badCounts.some(e => /count/i.test(e) || /passed/i.test(e))).toBe(true);

  const unknownArt = validateEvidenceResult(ctx, "run_aaaaaaaaaa", {
    summary: "x",
    passed: 0,
    failed: 0,
    unverified: 1,
    surfaces: [{ name: "web", status: "unverified", steps: ["a"], artifacts: ["art_bbbbbbbbbb"] }],
  });
  expect(unknownArt.some(e => /artifact/i.test(e))).toBe(true);
});

test("step.result accepts matching evidence and refuses mismatch", async () => {
  const ctx = fakeCtx();
  const { run, taskId, worktree } = await startedTest(ctx);
  const file = join(worktree, "shot.png");
  writeFileSync(file, "png");
  const art = storeArtifact(ctx, taskId, { path: file, label: "shot" });

  const mismatch = await fail(callOp(executorCtx(ctx, taskId), "step.result", {
    result: {
      summary: "partial",
      passed: 1,
      failed: 0,
      unverified: 0,
      surfaces: [{ name: "web", status: "unverified", steps: ["open"], artifacts: [art.id] }],
    },
  }));
  expect(mismatch.code).toBe("invalid_input");

  const ok = await callOp(executorCtx(ctx, taskId), "step.result", {
    result: {
      summary: "ok",
      passed: 0,
      failed: 0,
      unverified: 1,
      surfaces: [{ name: "web", status: "unverified", steps: ["open"], artifacts: [art.id] }],
      report: art.id,
    },
  });
  expect(ok).toMatchObject({ stepId: "test" });
  void run;
});

test("unverified surface never satisfies a pass-only condition", () => {
  const gate = "result.failed == 0 and result.unverified == 0";
  const ast = parseCondition(gate).ast!;
  expect(evalCondition(ast, {
    result: { passed: 0, failed: 0, unverified: 1, surfaces: [{ status: "unverified" }] },
    brief: "b",
  })).toBe(false);
  expect(evalCondition(ast, {
    result: { passed: 1, failed: 0, unverified: 0, surfaces: [{ status: "pass" }] },
    brief: "b",
  })).toBe(true);
});

test("needs without a matching runner tool notes unverified in the prompt", async () => {
  const ctx = fakeCtx();
  // Capture the brief goal the delegate receives.
  let goal = "";
  const deps: OpDeps = {
    delegate: async (c, input) => {
      goal = typeof input.brief === "string" ? input.brief : input.brief.goal;
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
    },
  };
  await callOp(ctx, "workflow.add", { source: WF });
  await callOp(ctx, "run.start", { workflow: "t/ev", repo: tmpDir(), brief: "Evidence" }, deps);
  expect(goal).toMatch(/unverified/i);
  expect(goal).toMatch(/browser/i);
});
