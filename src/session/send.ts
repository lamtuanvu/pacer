import { checkRev, taskActivity } from "../core/tasks";
import { CoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import { type Backend, backendById } from "../exec/backend";
import { isTaskId, readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

const unknown = (id: string) => new CoreError("unknown_task", `unknown task ${id}`);

/**
 * How recently someone else must have sent for `pacer send` to refuse without `--force`. pacer has
 * no way to see a human typing directly in the host's own terminal UI (see the interactive-lanes design
 * doc); this is a cooperative lease between pacer's own callers, not a process-level lock.
 */
export const DRIVING_LEASE_S = 60;

export interface SendOptions { force?: boolean; by?: string; expectRev?: number; backends?: Backend[] }

/**
 * Who is sending, for the driving lease and the timeline. A service client is its `X-Pacer-Client` label; a CLI call
 * is the terminal it runs in, so two planners in two terminals contend while one planner never contends with itself.
 */
export function callerIdentity(ctx: Ctx, client?: string): string {
  if (client) return `client:${client}`;
  const user = ctx.env.USER?.trim() || "planner";
  const session = ctx.env.ORCA_TERMINAL_HANDLE?.trim() || ctx.env.TMUX_PANE?.trim() || ctx.env.TERM_SESSION_ID?.trim();
  return session ? `${user}@${session}` : user;
}

/**
 * Deliver one message into an interactive lane's live worker through the backend that owns it. Records it on the task's
 * timeline; does not create a new attempt. The state, revision and lease checks run under the task lock with every
 * other task mutation, and the lease is claimed there before delivery, so a concurrent sender sees it and is refused.
 */
export async function send(ctx: Ctx, id: string, text: string, o: SendOptions = {}): Promise<TaskRecord> {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", "executors cannot use pacer send; use pacer ask");
  if (!isTaskId(id)) throw unknown(id);
  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    throw new CoreError("invalid_input", "message must contain 1–4000 characters");
  }
  const by = o.by?.trim() || callerIdentity(ctx);
  const claim = withTaskLock(ctx, id, () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    checkRev(ctx, task, o.expectRev);
    // Only a running lane has a runner supervising its worker; one waiting on its question is answered instead, so
    // the agent's resumed work is captured by the answering attempt.
    if (task.state === "needs_input") throw new CoreError("conflict", `task is waiting for an answer; use pacer answer ${id}`);
    if (task.state !== "running") throw new CoreError("conflict", `task is ${task.state}, not running`);
    if (!task.live) throw new CoreError("unavailable", "this task has no live terminal to send into", "only an interactive lane (delegate --interactive) on a backend that keeps its worker live accepts messages");
    if (!backendById(task.live.backend, o.backends)?.live) {
      throw new CoreError("unavailable", `the ${task.live.backend} backend cannot deliver live input`);
    }
    const holder = task.driving;
    const contended = !!holder && holder.by !== by && ctx.now - holder.at < DRIVING_LEASE_S;
    if (contended && !o.force) {
      throw new CoreError("conflict", `${holder!.by} sent a message ${Math.round(ctx.now - holder!.at)}s ago; use --force to send anyway`);
    }
    const claimed = updateTask(ctx, id, t => { t.driving = { by, at: ctx.now }; });
    return { task: claimed, previous: holder, contended };
  });
  const live = claim.task.live!;
  const delivered = await backendById(live.backend, o.backends)!.live!.send(ctx, claim.task, text);
  if (!delivered.ok) {
    // Nothing was delivered: give the lease back unless someone else has claimed it since.
    withTaskLock(ctx, id, () => updateTask(ctx, id, t => {
      if (t.driving?.by !== by || t.driving.at !== ctx.now) return;
      if (claim.previous) t.driving = claim.previous; else delete t.driving;
    }));
    throw new CoreError(delivered.code, delivered.message);
  }
  const updated = readTask(ctx, id) ?? claim.task;
  taskActivity(ctx, updated, "message", `Sent${claim.contended ? ` (took over from ${claim.previous!.by})` : ""}: ${text.slice(0, 200)}`);
  return updated;
}
