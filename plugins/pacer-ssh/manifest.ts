import type { PluginManifest } from "@pacer/plugin";

/** Bundled SSH provider. Only host-issued operations reach its process capability. */
export const manifest: PluginManifest = {
  id: "pacer-ssh", version: "0.1.0", publisher: "pacer", host: "^1.7",
  contributes: { hostRunner: { kinds: ["ssh"] } },
  capabilities: [{ name: "process.spawn", scopes: ["ssh"] }],
  reentrant: true, tier: "free",
};
