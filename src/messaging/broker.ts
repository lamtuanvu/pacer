import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { requestReview } from "../core/tasks";
import type { Mode } from "../engine/mode";
import { executorExclusion } from "../executors/availability";
import { publish } from "../link/publish";
import { readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import { stopRun } from "../supervisor/run";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { callerAlive, type CallerReach } from "./caller-reach";
import { analyzeLiveness, buildSnapshot, owesDecision, type Stall } from "./liveness";
import { clearLiveness, getLiveness, listLiveness, upsertLiveness, type LivenessUpsert } from "./liveness-store";
import { refreshAllPromptWaits } from "../workflow/prompt-detector";
import { rootOf, taskOf } from "./participants";
import { effectivePolicy } from "./policy";
import { insertMessage, markRead } from "./store";
import { messagesDatabase } from "./store";
import { deliver } from "./turns";

/**
 * Cheap local guard: exhausted.json / blocked.json via executorExclusion (no provider I/O).
 * Unknown executor → allow the nudge; only skip when we know the account cannot spend.
 */
function executorCanSpend(ctx: Ctx, task: TaskRecord | undefined): boolean {
  const id = task?.run?.executor ?? task?.attempts.at(-1)?.executor;
  if (!id) return true;
  try {
    return !executorExclusion(ctx, loadStrategy(ctx), id);
  } catch {
    return true;
  }
}

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
  // A spinner moves lastOutputAt every tick; no_progress / silent_prompt reset only on real progress.
  // silent_prompt must not use silentSince here: report.at moves on every Stop and would reset nudges forever.
  const moved = stall.reason === "no_progress" || stall.reason === "silent_prompt" ? n?.lastProgressAt
    : task?.progress?.lastOutputAt;
  // A caller's ladder restarts when another of its tasks settles, so each pending decision gets wakes.
  const pending = stall.reason === "caller_decision" ? stall.blocking : undefined;
  // silent_prompt retains across temporary working gaps only while this attempt's progressMark still matches.
  const attempt = stall.reason === "silent_prompt" ? task?.run?.attempt ?? 0 : null;
  return JSON.stringify([task?.state, task?.attempts.length, task?.settledAt, moved, last?.id, pending, attempt]);
}

/**
 * After a silent_prompt nudge the agent often leaves needs-input briefly; analyzeLiveness then has no stall and
 * the broker would clear the row, resetting nudges forever. Keep the row while the same attempt is still running
 * and lastProgressAt has not moved past the row's progressMark. Clear on real progress, settle, or new attempt.
 */
function retainAbsentSilentPrompt(ctx: Ctx, row: { reason: string; node: string; progressMark: string | null }, snapshot: ReturnType<typeof buildSnapshot>): boolean {
  if (row.reason !== "silent_prompt" || !row.progressMark) return false;
  const seen = snapshot.tasks.find(n => `task:${n.task.id}` === row.node);
  if (!seen || seen.task.state !== "running" || !seen.task.run) return false;
  return progressMark(ctx, { node: row.node, reason: "silent_prompt", blocking: [] }, snapshot) === row.progressMark;
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
      refreshAllPromptWaits(ctx);
      const stalls = analyzeLiveness(snapshot, ctx.now);
      const present = new Set(stalls.map(s => s.node));
      for (const row of listLiveness(ctx)) if (row.reason && !present.has(row.node)) {
        if (retainAbsentSilentPrompt(ctx, row, snapshot)) continue;
        clearLiveness(ctx, row.node); publishRow(ctx, null, row.node);
      }
      let actions = 0;
      const cycleTargets = new Set<string>();
      for (const stall of stalls) {
        const node = stall.node;
        const root = taskOf(node) ? rootOf(ctx, node) : undefined;
        const config = effectivePolicy(ctx, { root }).config.liveness;
        // Executor nudges vs planner wakes: separate mode gates. Strict saves the planner's budget only.
        const nudgeAllowed = config.nudge_in_modes.includes(mode);
        const wakeAllowed = config.caller_wake_in_modes.includes(mode);
        const old = getLiveness(ctx, node);
        const mark = progressMark(ctx, stall, snapshot), seen = snapshot.tasks.find(n => `task:${n.task.id}` === node);
        // Per attempt, so a retried task's pings are not taken for the previous attempt's.
        const pingId = (n: number) => `nudge:${node}:a${seen?.task.run?.attempt ?? 0}:${n}`;
        const changed = old?.progressMark !== mark || old.reason !== stall.reason;
        const row: LivenessUpsert = old && !changed ? { ...old } : {
          // A no_progress / silent_prompt stall started at the last progress or prompt wait, which attention counts from.
          node, reason: stall.reason,
          since: stall.reason === "no_progress" ? seen?.lastProgressAt ?? ctx.now
            : stall.reason === "silent_prompt" ? seen?.silentSince ?? seen?.task.attemptStartedAt ?? ctx.now
            : ctx.now,
          attempts: 0, nudges: 0, nextAt: ctx.now + config.interval_s,
          progressMark: mark, stalledAt: null, escalatedAt: null,
        };
        // A people node keeps its alert when its stall moves between unread messages and an owed decision,
        // or when another decision joins: the wakes restart, the escalation does not.
        const people = (r?: string) => r === "unread_external" || r === "unread_human" || r === "caller_decision";
        if (old && changed && people(old.reason) && people(stall.reason)) {
          if (old.reason !== stall.reason) row.since = Math.min(old.since, row.since);
          row.stalledAt = old.stalledAt ?? row.stalledAt; row.escalatedAt = old.escalatedAt ?? row.escalatedAt;
        }
        row.reason = stall.reason;
        const nudged = stall.reason === "cycle" || stall.reason === "idle_run" || stall.reason === "no_progress" || stall.reason === "silent_prompt";
        // An exhausted/blocked executor account cannot spend on a nudge — escalate instead (local marks only).
        const canSpend = !nudged && stall.reason !== "undelivered" ? true : executorCanSpend(ctx, seen?.task);
        // Nudges wait one interval after the stall is first seen; a zero cap or a mode without nudges escalates at once.
        if (ctx.now < row.nextAt && nudged && nudgeAllowed && canSpend && config.max_nudges > 0) { upsertLiveness(ctx, row); continue; }
        if (ctx.now < row.nextAt && !changed) continue;
        let acted = false;
        let stallNow = false;
        if (stall.reason === "undelivered") {
          if (!nudgeAllowed || !canSpend) stallNow = true;
          else {
            const result = (await deliver(ctx, node, deps.spawnRunner)).delivery;
            acted = true;
            stallNow = ["cap", "no_session", "closed", "live_unavailable"].includes(result);
          }
        } else if (stall.reason === "no_progress") {
          if (!nudgeAllowed || !canSpend) stallNow = true;
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
        } else if (stall.reason === "silent_prompt") {
          // Keep the live session; tell it to finish with pacer report or ask a real question.
          if (!nudgeAllowed || !canSpend || row.nudges >= config.max_nudges) stallNow = true;
          else {
            insertMessage(ctx, { taskId: taskOf(node), rootId: rootOf(ctx, node), from: "broker", to: node,
              kind: "nudge", body: "pacer: you are waiting at your prompt with no open question. Finish with `pacer report --outcome done|failed`, or ask a question via pacer.",
              replyTo: null, requestId: pingId(row.nudges + 1) });
            await deliver(ctx, node, deps.spawnRunner);
            row.nudges++; acted = true;
          }
        } else if (nudged) {
          if ((stall.reason === "cycle" && !stall.deepest) || !nudgeAllowed || !canSpend || row.nudges >= config.max_nudges) stallNow = true;
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
          if (!wakeAllowed) notify();
          else if (!due || row.nudges >= config.max_nudges) { if (escalate) notify(); }
          else {
            // The oldest pending decision the caller can be reached for and told about.
            const wakeable = snapshot.tasks.map(n => n.task).filter(t => t.origin === node && owesDecision(t) && t.callerReach)
              .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0) || a.id.localeCompare(b.id))
              .map(t => ({ t, q: snapshot.questions.find(m => m.taskId === t.id && m.to === node)?.id }))
              .find(({ t, q }) => t.state !== "needs_input" || q);
            const task = wakeable?.t, question = wakeable?.q;
            const text = task ? callerText(task, question) : null;
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
          if (!nudgeAllowed || ctx.now >= row.since + config.escalate_after_s) {
            row.escalatedAt ??= ctx.now; acted = true;
          }
        } else if (stall.reason === "unread_human") {
          if (!nudgeAllowed || ctx.now >= row.since + config.escalate_after_s) row.escalatedAt ??= ctx.now;
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
