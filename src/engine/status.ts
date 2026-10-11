import type { ProviderCfg, Strategy } from "../config/strategy";
import { type ActivityProfile, loadActivity } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx, UsageReading } from "../types";
import { readUsage } from "../usage/index";
import { type Mode, plannerMode } from "./mode";
import { type Excluded, type ProviderStatus, type RankedExecutor, rankExecutors } from "./rank";
import { bindingWindow, evaluateWindow } from "./verdict";

export interface Status {
  generatedAt: number;
  strategy: string;
  planner: string;
  mode: Mode;
  disabled: boolean;
  calendarPace: boolean;
  providers: ProviderStatus[];
  executors: { ranked: RankedExecutor[]; excluded: Excluded[] };
}

const BINARIES: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent" };
const NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", byteplus: "BytePlus" };

export function binaryFor(cfg: ProviderCfg): string {
  return cfg.via === "opencode" ? "opencode" : BINARIES[cfg.id] ?? cfg.id;
}

export function displayName(id: string): string {
  return NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export async function computeStatus(
  ctx: Ctx, s: Strategy, opts: { profile?: ActivityProfile | null } = {},
): Promise<Status> {
  const profile = opts.profile !== undefined ? opts.profile : await loadActivity(ctx).catch(() => null);
  const providers = await Promise.all(Object.values(s.providers).map(async (cfg): Promise<ProviderStatus> => {
    const reading: UsageReading = await readUsage(ctx, cfg).catch((e) => ({
      windows: [], capturedAt: null, stale: false, error: String(e),
    }));
    const th = {
      ahead: s.pacing.aheadThreshold,
      behind: s.pacing.behindThreshold,
      paceScale: cfg.id === s.planner ? 1 - s.pacing.plannerReserve / 100 : 1,
    };
    const windows = reading.windows.map((w) => evaluateWindow(w, ctx.now, profile, th));
    const binding = bindingWindow(windows);
    const verdict = cfg.usage === "unmetered" && !windows.length ? "OK" : binding?.verdict ?? "UNKNOWN";
    return {
      id: cfg.id, usage: cfg.usage, windows, binding, verdict,
      installed: ctx.which(binaryFor(cfg)) !== null,
      stale: reading.stale,
      ...(reading.error ? { error: reading.error } : {}),
    };
  }));
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  const planner = byId[s.planner];
  return {
    generatedAt: ctx.now,
    strategy: s.name,
    planner: s.planner,
    mode: planner ? plannerMode(planner.verdict) : "normal",
    disabled: (ctx.env.PACER ?? "").toLowerCase() === "off",
    calendarPace: isCalendar(profile),
    providers,
    executors: rankExecutors(null, s, byId),
  };
}
