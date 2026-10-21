import { editStrategy, type StrategyDoc } from "../config/edit";
import { EMPTY_PLUGINS, MissingStrategyError, type PluginGrant, type PluginsCfg, loadStrategy, strategyPath } from "../config/strategy";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";

export { EMPTY_PLUGINS, type PluginGrant, type PluginsCfg } from "../config/strategy";

/** No strategy file means no plugin configuration; other strategy errors still surface. */
export function pluginsConfig(ctx: Ctx): PluginsCfg {
  try { return loadStrategy(ctx).plugins ?? EMPTY_PLUGINS; }
  catch (e) { if (e instanceof MissingStrategyError) return EMPTY_PLUGINS; throw e; }
}

async function edit(ctx: Ctx, change: (doc: StrategyDoc, current: PluginsCfg) => void): Promise<void> {
  await withLock(ctx, "plugins", async () => {
    const current = pluginsConfig(ctx);
    const result = editStrategy(strategyPath(ctx), doc => change(doc, current));
    if (!result.ok) throw new CoreError(/changed during edit/.test(result.error) ? "conflict" : "invalid_input", result.error);
  });
}

export function setPluginDisabled(ctx: Ctx, id: string, disabled: boolean): Promise<void> {
  return edit(ctx, (doc, current) => {
    const next = disabled ? [...new Set([...current.disabled, id])] : current.disabled.filter(x => x !== id);
    if (next.length === current.disabled.length && next.every((x, i) => x === current.disabled[i])) return;
    doc.setIn(["plugins", "disabled"], next);
  });
}

export function setPluginGrant(ctx: Ctx, id: string, grant: PluginGrant | null): Promise<void> {
  return edit(ctx, (doc, current) => {
    if (grant) doc.setIn(["plugins", "installed", id], { version: grant.version, capabilities: grant.capabilities });
    else if (Object.hasOwn(current.installed, id)) doc.deleteIn(["plugins", "installed", id]);
  });
}
