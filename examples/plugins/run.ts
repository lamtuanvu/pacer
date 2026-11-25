/**
 * Source-mode runner for the SDK example plugins: `bun examples/plugins/run.ts <id>`.
 *
 * The shipped product serves every bundled plugin natively (`pacer plugin run <id>`).
 * These sources stay as the parity reference until D3; this runner is the TS half
 * of `test/plugin-parity` and of a source-mode service without the Rust door.
 */
import { serve, stdinLines } from "@pacer/plugin";

import planners from "../../plugins-rs/pacer-planners/manifest.json";
import endpoints from "../../plugins-rs/pacer-endpoints/manifest.json";
import notifier from "../../plugins-rs/pacer-notify/manifest.json";
import classifier from "../../plugins-rs/pacer-classify/manifest.json";
import usage from "../../plugins-rs/pacer-usage/manifest.json";
import agentSession from "../../plugins-rs/pacer-agent-session/manifest.json";
import assistant from "../../plugins-rs/pacer-assistant/manifest.json";
import assistantExecutor from "../../plugins-rs/assistant-executor/manifest.json";
import ssh from "../../plugins-rs/pacer-ssh/manifest.json";
import remoteCaller from "../../plugins-rs/pacer-remote-caller/manifest.json";
import directExecutor from "../../plugins-rs/pacer-exec-direct/manifest.json";
import orcaExecutor from "../../plugins-rs/pacer-exec-orca/manifest.json";
import pacerDev from "../../crates/bundled/manifests/pacer-dev.json";

type Entry = {
  manifest: unknown;
  main: () => Promise<{ handlers: Record<string, unknown> }>;
};

const BUNDLED: Record<string, Entry> = {
  "pacer-planners": { manifest: planners, main: () => import("./pacer-planners/index") },
  "pacer-endpoints": { manifest: endpoints, main: () => import("./pacer-endpoints/index") },
  "pacer-notify": { manifest: notifier, main: () => import("./pacer-notify/index") },
  "pacer-classify": { manifest: classifier, main: () => import("./pacer-classify/index") },
  "pacer-usage": { manifest: usage, main: () => import("./pacer-usage/index") },
  "pacer-agent-session": { manifest: agentSession, main: () => import("./agent-session/index") },
  "pacer-assistant": { manifest: assistant, main: () => import("./assistant/index") },
  "assistant-executor": { manifest: assistantExecutor, main: () => import("./assistant-executor/index") },
  "pacer-ssh": { manifest: ssh, main: () => import("./pacer-ssh/index") },
  "pacer-remote-caller": { manifest: remoteCaller, main: () => import("./pacer-remote-caller/index") },
  "pacer-exec-direct": { manifest: directExecutor, main: () => import("./pacer-exec-direct/index") },
  "pacer-exec-orca": { manifest: orcaExecutor, main: () => import("./pacer-exec-orca/index") },
  // Out of scope for C13: the workflow-frame plugin has no native port yet.
  "pacer-dev": { manifest: pacerDev, main: () => import("../../plugins/pacer-dev/index") },
};

const id = process.argv[2];
const bundled = id === undefined ? undefined : BUNDLED[id];
if (!bundled) {
  process.stderr.write(`pacer: no bundled plugin ${id ?? ""}\n`);
  process.exit(2);
}

const { handlers } = await bundled.main();
await serve({
  manifest: bundled.manifest as Parameters<typeof serve>[0]["manifest"],
  handlers: handlers as Parameters<typeof serve>[0]["handlers"],
  input: stdinLines(),
});
