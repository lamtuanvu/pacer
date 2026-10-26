import {enableReviewed} from "./fixtures/plugin-consent";
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { pluginLogPath } from "../src/plugins/host";
import type { PluginManifest } from "../src/plugins/protocol";
import { PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";
import { fakeCtx } from "./helpers";

const entry = join(import.meta.dir, "fixtures/sp02-security/legacy-plugin.ts");
function home(id: string) {
  const ctx = fakeCtx({ now: Date.now() / 1000, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
  mkdirSync(join(ctx.home, ".codex"), { recursive: true });
  writeFileSync(join(ctx.home, ".codex/auth.json"), "synthetic-credential-must-not-cross-boundary");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders:\n  codex: {}\nplugins:\n  config:\n    ${id}: {label: legacy-public-config}\n`);
  return ctx;
}
function manifest(id: string): PluginManifest {
  return { id, version: "1.0.0", publisher: "test", host: "^1", contributes: { diagnostic: {}, agentSession: {} },
    capabilities: [{ name: "log" }, { name: "config.get" }, { name: "fs.read", scopes: ["$ACCOUNT_HOME/sessions/**"] }], reentrant: false, tier: "free" };
}
function install(ctx: ReturnType<typeof fakeCtx>, value: PluginManifest) {
  const dir = join(ctx.pacerHome, "plugins", value.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({ ...value, entry: "main.ts" }));
  copyFileSync(entry, join(dir, "main.ts")); chmodSync(join(dir, "main.ts"), 0o700);
}

test("raw1.0 plugin retains agentSession/config/log but gains no uncorrelated account reads", async () => {
  const id = "sp02-legacy", ctx = home(id);
  install(ctx, manifest(id));
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle in legacy fixture"); } });
  try {
    await enableReviewed(registry, ctx, id);
    expect(await registry.call(ctx, id, "diagnostic.ping", {})).toMatchObject({ ok: true });
    expect(await registry.call(ctx, id, "agentSession.capabilities", { agent: "codex", version: "0.163.0" }))
      .toEqual({ interactive: true, resume: true, launchImages: true, liveImages: false, files: true });
    expect(await registry.call(ctx, id, "agentSession.prepare", { agent: "codex", version: "0.163.0", request: "public fixture request",
      workspace: ctx.home, runDir: ctx.home, attachments: [], permissionPolicy: "native" }))
      .toEqual({ argv: ["fixture-agent", "--", "public fixture request"], cwd: ctx.home });
    const [doctor] = await registry.doctor(ctx, id);
    expect(doctor).toMatchObject({ ok: true, protocol: { host: PLUGIN_PROTOCOL_VERSION, plugin: "1.0.0" } });
    const log = readFileSync(pluginLogPath(ctx, id), "utf8");
    expect(log).toContain("legacy-config:legacy-public-config; legacy-fs:capability_denied");
    expect(log).not.toContain("synthetic-credential-must-not-cross-boundary");
  } finally { await registry.shutdown(); }
}, 10000);

test("an installed same-id folder cannot replace or refuse the canonical bundled plugin", async () => {
  const id = "sp02-bundled", ctx = home(id), value = manifest(id);
  const registry = new PluginRegistry({ bundled: [{ manifest: value, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({ argv: [process.execPath, entry], cwd: ctx.home, env: {} }) });
  try {
    expect(await registry.call(ctx, id, "diagnostic.ping", {})).toMatchObject({ ok: true });
    install(ctx, value);
    registry.refresh(ctx);
    const entries = registry.list(ctx).filter(plugin => plugin.id === id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ bundled: true, enabled: true, version: "1.0.0" });
    expect(entries[0].state).not.toBe("refused");
    expect(await registry.call(ctx, id, "agentSession.capabilities", { agent: "codex", version: "0.163.0" }))
      .toMatchObject({ interactive: true, files: true });
  } finally { await registry.shutdown(); }
}, 10000);
