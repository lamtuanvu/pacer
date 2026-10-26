import type { PluginManifest } from "@pacer/plugin";

/** The process capability accepts only exact commands issued by the owning host call. */
export const manifest = {
  id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.5",
  contributes: { executor: { backends: ["direct"] } },
  capabilities: [{ name: "process.spawn", scopes: ["bun", "codex", "claude", "cursor-agent", "agy", "opencode"] }],
  reentrant: true, tier: "free",
} satisfies PluginManifest;
