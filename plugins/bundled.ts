import { manifestSchema } from "../src/plugins/protocol";
import { manifest as endpointManifest } from "./pacer-endpoints/index";
import { manifest as notifierManifest } from "./pacer-notify/index";
import { manifest as classifierManifest } from "./pacer-classify/manifest";
import type { BundledPlugin } from "../src/plugins/types";
/** Reference plugins compiled into the pacer binary; installed shadows never replace these IDs. */
export const BUNDLED: BundledPlugin[] = [{ manifest: manifestSchema.parse(endpointManifest), main: () => import("./pacer-endpoints/index") }, { manifest: notifierManifest, main: () => import("./pacer-notify/index") }, { manifest: classifierManifest, main: () => import("./pacer-classify/index") }, {
  manifest: { id: "pacer-usage", version: "0.2.0", publisher: "pacer", host: "^1.1", contributes: { usage: { providers: ["claude-code", "codex", "arkcli", "metered"] } },
    capabilities: [{ name: "fs.read", scopes: ["${PACER_HOME}/cache/claude-rate-limits*.json", "${HOME}/.claude/state/budget/claude.json", "${ACCOUNT_HOME}/sessions/**/rollout-*.jsonl"] },
      { name: "process.spawn", scopes: ["arkcli", "opencode"] }, { name: "usage.state" }], reentrant: true, tier: "free" },
  main: () => import("./pacer-usage/index"),
}, {
  manifest: {id: "pacer-agent-session", version: "1.0.0", publisher: "pacer", host: "^1", contributes: {agentSession: {}}, capabilities: [], reentrant: true, tier: "free"},
  main: () => import("./agent-session/index"),
}];
