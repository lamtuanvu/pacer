// Structured question ask / escalate / answer (Phase 4). One thread is one record.
// Ops/CLI/MCP wire-up lands in a later task; this module is the engine API.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { answer as answerTask } from "../core/tasks";
import { requireStepWorker } from "./step-identity";
import { isExecutorSession, isOrchestratorSession } from "../install/role";
import { insertMessage } from "../messaging/store";
import { rootOf } from "../messaging/participants";
import { readTask, updateTask } from "../tasks/store";
import type { SpawnRunner } from "../tasks/api";
import { canAutoDecide } from "./auto";
import {
  NOTE_TOO_LONG, questionAnswerInputSchema, questionInputSchema, sanitizeAnswerNote,
  validateQuestionAnswer, type QuestionInput,
} from "./question-schema";
import { directInputAvailable } from "../session/send";
import type { HumanStep } from "./schema";
import type { EngineDeps } from "./engine";
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

/** Recompute human_step answerer from auto/strict (I5). Escalated rows (chain has orchestrator) stay person. */
export function syncHumanStepAnswerers(ctx: Ctx, runId: string): void {
  const rootId = rootRunId(ctx, runId);
  const root = getRun(ctx, rootId);
  if (!root) return;
  const def = getDefinition(ctx, `${root.workflow}@${root.version}`) ?? getDefinition(ctx, root.workflow);
  if (!def) return;
  const ids = [rootId, ...workflowDatabase(ctx).query<{ id: string }, [string]>(
    "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
  ).all(rootId).map(r => r.id)];
  for (const id of ids) {
    const open = listQuestions(ctx, id, "open").filter(q => q.askerKind === "human_step");
    for (const q of open) {
      const stepDef = def.steps[q.stepId];
      if (!stepDef || stepDef.type !== "human") continue;
      if (q.chain.includes("orchestrator") && q.answerer === "person") continue; // escalated
      const next = canAutoDecide(root, q.stepId, stepDef) ? "orchestrator" : "person";
      if (next === q.answerer) continue;
      const prev = q.answerer;
      workflowDatabase(ctx).query(
        "UPDATE workflow_questions SET answerer = ?, rev = rev + 1 WHERE id = ? AND status = 'open'",
      ).run(next, q.id);
      // Orchestrator no longer owns the step: drop the step wake so the next turn
      // is not spent re-discovering a person-owned human question (M-3).
      if (prev === "orchestrator" && next === "person") {
        completeWakeupRef(ctx, q.runId, "question", q.id);
        completeWakeupRef(
          ctx,
          q.runId,
          "question",
          stepWakeRef(q.runId, q.stepId, q.attempt, q.branch),
        );
      }
    }
  }
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
  /** Optional engine deps so human_step answers can advance with a test stub. */
  engineDeps?: EngineDeps;
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

/** Record answer + complete wake + emit redacted entity. Shared by question.answer and task.answer. */
export async function settleAnsweredQuestion(
  ctx: Ctx,
  id: string,
  input: { answer: string; note?: string; expectRev: number; answeredBy: string },
): Promise<QuestionRow> {
  // Record + wake completion are one immediate transaction (M-b): a crash between
  // them must not leave an open wake for an answered question.
  const answered = workflowDatabase(ctx).transaction(() => {
    const row = answerQuestionRecord(ctx, id, input);
    completeWakeupRef(ctx, row.runId, "question", row.id);
    return row;
  })();
  await publishQuestionEntity(ctx, answered);
  return answered;
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

  const taskId = requireStepWorker(ctx);
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
  branch?: string,
  note?: string,
): QuestionRow | null {
  const open = listQuestions(ctx, runId, "open").filter(q =>
    q.askerKind === "human_step"
    && q.stepId === stepId
    && q.attempt === attempt
    && (q.branch ?? undefined) === branch,
  );
  const q = open[open.length - 1];
  if (!q) return null;
  const answered = answerQuestionRecord(ctx, q.id, {
    answer,
    ...(note !== undefined ? { note } : {}),
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
  // Escalate record + wake completion share one transaction (M-b).
  const escalated = workflowDatabase(ctx).transaction(() => {
    const row = escalateQuestionRecord(ctx, input.id, {
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
    return row;
  })();
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
    if (msg.includes(NOTE_TOO_LONG) || /note.*(4000|too_big|Too big)/i.test(msg)) {
      throw new CoreError("invalid_input", NOTE_TOO_LONG);
    }
    throw new CoreError("invalid_input", msg.includes("2000") || msg.includes("<=2000")
      ? "answer must contain 1–2000 characters"
      : msg);
  }
  if (parsed.note !== undefined) {
    const cleaned = sanitizeAnswerNote(parsed.note);
    if (cleaned.length > 4000) throw new CoreError("invalid_input", NOTE_TOO_LONG);
    // Trim before emptiness: whitespace-only notes must not produce empty fenced blocks.
    parsed = cleaned.trim() === ""
      ? { answer: parsed.answer, expectRev: parsed.expectRev }
      : { ...parsed, note: cleaned };
  }
  const unknownMsg = `unknown question ${raw.id}`;
  const current = getQuestion(ctx, raw.id);
  if (!current) throw new CoreError("not_found", unknownMsg);
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
      // Escalated (or sync-flipped) human steps stay person-owned even when canAutoDecide (M-2).
      if (current.answerer === "person") {
        throw new CoreError("not_allowed", "Only the person can answer this question");
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
    // Executor existence oracle: same not_found text as an unknown id (M-h).
    if (isExecutorSession(ctx)) throw new CoreError("not_found", unknownMsg);
    if (!personCaller(ctx)) {
      throw new CoreError("not_allowed", "Only the person can answer this question");
    }
    answeredBy = "person";
  }

  // Human steps settle through the Phase 1 compare-and-set (answerHumanStep),
  // which also resolves the open question record (including the revise note).
  if (current.askerKind === "human_step") {
    if (current.rev !== parsed.expectRev) {
      throw new CoreError("conflict", `conflict: question ${current.id} changed since rev ${parsed.expectRev}`);
    }
    const run = getRun(ctx, current.runId);
    if (!run) throw new CoreError("not_found", `unknown run ${current.runId}`);
    const { answerHumanStep } = await import("./engine");
    await answerHumanStep(
      ctx,
      current.runId,
      current.stepId,
      parsed.answer,
      run.rev,
      deps.engineDeps,
      deps.spawnRunner,
      parsed.note,
    );
    const settled = getQuestion(ctx, current.id);
    if (!settled || settled.status !== "answered") {
      throw new CoreError("conflict", `conflict: question ${current.id} was not resolved`);
    }
    return settled;
  }

  // Yield so a concurrent answer can race the compare-and-set (same pattern as answerHumanStep).
  await Promise.resolve();
  // Re-read after the yield (M-c): a withdraw/escalate during the gap must not use a stale rev.
  const afterYield = getQuestion(ctx, current.id);
  if (!afterYield) throw new CoreError("not_found", `unknown question ${current.id}`);
  if (afterYield.status !== "open") {
    // Record-only retry: if the asker was already resumed, do not fail the caller (M-c).
    if (afterYield.status === "answered" && current.askerTaskId) {
      const asker = readTask(ctx, current.askerTaskId);
      if (asker?.question?.answer !== undefined) return afterYield;
    }
    throw new CoreError("conflict", `conflict: question ${current.id} is ${afterYield.status}`);
  }
  if (afterYield.rev !== parsed.expectRev) {
    throw new CoreError("conflict", `conflict: question ${current.id} changed since rev ${parsed.expectRev}`);
  }
  const deliveryBody = parsed.note !== undefined
    ? `${parsed.answer}\n\n${parsed.note}`
    : parsed.answer;
  // task.answer delivery is capped at 2000 chars; refuse the combined body up front (M-e).
  if (deliveryBody.length > 2000) {
    throw new CoreError(
      "invalid_input",
      "answer and note together must be at most 2000 characters (task.answer delivery limit)",
    );
  }

  if (afterYield.askerKind === "orchestrator") {
    // Answer record + wake enqueue share one transaction (M-b).
    const answered = workflowDatabase(ctx).transaction(() => {
      const row = answerQuestionRecord(ctx, afterYield.id, {
        answer: parsed.answer,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        expectRev: parsed.expectRev,
        answeredBy,
      });
      enqueueWakeup(ctx, {
        runId: afterYield.runId,
        cause: "question",
        ref: afterYield.id,
        createdAt: ctx.now,
      });
      return row;
    })();
    await publishQuestionEntity(ctx, answered);
    return answered;
  }

  const blocking = afterYield.blocks === "step" || afterYield.blocks === "branch";
  if (blocking && afterYield.askerTaskId) {
    const asker = readTask(ctx, afterYield.askerTaskId);
    if (asker?.question && asker.question.answer === undefined) {
      // Deliver first so a not-yet-needs_input / stopped asker leaves the record open (retryable).
      if (asker.state !== "needs_input" && !directInputAvailable(asker)) {
        throw new CoreError(
          "conflict",
          "asker is not waiting for an answer yet; retry when the task needs input",
        );
      }
      // task.answer must not also CAS the record (R2-BL1); we settle after delivery.
      await answerTask(ctx, afterYield.askerTaskId, deliveryBody, {}, {
        skipLinkedQuestionRecord: true,
        ...(deps.spawnRunner ? { spawnRunner: deps.spawnRunner } : {}),
      });
      return settleAnsweredQuestion(ctx, afterYield.id, {
        answer: parsed.answer,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        expectRev: parsed.expectRev,
        answeredBy,
      });
    }
    if (asker?.question && asker.question.answer !== undefined) {
      // Already delivered (e.g. via task.answer); record the delivered text (M-f).
      return settleAnsweredQuestion(ctx, afterYield.id, {
        answer: asker.question.answer,
        expectRev: parsed.expectRev,
        answeredBy,
      });
    }
  }

  // blocks:nothing and prompt-convert: deliver first, then settle (M-d).
  if (afterYield.askerTaskId && afterYield.blocks === "nothing") {
    insertMessage(ctx, {
      taskId: afterYield.askerTaskId,
      rootId: rootOf(ctx, `task:${afterYield.askerTaskId}`),
      from: "human",
      to: `task:${afterYield.askerTaskId}`,
      kind: "message",
      body: deliveryBody,
      replyTo: null,
      requestId: `question.answer:${afterYield.id}:${afterYield.rev + 1}`,
    });
    return settleAnsweredQuestion(ctx, afterYield.id, {
      answer: parsed.answer,
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      expectRev: parsed.expectRev,
      answeredBy,
    });
  }
  if (afterYield.askerTaskId && blocking) {
    const asker = readTask(ctx, afterYield.askerTaskId);
    // Prompt-convert only (no task.question): deliver as a message first (M-d).
    if (!asker?.question) {
      insertMessage(ctx, {
        taskId: afterYield.askerTaskId,
        rootId: rootOf(ctx, `task:${afterYield.askerTaskId}`),
        from: "human",
        to: `task:${afterYield.askerTaskId}`,
        kind: "message",
        body: deliveryBody,
        replyTo: null,
        requestId: `question.answer:${afterYield.id}:${afterYield.rev + 1}`,
      });
      return settleAnsweredQuestion(ctx, afterYield.id, {
        answer: parsed.answer,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        expectRev: parsed.expectRev,
        answeredBy,
      });
    }
  }

  return settleAnsweredQuestion(ctx, afterYield.id, {
    answer: parsed.answer,
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    expectRev: parsed.expectRev,
    answeredBy,
  });
}

function RUN_TERMINAL(status: string): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}
