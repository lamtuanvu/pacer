import type { ReaderContext, UsageReading } from "./reader-types";
import { isObj, parseTs, toNum } from "./util";

export async function readClaude(ctx: ReaderContext): Promise<UsageReading> {
  const candidates: Record<string, unknown>[] = [];
  for (const path of ctx.resources?.claudeFiles ?? []) {
    const file = await ctx.io.read(path);
    if (!file) continue;
    let value: unknown;
    try { value = JSON.parse(file.text); } catch { continue; }
    if (isObj(value)) candidates.push(value);
  }
  const data = candidates.filter(d => { const at = parseTs(d.captured_at); return at === null || at <= ctx.now; })
    .sort((a, b) => (parseTs(b.captured_at) ?? -Infinity) - (parseTs(a.captured_at) ?? -Infinity))[0];
  if (!isObj(data)) {
    return { windows: [], capturedAt: null, stale: false, error: "no Claude rate-limit data yet (the Claude Code status line writes it)" };
  }
  const wk = isObj(data.seven_day) ? data.seven_day : {};
  const fh = isObj(data.five_hour) ? data.five_hour : {};
  const capturedAt = parseTs(data.captured_at);
  return {
    source: data.source === "session-log" ? "session-log" : "status-line",
    capturedAt,
    stale: false,
    windows: [
      { name: "weekly", usedPct: toNum(wk.used_percentage), resetsAt: parseTs(wk.resets_at), lengthS: 7 * 86400, paced: true },
      { name: "5h", usedPct: toNum(fh.used_percentage), resetsAt: parseTs(fh.resets_at), lengthS: 5 * 3600, paced: false },
    ],
  };
}
