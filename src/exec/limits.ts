import type { ProviderCfg } from "../config/strategy";
import type { ProviderStatus } from "../engine/rank";
import type { ExecResult } from "./process";

const GENERIC: RegExp[] = [
  /rate[ _-]?limit/i,
  /usage limit/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /too many requests/i,
  /\b429\b/,
  /limit (?:reached|exceeded)/i,
  /out of (?:credits|quota)/i,
  /insufficient (?:quota|credits|balance)/i,
];
const SPECIFIC: Record<string, RegExp[]> = {
  codex: [/rate_limit_reached/i, /hit your usage limit/i],
};

/** True when a FAILED run's output says the provider's plan limit was hit. Timeouts never count. */
export function detectLimit(providerId: string, r: ExecResult): boolean {
  if (r.code === 0 || r.timedOut) return false;
  const text = `${r.stderr}\n${r.stdout}`.slice(-8000);
  return [...GENERIC, ...(SPECIFIC[providerId] ?? [])].some((re) => re.test(text));
}

/** Until when to treat a provider as exhausted after a limit hit. */
export function exhaustUntil(st: ProviderStatus | undefined, cfg: ProviderCfg, now: number): number {
  const resets = (st?.windows ?? [])
    .filter((w) => w.resetsAt !== null && w.resetsAt > now && (w.usedPct ?? 0) >= 90)
    .map((w) => w.resetsAt as number);
  return resets.length ? Math.min(...resets) : now + cfg.cooldownS;
}
