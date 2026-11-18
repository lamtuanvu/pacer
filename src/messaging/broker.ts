import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { requestReview } from "../core/tasks";
import type { Mode } from "../engine/mode";
import { publish } from "../link/publish";
import { readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import { stopRun } from "../supervisor/run";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { callerAlive, type CallerReach } from "./caller-reach";
import { analyzeLiveness, buildSnapshot, owesDecision, type Stall } from "./liveness";
import { clearLiveness, getLiveness, listLiveness, upsertLiveness, type LivenessUpsert } from "./liveness-store";
import { rootOf, taskOf } from "./participants";
import { effectivePolicy } from "./policy";
import { insertMessage, markRead } from "./store";
import { messagesDatabase } from "./store";
import { deliver } from "./turns";

export interface BrokerReport { skipped?: "locked" | "mode_unavailable"; stalls?: number; actions?: number }
/** The wake step for a caller that owes a decision, injected so src/messaging never names a host or a planner. */
export type CallerWakeResult = "sent" | "busy" | "gone" | "resumed" | "unavailable";
export interface BrokerDeps {
  spawnRunner?: SpawnRunner;
  mode: () => Promise<Mode | undefined>;
  callerWake?: (ctx: Ctx, reach: CallerReach, text: string, step: "ping" | "resume", taskId: string) => Promise<CallerWakeResult>;
}

function progressMark(ctx: Ctx, stall: Stall, snapshot: ReturnType<typeof buildSnapshot>): string {
  const n = snapshot.tasks.find(n => `task:${n.task.id}` === stall.node), task = n?.task;
  const last = messagesDatabase(ctx).query<{ id: string }, [string]>("SELECT id FROM messages WHERE sender=? AND kind<>'nudge' ORDER BY id DESC LIMIT 1").get(stall.node);
  // A spinner moves lastOutputAt every tick; a no-progress stall resets only on progress.
  const moved = stall.reason === "no_progress" ? n?.lastProgressAt : task?.progress?.lastOutputAt;
  return JSON.stringify([task?.state, task?.attempts.length, task?.settledAt, moved, last?.id]);
}

function publishRow(ctx: Ctx, row: LivenessUpsert | null, node: string): void {
  void publish(ctx, [{ type: "entity", data: { kind: "liveness", id: node, ...(row ? { value: row } : { removed: true }) } }]);
}

/** The one line typed into the caller's terminal or handed to its resume prompt (design §3). */
function callerText(t: TaskRecord, question: string | undefined): string {
  return t.state === "needs_input"
    ? `pacer: task ${t.id} asked a question. Answer with pacer msg send ${t.id} --answer ${question}.`
    : `pacer: task ${t.id} is ${t.state}. Review and decide: pacer review ${t.id} --accept|--reject, or pacer msg inbox.`;
}

/** One bounded reconciliation pass. The file lock also prevents a second service process from acting on the same stall. */
export async function brokerTick(ctx: Ctx, deps: BrokerDeps): Promise<BrokerReport> {
  try {
    return await withLock(ctx, "msg-broker", async () => {
      const mode = await deps.mode();
      if (!mode) return { skipped: "mode_unavailable" };
      const snapshot = buildSnapshot(ctx);
      const stalls = analyzeLiveness(snapshot, ctx.now);
      const present = new Set(stalls.map(s => s.node));
      for (const row of listLiveness(ctx)) if (row.reason && !present.has(row.node)) {
        clearLiveness(ctx, row.node); publishRow(ctx, null, row.node);
      }
      let actions = 0;
      const cycleTargets = new Set<string>();
      for (const stall of stalls) {
        const node = stall.node;
        const root = taskOf(node) ? rootOf(ctx, node) : undefined;
        const config = effectivePolicy(ctx, { root }).config.liveness;
        const allowed = config.nudge_in_modes.includes(mode);
        const old = getLiveness(ctx, node);
        const mark = progressMark(ctx, stall, snapshot), seen = snapshot.tasks.find(n => `task:${n.task.id}` === node);
        // Per attempt, so a retried task's pings are not taken for the previous attempt's.
        const pingId = (n: number) => `nudge:${node}:a${seen?.task.run?.attempt ?? 0}:${n}`;
        const changed = old?.progressMark !== mark || old.reason !== stall.reason;
        const row: LivenessUpsert = old && !changed ? { ...old } : {
          // A no_progress stall started at the last progress, which the attention detail counts from.
          node, reason: stall.reason, since: stall.reason === "no_progress" ? seen?.lastProgressAt ?? ctx.now : ctx.now, attempts: 0, nudges: 0, nextAt: ctx.now + config.interval_s,
          progressMark: mark, stalledAt: null, escalatedAt: null,
        };
        row.reason = stall.reason;
        const nudged = stall.reason === "cycle" || stall.reason === "idle_run" || stall.reason === "no_progress";
        // Nudges wait one interval after the stall is first seen; a zero cap or a mode without nudges escalates at once.
        if (ctx.now < row.nextAt && nudged && allowed && config.max_nudges > 0) { upsertLiveness(ctx, row); continue; }
        if (ctx.now < row.nextAt && !changed) continue;
        let acted = false;
        let stallNow = false;
        if (stall.reason === "undelivered") {
          if (!allowed) stallNow = true;
          else {
            const result = (await deliver(ctx, node, deps.spawnRunner)).delivery;
            acted = true;
            stallNow = ["cap", "no_session", "closed", "live_unavailable"].includes(result);
          }
        } else if (stall.reason === "no_progress") {
          if (!allowed) stallNow = true;
          // Ping first; only pings that go unanswered stop the run.
          else if (row.nudges < config.max_nudges) {
            insertMessage(ctx, { taskId: taskOf(node), rootId: rootOf(ctx, node), from: "broker", to: node,
              kind: "nudge", body: `pacer: no progress for ${snapshot.noProgressS / 60} min. Report progress, ask your parent, or report a blocker.`,
              replyTo: null, requestId: pingId(row.nudges + 1) });
            await deliver(ctx, node, deps.spawnRunner);
            row.nudges++; acted = true;
          } else {
            // Record it on the attempt first, so the runner classifies the stopped run even across a restart.
            // Only the run the broker saw stall is marked and stopped; a run that ended or was replaced since is left alone.
            const id = taskOf(node)!, run = seen?.task.run;
            let marked = false;
            if (run) updateTask(ctx, id, t => {
              if (t.state !== "running" || t.run?.dir !== run.dir || t.run.startedAt !== run.startedAt || t.unresponsive?.attempt === t.run.attempt) return;
              t.unresponsive = { attempt: t.run.attempt, pings: row.nudges };
              marked = true;
            });
            if (marked && run) {
              acted = true;
              // Unanswered pings must not resume the task once its run is stopped.
              const pings = messagesDatabase(ctx).query<{ id: string }, [string]>(
                "SELECT id FROM messages WHERE sender='broker' AND recipient=? AND kind='nudge' AND status<>'read'").all(node).map(r => r.id);
              markRead(ctx, node, pings);
              await stopRun(run.dir);
            }
          }
        } else if (nudged) {
          if ((stall.reason === "cycle" && !stall.deepest) || !allowed || row.nudges >= config.max_nudges) stallNow = true;
          else if (node === stall.deepest && !cycleTargets.has(node)) {
            cycleTargets.add(node);
            const chain = `${node} → ${stall.waitingOn ?? node} → ${node}`;
            insertMessage(ctx, { taskId: taskOf(node), rootId: rootOf(ctx, node), from: "broker", to: node,
              kind: "nudge", body: `pacer: your conversation is waiting on you (cycle: ${chain}). Answer the open question, ask your parent, or report.`,
              replyTo: null, requestId: pingId(row.nudges + 1) });
            await deliver(ctx, node, deps.spawnRunner);
            row.nudges++; acted = true;
          } else if (stall.reason === "idle_run") {
            // As supervise does for an idle run: stop the turn, then a nudge resumes it once the task settles.
            const task = readTask(ctx, taskOf(node)!);
            if (task?.run?.dir) await stopRun(task.run.dir);
            insertMessage(ctx, { taskId: taskOf(node), rootId: rootOf(ctx, node), from: "broker", to: node,
              kind: "nudge", body: "pacer: your run was idle. Resume the work, ask for help, or report progress.",
              replyTo: null, requestId: pingId(row.nudges + 1) });
            await deliver(ctx, node, deps.spawnRunner);
            row.nudges++; acted = true;
          }
        } else if (stall.reason === "caller_decision") {
          // Hooks hold the message first; the caller itself is woken only once caller_wake_after_s has passed.
          const notify = () => { stallNow = true; acted = true; };
          const due = ctx.now >= row.since + config.caller_wake_after_s;
          const escalate = ctx.now >= row.since + config.escalate_after_s;
          if (!allowed) notify();
          else if (!due || row.nudges >= config.max_nudges) { if (escalate) notify(); }
          else {
            const task = snapshot.tasks.find(n => n.task.origin === node && owesDecision(n.task))?.task;
            const question = task ? snapshot.questions.find(m => m.taskId === task.id && m.to === node)?.id : undefined;
            const text = task && (task.state !== "needs_input" || question) ? callerText(task, question) : null;
            const reach = task?.callerReach;
            const wake = deps.callerWake;
            const taskId = task?.id ?? "";
            // A human origin is never woken. An open caller in a controllable terminal is pinged;
            // a closed caller (gone) is resumed in the background; unknown liveness never wakes.
            let step: "ping" | "resume" | null = null;
            if (wake && text && reach && node !== "human") {
              const state = await callerAlive(ctx, reach);
              if (state === "alive" && reach.terminal.kind === "orca") step = "ping";
              else if (state === "gone") step = "resume";
            }
            if (step) {
              const result = await wake!(ctx, reach!, text!, step, taskId);
              if (result === "sent" || result === "resumed") { row.nudges++; acted = true; }
              // A busy terminal is retried on the next tick without spending a wake.
              else if (result === "busy") { if (escalate) notify(); else row.nextAt = ctx.now; }
              else if (result === "unavailable") { if (escalate) notify(); else row.nextAt = row.since + config.escalate_after_s; }
              else if (escalate) notify();
            } else if (escalate) notify();
          }
        } else if (stall.reason === "unread_external") {
          if (!allowed || ctx.now >= row.since + config.escalate_after_s) {
            row.escalatedAt ??= ctx.now; acted = true;
          }
        } else if (stall.reason === "unread_human") {
          if (!allowed || ctx.now >= row.since + config.escalate_after_s) row.escalatedAt ??= ctx.now;
          acted = true;
        }
        if (acted) {
          row.attempts++;
          // Nudges back off by nudge count; delivery retries and human reminders by their own attempts.
          row.nextAt = ctx.now + Math.min(config.interval_s * 2 ** (nudged ? row.nudges : row.attempts), config.backoff_max_s);
          actions++;
        }
        // Delivery retries keep going on their backoff, but the node is shown as stalled after max_nudges of them.
        if (stallNow || (nudged && row.nudges >= config.max_nudges) || (stall.reason === "undelivered" && acted && row.attempts >= config.max_nudges)) {
          row.stalledAt ??= ctx.now;
          row.escalatedAt ??= ctx.now;
          const id = taskOf(node), task = id ? readTask(ctx, id) : null;
          if (task && ["done", "partial"].includes(task.state) && !task.review && !task.reviewRequest) {
            try { requestReview(ctx, id!, { note: "This conversation is stalled and needs a decision." }); }
            catch (error) { if (!(error instanceof CoreError && error.code === "conflict")) throw error; }
          }
        }
        upsertLiveness(ctx, row);
        // Escalation is published when it happens or the row moves, not again on every tick.
        if ((row.stalledAt || row.escalatedAt) && (acted || row.stalledAt !== old?.stalledAt || row.escalatedAt !== old?.escalatedAt)) publishRow(ctx, row, node);
      }
      return { stalls: stalls.length, actions };
    }, { timeoutMs: 0, staleMs: 10 * 60_000 });
  } catch (error) {
    if (error instanceof Error && error.message.includes("timed out waiting for")) return { skipped: "locked" };
    throw error;
  }
}
