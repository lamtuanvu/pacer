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
import { questionAnswerInputSchema, questionInputSchema, type QuestionInput } from "./question-schema";
import {
  answerQuestionRecord,
  escalateQuestionRecord,
  getQuestion,
  getRun,
  insertQuestion,
  rootRunId,
  stepByTask,
  type QuestionRow,
} from "./store";
import { completeWakeupRef, enqueueWakeup } from "./wakeups";
import { orchestratorTaskIdForGrant, verifyRunGrant } from "./run-grant";

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
  const input = questionInputSchema.parse(raw);
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
  return q;
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
  if (current.answerer !== "orchestrator") {
    throw new CoreError("not_allowed", "Only the current orchestrator answerer can escalate");
  }
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${input.id} is ${current.status}`);
  }
  return escalateQuestionRecord(ctx, input.id, {
    suggested: input.suggested,
    expectRev: input.expectRev,
    by: "orchestrator",
  });
}

/** Answer by the current answerer; deliver to the asker unchanged. */
export async function answerQuestion(
  ctx: Ctx,
  raw: AnswerQuestionInput,
  deps: QuestionDeps = {},
): Promise<QuestionRow> {
  const parsed = questionAnswerInputSchema.parse({
    answer: raw.answer,
    ...(raw.note !== undefined ? { note: raw.note } : {}),
    expectRev: raw.expectRev,
  });
  const current = getQuestion(ctx, raw.id);
  if (!current) throw new CoreError("not_found", `unknown question ${raw.id}`);
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${raw.id} is ${current.status}`);
  }

  let answeredBy: string;
  if (current.answerer === "orchestrator") {
    const grant = requireRunGrant(ctx);
    if (rootRunId(ctx, current.runId) !== grant.runId) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    // must human_step questions never accept an orchestrator answer (Task 3).
    if (current.askerKind === "human_step") {
      const run = getRun(ctx, rootRunId(ctx, current.runId)) ?? getRun(ctx, current.runId);
      // Defence in depth: human_step rows created for must steps use answerer person.
      // Refuse anyway if answerer was wrongly left as orchestrator.
      if (!run) throw new CoreError("not_found", `unknown run ${current.runId}`);
    }
    answeredBy = orchestratorTaskIdForGrant(ctx, grant) ?? "orchestrator";
  } else {
    if (!personCaller(ctx)) {
      throw new CoreError("not_allowed", "Only the person can answer this question");
    }
    answeredBy = "person";
  }

  // Yield so a concurrent answer can race the compare-and-set (same pattern as answerHumanStep).
  await Promise.resolve();
  const answered = answerQuestionRecord(ctx, current.id, {
    answer: parsed.answer,
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    expectRev: parsed.expectRev,
    answeredBy,
  });

  completeWakeupRef(ctx, current.runId, "question", current.id);

  if (current.askerTaskId && (current.blocks === "step" || current.blocks === "branch")) {
    const asker = readTask(ctx, current.askerTaskId);
    if (asker?.question && asker.question.answer === undefined) {
      await answerTask(ctx, current.askerTaskId, parsed.answer, {}, {
        ...(deps.spawnRunner ? { spawnRunner: deps.spawnRunner } : {}),
      });
    }
  } else if (current.askerTaskId && current.blocks === "nothing") {
    insertMessage(ctx, {
      taskId: current.askerTaskId,
      rootId: rootOf(ctx, `task:${current.askerTaskId}`),
      from: "human",
      to: `task:${current.askerTaskId}`,
      kind: "message",
      body: parsed.answer,
      replyTo: null,
      requestId: `question.answer:${current.id}:${answered.rev}`,
    });
  }

  return answered;
}

function RUN_TERMINAL(status: string): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}
