import { readFileSync } from "node:fs";
import { loadStrategy, strategyPath } from "../config/strategy";
import { tierTargetsSchema, type TierTargets } from "../dispatch/types";
import { ensureAccounts } from "./accounts";
import { withLock } from "./lock";
import { CoreError } from "./errors";
import { strategyRevision } from "./executor-settings";
import type { Ctx } from "../types";

/** Read the active tier targets with the strategy revision; built-in defaults when the setup saves none. */
export function readTierTargets(ctx: Ctx): { revision: string; targets: TierTargets } {
  const path = strategyPath(ctx), text = readFileSync(path, "utf8"), s = loadStrategy(ctx);
  if (readFileSync(path, "utf8") !== text) throw new CoreError("conflict", "Executor settings changed. Reload saved settings.");
  return { revision: strategyRevision(text), targets: s.dispatch?.tierTargets ?? tierTargetsSchema.parse({}) };
}

/** Validate and save tier targets in the active strategy file in one revision-checked edit under the executor-settings CAS lock. */
export async function saveTierTargets(ctx: Ctx, input: { expectedRevision: string; targets: TierTargets }): Promise<{ revision: string; targets: TierTargets }> {
  const parsed = tierTargetsSchema.safeParse(input.targets);
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues[0]?.message ?? "dispatch.tierTargets must not decrease from simple to complex.");
  const path = strategyPath(ctx);
  return await withLock(ctx, "executor-settings", async () => {
    const text = readFileSync(path, "utf8");
    if (input.expectedRevision !== strategyRevision(text)) throw new CoreError("conflict", "Executor settings changed elsewhere.", "Reload saved settings, then reapply your changes.");
    // Migration preserves old values and creates its established backup. Draft
    // validation precedes it; the targets commit in one edit like runner models.
    const prepared = ensureAccounts(ctx), source = readFileSync(path, "utf8");
    if (!prepared.migrated && source !== text) throw new CoreError("conflict", "Executor settings changed. Reload saved settings.");
    await prepared.edit(doc => {
      if (doc.toString() !== source) throw new Error("strategy changed during edit; retry");
      doc.setIn(["dispatch", "tierTargets"], {simple: parsed.data.simple, standard: parsed.data.standard, complex: parsed.data.complex});
    });
    const updated = loadStrategy(ctx);
    return { revision: strategyRevision(readFileSync(path, "utf8")), targets: updated.dispatch!.tierTargets };
  });
}
