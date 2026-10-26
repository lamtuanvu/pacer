import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { EXTENSION_METHODS, EXTENSION_POINTS, PLUGIN_PROTOCOL_VERSION, executorContribution, manifestSchema } from "../src/plugins/protocol";
import { PROTOCOL as SDK_PROTOCOL } from "@pacer/plugin";

const manifest = (contributes: unknown) => ({
  id: "fx-executor", version: "1.0.0", publisher: "test", host: "^1.5", contributes,
});
const available = EXTENSION_METHODS["executor.available"];

test("staged executor manifest and availability contract are exact and protocol 1.5 compatible", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.5.0");
  expect(SDK_PROTOCOL).toBe(PLUGIN_PROTOCOL_VERSION);
  expect(EXTENSION_POINTS).toContain("executor");
  expect(executorContribution.safeParse({ backends: ["direct"] }).success).toBe(true);
  for (const contribution of [{ backends: ["orca"] }, { backends: ["direct", "orca"] },
    { backends: ["direct"], command: "sh" }, { backends: ["direct"], credentials: {} }]) {
    expect(manifestSchema.safeParse(manifest({ executor: contribution })).success).toBe(false);
  }
  expect(manifestSchema.safeParse(manifest({ executor: { backends: ["direct"] } })).success).toBe(true);
  expect(manifestSchema.safeParse(manifest({ hostRunner: { kinds: ["ssh"] } })).success).toBe(true);
  expect(available.deadlineMs).toBe(10_000);
  expect(available.params.safeParse({ strategy: { name: "default" } }).success).toBe(true);
  for (const input of [{ strategy: {} }, { strategy: { name: "default", env: { KEY: "secret" } } },
    { strategy: { name: "default" }, command: "sh" }, { strategy: { name: "x".repeat(129) } }])
    expect(available.params.safeParse(input).success).toBe(false);
  expect(available.result.safeParse({ available: true }).success).toBe(true);
  expect(available.result.safeParse({ available: false, reason: "fixture unavailable" }).success).toBe(true);
  expect(available.result.safeParse({ available: true, unsafe: "extra" }).success).toBe(false);
  expect(available.result.safeParse({ available: true, reason: "x".repeat(1025) }).success).toBe(false);
  const published = JSON.parse(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.schema.json"), "utf8"));
  expect(published.version).toBe("1.5.0");
  expect(published.$defs.manifest.properties.contributes.properties.executor.properties.backends.prefixItems[0].const).toBe("direct");
  expect(published.$defs["executor.available.params"].properties.strategy.properties.name.maxLength).toBe(128);
  expect(published.$defs["executor.available.result"].additionalProperties).toBe(false);
  expect(published.$defs["hostRunner.check.params"]).toBeDefined();
});

test("installed fake executor validates availability without launching an attempt", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-executor-available-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  const folder = installFixture("executor", join(ctx.pacerHome, "plugins"));
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-executor", true);
    expect(registry.list(ctx)[0]?.pid).toBeNull();
    const doctor = (await registry.doctor(ctx, "fx-executor"))[0];
    expect(doctor?.ok).toBe(true);
    expect(doctor?.served).toContain("executor");
    await expect(registry.call(ctx, "fx-executor", "executor.available", { strategy: { name: "default" } }))
      .resolves.toEqual({ available: true });
    await expect(registry.call(ctx, "fx-executor", "executor.available", { strategy: { name: "default", env: {} } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(registry.call(ctx, "fx-executor", "executor.available", { strategy: { name: "default" } }, { deadlineMs: 0 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(registry.call(ctx, "fx-executor", "executor.run", {}))
      .rejects.toMatchObject({ code: "invalid_input" });
  } finally { await registry.shutdown(); }
  writeFileSync(join(folder, "fixture.json"), JSON.stringify({ available: true, malformed: true }));
  const malformed = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await expect(malformed.call(ctx, "fx-executor", "executor.available", { strategy: { name: "default" } }))
      .rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await malformed.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
