import { resolveRunner } from "../config/runner-id";
import { type Strategy, loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import type { Ctx } from "../types";
import { markExhausted } from "../usage/reactive";
import { CoreError } from "./errors";

export interface LimitsRow {
  account: string;
  kind: string;
  source: string | null;
  capturedAt: number | null;
  ageS: number | null;
  stale: boolean;
  verdict: string;
  usedPct: number | null;
  window: string | null;
  resetsAt: number | null;
  runners: string[];
  error: string | null;
  hint: string | null;
}

export async function check(ctx: Ctx, s: Strategy = loadStrategy(ctx)): Promise<LimitsRow[]> {
  const st = await computeStatus(ctx, s);
  return st.accounts.map((a) => {
    const error = st.providers.find((p) => p.account === a.name && p.error)?.error ?? null;
    const noData = a.capturedAt === null && (a.kind === "claude" || a.kind === "codex");
    const hint = noData && a.kind === "claude" ? "start a Claude Code session with pacer's status line, or rely on limit errors"
      : noData && a.kind === "codex" ? "run codex once with this account so it writes session logs"
      : a.stale ? "numbers are older than the freshness limit; they no longer decide routing" : null;
    return {
      account: a.name, kind: a.kind, source: noData ? null : a.remoteHost ? `${a.source} (via ${a.remoteHost})` : a.source, capturedAt: a.capturedAt,
      ageS: a.capturedAt === null ? null : Math.max(0, Math.round(ctx.now - a.capturedAt)),
      stale: a.stale, verdict: a.verdict, usedPct: a.usedPct, window: a.window, resetsAt: a.resetsAt,
      runners: a.runners, error, hint,
    };
  });
}

/** report-limit: the runner's account is skipped until `until` (unix seconds) or its cooldown. */
export function report(ctx: Ctx, provider: string, until?: number, s: Strategy = loadStrategy(ctx)): { provider: string; account: string; exhaustedUntil: number } {
  const runner = resolveRunner(s, provider);
  const cfg = s.providers[runner?.id ?? provider];
  if (!cfg) throw new CoreError("unknown_executor", `unknown provider "${provider}"`);
  const at = until ?? ctx.now + cfg.cooldownS;
  if (!Number.isFinite(at)) throw new CoreError("invalid_input", "until must be unix seconds");
  const account = runner?.account ?? provider;
  markExhausted(ctx, account, at, { manual: true });
  return { provider, account, exhaustedUntil: at };
}
