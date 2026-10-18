import type { AttentionItem } from "../../../../src/api/read-model/types";
export interface ReviewView { queue: AttentionItem[]; selectedId: string | null; noteFor: "reject" | "send_back" | null; pending: boolean }
export const initialReview: ReviewView = { queue: [], selectedId: null, noteFor: null, pending: false };
export type ReviewAction =
  | { type: "queue"; items: AttentionItem[] } | { type: "move"; by: 1 | -1 }
  | { type: "select"; id: string } | { type: "verdict-sent" } | { type: "verdict-settled" }
  | { type: "verdict-done"; id: string } | { type: "open-note"; for: "reject" | "send_back" } | { type: "close-note" };
function queue(v: ReviewView, items: AttentionItem[]): ReviewView {
  const index = v.queue.findIndex(i => i.taskId === v.selectedId);
  const ids = new Set(items.map(i => i.taskId));
  const successor = v.queue.slice(index + 1).find(i => ids.has(i.taskId));
  const predecessor = v.queue.slice(0, Math.max(0, index)).reverse().find(i => ids.has(i.taskId));
  const selectedId = ids.has(v.selectedId ?? undefined) ? v.selectedId
    : successor?.taskId ?? predecessor?.taskId ?? items[0]?.taskId ?? null;
  return { ...v, queue: items, selectedId, ...(selectedId !== v.selectedId ? { noteFor: null } : {}) };
}
export function reviewReducer(v: ReviewView, a: ReviewAction): ReviewView {
  switch (a.type) {
    case "queue": return queue(v, a.items);
    case "select": return v.queue.some(i => i.taskId === a.id) ? { ...v, selectedId: a.id, noteFor: a.id === v.selectedId ? v.noteFor : null } : v;
    case "move": {
      const index = v.queue.findIndex(i => i.taskId === v.selectedId);
      const id = v.queue[Math.max(0, Math.min(v.queue.length - 1, index + a.by))]?.taskId;
      return id ? reviewReducer(v, { type: "select", id }) : v;
    }
    case "verdict-sent": return { ...v, pending: true };
    case "verdict-settled": return { ...v, pending: false };
    case "verdict-done": return { ...queue(v, v.queue.filter(i => i.taskId !== a.id)), pending: false, noteFor: null };
    case "open-note": return { ...v, noteFor: a.for };
    case "close-note": return { ...v, noteFor: null };
  }
}
export interface Verdict { verdict: "accept" | "reject" | "send_back" | "retry"; note?: string; kind?: string; executor?: string }
export function verdictParams(task: { id: string; rev?: number }, v: Verdict): Record<string, unknown> {
  if (v.verdict === "retry" && !v.executor?.trim()) throw new Error("Choose an executor to retry on.");
  if ((v.verdict === "reject" || v.verdict === "send_back") && !v.note?.trim()) throw new Error("Add a note first.");
  return { id: task.id, verdict: v.verdict, accepted: v.verdict === "accept",
    ...(v.note?.trim() ? { note: v.note } : {}), ...(v.kind ? { kind: v.kind } : {}), ...(v.executor ? { executor: v.executor } : {}) };
}
