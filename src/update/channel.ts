import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/** The release channel this installation follows (strategy key `update_channel`). */
export type UpdateChannel = "stable" | "nightly";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];
export const UPDATE_CHANNEL_ERROR = "update_channel must be stable or nightly";

// Defined in the shared view model so the app bundle uses the same rule without node:fs.
export { isNightlyVersion } from "../view-model/updates";

/** The active strategy's text, or null when it cannot be read. Usable without the config stack (Node worker, Rust parity). */
export function activeStrategyText(ctx: Pick<Ctx, "pacerHome">): string | null {
  let active = "";
  try { active = readFileSync(join(ctx.pacerHome, "active"), "utf8").trim(); } catch { /* No named strategy is active. */ }
  const path = active && /^[\w-]+$/.test(active) ? join(ctx.pacerHome, "strategies", `${active}.yaml`) : join(ctx.pacerHome, "strategy.yaml");
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * The effective `update_channel`: a top-level `update_channel: nightly` (plain or quoted) in the
 * active strategy selects nightly. Anything else, including an unreadable strategy, is stable.
 * `crates/update/src/check.rs` mirrors this rule.
 */
export function updateChannel(ctx: Pick<Ctx, "pacerHome" | "env">): UpdateChannel {
  const text = activeStrategyText(ctx);
  return text !== null && /^update_channel:[ \t]*(["']?)nightly\1[ \t]*(?:#.*)?$/m.test(text) ? "nightly" : "stable";
}
