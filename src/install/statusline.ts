import { plannerSessionStatus } from "./role";
import { resolve } from "node:path";
import { orcaAccountHome } from "../orca/accounts";
import { claudeCacheFile } from "../usage/claude";
import { loadStrategy } from "../config/strategy";
import { writeJsonAtomic } from "../fsutil";
import { renderLine } from "../render/line";
import type { Ctx } from "../types";
import { isObj } from "../util";

function claudeCaptureTarget(ctx: Ctx) {
  const folder = ctx.env.CLAUDE_CONFIG_DIR;
  if (!folder || resolve(folder) === resolve(ctx.home, ".claude")) return {};
  try {
    const account = Object.values(loadStrategy(ctx).accounts).find(a => {
      if (a.kind !== "claude" || a.source === "default") return false;
      const home = a.source === "orca" ? orcaAccountHome(ctx, "claude", a.orcaAccount ?? "") : a.home;
      return home !== null && resolve(home.replace(/^~(?=\/|$)/, ctx.home)) === resolve(folder);
    });
    if (account) return { account };
  } catch { /* Capture still works before a strategy is installed. */ }
  return { warning: "unknown CLAUDE_CONFIG_DIR; using the default Claude account" };
}

export function captureClaudeRateLimits(ctx: Ctx, stdin: string): boolean {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return false;
  }
  if (!isObj(input) || !isObj(input.rate_limits) || !isObj(input.rate_limits.seven_day)) {
    return false;
  }
  const selected = claudeCaptureTarget(ctx);
  writeJsonAtomic(claudeCacheFile(ctx, selected.account), {
    ...input.rate_limits,
    captured_at: ctx.now,
    ...(selected.warning ? { warning: selected.warning } : {}),
  });
  return true;
}

export async function statusLine(ctx: Ctx, stdin: string): Promise<string> {
  try {
    captureClaudeRateLimits(ctx, stdin);
  } catch { /* Cache persistence must not prevent budget rendering. */ }
  try {
    const line = renderLine(await plannerSessionStatus(ctx));
    const warning = claudeCaptureTarget(ctx).warning;
    return warning ? `${line}\nWarning: ${warning}` : line;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `◆ Budget ? (${message.split(/\r?\n/)[0]})`;
  }
}
