import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { readManifest } from "../src/install/manifest";
import { fakeCtx, installLegacyPlugin, tmpDir } from "./helpers";

function setup() {
  const home = tmpDir(), userData = join(home, "orca-user-data");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PACER_BIN: "/opt/pacer", PACER_ORCA_USER_DATA: userData }, run: async () => ({ code: 99, stdout: "", stderr: "unexpected process" }) });
  return { ctx, userData };
}

test("plugin subcommands other than uninstall explain the plugin was removed", async () => {
  const { ctx } = setup();
  for (const args of [["install"], ["status"], ["set", "port", "4317"], []]) {
    const r = await main(["plugin", ...args], ctx);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no longer ships an Orca plugin");
    expect(r.err).toContain("pacer plugin uninstall");
  }
  expect(existsSync(join(ctx.pacerHome, "orca-plugin"))).toBe(false);
});

test("plugin uninstall removes an earlier install, its panel and both storage keys", async () => {
  const { ctx, userData } = setup();
  const root = await installLegacyPlugin(ctx);
  writeFileSync(join(root, ".pacer-panel-serve.json"), '{"at":1}');
  writeFileSync(join(ctx.pacerHome, "plugin-version.json"), '{"version":"0.1.0"}');
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "state", "plugin-reload.json"), "{}");
  for (const key of ["lamtuanvu.pacer", "pacer.pacer"]) {
    mkdirSync(join(userData, "plugins-data", key), { recursive: true });
    writeFileSync(join(userData, "plugins-data", key, "storage.json"), '{"link":{"v":1},"other":"keep"}');
  }
  const r = await main(["plugin", "uninstall"], ctx);
  expect(r.code).toBe(0);
  expect(r.out).toContain("development plugin paths");
  expect(existsSync(root)).toBe(false);
  expect(readManifest(ctx).planners["orca-plugin"]).toBeUndefined();
  for (const leftover of ["plugin-version.json", "state/plugin-reload.json"]) expect(existsSync(join(ctx.pacerHome, leftover))).toBe(false);
  for (const key of ["lamtuanvu.pacer", "pacer.pacer"]) expect(JSON.parse(readFileSync(join(userData, "plugins-data", key, "storage.json"), "utf8"))).toEqual({ other: "keep" });
  expect(await main(["plugin", "uninstall"], ctx)).toMatchObject({ code: 1, err: "pacer: the Orca plugin is not installed" });
});

test("serve no longer writes an Orca panel for a leftover install", async () => {
  const { ctx } = setup();
  const root = await installLegacyPlugin(ctx);
  const { startServer } = await import("../src/serve/http");
  const server = startServer(() => ctx, { port: 0, listener: false });
  // The old writer refreshed the panel within its first two-second cycle.
  try { await Bun.sleep(3000); } finally { server.stop(); }
  expect(readFileSync(join(root, "panel", "live.html"), "utf8")).toBe("<p>panel</p>");
});
