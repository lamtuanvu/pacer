import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, type Strategy } from "../config/strategy";
import type { Mode } from "../engine/mode";
import { computeStatus } from "../engine/status";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { CoreError } from "./errors";

export interface ModeHold {mode: Mode; until: number}
const modes = ["strict", "normal", "relaxed", "emergency"];
const path = (ctx: Ctx) => join(ctx.pacerHome, "state", "mode-hold.json");
export async function holdMode(ctx: Ctx, o: {mode: Mode; until?: number}, s?: Strategy): Promise<ModeHold> {
  if (!modes.includes(o.mode)) throw new CoreError("invalid_input", "unknown mode");
  let until = o.until;
  if (until === undefined) {
    const strategy = s ?? loadStrategy(ctx);
    const status = await computeStatus(ctx, strategy);
    until = status.accounts?.find(a => a.name === strategy.planner.account)?.resetsAt ?? ctx.now + 7 * 86400;
  }
  if (!Number.isFinite(until) || until <= ctx.now) throw new CoreError("invalid_input", "mode hold until must be a future unix timestamp");
  const state = {mode: o.mode, until};
  writeJsonAtomic(path(ctx), state);
  return state;
}
export function releaseMode(ctx: Ctx): {released: true} {
  rmSync(path(ctx), {force: true});
  return {released: true};
}
export function readHold(ctx: Ctx): ModeHold | null {
  const state = readJson<ModeHold>(path(ctx));
  return state && modes.includes(state.mode) && typeof state.until === "number" && Number.isFinite(state.until) && state.until > ctx.now ? state : null;
}
