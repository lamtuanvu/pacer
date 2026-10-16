import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { installPlugin, MANAGED_MARKER, pluginDir } from "../src/plugin/install";
import { PLUGIN_VERSION } from "../src/plugin/assets.generated";
import { readManifest, writeManifest } from "../src/install/manifest";
import { currentSnapshot } from "../src/link/store";
import { refreshManagedPlugin } from "../src/serve/plugin-refresh";
import { startServer } from "../src/serve/http";

async function fixture() {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer" } });
  ctx.env.HOME = ctx.home;
  ctx.env.PACER_HOME = ctx.pacerHome;
  await installPlugin({ ctx, pacerArgv: ["/opt/pacer"] });
  const marker = join(pluginDir(ctx), MANAGED_MARKER);
  writeFileSync(marker, JSON.stringify({ version: "0.1.17" }));
  writeFileSync(join(pluginDir(ctx), "worker.mjs"), "old worker");
  const lines: string[] = [];
  const deps = { standalone: true, execPath: "/opt/pacer", log: (s: string) => { lines.push(s); } };
  return { ctx, marker, lines, deps };
}

test("managed refresh installs bundled assets and persists an info alert", async () => {
  const { ctx, marker, lines, deps } = await fixture();
  await refreshManagedPlugin(ctx, PLUGIN_VERSION, deps);
  expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe(PLUGIN_VERSION);
  expect(readFileSync(join(pluginDir(ctx), "worker.mjs"), "utf8")).not.toBe("old worker");
  expect(lines).toEqual([`pacer: refreshed the Orca plugin to ${PLUGIN_VERSION}; turn pacer off and on in Orca Settings > Plugins to load it`]);
  expect(currentSnapshot(ctx).alerts).toContainEqual(expect.objectContaining({ key: "plugin-refreshed", level: "info", body: lines[0] }));
});

test("managed refresh contains install failures", async () => {
  const { ctx, lines, deps } = await fixture();
  await refreshManagedPlugin(ctx, PLUGIN_VERSION, { ...deps, install: async () => { throw Error("cannot write\nextra detail"); } });
  expect(lines).toEqual(["pacer: could not refresh the Orca plugin: cannot write"]);
  expect(currentSnapshot(ctx).alerts).toEqual([]);
});

test("serve start refreshes a stale managed plugin and publishes the reload hint", async () => {
  const { ctx, marker, lines, deps } = await fixture();
  const server = startServer(() => ctx, { port: 0, pumpMs: 0, pluginRefreshDeps: deps });
  try {
    for (let i = 0; i < 100 && !currentSnapshot(ctx).alerts.some(a => a.key === "plugin-refreshed"); i++) await Bun.sleep(10);
    expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe(PLUGIN_VERSION);
    expect(readFileSync(join(pluginDir(ctx), "worker.mjs"), "utf8")).not.toBe("old worker");
    const hint = `pacer: refreshed the Orca plugin to ${PLUGIN_VERSION}; turn pacer off and on in Orca Settings > Plugins to load it`;
    expect(lines).toEqual([hint]);
    expect(currentSnapshot(ctx).alerts).toContainEqual(expect.objectContaining({ key: "plugin-refreshed", level: "info", body: hint }));
  } finally { server.stop(); }
});

for (const skip of ["current", "record", "marker", "folder", "source"] as const) {
  test(`managed refresh skips ${skip}`, async () => {
    const { ctx, marker, lines, deps } = await fixture();
    if (skip === "current") writeFileSync(marker, JSON.stringify({ version: PLUGIN_VERSION }));
    if (skip === "record") { const m = readManifest(ctx); delete m.planners["orca-plugin"]; writeManifest(ctx, m); }
    if (skip === "marker") rmSync(marker);
    if (skip === "folder") rmSync(pluginDir(ctx), { recursive: true });
    if (skip === "source") deps.standalone = false;
    await refreshManagedPlugin(ctx, PLUGIN_VERSION, deps);
    if (skip !== "folder") expect(readFileSync(join(pluginDir(ctx), "worker.mjs"), "utf8")).toBe("old worker");
    else expect(existsSync(pluginDir(ctx))).toBe(false);
    expect(lines).toEqual([]);
    expect(currentSnapshot(ctx).alerts).toEqual([]);
  });
}

test("refresh failure logs one line and serve stays available", async () => {
  const { ctx, marker, lines, deps } = await fixture();
  const server = startServer(() => ctx, { port: 0, pumpMs: 0, pluginRefreshDeps: {
    ...deps, install: async () => { throw new Error("cannot write\nextra detail"); },
  } });
  try {
    for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cannot write");
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe("0.1.17");
    expect(currentSnapshot(ctx).alerts).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  } finally { server.stop(); }
});
