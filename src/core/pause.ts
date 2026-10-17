import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { CoreError } from "./errors";

export interface PauseState { until: number | null; reason: string | null; by: string | null }
const path = (ctx: Ctx) => join(ctx.pacerHome, "state", "pause.json");
export function pause(ctx: Ctx, o: {for: string; reason?: string; by?: string}): PauseState {
  const match = /^(\d+)(m|h|d)$/.exec(o.for);
  const seconds = match ? Number(match[1]) * {m: 60, h: 3600, d: 86400}[match[2] as "m" | "h" | "d"] : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 86400) throw new CoreError("invalid_input", "pause duration must be whole minutes, hours or days, up to 7 days");
  const state = {until: ctx.now + seconds, reason: o.reason ?? null, by: o.by ?? null};
  writeJsonAtomic(path(ctx), state);
  return state;
}
export function resume(ctx: Ctx): {resumed: true} {
  rmSync(path(ctx), {force: true});
  return {resumed: true};
}
export function readPause(ctx: Ctx): PauseState | null {
  const state = readJson<PauseState>(path(ctx));
  if (!state || (state.until !== null && (typeof state.until !== "number" || !Number.isFinite(state.until) || state.until <= ctx.now))) return null;
  if (state.reason !== null && typeof state.reason !== "string" || state.by !== null && typeof state.by !== "string") return null;
  return state;
}
export function pauseTime(state: PauseState): string {
  if (state.until === null) return "resumed";
  const d = new Date(state.until * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function pauseLine(state: PauseState): string {
  return `Delegation paused until ${pauseTime(state)} — do the work yourself or wait.`;
}
