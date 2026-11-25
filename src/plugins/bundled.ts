// src/plugins/bundled.ts
// The bundled-plugin table is now manifest-only. Every shipped row is a native
// Rust plugin; `crates/bundled/src/lib.rs` is the runtime table. The JSON files
// under plugins-rs/ are the single source of truth for the manifests (M3 C13).
import type { PluginManifest } from "./protocol";
import type { BundledPlugin } from "./types";

import planners from "../../plugins-rs/pacer-planners/manifest.json";
import endpoints from "../../plugins-rs/pacer-endpoints/manifest.json";
import notifier from "../../plugins-rs/pacer-notify/manifest.json";
import classifier from "../../plugins-rs/pacer-classify/manifest.json";
import usage from "../../plugins-rs/pacer-usage/manifest.json";
import agentSession from "../../plugins-rs/pacer-agent-session/manifest.json";
import assistant from "../../plugins-rs/pacer-assistant/manifest.json";
// Pacer's own agent (ADR 0028): a native sibling, never spawned through `plugin run`.
import assistantPacer from "../../crates/assistant-pacer/manifest.json";
import assistantExecutor from "../../plugins-rs/assistant-executor/manifest.json";
import ssh from "../../plugins-rs/pacer-ssh/manifest.json";
import remoteCaller from "../../plugins-rs/pacer-remote-caller/manifest.json";
import directExecutor from "../../plugins-rs/pacer-exec-direct/manifest.json";
import orcaExecutor from "../../plugins-rs/pacer-exec-orca/manifest.json";

// Out of scope for C13: `pacer-dev` arrived with the workflow-frame workstream
// (ADR 0029) and has no native port yet. It keeps its TypeScript entry so the
// workflow contribution keeps working; it is the one remaining `main` row.
import pacerDev from "../../crates/bundled/manifests/pacer-dev.json";

const asManifest = (json: unknown): PluginManifest => json as PluginManifest;

/** Reference plugins available to the host; versions/ids are parity-checked with the Rust table. */
export const BUNDLED: BundledPlugin[] = [
  { manifest: asManifest(planners) },
  { manifest: asManifest(endpoints) },
  { manifest: asManifest(notifier) },
  { manifest: asManifest(classifier) },
  { manifest: asManifest(usage) },
  { manifest: asManifest(agentSession) },
  { manifest: asManifest(assistant) },
  { manifest: asManifest(assistantPacer), executable: "pacer-assistant-pacer" },
  { manifest: asManifest(assistantExecutor) },
  { manifest: asManifest(ssh) },
  { manifest: asManifest(remoteCaller) },
  { manifest: asManifest(directExecutor) },
  { manifest: asManifest(orcaExecutor) },
  // Still TypeScript; see the note above.
  { manifest: asManifest(pacerDev), main: () => import("../../plugins/pacer-dev/index") },
];

/** Deep-freeze manifests so bun:test `toMatchObject` / asymmetric matchers cannot
 * mutate the shared copies (that left non-cloneable shells and broke plugin start). */
function freezeManifest(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeManifest(child);
}
for (const plugin of BUNDLED) freezeManifest(plugin.manifest);
