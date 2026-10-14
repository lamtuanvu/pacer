import { type Strategy, loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { readBroken } from "../exec/broken";
import { blockExecutor, readBlocked, unblockExecutor } from "../executors/blocked";
import type { Ctx } from "../types";
import { readMarks } from "../usage/reactive";
import { CoreError } from "./errors";

export interface RunnerRow { id: string; state: "ok" | "blocked" | "broken" | "exhausted"; until: number | null; reason: string | null }

function executorIds(s: Strategy): string[] {
  return Object.keys(s.providers).filter((id) => id !== s.planner);
}
function mustExecutor(s: Strategy, id: string): void {
  if (!executorIds(s).includes(id)) throw new CoreError("unknown_executor", `unknown executor ${id}`, `configured: ${executorIds(s).join(", ")}`);
}

export async function list(ctx: Ctx, s: Strategy = loadStrategy(ctx)): Promise<RunnerRow[]> {
  const blocked = readBlocked(ctx), broken = readBroken(ctx), marks = readMarks(ctx);
  const st = await computeStatus(ctx, s);
  return executorIds(s).map((id): RunnerRow => {
    const block = blocked[id], bad = broken[id], p = st.providers.find((x) => x.id === id);
    if (block) return { id, state: "blocked", until: block.until, reason: block.reason };
    if (bad) return { id, state: "broken", until: bad.until, reason: bad.reason };
    if (marks[id] > ctx.now) return { id, state: "exhausted", until: marks[id], reason: null };
    if (p?.verdict === "EXHAUSTED") return { id, state: "exhausted", until: p.binding?.resetsAt ?? null, reason: null };
    return { id, state: "ok", until: null, reason: null };
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

export function unblock(ctx: Ctx, id: string, s: Strategy = loadStrategy(ctx)): void {
  mustExecutor(s, id);
  unblockExecutor(ctx, id);
}
