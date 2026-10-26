import {createHash} from "node:crypto";
import {manifestSchema} from "../../src/plugins/protocol";
import type {PluginRegistry} from "../../src/plugins/registry";

/** Mirror the public plugin.list consent value for a fixture declaration. */
export function fixtureConsent(manifest: unknown): string {
  return createHash("sha256").update(JSON.stringify(manifestSchema.parse(manifest))).digest("hex");
}

/** Exercise the same review step an external caller must perform. */
export async function enableReviewed(registry: PluginRegistry, ctx: Parameters<PluginRegistry["enable"]>[0], id: string) {
  const consent = registry.list(ctx).find(plugin => plugin.id === id)?.expectedConsent;
  if (!consent) throw new Error(`fixture ${id} has no reviewable consent`);
  return registry.enable(ctx, id, true, consent);
}
