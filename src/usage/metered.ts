import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";

export async function readMetered(ctx: Ctx, cfg: ProviderCfg, refresh = false): Promise<UsageReading> {
  return (await import("./plugin-readers")).readMeteredPlugin(ctx, cfg, refresh);
}
