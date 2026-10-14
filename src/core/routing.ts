import { type Strategy, loadStrategy } from "../config/strategy";
import { rankExecutors } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import type { Ctx } from "../types";

export function status(ctx: Ctx, s: Strategy = loadStrategy(ctx)): Promise<Status> {
  return computeStatus(ctx, s);
}

export async function route(ctx: Ctx, kind: string | null, s: Strategy = loadStrategy(ctx)) {
  const st = await computeStatus(ctx, s);
  const r = rankExecutors(kind, s, Object.fromEntries(st.providers.map((p) => [p.id, p])));
  return { kind, ranked: r.ranked, excluded: r.excluded };
}
