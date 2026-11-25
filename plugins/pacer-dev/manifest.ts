import type { PluginManifest } from "@pacer/plugin";

export const manifest = {
  id: "pacer-dev",
  version: "1.0.1",
  publisher: "pacer",
  host: ">=1.12.0",
  contributes: {
    workflow: {
      router: { title: "Router" },
      feature: { title: "Feature" },
      bug: { title: "Bug fix" },
      ask: { title: "Ask" },
    },
  },
  capabilities: [],
  reentrant: true,
  tier: "free",
} satisfies PluginManifest;
