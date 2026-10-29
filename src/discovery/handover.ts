import type { Ctx } from "../types";
import type { PluginRegistry } from "../plugins/registry";
import { appendPluginLog } from "../plugins/host";
import { pairingStartResult } from "../plugins/protocol";
import type { Seen } from "./state";

type Registry = Pick<PluginRegistry, "list" | "call">;

/**
 * Hands Pair to the first enabled plugin contributing `pairing` that accepts it. The registry validates only ui.* results,
 * so the pairing.start result is checked here against the method's result schema; an invalid result or a plugin error counts as not handed over.
 */
export async function handOver(ctx: Ctx, seen: Seen, deps: { registry?: Registry } = {}): Promise<{ handedOver: boolean; plugin?: string }> {
  const reg = deps.registry ?? (await import("../plugins")).pluginRegistry(ctx);
  for (const p of reg.list(ctx).filter(p => p.enabled && p.contributes.includes("pairing"))) {
    try {
      const parsed = pairingStartResult.safeParse(await reg.call(ctx, p.id, "pairing.start", { discoveryId: seen.discoveryId, name: seen.name, hints: seen.hints }));
      if (!parsed.success) { appendPluginLog(ctx, p.id, "stderr", `invalid pairing.start result: ${parsed.error.issues[0]?.path.join(".") || "result"}`); continue; }
      if (parsed.data.accepted) return { handedOver: true, plugin: p.id };
    } catch { /* a failing plugin degrades only its own pairing */ }
  }
  return { handedOver: false };
}
