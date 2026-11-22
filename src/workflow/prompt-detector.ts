// Fallback detector: flag prompt-like terminal lines on step tasks without answering.
import { existsSync, readFileSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { listTasksWhere, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import { insertQuestion, stepByTask, type QuestionRow } from "./store";

export const PROMPT_WAIT_QUIET_S = 30;

const LINE_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\[y\/n\]/i,
  /\bwhich option\b/i,
  /\bpress enter\b/i,
];

/** Numbered choice list (2+ items) ending with a prompt line. */
const NUMBERED_LIST = /(?:^|\n)\s*\d+[.)]\s+\S[^\n]*(?:\n\s*\d+[.)]\s+\S[^\n]*)+\n+[^\n]*[?:]\s*$/i;

export function findPromptLikeLine(text: string): string | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return null;
  const lines = trimmed.split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (LINE_PATTERNS.some(re => re.test(line))) return line;
  }
  if (NUMBERED_LIST.test(trimmed)) {
    const last = lines.filter(l => l.trim()).at(-1)?.trim();
    return last || trimmed.slice(-200);
  }
  return null;
}

function logPath(task: TaskRecord): string | null {
  if (task.run?.logFile && existsSync(task.run.logFile)) return task.run.logFile;
  const attempt = task.attempts.at(-1);
  if (attempt?.log && existsSync(attempt.log)) return attempt.log;
  return null;
}

function readTail(path: string, maxBytes = 16_384): string {
  try {
    const raw = readFileSync(path);
    return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf8");
  } catch {
    return "";
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
  if (!stepByTask(ctx, taskId)) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const lastOut = task.progress?.lastOutputAt ?? task.run?.startedAt ?? task.updatedAt;
  if (ctx.now - lastOut < PROMPT_WAIT_QUIET_S) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const path = logPath(task);
  if (!path) {
    clearPromptWait(ctx, taskId);
    return null;
  }
  const matched = findPromptLikeLine(readTail(path));
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
  for (const task of listTasksWhere(ctx, { states: ["running"] })) {
    if (stepByTask(ctx, task.id)) refreshPromptWait(ctx, task.id);
  }
}

export type ConvertPromptDeps = {
  /** Optional spy: production never types into the terminal. */
  typeIntoTerminal?: (text: string) => void;
};

/**
 * Convert a prompt-wait mark into a structured question. Never types into the terminal.
 */
export function convertPromptWaitToQuestion(
  ctx: Ctx,
  taskId: string,
  deps: ConvertPromptDeps = {},
): QuestionRow {
  void deps.typeIntoTerminal; // intentionally unused — detector never answers
  const task = readTask(ctx, taskId);
  if (!task?.promptWait) throw new CoreError("not_found", `no prompt wait on task ${taskId}`);
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} has no step row`);
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
  clearPromptWait(ctx, taskId);
  return q;
}
