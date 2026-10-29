import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getWork } from "../dispatch/work";
import type { Ctx } from "../types";
import type { Redactor } from "./redact";
import type { ActionCard } from "./types";

const id = z.string().min(1).max(128);
const hours = z.string().regex(/^([1-9]|1\d|2[0-4])h$|^([1-9]\d?|[1-9]\d{2}|1[0-3]\d{2}|1440)m$/, "A pause lasts at most 24 hours.");

/** Only these ops can be proposed. `requestId` and `expect_rev` are the host's, never the model's. */
const SCHEMAS = {
  retry: z.object({ id, feedback: z.string().max(2000).optional() }).strict(),
  stop: z.object({ id }).strict(),
  answer: z.object({ id, text: z.string().min(1).max(2000) }).strict(),
  "delegation.pause": z.object({ for: hours, reason: z.string().max(200).optional() }).strict(),
  "delegation.resume": z.object({}).strict(),
  "dispatch.submit": z.object({ goal: z.string().min(1).max(20000), repo: z.string().min(1).max(4096), title: z.string().max(500).optional() }).strict(),
  navigate: z.object({ to: z.enum(["task", "tasks", "needs-you", "overview", "settings-assistant"]), id: id.optional() }).strict(),
} as const;

export const PROPOSABLE = ["dispatch.retry", "task.retry", "dispatch.stop", "task.stop", "dispatch.answer", "task.answer", "delegation.pause", "delegation.resume", "dispatch.submit", "navigate"] as const;

export const proposalSchema = z.object({ op: z.string().max(64), params: z.record(z.string(), z.unknown()).default({}), why: z.string().max(600).default("") });
export type Proposal = z.infer<typeof proposalSchema>;

/** Read access to the task a card concerns. Injected in tests. */
export interface CardDeps { task(ctx: Ctx, id: string): { rev: number; title: string; state: string } | null; managed?(ctx: Ctx, id: string): boolean }

export type CardResult = { ok: true; card: ActionCard } | { ok: false; note: string };

const short = (title: string) => title.length > 60 ? `${title.slice(0, 57)}…` : title;

/** Builds a card from a proposal. The title and summary come from the op and its params, never from the model. */
export function buildCard(ctx: Ctx, proposal: Proposal, deps: CardDeps, redactor: Redactor): CardResult {
  const parsedProposal = proposalSchema.safeParse(proposal);
  if (!parsedProposal.success) return { ok: false, note: "A proposed action was dropped: it was malformed." };
  const { op, params, why } = parsedProposal.data;
  if (!(PROPOSABLE as readonly string[]).includes(op)) return { ok: false, note: `A proposed action was dropped: ${redactor.text(op).slice(0, 40)} is not an action the assistant can propose.` };
  const why_ = redactor.text(why);
  const cardId = `card-${randomUUID().slice(0, 8)}`;
  const kind = op === "navigate" ? "navigate" : op.replace(/^(dispatch|task)\./, "") as keyof typeof SCHEMAS;
  const key = op === "delegation.pause" || op === "delegation.resume" || op === "dispatch.submit" || op === "navigate" ? op : kind;
  const schema = (SCHEMAS as Record<string, z.ZodTypeAny>)[key]!;
  const parsed = schema.safeParse(params);
  if (!parsed.success) return { ok: false, note: `A proposed ${op} action was dropped: its parameters were invalid.` };
  const p = parsed.data as Record<string, unknown>;

  if (op === "navigate") {
    const to = p.to as string, target = p.id as string | undefined;
    if (to === "task" && !target) return { ok: false, note: "A proposed link was dropped: it named no task." };
    const href = to === "task" ? `#/tasks/${encodeURIComponent(target!)}` : to === "tasks" ? "#/tasks" : to === "needs-you" ? "#/needs-you" : to === "overview" ? "#/overview" : "#/settings";
    const label = to === "task" ? "Open task" : to === "tasks" ? "Open tasks" : to === "needs-you" ? "Open Needs you" : to === "overview" ? "Open Overview" : "Open assistant settings";
    return { ok: true, card: { id: cardId, op: "navigate", params: p, title: label, summary: label, editable: [], why: why_, href, state: "pending" } };
  }
  if (op === "delegation.resume") return { ok: true, card: { id: cardId, op, params: {}, title: "Resume delegation", summary: "Resume delegating new work.", editable: [], why: why_, state: "pending" } };
  if (op === "delegation.pause") {
    const length = String(p.for);
    return { ok: true, card: { id: cardId, op, params: { for: length, ...(p.reason ? { reason: redactor.text(String(p.reason)) } : {}) }, title: "Pause delegation", summary: `Pause new delegation for ${length.endsWith("h") ? `${length.slice(0, -1)} hours` : `${length.slice(0, -1)} minutes`}. Running work continues.`, editable: p.reason ? [{ name: "reason", label: "Reason", value: redactor.text(String(p.reason)) }] : [], why: why_, state: "pending" } };
  }
  if (op === "dispatch.submit") {
    return { ok: true, card: { id: cardId, op, params: { goal: redactor.text(String(p.goal)), repo: String(p.repo), ...(p.title ? { title: redactor.text(String(p.title)) } : {}) }, title: "New task", summary: "Open the New task composer with this request filled in. Nothing is submitted until you press Delegate.", editable: [{ name: "goal", label: "Request", value: redactor.text(String(p.goal)) }], why: why_, state: "pending" } };
  }
  // Task-scoped ops: revision is read now, when the card is made, never when it is clicked.
  const taskId = String(p.id), task = deps.task(ctx, taskId);
  if (!task) return { ok: false, note: `A proposed ${kind} action was dropped: there is no task ${redactor.text(taskId).slice(0, 40)}.` };
  const managed = (deps.managed ?? ((c, t) => !!getWork(c, t)))(ctx, taskId);
  const real = `${managed ? "dispatch" : "task"}.${kind}`;
  const name = short(redactor.text(task.title || taskId));
  if (kind === "retry") {
    // Only managed work takes feedback; a plain task retry would silently drop it, so the card does not offer it.
    const feedback = managed && p.feedback ? redactor.text(String(p.feedback)) : undefined;
    return { ok: true, card: { id: cardId, op: real as ActionCard["op"], params: { id: taskId, expect_rev: task.rev, ...(feedback ? { feedback } : {}) }, title: "Retry task", summary: `Retry “${name}” as a new attempt in the same worktree, on the executor pacer routes it to.`, editable: managed ? [{ name: "feedback", label: "Feedback for the new attempt", value: feedback ?? "" }] : [], why: why_, state: "pending" } };
  }
  if (kind === "stop") return { ok: true, card: { id: cardId, op: real as ActionCard["op"], params: { id: taskId, expect_rev: task.rev }, title: "Stop task", summary: `Stop “${name}” and the work under it.`, editable: [], why: why_, state: "pending" } };
  const text = redactor.text(String(p.text));
  return { ok: true, card: { id: cardId, op: real as ActionCard["op"], params: { id: taskId, expect_rev: task.rev, text }, title: "Answer the executor", summary: `Send this answer to the executor working on “${name}”. You can edit it first.`, editable: [{ name: "text", label: "Answer", value: text }], why: why_, state: "pending" } };
}
