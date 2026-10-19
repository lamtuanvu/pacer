import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { installPlugin, MANAGED_MARKER, pluginDir } from "../src/plugin/install";
import { PLUGIN_FILES, PLUGIN_VERSION } from "../src/plugin/assets.generated";
import { BUNDLED_PLUGIN_HASH, installedPluginHash } from "../src/plugin/content";
import { readManifest, writeManifest } from "../src/install/manifest";
import { readPluginReload } from "../src/attention/plugin-reload";
import { refreshManagedPlugin } from "../src/serve/plugin-refresh";
import { startServer } from "../src/serve/http";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture } from "./read-model-helpers";
import { dismiss } from "../src/core/attention";

async function fixture() {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer" } });
  ctx.env.HOME = ctx.home;
  ctx.env.PACER_HOME = ctx.pacerHome;
  await installPlugin({ ctx, pacerArgv: ["/opt/pacer"] });
  const marker = join(pluginDir(ctx), MANAGED_MARKER);
  const lines: string[] = [];
  const deps = { standalone: true, execPath: "/opt/pacer", log: (s: string) => { lines.push(s); } };
  return { ctx, marker, lines, deps };
}
function attention(ctx: ReturnType<typeof fakeCtx>) {
  const { s, st } = capacityFixture();
  return buildReadModel(ctx, { strategy: s, status: st, tasks: [], hosts: [], setup: { complete: true, checkedAt: ctx.now, items: [] } }).attention;
}
const hint = `pacer: refreshed the Orca plugin to ${PLUGIN_VERSION}; see Needs you for reload instructions`;

test("unchanged assets skip installation regardless of marker version, including dev versions", async () => {
  for (const version of [PLUGIN_VERSION, "0.0.0-dev", "0.1.17"]) {
    const { ctx, marker, lines, deps } = await fixture();
    writeFileSync(marker, JSON.stringify({ version }));
    writeFileSync(join(pluginDir(ctx), "panel/live.html"), "service rendered panel");
    let installs = 0;
    await refreshManagedPlugin(ctx, { ...deps, install: async () => { installs++; throw Error("unexpected install"); } });
    expect(installedPluginHash(pluginDir(ctx))).toBe(BUNDLED_PLUGIN_HASH);
    expect(installs).toBe(0);
    expect(lines).toEqual([]);
    expect(readPluginReload(ctx)).toBeNull();
  }
});

for (const file of PLUGIN_FILES) {
  for (const change of ["changed", "missing"] as const) {
    test(`${change} ${file.rel} refreshes even at the same version`, async () => {
      const { ctx, lines, deps } = await fixture();
      const path = join(pluginDir(ctx), file.rel);
      if (change === "missing") rmSync(path);
      else writeFileSync(path, `${file.text}\nchanged`);
      expect(installedPluginHash(pluginDir(ctx))).not.toBe(BUNDLED_PLUGIN_HASH);
      await refreshManagedPlugin(ctx, deps);
      expect(installedPluginHash(pluginDir(ctx))).toBe(BUNDLED_PLUGIN_HASH);
      expect(lines).toEqual([hint]);
      expect(readPluginReload(ctx)).toEqual({ hash: BUNDLED_PLUGIN_HASH, version: PLUGIN_VERSION, at: ctx.now });
    });
  }
}

test("reload instructions appear once in Needs you and stay dismissed across restarts", async () => {
  const { ctx, lines, deps } = await fixture();
  writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
  await refreshManagedPlugin(ctx, deps);
  const item = attention(ctx).find(i => i.id === `setup:plugin-reload-${BUNDLED_PLUGIN_HASH}`)!;
  expect(item.detail).toContain("Turn pacer off and on");
  expect(item.actions).toEqual([{ label: "Done", op: "attention.dismiss", params: { id: item.id } }]);
  await refreshManagedPlugin({ ...ctx, now: ctx.now + 60 }, deps);
  expect(attention(ctx).filter(i => i.id === item.id)).toHaveLength(1);
  await dismiss(ctx, item.id);
  await refreshManagedPlugin({ ...ctx, now: ctx.now + 120 }, deps);
  expect(attention(ctx).some(i => i.id === item.id)).toBe(false);
  expect(lines).toEqual([hint]);
});

test("managed refresh contains install failures", async () => {
  const { ctx, lines, deps } = await fixture();
  writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
  await refreshManagedPlugin(ctx, { ...deps, install: async () => { throw Error("cannot write\nextra detail"); } });
  expect(lines).toEqual(["pacer: could not refresh the Orca plugin: cannot write"]);
  expect(readPluginReload(ctx)).toBeNull();
});

test("serve start refreshes stale assets and the next start stays quiet", async () => {
  const { ctx, lines, deps } = await fixture();
  writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
  for (let start = 0; start < 2; start++) {
    const server = startServer(() => ctx, { port: 0, pumpMs: 0, pluginRefreshDeps: deps });
    try {
      for (let i = 0; i < 100 && !readPluginReload(ctx); i++) await Bun.sleep(10);
      expect(installedPluginHash(pluginDir(ctx))).toBe(BUNDLED_PLUGIN_HASH);
      expect(lines).toEqual([hint]);
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    } finally { server.stop(); }
  }
});

for (const skip of ["record", "marker", "folder", "source"] as const) {
  test(`managed refresh skips ${skip}`, async () => {
    const { ctx, marker, lines, deps } = await fixture();
    writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
    if (skip === "record") { const m = readManifest(ctx); delete m.planners["orca-plugin"]; writeManifest(ctx, m); }
    if (skip === "marker") rmSync(marker);
    if (skip === "folder") rmSync(pluginDir(ctx), { recursive: true });
    if (skip === "source") deps.standalone = false;
    await refreshManagedPlugin(ctx, deps);
    if (skip !== "folder") expect(readFileSync(join(pluginDir(ctx), "worker.mjs"), "utf8")).toBe("old worker");
    else expect(existsSync(pluginDir(ctx))).toBe(false);
    expect(lines).toEqual([]);
    expect(readPluginReload(ctx)).toBeNull();
  });
}

test("refresh failure logs one line and serve stays available", async () => {
  const { ctx, lines, deps } = await fixture();
  writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
  const server = startServer(() => ctx, { port: 0, pumpMs: 0, pluginRefreshDeps: {
    ...deps, install: async () => { throw new Error("cannot write\nextra detail"); },
  } });
  try {
    for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(10);
    expect(lines).toEqual(["pacer: could not refresh the Orca plugin: cannot write"]);
    expect(readPluginReload(ctx)).toBeNull();
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  } finally { server.stop(); }
});
