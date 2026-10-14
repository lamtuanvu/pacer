import { resolveRunner } from "../config/runner-id";
import { type Strategy, loadStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { markExhausted } from "../usage/reactive";
import { CoreError } from "./errors";

/** report-limit: the runner's account is skipped until `until` (unix seconds) or its cooldown. */
export function report(ctx: Ctx, provider: string, until?: number, s: Strategy = loadStrategy(ctx)): { provider: string; account: string; exhaustedUntil: number } {
  const runner = resolveRunner(s, provider);
  const cfg = s.providers[runner?.id ?? provider];
  if (!cfg) throw new CoreError("unknown_executor", `unknown provider "${provider}"`);
  const at = until ?? ctx.now + cfg.cooldownS;
  if (!Number.isFinite(at)) throw new CoreError("invalid_input", "until must be unix seconds");
  const account = runner?.account ?? provider;
  markExhausted(ctx, account, at);
  return { provider, account, exhaustedUntil: at };
}
