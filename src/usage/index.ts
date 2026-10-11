import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readByteplus } from "./byteplus";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { readMetered } from "./metered";
import { limitWindow } from "./reactive";

async function base(ctx: Ctx, cfg: ProviderCfg): Promise<UsageReading> {
  switch (cfg.usage) {
    case "quota":
      if (cfg.id === "claude-code") return readClaude(ctx);
      if (cfg.id === "codex") return readCodex(ctx);
      if (cfg.quotaSource === "arkcli") return readByteplus(ctx);
      return { windows: [], capturedAt: null, stale: false, error: `no quota source for ${cfg.id}` };
    case "metered":
      return readMetered(ctx, cfg);
    case "reactive":
      return { windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: ctx.now, stale: false };
    case "unmetered":
      return { windows: [], capturedAt: ctx.now, stale: false };
  }
}

/** A provider's usage reading, with any active exhausted mark applied on top. */
export async function readUsage(ctx: Ctx, cfg: ProviderCfg): Promise<UsageReading> {
  const r = await base(ctx, cfg);
  const lim = limitWindow(ctx, cfg.id);
  return lim ? { ...r, windows: [...r.windows.filter((w) => w.name !== "limit"), lim] } : r;
}
