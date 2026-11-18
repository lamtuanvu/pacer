import type { Redactor } from "./redact";
import { runReadTool, type ReadOp } from "./tools";
import type { AssistantScope } from "./types";
import type { Ctx } from "../types";

/** At most ~2,000 tokens of host-built summary, so most questions need no tool round. */
export const DIGEST_MAX_CHARS = 8_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const scopeLine = (scope: AssistantScope) =>
  `Scope: ${scope.kind === "dispatch" ? `dispatch, last ${scope.days} days` : scope.kind === "task" ? `task ${scope.id}` : `repository ${scope.repo}`}.`;

/** The chosen account's row of the `budget` tool, in plain words. Never a live reading. */
function budgetLine(content: string, account: string | null): string {
  let view: { accounts?: { name?: string; verdict?: string; usedPct?: number | null; pacePct?: number | null; resetsAt?: string | number | null; window?: string | null; stale?: boolean }[] };
  try { view = JSON.parse(content) as typeof view; } catch { return "not readable."; }
  const row = account ? view.accounts?.find(a => a.name === account) : undefined;
  if (!row) return `${account ?? "The chosen account"} has no cached reading.`;
  const facts = [
    row.verdict && `verdict ${row.verdict}`,
    typeof row.usedPct === "number" && `used ${row.usedPct}%`,
    typeof row.pacePct === "number" && `pace ${row.pacePct}%`,
    row.window && `window ${row.window}`,
    row.resetsAt != null && `resets ${row.resetsAt}`,
    row.stale && "stale",
  ].filter((fact): fact is string => !!fact);
  return facts.length ? `${account}: ${facts.join(", ")}.` : `${account}: no cached reading.`;
}

/**
 * The `digest` of `assistant.reply`: the host's own summary of the turn's context, built through
 * the same read pipeline as the tools (permitted op, projection, redaction, size cap), so it can
 * never carry a key or free text the tools would drop. A read that fails leaves that part out;
 * the digest never fails the turn.
 */
export async function buildDigest(ctx: Ctx, o: { read: ReadOp; scope: AssistantScope; redactor: Redactor; account: string | null }): Promise<string> {
  const parts = [scopeLine(o.scope)];
  for (const [label, tool] of [["Snapshot", "snapshot"], ["Budget", "budget"]] as const) {
    try {
      const out = await runReadTool(ctx, tool, {}, o);
      if (!out.ok) { parts.push(`${label}: unavailable.`); continue; }
      parts.push(label === "Budget" ? `Budget: ${budgetLine(out.content, o.account)}` : `${label}: ${out.content}`);
    } catch { parts.push(`${label}: unavailable.`); }
  }
  return clip(parts.join("\n"), DIGEST_MAX_CHARS);
}
