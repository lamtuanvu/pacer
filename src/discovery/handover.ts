import type { Ctx } from "../types";
import type { PluginRegistry } from "../plugins/registry";
import { appendPluginLog } from "../plugins/host";
import { pairingStartResult } from "../plugins/protocol";
import { updateState, type Seen } from "./state";

type Registry = Pick<PluginRegistry, "list" | "call">;

/** The whole hand-over finishes within this, below the CLI client's 15 s request timeout (N2). */
export const HANDOVER_BUDGET_MS = 10_000;

/**
 * Hands Pair to the first enabled plugin contributing `pairing` that accepts it, trying plugins in turn within one overall time budget.
 * The registry validates only ui.* results, so the pairing.start result is checked here against the method's result schema;
 * an invalid result, a plugin error or running out of time counts as not handed over and is written to that plugin's log.
 */
export async function handOver(ctx: Ctx, seen: Seen, deps: { registry?: Registry; budgetMs?: number } = {}): Promise<{ handedOver: boolean; plugin?: string }> {
  const reg = deps.registry ?? (await import("../plugins")).pluginRegistry(ctx);
  const end = Date.now() + (deps.budgetMs ?? HANDOVER_BUDGET_MS);
  for (const p of reg.list(ctx).filter(p => p.enabled && p.contributes.includes("pairing"))) {
    const left = end - Date.now();
    if (left <= 0) break;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("hand-over time budget used up")); }, left); });
    try {
      const call = reg.call(ctx, p.id, "pairing.start", { discoveryId: seen.discoveryId, name: seen.name, hints: seen.hints }, { deadlineMs: left, signal: controller.signal });
      const parsed = pairingStartResult.safeParse(await Promise.race([call, budget]));
      if (!parsed.success) { appendPluginLog(ctx, p.id, "stderr", `invalid pairing.start result: ${parsed.error.issues[0]?.path.join(".") || "result"}`); continue; }
      if (parsed.data.accepted) return { handedOver: true, plugin: p.id };
    } catch (error) {
      // A failing plugin degrades only its own pairing.
      appendPluginLog(ctx, p.id, "stderr", `pairing.start failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); }
  }
  return { handedOver: false };
}

/** Pair: hands over and, when a plugin accepted, records handedOverAt so the found-machine prompt closes everywhere (N3). */
export async function pair(ctx: Ctx, seen: Seen, deps: { registry?: Registry; now?: number } = {}): Promise<{ handedOver: boolean; plugin?: string }> {
  const result = await handOver(ctx, seen, { registry: deps.registry });
  if (result.handedOver) await updateState(ctx, s => { const x = s.seen[seen.discoveryId]; if (x) x.handedOverAt = deps.now ?? Math.floor(Date.now() / 1000); });
  return result;
}
