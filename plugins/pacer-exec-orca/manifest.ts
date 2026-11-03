import type { PluginManifest } from "@pacer/plugin";

/** The orca capability answers only the host-issued attempt of the owning executor call; it names no argv or path. */
export const manifest = {
  id: "pacer-exec-orca", version: "0.1.0", publisher: "pacer", host: ">=1.10.0",
  contributes: { executor: { backends: ["orca"] } },
  capabilities: [{ name: "orca", scopes: ["task-owned"] }],
  reentrant: true, tier: "free",
} satisfies PluginManifest;
