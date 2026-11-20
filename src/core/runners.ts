import { type Strategy, loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { readBroken } from "../exec/broken";
import { blockExecutor, readBlocked, unblockExecutor } from "../executors/blocked";
import type { Ctx } from "../types";
import { eligibilityPresentation } from "../view-model/eligibility";
import { EXHAUSTED_PCT } from "../engine/verdict";
import { CoreError } from "./errors";

export interface RunnerRow { eligibility?: import("../evidence/types").EligibilityDecision; id: string; state: "ok" | "blocked" | "broken" | "exhausted"; until: number | null; reason: string | null }

function executorIds(s: Strategy): string[] {
  return Object.keys(s.providers).filter((id) => id !== s.planner.agent);
}
function mustExecutor(s: Strategy, id: string): void {
  if (!executorIds(s).includes(id)) throw new CoreError("unknown_executor", `unknown executor ${id}`, `configured: ${executorIds(s).join(", ")}`);
}

export async function list(ctx: Ctx, s: Strategy = loadStrategy(ctx)): Promise<RunnerRow[]> {
  const blocked = readBlocked(ctx), broken = readBroken(ctx);
  const st = await computeStatus(ctx, s);
  return executorIds(s).map((id): RunnerRow => {
    const block = blocked[id], bad = broken[id], p = st.providers.find((x) => x.id === id);
    if (block) return { id, eligibility: p?.eligibility, state: "blocked", until: block.until, reason: block.reason };
    if (bad) return { id, eligibility: p?.eligibility, state: "broken", until: bad.until, reason: bad.reason };
    if (p?.eligibility?.state === "ineligible") {
      const quota = p.eligibility.reasons.some(r => r.code === "budget_exhausted");
      // The limit lasts until its last exhausted window resets, not the earliest deadline of any fact.
      const resets = p.windows.filter(w => !w.stale && w.usedPct !== null && w.usedPct >= EXHAUSTED_PCT && w.resetsAt !== null).map(w => w.resetsAt!);
      return { id, eligibility: p.eligibility, state: quota ? "exhausted" : "broken",
        until: quota && resets.length ? Math.max(...resets) : p.eligibility.validUntil, reason: eligibilityPresentation(p.eligibility, ctx.now).detail };
    }
    return { id, ...(p?.eligibility ? { eligibility: p.eligibility } : {}), state: "ok", until: null, reason: null };
  });
}

export function block(ctx: Ctx, id: string, o: { for?: string; reason?: string } = {}, s: Strategy = loadStrategy(ctx)): void {
  mustExecutor(s, id);
  try {
    blockExecutor(ctx, id, o.for, o.reason);
  } catch (e) {
    throw new CoreError("invalid_input", (e as Error).message);
  }
}

export function unblock(ctx: Ctx, id: string, s: Strategy = loadStrategy(ctx)): { wasBlocked: boolean } {
  mustExecutor(s, id);
  const wasBlocked = unblockExecutor(ctx, id);
  return { wasBlocked };
}
