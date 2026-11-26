import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { shutdownPlugins } from "../src/plugins";
import { fakeCtx, tmpDir } from "./helpers";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

/** Canonical `plugin.list` entry for a workflow contributor — matches crates/plugin-ops. */
const LIST_ENTRY = {
  ui: { activity: 0, panelTabs: 0, settings: 0, status: 0 },
  surfaces: [] as string[],
  id: "fx-workflow",
  version: "1.0.0",
  publisher: "fixture",
  tier: "free" as const,
  bundled: false,
  enabled: true,
  state: "idle",
  contributes: ["workflow"],
  capabilities: [] as { name: string }[],
  grant: {
    version: "1.0.0",
    capabilities: [] as string[],
    policy: false,
    workflows: ["demo"],
  },
  error: null as string | null,
  pid: null as number | null,
};

test("plugin.list JSON for a workflow plugin matches the Rust listing shape", async () => {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir,
    pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: Date.now() / 1000,
  });
  contexts.push(ctx);
  // The fixture plugin imports @pacer/plugin; without this link it cannot resolve the SDK outside the repo,
  // exits at start-up and the listing carries "plugin stdout closed" (seen on CI runners).
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins", "fx-workflow"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  writeFileSync(join(ctx.pacerHome, "plugins", "fx-workflow", "pacer-plugin.json"), JSON.stringify({
    id: "fx-workflow",
    version: "1.0.0",
    publisher: "fixture",
    host: ">=1.12.0",
    entry: "main.ts",
    capabilities: [],
    contributes: { workflow: { demo: { title: "Demo" } } },
  }));
  writeFileSync(join(ctx.pacerHome, "plugins", "fx-workflow", "main.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve, stdinLines, workflowDefinitions } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    ...workflowDefinitions(() => ({ workflows: [] })),
  },
});
`);
  chmodSync(join(ctx.pacerHome, "plugins", "fx-workflow", "main.ts"), 0o755);

  const first = await callOp(ctx, "plugin.enable", { id: "fx-workflow" }) as { state: string; workflows?: string[] };
  expect(first).toMatchObject({ state: "needs_grant", workflows: ["demo"] });
  await callOp(ctx, "plugin.enable", { id: "fx-workflow", grant: true });

  const listed = await callOp(ctx, "plugin.list", {}) as { plugins: typeof LIST_ENTRY[] };
  const entry = listed.plugins.find(p => p.id === "fx-workflow");
  expect(entry).toBeDefined();
  // Drop volatile process fields after enable may have started the plugin for sync.
  const stable = { ...entry!, pid: null, state: "idle", enabled: true };
  expect(JSON.stringify(stable)).toBe(JSON.stringify(LIST_ENTRY));
}, 30000);
