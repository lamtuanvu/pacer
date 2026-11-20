import { policySummary } from "../plugins/policy";
import { setupCheckFacts } from "../setup/check";
import type { Ctx } from "../types";
import { toCoreError } from "../core/errors";

/**
 * The facts behind the setup checklist for the Rust front door, which applies the checklist rules. Probes, plugin
 * readings and the in-process status cache stay here; only the fields the rules read cross the bridge.
 */
export async function setupCheckParts(ctx: Ctx, snapshotProbe?: boolean) {
  const facts = await setupCheckFacts(ctx, snapshotProbe === undefined ? {} : { snapshotProbe });
  const { executors } = facts;
  return {
    ...facts,
    service: { installed: facts.service.installed, running: facts.service.running },
    ...(executors ? { executors: {
      ranked: executors.ranked.map(({ id }) => ({ id })),
      excluded: executors.excluded.map(({ id, reason }) => ({ id, reason })),
    } } : {}),
    policy: policySummary(ctx),
  };
}

export async function setupCheckBridge(ctx: Ctx, snapshotProbe?: boolean) {
  try {
    return await setupCheckParts(ctx, snapshotProbe);
  } catch (e) {
    throw toCoreError(e);
  }
}
