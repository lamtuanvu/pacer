import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { PluginRegistry } from "../src/plugins/registry";
import { bundledPluginSpawn } from "../src/plugins";
import { fakeCtx } from "./helpers";

test("production registry reports bundled direct readiness and disabled refusal", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-bundled-direct-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" } });
  const registry = new PluginRegistry({ bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
  try {
    const listed = registry.list(ctx).find(item => item.id === "pacer-exec-direct");
    expect(listed).toMatchObject({ bundled: true, enabled: true, contributes: ["executor"] });
    expect((await registry.doctor(ctx, "pacer-exec-direct"))[0]).toMatchObject({ ok: true });
    expect(await registry.call(ctx, "pacer-exec-direct", "executor.available",
      { strategy: { name: "default" } })).toEqual({ available: true });
    await registry.disable(ctx, "pacer-exec-direct");
    await expect(registry.call(ctx, "pacer-exec-direct", "executor.available",
      { strategy: { name: "default" } })).rejects.toMatchObject({ code: "plugin_unavailable" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
