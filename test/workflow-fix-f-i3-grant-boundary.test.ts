// TAIL I3: orchestrator/prg_ CLI allow-list admits answer/question/ask wholesale;
// the op layer must still refuse person-only and out-of-scope actions.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import {
  addDefinition, getQuestion, getRun, insertRun, insertStep,
} from "../src/workflow/store";
import { askQuestion, escalateQuestion, raiseHumanStepQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import { main } from "../src/cli";
import { startServer } from "../src/serve/http";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/grant-bound",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    gate: { type: "human", decision: "must", question: { text: "Ship?", kind: "yes_no" } },
    done: { type: "end" },
  },
  edges: [
    { from: "ask", to: "gate" },
    { from: "gate", to: "done", when: "result.answer == 'yes'" },
  ],
  entry: "ask",
};

function withStrategy(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n",
  );
}

function seedRun(ctx: Ctx): { runId: string; task: TaskRecord; turnId: string } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/grant-bound\n");
  const run = insertRun(ctx, { workflow: "t/grant-bound", version: 1, repo: tmpDir(), brief: "B", title: "G" });
  const task = createTask(ctx, {
    brief: { goal: "Ask", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.question = { text: "ordinary?", at: ctx.now };
    t.run = {
      dir: tmpDir(),
      attempt: 1,
      executor: "codex",
      startedAt: ctx.now,
      mode: "new",
      workdir: run.repo,
      logFile: "/dev/null",
      agentSession: { id: "sid", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  const turnId = `turn_${run.id.slice(-6)}`;
  insertTurn(ctx, {
    id: turnId,
    runId: run.id,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
    taskId: task.id,
  });
  return { runId: run.id, task: readTask(ctx, task.id)!, turnId };
}

describe("I3: run-grant CLI security boundary (real HTTP)", () => {
  test("answer taskId, question convert, other-run q_, person/must answers, unstructured ask are refused", async () => {
    const ctx = fakeCtx({ now: NOW });
    const { runId, task, turnId } = seedRun(ctx);

    // Second run for the other-run question oracle.
    const other = insertRun(ctx, {
      workflow: "t/grant-bound", version: 1, repo: tmpDir(), brief: "other", title: "O",
    });
    const otherTask = createTask(ctx, {
      brief: { goal: "Other", repo: other.repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 600,
    });
    updateTask(ctx, otherTask.id, t => { t.state = "running"; });
    insertStep(ctx, { runId: other.id, stepId: "ask", attempt: 1, taskId: otherTask.id, status: "running" });
    const otherQ = await askQuestion(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: otherTask.id } },
      { text: "Other run?", answerType: "yes_no", blocks: "step" },
    );

    // Person-answerer question on this grant's run (escalate an executor ask).
    const personQ = await askQuestion(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
      { text: "Person owns?", answerType: "yes_no", blocks: "nothing" },
    );
    const grantForEsc = issueRunGrant(ctx, { runId, turnId, deadline: ctx.now + 600 });
    escalateQuestion(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grantForEsc, PACER_ROLE: "orchestrator" } },
      { id: personQ.id, suggested: "yes", reason: "needs human", expectRev: personQ.rev },
    );
    expect(getQuestion(ctx, personQ.id)?.answerer).toBe("person");

    // Must human-step question on the same run (decision:must → answerer person).
    insertStep(ctx, { runId, stepId: "gate", attempt: 1, status: "waiting" });
    const mustStep = def.steps.gate;
    if (mustStep.type !== "human") throw new Error("expected human gate");
    const mustQ = raiseHumanStepQuestion(ctx, getRun(ctx, runId)!, "gate", 1, mustStep);
    expect(mustQ.answerer).toBe("person");
    expect(mustQ.askerKind).toBe("human_step");

    const server = startServer(() => ({ ...ctx, now: NOW }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
    });
    try {
      await Bun.sleep(20);
      const bearer = issueRunGrant(ctx, { runId, turnId, deadline: ctx.now + 600 });
      const orchCtx: Ctx = {
        ...ctx,
        env: {
          ...ctx.env,
          PACER_ROLE: "orchestrator",
          PACER_RUN_GRANT: bearer,
          PACER_PORT: String(server.port),
          PACER_RUN_ID: runId,
          PACER_TURN_ID: turnId,
          PACER_TASK_ID: task.id,
        },
      };
      delete orchCtx.env.PACER_API;

      // 1) Ordinary task.answer is not in RUN_GRANT_OPS (op-layer gate, not CLI allow-list).
      const taskAnswer = await main(["answer", task.id, "x"], orchCtx);
      expect(taskAnswer.code).toBe(2);
      expect(taskAnswer.err).toContain("Operation is not allowed by this run grant");
      expect(taskAnswer.err).not.toMatch(/orchestrator role only allows/);

      // 2) question.convert_prompt is not in RUN_GRANT_OPS.
      const convert = await main(["question", "convert", task.id], orchCtx);
      expect(convert.code).toBe(2);
      expect(convert.err).toContain("only run-grant operations are allowed on this turn");

      // 3) Other-run question: same not_found text as unknown id.
      const unknownId = "q_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
      const unknown = await main(["answer", unknownId, "yes"], orchCtx);
      const otherRun = await main(["answer", otherQ.id, "yes"], orchCtx);
      expect(otherRun.code).toBe(2);
      expect(unknown.code).toBe(2);
      expect(otherRun.err).toBe(unknown.err.replace(unknownId, otherQ.id));
      expect(otherRun.err).toContain(`unknown question ${otherQ.id}`);

      // 4) Person-answerer / must-step questions refused for the orchestrator.
      const personAnswer = await main(
        ["answer", personQ.id, "yes", "--expect-rev", String(getQuestion(ctx, personQ.id)!.rev)],
        orchCtx,
      );
      expect(personAnswer.code).toBe(2);
      expect(personAnswer.err).toMatch(/Only the person can answer this question/);

      const mustAnswer = await main(
        ["answer", mustQ.id, "yes", "--expect-rev", String(mustQ.rev)],
        orchCtx,
      );
      expect(mustAnswer.code).toBe(2);
      expect(mustAnswer.err).toMatch(/Only the person can answer this question|Orchestrator cannot answer this step/);

      // 5) Unstructured pacer ask (assistant) refused under the grant.
      const unstructured = await main(["ask", "what should I do?"], orchCtx);
      expect(unstructured.code).toBe(2);
      expect(unstructured.err).toContain("Operation is not allowed by this run grant");
    } finally {
      await server.stop();
    }
  });
});
