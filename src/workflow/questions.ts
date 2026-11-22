// Structured question ask / escalate / answer (Phase 4). One thread is one record.
// Ops/CLI/MCP wire-up lands in a later task; this module is the engine API.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { answer as answerTask, requireAskingExecutor } from "../core/tasks";
import { isExecutorSession, isOrchestratorSession } from "../install/role";
import { insertMessage } from "../messaging/store";
import { rootOf } from "../messaging/participants";
import { readTask, updateTask } from "../tasks/store";
import type { SpawnRunner } from "../tasks/api";
import { canAutoDecide } from "./auto";
import {
  questionAnswerInputSchema, questionInputSchema, validateQuestionAnswer, type QuestionInput,
} from "./question-schema";
import { directInputAvailable } from "../session/send";
import type { HumanStep } from "./schema";
import {
  answerQuestionRecord,
  escalateQuestionRecord,
  getDefinition,
  getQuestion,
  getRun,
  insertQuestion,
  listQuestions,
  rootRunId,
  stepByTask,
  workflowDatabase,
  type QuestionAnswerType,
  type QuestionRow,
  type RunRow,
} from "./store";

/** Soft caps so unbounded blocks:nothing asks cannot flood wakes/attention. */
export const MAX_OPEN_QUESTIONS_PER_ASKER = 5;
export const MAX_OPEN_QUESTIONS_PER_RUN = 20;

function countOpenQuestionsForRun(ctx: Ctx, runId: string): number {
  const row = workflowDatabase(ctx).query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM workflow_questions WHERE run_id = ? AND status = 'open'",
  ).get(runId);
  return row?.n ?? 0;
}

function countOpenQuestionsForAsker(ctx: Ctx, askerTaskId: string): number {
  const row = workflowDatabase(ctx).query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM workflow_questions WHERE asker_task_id = ? AND status = 'open'",
  ).get(askerTaskId);
  return row?.n ?? 0;
}

export function assertOpenQuestionCaps(ctx: Ctx, runId: string, askerTaskId?: string): void {
  if (countOpenQuestionsForRun(ctx, runId) >= MAX_OPEN_QUESTIONS_PER_RUN) {
    throw new CoreError("conflict", `conflict: run ${runId} already has ${MAX_OPEN_QUESTIONS_PER_RUN} open questions`);
  }
  if (askerTaskId && countOpenQuestionsForAsker(ctx, askerTaskId) >= MAX_OPEN_QUESTIONS_PER_ASKER) {
    throw new CoreError("conflict", `conflict: asker ${askerTaskId} already has ${MAX_OPEN_QUESTIONS_PER_ASKER} open questions`);
  }
}
import { completeWakeupRef, enqueueWakeup, stepWakeRef } from "./wakeups";
import { orchestratorTaskIdForGrant, verifyRunGrant } from "./run-grant";
import { publish } from "../link/publish";

export type AskQuestionInput = QuestionInput & {
  /** Orchestrator ask: bind to a step of the grant's run. */
  stepId?: string;
  attempt?: number;
  branch?: string;
  runId?: string;
};

export type EscalateQuestionInput = {
  id: string;
  suggested: string;
  reason: string;
  expectRev: number;
};

export type AnswerQuestionInput = {
  id: string;
  answer: string;
  note?: string;
  expectRev: number;
};

export type QuestionDeps = {
  spawnRunner?: SpawnRunner;
};

/** Redacted question entity for link/plugins: id, run, status, blocks only — no bodies. */
export function questionEntityValue(q: QuestionRow): {
  id: string;
  runId: string;
  status: QuestionRow["status"];
  blocks: QuestionRow["blocks"];
} {
  return { id: q.id, runId: q.runId, status: q.status, blocks: q.blocks };
}

async function publishQuestionEntity(ctx: Ctx, q: QuestionRow): Promise<void> {
  try {
    await publish(ctx, [{
      type: "entity",
      data: { kind: "question", id: q.id, value: questionEntityValue(q) },
    }]);
  } catch { /* publish must not fail the mutation */ }
}

function personCaller(ctx: Ctx): boolean {
  return !ctx.env.PACER_RUN_GRANT && !isOrchestratorSession(ctx) && !isExecutorSession(ctx);
}

function requireRunGrant(ctx: Ctx) {
  const token = ctx.env.PACER_RUN_GRANT;
  if (!token) throw new CoreError("not_allowed", "A run grant is required");
  const grant = verifyRunGrant(ctx, token);
  if (!grant) throw new CoreError("not_allowed", "Expired or revoked run grant");
  return grant;
}

/** Ask a structured question from an executor step or the orchestrator (run grant). */
export async function askQuestion(ctx: Ctx, raw: AskQuestionInput): Promise<QuestionRow> {
  // Parse only QuestionInput fields — stepId/attempt/branch/runId are AskQuestionInput extras.
  const input = questionInputSchema.parse({
    text: raw.text,
    answerType: raw.answerType,
    blocks: raw.blocks,
    ...(raw.options ? { options: raw.options } : {}),
    ...(raw.recommended !== undefined ? { recommended: raw.recommended } : {}),
    ...(raw.artifact !== undefined ? { artifact: raw.artifact } : {}),
  });
  if (ctx.env.PACER_RUN_GRANT || isOrchestratorSession(ctx)) {
    const grant = requireRunGrant(ctx);
    const runId = raw.runId ?? grant.runId;
    const run = getRun(ctx, runId);
    if (!run || rootRunId(ctx, runId) !== grant.runId) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    if (RUN_TERMINAL(run.status)) {
      throw new CoreError("conflict", `conflict: run ${runId} is ${run.status}`);
    }
    const stepId = raw.stepId;
    if (typeof stepId !== "string" || !stepId) {
      throw new CoreError("invalid_input", "stepId is required when the orchestrator asks");
    }
    const attempt = raw.attempt ?? 1;
    const orchTask = orchestratorTaskIdForGrant(ctx, grant) ?? ctx.env.PACER_TASK_ID;
    assertOpenQuestionCaps(ctx, runId, typeof orchTask === "string" ? orchTask : undefined);
    const q = insertQuestion(ctx, {
      runId,
      stepId,
      attempt,
      ...(raw.branch ? { branch: raw.branch } : {}),
      ...(typeof orchTask === "string" && orchTask ? { askerTaskId: orchTask } : {}),
      askerKind: "orchestrator",
      text: input.text,
      answerType: input.answerType,
      ...(input.options ? { options: input.options } : {}),
      ...(input.recommended ? { recommended: input.recommended } : {}),
      blocks: input.blocks,
      ...(input.artifact ? { artifact: input.artifact } : {}),
      answerer: "person",
    });
    await publishQuestionEntity(ctx, q);
    return q;
  }

  const taskId = requireAskingExecutor(ctx);
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_allowed", "Structured questions require a run step task");
  const run = getRun(ctx, step.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${step.runId}`);
  if (RUN_TERMINAL(run.status)) {
    throw new CoreError("conflict", `conflict: run ${step.runId} is ${run.status}`);
  }
  const task = readTask(ctx, taskId);
  if (!task) throw new CoreError("not_found", `unknown task ${taskId}`);
  if (task.state !== "running" && task.state !== "needs_input") {
    throw new CoreError("conflict", "task is not running");
  }
  if (input.blocks !== "nothing") {
    if (task.question && task.question.answer === undefined) {
      throw new CoreError("conflict", "already asked; stop and wait for the answer");
    }
  }
  assertOpenQuestionCaps(ctx, step.runId, taskId);

  const q = insertQuestion(ctx, {
    runId: step.runId,
    stepId: step.stepId,
    attempt: step.attempt,
    ...(step.branch ? { branch: step.branch } : {}),
    askerTaskId: taskId,
    askerKind: "executor",
    text: input.text,
    answerType: input.answerType,
    ...(input.options ? { options: input.options } : {}),
    ...(input.recommended ? { recommended: input.recommended } : {}),
    blocks: input.blocks,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    answerer: "orchestrator",
  });

  enqueueWakeup(ctx, {
    runId: step.runId,
    cause: "question",
    ref: q.id,
    createdAt: ctx.now,
  });

  if (input.blocks !== "nothing") {
    updateTask(ctx, taskId, t => {
      t.question = { text: input.text, at: ctx.now };
    });
  }
  await publishQuestionEntity(ctx, q);
  return q;
}

/** Raise the structured question for a waiting human step (same transaction as the row). */
export function raiseHumanStepQuestion(
  ctx: Ctx,
  run: RunRow,
  stepId: string,
  attempt: number,
  stepDef: HumanStep,
  branch?: string,
): QuestionRow {
  const root = getRun(ctx, rootRunId(ctx, run.id)) ?? run;
  // must / strict / auto-off → person; only auto-effective steps may start with orchestrator.
  const answerer = canAutoDecide(root, stepId, stepDef) ? "orchestrator" : "person";
  const answerType = stepDef.question.kind as QuestionAnswerType;
  const options = stepDef.question.options?.map(value => ({ value }));
  const q = insertQuestion(ctx, {
    runId: run.id,
    stepId,
    attempt,
    ...(branch ? { branch } : {}),
    askerKind: "human_step",
    text: stepDef.question.text,
    answerType,
    ...(options && options.length > 0 ? { options } : {}),
    blocks: "step",
    answerer,
  });
  void publishQuestionEntity(ctx, q);
  return q;
}

/** Mark the open human-step question answered (run.answer / run.decide path). */
export function resolveHumanStepQuestion(
  ctx: Ctx,
  runId: string,
  stepId: string,
  attempt: number,
  answer: string,
  answeredBy: string,
): QuestionRow | null {
  const open = listQuestions(ctx, runId, "open").filter(q =>
    q.askerKind === "human_step"
    && q.stepId === stepId
    && q.attempt === attempt,
  );
  const q = open[open.length - 1];
  if (!q) return null;
  const answered = answerQuestionRecord(ctx, q.id, {
    answer,
    expectRev: q.rev,
    answeredBy,
  });
  completeWakeupRef(ctx, runId, "question", q.id);
  completeWakeupRef(ctx, runId, "question", stepWakeRef(runId, stepId, attempt));
  void publishQuestionEntity(ctx, answered);
  return answered;
}

/** Escalate an open question to the person (orchestrator grant). */
export function escalateQuestion(ctx: Ctx, input: EscalateQuestionInput): QuestionRow {
  if (typeof input.suggested !== "string" || input.suggested.length < 1) {
    throw new CoreError("invalid_input", "suggested must be a non-empty string");
  }
  if (typeof input.reason !== "string" || input.reason.length < 1) {
    throw new CoreError("invalid_input", "reason must be a non-empty string");
  }
  const grant = requireRunGrant(ctx);
  const current = getQuestion(ctx, input.id);
  if (!current) throw new CoreError("not_found", `unknown question ${input.id}`);
  if (rootRunId(ctx, current.runId) !== grant.runId) {
    throw new CoreError("not_allowed", "Operation is outside this run grant");
  }
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${input.id} is ${current.status}`);
  }
  const escalateRun = getRun(ctx, current.runId);
  if (!escalateRun || RUN_TERMINAL(escalateRun.status)) {
    throw new CoreError("conflict", `conflict: run ${current.runId} is ${escalateRun?.status ?? "missing"}`);
  }
  if (current.askerKind === "human_step") {
    const run = getRun(ctx, current.runId);
    const root = run ? (getRun(ctx, rootRunId(ctx, run.id)) ?? run) : null;
    const def = root
      ? (getDefinition(ctx, `${root.workflow}@${root.version}`) ?? getDefinition(ctx, root.workflow))
      : null;
    const stepDef = def?.steps[current.stepId];
    if (!root || !stepDef || stepDef.type !== "human" || !canAutoDecide(root, current.stepId, stepDef)) {
      throw new CoreError("not_allowed", "Cannot escalate a must human step question");
    }
  }
  if (current.answerer !== "orchestrator") {
    throw new CoreError("not_allowed", "Only the current orchestrator answerer can escalate");
  }
  const escalated = escalateQuestionRecord(ctx, input.id, {
    suggested: input.suggested,
    expectRev: input.expectRev,
    by: "orchestrator",
  });
  // Person now owns the question: complete both the q_ wake (executor asks) and the
  // human-step stepWakeRef so needsOrchestrator / turn settle cannot re-wake forever.
  completeWakeupRef(ctx, current.runId, "question", current.id);
  if (current.askerKind === "human_step") {
    completeWakeupRef(
      ctx,
      current.runId,
      "question",
      stepWakeRef(current.runId, current.stepId, current.attempt, current.branch),
    );
  }
  void publishQuestionEntity(ctx, escalated);
  return escalated;
}

/** Answer by the current answerer; deliver to the asker unchanged. */
export async function answerQuestion(
  ctx: Ctx,
  raw: AnswerQuestionInput,
  deps: QuestionDeps = {},
): Promise<QuestionRow> {
  let parsed: { answer: string; note?: string; expectRev: number };
  try {
    parsed = questionAnswerInputSchema.parse({
      answer: raw.answer,
      ...(raw.note !== undefined ? { note: raw.note } : {}),
      expectRev: raw.expectRev,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid answer";
    throw new CoreError("invalid_input", msg.includes("2000") || msg.includes("<=2000")
      ? "answer must contain 1–2000 characters"
      : msg);
  }
  const current = getQuestion(ctx, raw.id);
  if (!current) throw new CoreError("not_found", `unknown question ${raw.id}`);
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${raw.id} is ${current.status}`);
  }
  validateQuestionAnswer(current.answerType, parsed.answer, current.options);
  const answerRun = getRun(ctx, current.runId);
  if (!answerRun || RUN_TERMINAL(answerRun.status)) {
    throw new CoreError("conflict", `conflict: run ${current.runId} is ${answerRun?.status ?? "missing"}`);
  }

  let answeredBy: string;
  if (current.askerKind === "human_step") {
    const run = getRun(ctx, current.runId);
    if (!run) throw new CoreError("not_found", `unknown run ${current.runId}`);
    const root = getRun(ctx, rootRunId(ctx, run.id)) ?? run;
    const def = getDefinition(ctx, `${root.workflow}@${root.version}`) ?? getDefinition(ctx, root.workflow);
    const stepDef = def?.steps[current.stepId];
    if (!stepDef || stepDef.type !== "human") {
      throw new CoreError("conflict", `conflict: step ${current.stepId} is not a human step`);
    }
    if (ctx.env.PACER_RUN_GRANT || isOrchestratorSession(ctx)) {
      const grant = requireRunGrant(ctx);
      if (rootRunId(ctx, current.runId) !== grant.runId) {
        throw new CoreError("not_allowed", "Operation is outside this run grant");
      }
      if (!canAutoDecide(root, current.stepId, stepDef)) {
        throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
      }
      answeredBy = orchestratorTaskIdForGrant(ctx, grant) ?? "orchestrator";
    } else if (personCaller(ctx)) {
      answeredBy = "person";
    } else {
      throw new CoreError("not_allowed", "Only the person can answer this question");
    }
  } else if (current.answerer === "orchestrator") {
    const grant = requireRunGrant(ctx);
    if (rootRunId(ctx, current.runId) !== grant.runId) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    answeredBy = orchestratorTaskIdForGrant(ctx, grant) ?? "orchestrator";
  } else {
    if (!personCaller(ctx)) {
      throw new CoreError("not_allowed", "Only the person can answer this question");
    }
    answeredBy = "person";
  }

  // Human steps settle through the Phase 1 compare-and-set (answerHumanStep),
  // which also resolves the open question record.
  if (current.askerKind === "human_step") {
    if (current.rev !== parsed.expectRev) {
      throw new CoreError("conflict", `conflict: question ${current.id} changed since rev ${parsed.expectRev}`);
    }
    const run = getRun(ctx, current.runId);
    if (!run) throw new CoreError("not_found", `unknown run ${current.runId}`);
    const { answerHumanStep } = await import("./engine");
    await answerHumanStep(ctx, current.runId, current.stepId, parsed.answer, run.rev, undefined, deps.spawnRunner);
    const settled = getQuestion(ctx, current.id);
    if (!settled || settled.status !== "answered") {
      throw new CoreError("conflict", `conflict: question ${current.id} was not resolved`);
    }
    return settled;
  }

  // Yield so a concurrent answer can race the compare-and-set (same pattern as answerHumanStep).
  await Promise.resolve();
  const deliveryBody = parsed.note !== undefined
    ? `${parsed.answer}\n\n${parsed.note}`
    : parsed.answer;

  if (current.askerKind === "orchestrator") {
    const answered = answerQuestionRecord(ctx, current.id, {
      answer: parsed.answer,
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      expectRev: parsed.expectRev,
      answeredBy,
    });
    // Person answered an orchestrator ask: wake the orchestrator with the answer in the turn prompt.
    enqueueWakeup(ctx, {
      runId: current.runId,
      cause: "question",
      ref: current.id,
      createdAt: ctx.now,
    });
    await publishQuestionEntity(ctx, answered);
    return answered;
  }

  const blocking = current.blocks === "step" || current.blocks === "branch";
  if (blocking && current.askerTaskId) {
    const asker = readTask(ctx, current.askerTaskId);
    if (asker?.question && asker.question.answer === undefined) {
      // Deliver first so a not-yet-needs_input / stopped asker leaves the record open (retryable).
      if (asker.state !== "needs_input" && !directInputAvailable(asker)) {
        throw new CoreError(
          "conflict",
          "asker is not waiting for an answer yet; retry when the task needs input",
        );
      }
      await answerTask(ctx, current.askerTaskId, deliveryBody, {}, {
        ...(deps.spawnRunner ? { spawnRunner: deps.spawnRunner } : {}),
      });
      const answered = answerQuestionRecord(ctx, current.id, {
        answer: parsed.answer,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        expectRev: parsed.expectRev,
        answeredBy,
      });
      completeWakeupRef(ctx, current.runId, "question", current.id);
      await publishQuestionEntity(ctx, answered);
      return answered;
    }
  }

  const answered = answerQuestionRecord(ctx, current.id, {
    answer: parsed.answer,
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    expectRev: parsed.expectRev,
    answeredBy,
  });
  completeWakeupRef(ctx, current.runId, "question", current.id);

  if (current.askerTaskId && blocking) {
    // Prompt-convert (no task.question): deliver as a message.
    insertMessage(ctx, {
      taskId: current.askerTaskId,
      rootId: rootOf(ctx, `task:${current.askerTaskId}`),
      from: "human",
      to: `task:${current.askerTaskId}`,
      kind: "message",
      body: deliveryBody,
      replyTo: null,
      requestId: `question.answer:${current.id}:${answered.rev}`,
    });
  } else if (current.askerTaskId && current.blocks === "nothing") {
    insertMessage(ctx, {
      taskId: current.askerTaskId,
      rootId: rootOf(ctx, `task:${current.askerTaskId}`),
      from: "human",
      to: `task:${current.askerTaskId}`,
      kind: "message",
      body: deliveryBody,
      replyTo: null,
      requestId: `question.answer:${current.id}:${answered.rev}`,
    });
  }

  await publishQuestionEntity(ctx, answered);
  return answered;
}

function RUN_TERMINAL(status: string): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}
