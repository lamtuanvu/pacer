/**
 * The Live board's message bar sends through the same lanes agents use: `msg.send` to `task:<id>`.
 * party = the run's orchestrator and its running agents, whisper = one agent, planner = the orchestrator only.
 */
import { messageDeliveryWords } from "../../../../src/view-model/words";
import { sendRefusal } from "../../model/thread";

export type MessageChannel = "party" | "whisper" | "planner";

export const CHANNEL_LABELS: Record<MessageChannel, string> = { party: "Everyone", whisper: "One agent", planner: "Planner" };
export const CHANNEL_HINTS: Record<MessageChannel, string> = {
  party: "The planner and every agent working now.",
  whisper: "Only the agent you pick.",
  planner: "Only the planner, which decides for the run.",
};

export interface MessageContext {
  orchestratorTaskId?: string;
  /** Agents with a place on the board (running steps with a task). */
  agentTaskIds: string[];
  whisperTaskId?: string;
}

export type TargetResult = { ok: true; to: string[] } | { ok: false; reason: string };

const participant = (taskId: string) => `task:${taskId}`;

export function messageTargets(channel: MessageChannel, ctx: MessageContext): TargetResult {
  if (channel === "planner") {
    return ctx.orchestratorTaskId ? { ok: true, to: [participant(ctx.orchestratorTaskId)] } : { ok: false, reason: "This run has no planner to message." };
  }
  if (channel === "whisper") {
    if (!ctx.whisperTaskId) return { ok: false, reason: "Pick the agent to whisper to." };
    if (!ctx.agentTaskIds.includes(ctx.whisperTaskId)) return { ok: false, reason: "That agent is no longer working." };
    return { ok: true, to: [participant(ctx.whisperTaskId)] };
  }
  const ids = [...new Set([...(ctx.orchestratorTaskId ? [ctx.orchestratorTaskId] : []), ...ctx.agentTaskIds])];
  return ids.length ? { ok: true, to: ids.map(participant) } : { ok: false, reason: "Nobody is working on this run right now." };
}

/** One recipient's result: the service's `delivery`, or the plain refusal when the send was refused or failed. */
export interface RecipientResult { to: string; delivery?: string; refusal?: string }
export interface SendOutcome { results: RecipientResult[] }

/** Send one body to each target in turn. A failure for one recipient does not stop the others. */
export async function sendToTargets(send: (to: string, body: string) => Promise<unknown>, to: string[], body: string): Promise<SendOutcome> {
  const out: SendOutcome = { results: [] };
  for (const target of to) {
    try {
      const r = await send(target, body);
      const delivery = r && typeof r === "object" && typeof (r as { delivery?: unknown }).delivery === "string" ? (r as { delivery: string }).delivery : undefined;
      out.results.push({ to: target, ...(delivery ? { delivery } : {}) });
    } catch (e) {
      // The raw error stays in the console; the page shows plain words (UI-12).
      console.warn("runs: message send failed", e);
      out.results.push({ to: target, refusal: sendRefusal(e).text });
    }
  }
  return out;
}

/** A delivery that reached, or will reach, the task. Everything else is stored but not delivered (held, closed, capped, no session, ...). */
const REACHED = new Set(["turn_started", "queued", "live", "pull"]);
const wordsFor = (delivery: string | undefined): string => delivery === "pending" ? "Message recorded; delivery is not confirmed yet." : messageDeliveryWords(delivery);
const reached = (r: RecipientResult): boolean => !r.refusal && (r.delivery === undefined || REACHED.has(r.delivery));

export interface SendSummary {
  /** Plain words for the person: the shared delivery or refusal copy, with counts when several were addressed. */
  text: string;
  /** True when anything was not delivered; shown as an alert, not a quiet confirmation. */
  problem: boolean;
  /** The service stored the message for at least one recipient, so the box can be cleared. */
  stored: boolean;
}

export function summarizeSend(results: RecipientResult[]): SendSummary {
  const stored = results.some(r => !r.refusal);
  if (results.length === 1) {
    const r = results[0]!;
    if (r.refusal) return { text: r.refusal, problem: true, stored };
    return { text: wordsFor(r.delivery), problem: !reached(r), stored };
  }
  const ok = results.filter(reached).length;
  const held = results.filter(r => !r.refusal && !reached(r));
  const refused = results.filter(r => r.refusal);
  const parts = [`Delivered to ${ok} of ${results.length} recipients.`];
  if (held.length) parts.push(`${held.length} saved but not delivered: ${[...new Set(held.map(r => wordsFor(r.delivery)))].join(" ")}`);
  if (refused.length) parts.push(`${refused.length} not sent: ${[...new Set(refused.map(r => r.refusal))].join(" ")}`);
  return { text: parts.join(" "), problem: ok < results.length, stored };
}
