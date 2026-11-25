/**
 * The Live board's message bar sends through the same lanes agents use: `msg.send` to `task:<id>`.
 * party = the run's orchestrator and its running agents, whisper = one agent, planner = the orchestrator only.
 */
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

export interface SendOutcome { sent: string[]; failed: Array<{ to: string; message: string }> }

/** Send one body to each target in turn. A failure for one recipient does not stop the others. */
export async function sendToTargets(send: (to: string, body: string) => Promise<unknown>, to: string[], body: string): Promise<SendOutcome> {
  const out: SendOutcome = { sent: [], failed: [] };
  for (const target of to) {
    try { await send(target, body); out.sent.push(target); }
    catch (e) { out.failed.push({ to: target, message: e instanceof Error ? e.message : "The message could not be sent." }); }
  }
  return out;
}
