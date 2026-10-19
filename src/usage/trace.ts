import type { Ctx } from "../types";

/** Opt-in debug timings contain phase names and durations, never session content. */
export function statusTimer(ctx: Ctx): (phase: string) => void {
  let start = performance.now();
  return phase => {
    const end = performance.now();
    if (ctx.env.PACER_TRACE_STATUS === "1") {
      console.error(`[pacer:status:debug] ${phase} ${(end - start).toFixed(1)}ms`);
    }
    start = end;
  };
}
