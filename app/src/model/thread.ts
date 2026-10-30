import type { Message } from "../../../src/messaging/types";
import { clock } from "../../../src/view-model/time";
import { handBackWords, messageDeliveryWords, messageKindWords, messageRefusalWords, stalledWords } from "../../../src/view-model/words";

/** A task thread's view model: plain sender labels, kind chips, grouping and readable times. No DOM. */
export type ThreadMessage = Message;
export interface ThreadEntry { id: string; time: string; datetime: string; chip: string | null; body: string; unread: boolean }
export interface ThreadGroup { key: string; from: string; sender: string; entries: ThreadEntry[] }
export interface ThreadViewModel { groups: ThreadGroup[]; unreadIds: string[]; openQuestion: ThreadEntry | null; latest: string | null; empty: boolean }

/** Consecutive messages from one sender within this window share one sender label. */
const GROUP_S = 10 * 60;
const taskId = (participant: string) => participant.startsWith("task:") ? participant.slice(5) : null;

export function participantLabel(participant: string, titleOf: (task: string) => string | undefined = () => undefined): string {
  if (participant === "human") return "You";
  if (participant === "broker") return "pacer";
  if (participant.startsWith("external:")) return "Planner";
  const id = taskId(participant);
  if (!id) return "Someone else";
  const title = titleOf(id)?.trim();
  return title ? `Task: ${title}` : "Task";
}
export const kindChip = (kind: string): string | null => messageKindWords(kind);

const order = (a: ThreadMessage, b: ThreadMessage) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const unreadForHuman = (m: ThreadMessage) => m.to === "human" && m.status !== "read" && m.readAt === null && m.status !== "held";

export function threadView(messages: readonly ThreadMessage[], o: { now: number; titleOf?: (task: string) => string | undefined; timeZone?: string }): ThreadViewModel {
  const sorted = [...messages].sort(order), groups: ThreadGroup[] = [];
  let last: ThreadMessage | undefined;
  for (const m of sorted) {
    const entry: ThreadEntry = { id: m.id, time: clock(m.createdAt, o.now, o.timeZone), datetime: new Date(m.createdAt * 1000).toISOString(), chip: kindChip(m.kind), body: m.body, unread: unreadForHuman(m) };
    const group = groups.at(-1);
    if (group && last && last.from === m.from && m.createdAt - last.createdAt <= GROUP_S) group.entries.push(entry);
    else groups.push({ key: m.id, from: m.from, sender: participantLabel(m.from, o.titleOf), entries: [entry] });
    last = m;
  }
  const answered = new Set(sorted.filter(m => m.kind === "answer" && m.replyTo).map(m => m.replyTo));
  const question = sorted.findLast(m => m.kind === "question" && m.to === "human");
  const entries = groups.flatMap(g => g.entries);
  return {
    groups, unreadIds: sorted.filter(unreadForHuman).map(m => m.id),
    openQuestion: question && !answered.has(question.id) ? entries.find(e => e.id === question.id)! : null,
    latest: sorted.at(-1)?.id ?? null, empty: !sorted.length,
  };
}

/** Plain copy for a refused send: the service's `data.reason`, never the code itself. */
export function sendRefusal(error: unknown): { text: string; blocking: boolean } {
  const data = (error as { data?: unknown } | null)?.data;
  const reason = data && typeof data === "object" ? (data as { reason?: unknown }).reason : undefined;
  return { text: messageRefusalWords(typeof reason === "string" ? reason : undefined), blocking: ["msg_node_closed", "msg_forbidden", "msg_live_unavailable", "msg_worktree_unavailable"].includes(String(reason)) };
}
export const sendOutcome = (delivery: string | undefined): string => messageDeliveryWords(delivery);

/** The fields the liveness broker and the live driver add to a task; both may be absent on older services. */
export interface LivenessInput { liveness?: { stalled?: boolean; reason?: string } | null; liveBlocked?: string | null }
export function livenessNotice(task: LivenessInput | null | undefined): string | null {
  if (task?.liveness?.stalled) return stalledWords;
  if (task?.liveBlocked === "viewer" || task?.liveness?.reason === "viewer") return handBackWords;
  return null;
}
