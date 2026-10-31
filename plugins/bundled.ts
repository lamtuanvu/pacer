import { manifest as plannerManifest } from "./pacer-planners/index";
import { manifestSchema } from "../src/plugins/protocol";
import { manifest as endpointManifest } from "./pacer-endpoints/manifest";
import { manifest as notifierManifest } from "./pacer-notify/manifest";
import { manifest as classifierManifest } from "./pacer-classify/manifest";
import type { BundledPlugin } from "../src/plugins/types";
import { manifest as sshManifest } from "./pacer-ssh/manifest";
import { manifest as remoteCallerManifest } from "./pacer-remote-caller/index";
/** Reference plugins compiled into the pacer binary; installed shadows never replace these IDs. */
export const BUNDLED: BundledPlugin[] = [{manifest:manifestSchema.parse(plannerManifest),main:()=>import("./pacer-planners/index")}, { manifest: manifestSchema.parse(endpointManifest), main: () => import("./pacer-endpoints/index") }, { manifest: notifierManifest, main: () => import("./pacer-notify/index") }, { manifest: classifierManifest, main: () => import("./pacer-classify/index") }, {
  manifest: { id: "pacer-usage", version: "0.2.0", publisher: "pacer", host: "^1.6", contributes: { usage: { providers: ["claude-code", "codex", "arkcli", "metered"] } },
    capabilities: [{ name: "fs.read", scopes: ["${PACER_HOME}/cache/claude-rate-limits*.json", "${HOME}/.claude/state/budget/claude.json", "${ACCOUNT_HOME}/state/budget/claude.json", "${ACCOUNT_HOME}/sessions/**/rollout-*.jsonl"] },
      { name: "process.spawn", scopes: ["arkcli", "opencode", "codex"] }, { name: "usage.state" }], reentrant: true, tier: "free" },
  main: () => import("./pacer-usage/index"),
}, {
  manifest: {id: "pacer-agent-session", version: "1.0.0", publisher: "pacer", host: "^1", contributes: {agentSession: {}}, capabilities: [], reentrant: true, tier: "free"},
  main: () => import("./agent-session/index"),
}, {
  manifest: {id: "pacer-assistant", version: "1.0.0", publisher: "pacer", host: "^1.3", contributes: {assistant: {}}, capabilities: [{name: "secrets.resolve", scopes: ["endpoint"]}, {name: "net.http"}], reentrant: true, tier: "free"},
  main: () => import("./assistant/index"),
}, { manifest: manifestSchema.parse(sshManifest), main: () => import("./pacer-ssh/index") },
  { manifest: manifestSchema.parse(remoteCallerManifest), main: () => import("./pacer-remote-caller/index") }];
