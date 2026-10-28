import type { BundledPlugin } from "../src/plugins/types";
/** Reference plugins compiled into the pacer binary. Sub-project 2 adds pacer-usage. */
export const BUNDLED: BundledPlugin[] = [{
  manifest: {id: "pacer-agent-session", version: "1.0.0", publisher: "pacer", host: "^1", contributes: {agentSession: {}}, capabilities: [], reentrant: true, tier: "free"},
  main: () => import("./agent-session/index"),
}, {
  manifest: {id: "pacer-assistant", version: "1.0.0", publisher: "pacer", host: "^1.2", contributes: {assistant: {}}, capabilities: [{name: "secrets.resolve", scopes: ["endpoint"]}, {name: "net.http"}], reentrant: true, tier: "free"},
  main: () => import("./assistant/index"),
}];
