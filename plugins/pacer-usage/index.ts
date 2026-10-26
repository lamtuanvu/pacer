import { createUsageReaderIO, type Handler } from "@pacer/plugin";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { readCodexLive } from "./codex-live";
import { readByteplus } from "./byteplus";
import { readMetered } from "./metered";
import type { ReaderContext, UsageReading } from "./reader-types";
interface Input {
  provider: string; usage: "quota" | "metered" | "reactive" | "unmetered";
  model: string | null; weeklyTokens: number | null; weeklyUsd: number | null; quotaSource: string | null;
  now: number; readOnly: boolean; refresh: boolean; resources?: ReaderContext["resources"];
}
export const handlers: Record<string, Handler> = {
  "usage.read": async (params, host): Promise<UsageReading> => {
    const input = params as Input;
    const ctx: ReaderContext = { io: createUsageReaderIO(host), now: input.now, readOnly: input.readOnly, resources: input.resources };
    switch (input.usage) {
      case "quota":
        if (input.provider === "claude-code") return readClaude(ctx);
        if (input.provider === "codex") return input.refresh ? readCodexLive(ctx) : readCodex(ctx);
        if (input.quotaSource === "arkcli") return readByteplus(ctx, input.refresh);
        return { windows: [], capturedAt: null, stale: false, error: `no quota source for ${input.provider}` };
      case "metered": return readMetered(ctx, input, input.refresh);
      case "reactive": return { windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: input.now, stale: false, source: "reactive" };
      case "unmetered": return { windows: [], capturedAt: input.now, stale: false, source: "unmetered" };
    }
  },
};
