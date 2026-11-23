import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask } from "../src/tasks/store";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import {
  getRun, insertRun, listDecisions, recordDecision, workflowDatabase,
} from "../src/workflow/store";
import { isCodeStep } from "../src/workflow/branch";
import { answerHumanStep } from "../src/workflow/engine";
import { validateWorkflow } from "../src/workflow/validate";
import { checkWorkflowShape } from "../src/workflow/schema";

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

test("T4: code steps are delegated with worktree:new", async () => {
  expect(isCodeStep({ kind: "feature" })).toBe(true);
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const WF = `
id: t/code
version: 1
steps:
  impl: { type: agent, kind: feature, prompt: "Do it" }
  done: { type: end }
edges:
  - [impl, done]
`;
  await callOp(ctx, "workflow.add", { source: WF });
  const deps = stubDeps();
  const seen: DelegateInput[] = [];
  const base = deps.delegate!;
  deps.delegate = async (c, input, spawn) => {
    seen.push(input);
    return base(c, input, spawn);
  };
  const run = await callOp(ctx, "run.start", {
    workflow: "t/code", repo, brief: "code step",
  }, deps) as { id: string };
  expect(seen.some(i => i.kind === "feature" && (i as { worktree?: string }).worktree === "new")).toBe(true);
  expect(getRun(ctx, run.id)?.branch).toBeTruthy();
});

test("T4: listDecisions ties break by insertion order", () => {
  const ctx = fakeCtx({ now: 100 });
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/d", version: 1, repo: tmpDir(), brief: "b", stepMode: "plain" });
  recordDecision(ctx, {
    runId: run.id, stepId: "a", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve", reason: "first",
  });
  recordDecision(ctx, {
    runId: run.id, stepId: "a", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve", reason: "second",
  });
  const list = listDecisions(ctx, run.id);
  expect(list.map(d => d.reason)).toEqual(["first", "second"]);
});

test("T4/R2-F6: approves publish requires yes_no/approve_revise; tip recorded on answer", async () => {
  const bad = checkWorkflowShape({
    id: "t/pubbad",
    version: 1,
    entry: "ask",
    steps: {
      ask: {
        type: "human",
        decision: "must",
        approves: "publish",
        question: { kind: "text", text: "Publish?" },
      },
      end: { type: "end" },
    },
    edges: [{ from: "ask", to: "end" }],
  });
  expect(validateWorkflow(bad.def!).some(e => /yes_no|approve_revise/.test(e.message))).toBe(true);

  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  await callOp(ctx, "workflow.add", { source: `
id: t/pub2
version: 1
steps:
  ask: { type: human, decision: must, approves: publish, question: { kind: approve_revise, text: "Publish?" } }
  end: { type: end }
edges:
  - [ask, end]
` });
  const run = await callOp(ctx, "run.start", {
    workflow: "t/pub2", repo, brief: "pub",
  }, stubDeps()) as { id: string };
  const live = getRun(ctx, run.id)!;
  // Ensure run branch exists so tip can be read.
  const { ensureRunBranch } = await import("../src/workflow/branch");
  await ensureRunBranch(ctx, live);
  const branched = getRun(ctx, run.id)!;
  const tip = (await ctx.run(
    ["git", "-C", repo, "rev-parse", "--verify", `refs/heads/${branched.branch!}`],
    10_000,
  )).stdout.trim().toLowerCase();

  await answerHumanStep(ctx, branched.id, "ask", "approve", branched.rev);
  const decisions = listDecisions(ctx, branched.id).filter(d => d.kind === "publish_approved");
  expect(decisions.length).toBe(1);
  expect(decisions[0]!.actor).toBe("person");
  expect(decisions[0]!.reason).toContain(`tip=${tip}`);

  // Grant refused on publish approval (before burning the step).
  await callOp(ctx, "workflow.add", { source: `
id: t/pub3
version: 1
steps:
  ask: { type: human, decision: must, approves: publish, question: { kind: yes_no, text: "Publish?" } }
  end: { type: end }
edges:
  - [ask, end]
` });
  const run2 = await callOp(ctx, "run.start", {
    workflow: "t/pub3", repo, brief: "pub3",
  }, stubDeps()) as { id: string };
  await ensureRunBranch(ctx, getRun(ctx, run2.id)!);
  const grantCtx = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: "prg_" + "ab".repeat(32) } };
  await expect(answerHumanStep(
    grantCtx,
    run2.id,
    "ask",
    "yes",
    getRun(ctx, run2.id)!.rev,
  )).rejects.toMatchObject({ code: "not_allowed" });
});
