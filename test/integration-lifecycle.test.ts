import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { PACER } from "./install-helpers";
import { installPlanner } from "../src/install";
import { ensureRunnerIntegration } from "../src/core/integrations";
import { startServer } from "../src/serve/http";
import { readManifest, writeManifest } from "../src/install/manifest";
import { sha256 } from "../src/install/fsx";

const runner = { id: "codex", name: "codex", agent: "codex" as const, account: "codex", host: null, model: null };

test("launch readiness refuses customized assets and includes a repair hint", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
  await installPlanner({ ctx, pacerArgv: PACER }, "codex");
  writeFileSync(join(ctx.home, ".codex/skills/pacer/SKILL.md"), "my customization");
  try { await ensureRunnerIntegration(ctx, runner); throw Error("launch incorrectly admitted"); }
  catch (error: any) { expect(error.code).toBe("conflict"); expect(error.hint).toContain("pacer install codex"); }
});

test("unconnected and remote runners launch without installing integrations", async () => {
  const ctx = fakeCtx();
  await ensureRunnerIntegration(ctx, runner);
  await ensureRunnerIntegration(ctx, { ...runner, host: "remote" });
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
});

test("service startup reconciles old recorded assets while health stays available", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
  await installPlanner({ ctx, pacerArgv: PACER }, "codex");
  const path = join(ctx.home, ".codex/skills/pacer/SKILL.md"), desired = readFileSync(path, "utf8");
  writeFileSync(path, "old skill");
  const manifest = readManifest(ctx), skill = manifest.planners.codex.files.find(file => file.path === path)!;
  skill.afterHash = sha256("old skill"); delete skill.managed; writeManifest(ctx, manifest);
  const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 60000 });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).ok).toBe(true);
    await ensureRunnerIntegration(ctx, runner);
    expect(readFileSync(path, "utf8")).toBe(desired);
  } finally { await server.stop(); }
});
