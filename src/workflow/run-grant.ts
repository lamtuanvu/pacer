// The per-turn `prg_` run grant (API-5b): a distinct credential bound to one root
// run and one orchestrator turn, hashed at rest in the work_grants store under
// kind "run". It never answers as a work grant or an assistant grant.
import { createHash, randomBytes } from "node:crypto";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { dispatchDatabase } from "../dispatch/store";
import { getQuestion, getRun, rootRunId, stepByTask, workflowDatabase } from "./store";
import { getTurn } from "./wakeups";
import { awaitsReview } from "./review";

export const RUN_GRANT_KIND = "run";

/** Operations a live `prg_` grant may call, and only on its own run's targets.
 *  run.answer stays person-only. */
export const RUN_GRANT_OPS = [
  "task.review",
  "task.stop",
  "step.result",
  "step.artifact",
  "step.skip",
  "step.retry",
  "run.get",
  "run.choose",
  "run.decide",
  "run.submit_graph",
  "run.sync_base",
  "run.publish",
  "question.ask",
  "question.answer",
  "question.escalate",
  "question.get",
  "question.list",
] as const;

export type RunGrantOp = (typeof RUN_GRANT_OPS)[number];

export interface RunGrant {
  runId: string;
  turnId: string;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Issue a `prg_` bearer for one turn. Only the SHA-256 hash is stored. */
export function issueRunGrant(ctx: Ctx, input: { runId: string; turnId: string; deadline: number }): string {
  if (!input.runId || !input.turnId) throw new CoreError("invalid_input", "A run grant binds one run and one turn");
  if (!(input.deadline > ctx.now)) throw new CoreError("invalid_input", "A run grant must expire after now");
  const token = `prg_${randomBytes(32).toString("hex")}`;
  // task_id = turn id; conversation_id reused as the run id (same pattern as pag_).
  dispatchDatabase(ctx).query(
    "INSERT INTO work_grants(hash, task_id, attempt, expires, revoked, kind, conversation_id) VALUES (?, ?, 0, ?, 0, ?, ?)",
  ).run(tokenHash(token), input.turnId, input.deadline, RUN_GRANT_KIND, input.runId);
  return token;
}

/** Resolve a `prg_` bearer. Unknown, malformed, expired, revoked or terminal-run → null. */
export function verifyRunGrant(ctx: Ctx, bearer: string): RunGrant | null {
  if (!/^prg_[0-9a-f]{64}$/.test(bearer)) return null;
  const row = dispatchDatabase(ctx).query<{ task_id: string; conversation_id: string; expires: number; revoked: number; kind?: string }, [string]>(
    "SELECT * FROM work_grants WHERE hash = ?",
  ).get(tokenHash(bearer));
  if (!row || row.kind !== RUN_GRANT_KIND || row.revoked || row.expires <= ctx.now) return null;
  const run = getRun(ctx, row.conversation_id);
  if (!run || run.status === "done" || run.status === "failed" || run.status === "stopped") return null;
  return { runId: row.conversation_id, turnId: row.task_id };
}

export function revokeRunGrant(ctx: Ctx, turnId: string): void {
  dispatchDatabase(ctx).query(
    "UPDATE work_grants SET revoked = 1 WHERE task_id = ? AND kind = ?",
  ).run(turnId, RUN_GRANT_KIND);
}

export function revokeRunGrantsForRun(ctx: Ctx, runId: string): void {
  dispatchDatabase(ctx).query(
    "UPDATE work_grants SET revoked = 1 WHERE conversation_id = ? AND kind = ?",
  ).run(runId, RUN_GRANT_KIND);
}

/** At start-up: revoke run grants whose turn is not live (starting/running). */
export function revokeOrphanRunGrants(ctx: Ctx): void {
  const db = dispatchDatabase(ctx);
  // Ensure workflow tables exist before joining.
  workflowDatabase(ctx);
  db.query(`
    UPDATE work_grants SET revoked = 1
    WHERE kind = ?
      AND revoked = 0
      AND task_id NOT IN (
        SELECT id FROM workflow_turns WHERE status IN ('starting', 'running')
      )
  `).run(RUN_GRANT_KIND);
}

/** True when `runId` is the grant's root run or a choose_workflow child of it. */
function runInGrant(ctx: Ctx, grant: RunGrant, runId: string): boolean {
  return runId === grant.runId || rootRunId(ctx, runId) === grant.runId;
}

/** Whether `name` + `params` stay inside the grant's run (including child runs). */
export function assertRunGrantTarget(ctx: Ctx, grant: RunGrant, name: string, params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (name.startsWith("question.")) {
    if (name === "question.list") {
      const run = typeof p.run === "string" ? p.run
        : typeof p.runId === "string" ? p.runId
        : typeof p.id === "string" && p.id.startsWith("run_") ? p.id
        : undefined;
      if (run && !runInGrant(ctx, grant, run)) {
        throw new CoreError("not_found", `unknown run ${run}`);
      }
      return;
    }
    if (name === "question.ask") {
      const runId = typeof p.runId === "string" ? p.runId
        : typeof p.run_id === "string" ? p.run_id
        : typeof p.run === "string" ? p.run
        : grant.runId;
      if (!runInGrant(ctx, grant, runId)) {
        throw new CoreError("not_found", `unknown run ${runId}`);
      }
      return;
    }
    if (name === "question.convert_prompt") {
      const taskId = typeof p.id === "string" ? p.id : undefined;
      if (!taskId) throw new CoreError("invalid_input", "Task id is required");
      const step = stepByTask(ctx, taskId);
      if (!step || !runInGrant(ctx, grant, step.runId)) {
        throw new CoreError("not_found", `unknown task ${taskId}`);
      }
      return;
    }
    const id = p.id;
    if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "Question id is required");
    const q = getQuestion(ctx, id);
    // Outside the grant looks like an unknown id (prompt standing rule f).
    if (!q || !runInGrant(ctx, grant, q.runId)) {
      throw new CoreError("not_found", `unknown question ${id}`);
    }
    return;
  }
  if (name.startsWith("run.")) {
    const id = p.id;
    if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "Run id is required");
    if (!runInGrant(ctx, grant, id)) throw new CoreError("not_allowed", "Operation is outside this run grant");
    return;
  }
  if (name === "step.result" || name === "step.artifact") {
    const taskId = orchestratorTaskIdForGrant(ctx, grant) ?? ctx.env.PACER_TASK_ID;
    if (typeof taskId !== "string" || !taskId) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    const step = stepByTask(ctx, taskId);
    if (!step || !runInGrant(ctx, grant, step.runId)) {
      throw new CoreError("not_allowed", "Operation is outside this run grant");
    }
    return;
  }
  if (name === "step.skip" || name === "step.retry") {
    const runId = typeof p.id === "string" ? p.id
      : typeof p.run_id === "string" ? p.run_id
      : typeof p.runId === "string" ? p.runId
      : undefined;
    if (typeof runId !== "string" || !runId) throw new CoreError("invalid_input", "Run id is required");
    if (!runInGrant(ctx, grant, runId)) throw new CoreError("not_allowed", "Operation is outside this run grant");
    const step = typeof p.step === "string" ? p.step : typeof p.step_id === "string" ? p.step_id : undefined;
    if (typeof step !== "string" || !step) throw new CoreError("invalid_input", "Step id is required");
    return;
  }
  if (name.startsWith("step.")) {
    const runId = typeof p.id === "string" && p.id.startsWith("run_") ? p.id
      : typeof p.run_id === "string" ? p.run_id
      : typeof p.runId === "string" ? p.runId
      : undefined;
    if (runId && runInGrant(ctx, grant, runId)) return;
    const taskId = typeof p.task_id === "string" ? p.task_id
      : typeof p.taskId === "string" ? p.taskId
      : undefined;
    if (taskId) {
      const step = stepByTask(ctx, taskId);
      if (step && runInGrant(ctx, grant, step.runId)) return;
    }
    throw new CoreError("not_allowed", "Operation is outside this run grant");
  }
  if (name === "task.review" || name === "task.stop") {
    const id = p.id;
    if (typeof id !== "string" || !id) throw new CoreError("invalid_input", "Task id is required");
    // Orchestrator never delegates (API-5b / M2): retry starts a new task.
    if (name === "task.review" && p.verdict === "retry") {
      throw new CoreError("not_allowed", "PACER_ROLE=orchestrator: never delegate via retry");
    }
    const step = stepByTask(ctx, id);
    const mine = !!step && runInGrant(ctx, grant, step.runId);
    // send_back continues the same task and worktree (core review refuses the new
    // attempt it would otherwise fall back to), and only for a step under review.
    if (name === "task.review" && p.verdict === "send_back" && !(mine && awaitsReview(ctx, step!))) {
      throw new CoreError("not_allowed", "PACER_ROLE=orchestrator: send_back only continues a step task of this run that waits for review");
    }
    if (!mine) throw new CoreError("not_allowed", "Operation is outside this run grant");
    return;
  }
  throw new CoreError("not_allowed", "Operation is not allowed by this run grant");
}

/** The orchestrator task for a live grant's turn (HTTP/MCP have no PACER_TASK_ID). */
export function orchestratorTaskIdForGrant(ctx: Ctx, grant: RunGrant): string | undefined {
  return getTurn(ctx, grant.turnId)?.taskId;
}

/** Core gate for a `PACER_RUN_GRANT` caller: only RUN_GRANT_OPS on this run. */
export function authorizeRunGrantOperation(ctx: Ctx, name: string, params: unknown): void {
  const token = ctx.env.PACER_RUN_GRANT;
  if (!token) throw new CoreError("not_allowed", "A run grant is required");
  const grant = verifyRunGrant(ctx, token);
  if (!grant) throw new CoreError("not_allowed", "Expired or revoked run grant");
  if (!(RUN_GRANT_OPS as readonly string[]).includes(name)) {
    throw new CoreError("not_allowed", "Operation is not allowed by this run grant");
  }
  assertRunGrantTarget(ctx, grant, name, params);
}
