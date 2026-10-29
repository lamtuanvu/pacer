import type { TaskDetail } from "../../../../src/core/task-detail";
import type { AttentionItem } from "../../../../src/api/read-model/types";
/** missing: a task the URL asked for that is no longer waiting for review; the screen says so rather than picking another. */
export interface ReviewView { queue: AttentionItem[]; selectedId: string | null; noteFor: "reject" | "send_back" | null; pending: boolean; missing: string | null }
export const initialReview: ReviewView = { queue: [], selectedId: null, noteFor: null, pending: false, missing: null };
export type ReviewAction =
  | { type: "queue"; items: AttentionItem[] } | { type: "move"; by: 1 | -1 }
  | { type: "select"; id: string } | { type: "request"; id: string } | { type: "verdict-sent" } | { type: "verdict-settled" }
  | { type: "verdict-done"; id: string } | { type: "open-note"; for: "reject" | "send_back" } | { type: "close-note" };
function queue(v: ReviewView, items: AttentionItem[]): ReviewView {
  const index = v.queue.findIndex(i => i.taskId === v.selectedId);
  const ids = new Set(items.map(i => i.taskId));
  const successor = v.queue.slice(index + 1).find(i => ids.has(i.taskId));
  const predecessor = v.queue.slice(0, Math.max(0, index)).reverse().find(i => ids.has(i.taskId));
  const selectedId = ids.has(v.selectedId ?? undefined) ? v.selectedId
    : v.missing ? null : successor?.taskId ?? predecessor?.taskId ?? items[0]?.taskId ?? null;
  return { ...v, queue: items, selectedId, ...(selectedId !== v.selectedId ? { noteFor: null } : {}) };
}
export function reviewReducer(v: ReviewView, a: ReviewAction): ReviewView {
  switch (a.type) {
    case "queue": return queue(v, a.items);
    case "select": return v.queue.some(i => i.taskId === a.id) ? { ...v, selectedId: a.id, missing: null, noteFor: a.id === v.selectedId ? v.noteFor : null } : v;
    case "request": return v.queue.some(i => i.taskId === a.id) ? reviewReducer(v, { type: "select", id: a.id }) : { ...v, selectedId: null, noteFor: null, missing: a.id };
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
  return { id: task.id, verdict: v.verdict,
    ...(v.note?.trim() ? { note: v.note } : {}), ...(v.kind ? { kind: v.kind } : {}), ...(v.executor ? { executor: v.executor } : {}),
    // The service answers conflict when the task moved on (another client reviewed it), instead of overwriting that verdict.
    ...(typeof task.rev === "number" ? { expect_rev: task.rev } : {}) };
}

/** Line numbers come from hunk coordinates, never from the patch array index. */
export interface NumberedDiffLine { kind: string; text: string; mark: string; old?: number; next?: number }
export function numberDiffLines(lines: {kind:string; text:string}[]): NumberedDiffLine[] {
  let old = 0, next = 0;
  return lines.filter(line => line.kind !== "meta").map(line => {
    if (line.kind === "hunk") {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
      if (match) {old = Number(match[1]); next = Number(match[2]);}
      return {...line, mark:"", text:line.text};
    }
    if (line.kind === "added") return {...line, mark:"+", text:line.text.slice(1), next:next++};
    if (line.kind === "removed") return {...line, mark:"−", text:line.text.slice(1), old:old++};
    return {...line, mark:"", text:line.text.slice(1), old:old++, next:next++};
  });
}
export function splitDiffRows(lines: NumberedDiffLine[]): {before?: NumberedDiffLine; after?: NumberedDiffLine}[] {
  const result: {before?: NumberedDiffLine; after?: NumberedDiffLine}[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.kind !== "added" && line.kind !== "removed") {result.push({before:line,after:line}); i++; continue;}
    const before: NumberedDiffLine[] = [], after: NumberedDiffLine[] = [];
    while (i < lines.length && ["added", "removed"].includes(lines[i]!.kind)) {
      const entry = lines[i++]!; (entry.kind === "removed" ? before : after).push(entry);
    }
    for (let n = 0; n < Math.max(before.length, after.length); n++) result.push({before:before[n], after:after[n]});
  }
  return result;
}

/** After a managed rejection, retry the freshly revised work rather than creating a new lineage. */
export async function retryReviewedWork(id: string, note: string, call: <T>(op: string, params: unknown) => Promise<T>) {
  const task = await call<{rev: number}>("task.get", {id});
  return call("dispatch.retry", {id, expect_rev:task.rev, requestId:`${id}.${task.rev}.retry`, feedback:note.trim()});
}

/** Session metadata exposes the current run attempt even when there is no PTY recording. */
export function canOpenResultFile(task: TaskDetail, session: {host: string; machine: string | null; attempt?: number | null} | undefined, path: string | undefined): boolean {
  const file = task.files.find(file => file.path === path);
  return task.backend === "direct" && !task.machine && !!session && !session.machine && session.host !== "orca"
    && task.attempts.length > 0 && session.attempt === task.attempts.length && !!file && file.status !== "deleted" && !file.binary;
}
