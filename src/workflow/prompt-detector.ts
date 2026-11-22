// Fallback detector: flag prompt-like terminal lines on step tasks without answering.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { listTasksWhere, readTask, taskDatabase, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import {
  insertQuestion, stepByTask, stepByTaskIfPresent, workflowSchemaPresent, type QuestionRow,
} from "./store";
import { enqueueWakeup } from "./wakeups";
import { assertOpenQuestionCaps, questionEntityValue } from "./questions";
import { publish } from "../link/publish";

function hasOpenQuestionForTask(ctx: Ctx, taskId: string): boolean {
  if (!workflowSchemaPresent(ctx)) return false;
  const row = taskDatabase(ctx).query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM workflow_questions WHERE asker_task_id = ? AND status = 'open'",
  ).get(taskId);
  return (row?.n ?? 0) > 0;
}

export const PROMPT_WAIT_QUIET_S = 30;

const LINE_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\[y\/n\]/i,
  /\bwhich option\b/i,
  /\bpress enter\b/i,
];

const MAX_LINE_LEN = 400;
const TAIL_NONEMPTY = 3;

/** Scan only the last few non-empty lines (I10): avoid matching old prompts in a long log. */
export function findPromptLikeLine(text: string): string | null {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text.charCodeAt(i);
    if (i === text.length || c === 10 || c === 13) {
      let end = i;
      while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
      if (end > start) {
        const line = text.slice(start, Math.min(end, start + MAX_LINE_LEN));
        lines.push(line);
        if (lines.length > TAIL_NONEMPTY) lines.shift();
      }
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (LINE_PATTERNS.some(re => re.test(line))) return line;
  }
  // Numbered list: last 3 lines look like "1. …", "2. …", "Choose:"
  if (lines.length >= 3) {
    const [a, b, c] = lines.slice(-3);
    if (/^\s*\d+[.)]\s+\S/.test(a!) && /^\s*\d+[.)]\s+\S/.test(b!) && /[?:]\s*$/.test(c!)) {
      return c!.trim();
    }
  }
  return null;
}

function logPath(task: TaskRecord): string | null {
  if (task.run?.logFile && existsSync(task.run.logFile)) return task.run.logFile;
  const attempt = task.attempts.at(-1);
  if (attempt?.log && existsSync(attempt.log)) return attempt.log;
  return null;
}

/** Read only the last maxBytes of a log (R2-I1): never load a multi-hundred-MB file. */
export function readLogTail(path: string, maxBytes = 16_384): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export type PromptWaitMark = { text: string; at: number };

/** Scan a running step task's log; mark after PROMPT_WAIT_QUIET_S with no new output. */
export function refreshPromptWait(ctx: Ctx, taskId: string): PromptWaitMark | null {
  const task = readTask(ctx, taskId);
  if (!task || task.state !== "running") {
    clearPromptWait(ctx, taskId);
    return null;
  }
  if (!stepByTaskIfPresent(ctx, taskId)) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  // Skip while an open structured question already exists for this asker (I8).
  if (hasOpenQuestionForTask(ctx, taskId)) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const lastOut = task.progress?.lastOutputAt ?? task.run?.startedAt ?? task.createdAt;
  if (ctx.now - lastOut < PROMPT_WAIT_QUIET_S) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const path = logPath(task);
  if (!path) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const matched = findPromptLikeLine(readLogTail(path));
  if (!matched) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const mark: PromptWaitMark = { text: matched, at: lastOut };
  updateTask(ctx, taskId, t => { t.promptWait = mark; });
  return mark;
}

function clearPromptWait(ctx: Ctx, taskId: string): void {
  const task = readTask(ctx, taskId);
  if (!task?.promptWait) return;
  updateTask(ctx, taskId, t => { delete t.promptWait; });
}

/** Refresh marks for every running step task (broker / tick hook). */
export function refreshAllPromptWaits(ctx: Ctx): void {
  // Cheap pre-check: homes with no workflow tables skip without DDL (R2-I1/I4).
  try {
    if (!workflowSchemaPresent(ctx)) return;
    const n = taskDatabase(ctx).query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM workflow_steps WHERE status = 'running' LIMIT 1",
    ).get()?.n ?? 0;
    if (n === 0) return;
  } catch {
    return;
  }
  for (const task of listTasksWhere(ctx, { states: ["running"] })) {
    try {
      if (stepByTaskIfPresent(ctx, task.id)) refreshPromptWait(ctx, task.id);
    } catch {
      // Isolate per task so one failure cannot abort the whole broker tick (I10).
    }
  }
}

/**
 * Convert a prompt-wait mark into a structured question. Never types into the terminal.
 */
export function convertPromptWaitToQuestion(
  ctx: Ctx,
  taskId: string,
): QuestionRow {
  const task = readTask(ctx, taskId);
  if (!task?.promptWait) throw new CoreError("not_found", `no prompt wait on task ${taskId}`);
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} has no step row`);
  if (hasOpenQuestionForTask(ctx, taskId)) {
    throw new CoreError("conflict", "an open question already exists for this task");
  }
  assertOpenQuestionCaps(ctx, step.runId, taskId);
  const text = task.promptWait.text;
  const q = insertQuestion(ctx, {
    runId: step.runId,
    stepId: step.stepId,
    attempt: step.attempt,
    ...(step.branch ? { branch: step.branch } : {}),
    askerTaskId: taskId,
    askerKind: "executor",
    text: `The agent may be waiting on a terminal prompt:\n\n${text}`,
    answerType: "text",
    blocks: "step",
    answerer: "orchestrator",
  });
  enqueueWakeup(ctx, {
    runId: step.runId,
    cause: "question",
    ref: q.id,
    createdAt: ctx.now,
  });
  clearPromptWait(ctx, taskId);
  void publish(ctx, [{
    type: "entity",
    data: { kind: "question", id: q.id, value: questionEntityValue(q) },
  }]).catch(() => {});
  return q;
}
