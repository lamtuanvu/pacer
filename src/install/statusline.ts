import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { writeJsonAtomic } from "../fsutil";
import { renderLine } from "../render/line";
import type { Ctx } from "../types";
import { isObj } from "../util";

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
  writeJsonAtomic(join(ctx.pacerHome, "cache", "claude-rate-limits.json"), {
    ...input.rate_limits,
    captured_at: ctx.now,
  });
  return true;
}

export async function statusLine(ctx: Ctx, stdin: string): Promise<string> {
  try {
    captureClaudeRateLimits(ctx, stdin);
  } catch { /* Cache persistence must not prevent budget rendering. */ }
  try {
    return renderLine(await computeStatus(ctx, loadStrategy(ctx)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `◆ Budget ? (${message.split(/\r?\n/)[0]})`;
  }
}
