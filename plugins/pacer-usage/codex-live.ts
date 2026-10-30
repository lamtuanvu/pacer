import type { ReaderContext, UsageReading, UsageWindow } from "./reader-types";
import { isObj } from "./util";

function window(value: unknown): UsageWindow | null {
  if (!isObj(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)
    || value.usedPercent < 0 || value.usedPercent > 100) return null;
  const minutes = value.windowDurationMins;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const resetsAt = typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) ? value.resetsAt : null;
  return { name: minutes >= 10080 ? "weekly" : `${Math.round(minutes / 60)}h`, usedPct: value.usedPercent,
    resetsAt, lengthS: minutes * 60, paced: minutes >= 1440 };
}

/** A fixed host-issued read-only app-server exchange; no plugin input controls stdin or environment. */
export async function readCodexLive(ctx: ReaderContext): Promise<UsageReading> {
  const result = await ctx.io.run(["codex", "-s", "read-only", "-a", "never", "app-server"], 10_000);
  if (result.timedOut || result.code !== 0) return { windows: [], capturedAt: null, stale: true,
    error: result.timedOut ? "Codex usage request timed out" : "Codex usage request failed" };
  let response: Record<string, unknown> | null = null;
  for (const line of result.stdout.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObj(parsed) && parsed.id === 2) response = parsed;
    } catch { /* Ignore incomplete diagnostics or notifications. */ }
  }
  if (!response || isObj(response.error)) return { windows: [], capturedAt: null, stale: true, error: "Codex usage unavailable" };
  const payload = isObj(response.result) ? response.result : {};
  const limits = isObj(payload.rateLimits) ? payload.rateLimits : {};
  const windows = [window(limits.primary), window(limits.secondary)].filter((w): w is UsageWindow => w !== null);
  return windows.length ? { windows, capturedAt: ctx.now, stale: false, source: "provider-cli" }
    : { windows: [], capturedAt: null, stale: true, error: "Codex returned no quota windows" };
}
