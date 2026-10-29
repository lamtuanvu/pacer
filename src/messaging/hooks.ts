import { createHash } from "node:crypto";
import { isExecutorSession } from "../install/role";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { plannerSessionId, type PlannerKind } from "./identity";
import { clearHookBlocks, getLiveness, recordHookBlock, upsertLiveness } from "./liveness-store";
import { effectivePolicy } from "./policy";
import { getMessage, inbox, messagesDatabase } from "./store";
import type { Message } from "./types";

const MAX_MESSAGES = 20;
const MAX_BYTES = 8192;
const EXCERPT = 400;

const sessionOf = (input: unknown) => isObj(input) && typeof input.session_id === "string" ? input.session_id : undefined;

/**
 * Unread messages and open questions addressed to this planner session. A per-session planner also reads the
 * generic `external:<kind>` inbox, because MCP calls cannot see `PACER_PLANNER_SESSION`.
 */
export function pendingFor(ctx: Ctx, me: string): Message[] {
  const generic = me.split(":").slice(0, 2).join(":");
  const found = new Map<string, Message>();
  for (const to of me === generic ? [me] : [me, generic]) {
    for (const m of inbox(ctx, to, { unreadOnly: true })) found.set(m.id, m);
    const open = messagesDatabase(ctx).query<{ id: string }, [string]>(`SELECT id FROM messages q WHERE recipient=? AND kind='question' AND status='read'
      AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to=q.id AND a.kind='answer') ORDER BY id`).all(to);
    for (const { id } of open) found.set(id, getMessage(ctx, id)!);
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function render(pending: Message[]): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const m of pending.slice(0, MAX_MESSAGES)) {
    const line = `- ${m.from} (${m.kind}, ${m.id}): ${m.body.slice(0, EXCERPT)}`;
    if (bytes + line.length > MAX_BYTES) break;
    lines.push(line); bytes += line.length + 1;
  }
  if (lines.length < pending.length) lines.push(`- … ${pending.length - lines.length} more (pacer msg inbox)`);
  const task = pending.find(m => m.taskId)?.taskId ?? "<task>";
  return `${lines.join("\n")}\nReply with \`pacer msg send ${task} "…"\` (or \`--answer <id>\`); mark read with \`pacer msg read <ids>\`.`;
}

/** Stop hook stdout; an empty string allows the stop. Fails open. */
export async function stopHook(ctx: Ctx, kind: PlannerKind, input: unknown): Promise<string> {
  try {
    if (effectivePolicy(ctx).config.hooks.stop !== "block") return "";
    if (isExecutorSession(ctx, input)) return "";
    const me = plannerSessionId(kind, sessionOf(input));
    const pending = pendingFor(ctx, me);
    if (!pending.length) { clearHookBlocks(ctx, me); return ""; }
    const set = createHash("sha256").update(pending.map(m => m.id).sort().join("\n")).digest("hex");
    const n = recordHookBlock(ctx, me, set);
    if (n > effectivePolicy(ctx).config.hooks.stop_release_after) {
      const row = getLiveness(ctx, me)!;
      // The broker alerts the human about an escalated participant.
      if (row.escalatedAt === null) upsertLiveness(ctx, { node: me, reason: row.reason || "unread_external", since: row.since, attempts: row.attempts,
        nextAt: row.nextAt, progressMark: row.progressMark, stalledAt: row.stalledAt ?? ctx.now, escalatedAt: ctx.now });
      return "";
    }
    return JSON.stringify({ decision: "block", reason: `pacer: you have ${pending.length} message(s) waiting before you stop:\n${render(pending)}` });
  } catch { return ""; }
}

/** UserPromptSubmit hook stdout: JSON context for Claude Code, plain text for Codex. Fails open. */
export async function promptHook(ctx: Ctx, kind: PlannerKind, input: unknown): Promise<string> {
  try {
    if (isExecutorSession(ctx, input)) return "";
    const pending = pendingFor(ctx, plannerSessionId(kind, sessionOf(input)));
    if (!pending.length) return "";
    const text = `pacer: you have ${pending.length} message(s) waiting:\n${render(pending)}`;
    return kind === "claude-code" ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) : text;
  } catch { return ""; }
}
