import type { PluginManifest } from "@pacer/plugin";

/** Kept unbundled until the complete SSH adapter and caller cutover are validated. */
export const manifest: PluginManifest = {
  id: "pacer-ssh", version: "0.1.0", publisher: "pacer", host: "^1.5",
  contributes: { hostRunner: { kinds: ["ssh"] } },
  capabilities: [{ name: "process.spawn", scopes: ["ssh"] }],
  reentrant: true, tier: "free",
};
