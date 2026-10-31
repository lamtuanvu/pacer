/** Task messages shown in the TUI detail pane. */
import type { Message } from "../../messaging/types";
import { messageKindWords } from "../../view-model/words";
import { clock } from "../../view-model/time";
import { heading, span, wrap } from "../frame";
import type { Act } from "../state";
import { blank, empty } from "./common";
import type { Resource, Row, ScreenCtx, TaskDetail } from "./types";

export type ThreadDetail = TaskDetail & { messages?: Resource<Message[]> };
export const threadMessages = (detail?: TaskDetail): Resource<Message[]> | undefined => (detail as ThreadDetail | undefined)?.messages;

function sender(from: string, ctx: ScreenCtx): string {
  if (from === "human") return "You";
  if (from === "broker") return "pacer";
  if (from.startsWith("external:")) return "Planner";
  if (from.startsWith("task:")) {
    const task = ctx.s.tasks.find(t => t.id === from.slice(5));
    return task ? `Task: ${task.title ?? task.goal ?? "Task"}` : "Task";
  }
  return "Someone else";
}

/** Render human-facing copy without exposing participant ids or reason codes. */
export function threadRows(ctx: ScreenCtx, detail: TaskDetail, messages: readonly Message[] | undefined, width: number): Row[] {
  const rows: Row[] = [blank(), { line: heading(ctx.theme, "Thread") }];
  const resource = threadMessages(detail);
  if (!messages) return [...rows, empty(resource?.error ? "Messages are unavailable. Refresh to try again." : "Loading messages…")];
  if (!messages.length) return [...rows, empty("No messages yet.")];
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let previous: Message | undefined;
  for (const m of sorted.slice(-20)) {
    if (!previous || previous.from !== m.from || m.createdAt - previous.createdAt > 600)
      rows.push({ line: [span(sender(m.from, ctx), { bold: true })] });
    const chip = messageKindWords(m.kind);
    rows.push({ line: [span(clock(m.createdAt, ctx.now, ctx.timeZone), { fg: "muted" }), ...(chip ? [span(`  ${chip}`, { fg: "secondary" })] : []), ...(m.to === "human" && m.status !== "read" && m.status !== "held" ? [span("  New", { fg: "accent" })] : [])] });
    rows.push(...wrap(m.body, width).map(line => ({ line: [span(line)] })));
    previous = m;
  }
  return rows;
}

export function threadActs(ctx: ScreenCtx, id: string, detail?: TaskDetail): { reply?: Act; answer?: Act } {
  if (!ctx.supports("msg.send") || !threadMessages(detail)) return {};
  const task = ctx.s.tasks.find(t => t.id === id);
  if (task?.review || task?.dismissed || task?.state === "stopped") return {};
  const messages = threadMessages(detail)?.value ?? [];
  const answered = new Set(messages.filter(m => m.kind === "answer" && m.replyTo).map(m => m.replyTo));
  const latestQuestion = [...messages].reverse().find(m => m.kind === "question" && m.to === "human");
  const question = latestQuestion && !answered.has(latestQuestion.id) ? latestQuestion : undefined;
  const prompt = (label: string, kind: "message" | "answer", replyTo?: string): Act => ({
    label, effect: { type: "prompt", prompt: { title: label, label: "Message", required: "Add a message first.",
      submit: body => ({ type: "action", action: { label: kind === "answer" ? "Answer sent" : "Reply sent", op: "msg.send",
        params: { to: `task:${id}`, body, kind, ...(replyTo ? { reply_to: replyTo } : {}) } } }) } },
  });
  return { reply: prompt("Reply", "message"), ...(question ? { answer: prompt("Answer", "answer", question.id) } : {}) };
}
