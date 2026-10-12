import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/install/manifest";
import { pluginCli } from "../src/plugin/cli";
import { PLUGIN_FILES } from "../src/plugin/assets.generated";
import { fakeCtx, tmpDir } from "./helpers";

function setup() {
  const home = tmpDir();
  const userData = join(home, "orca-user-data");
  const f = fakeRun();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PACER_BIN: "/opt/pacer", PACER_ORCA_USER_DATA: userData }, run: f.run });
  return { home, userData, ctx, fake: f };
}
function fakeRun() {
  const calls: string[][] = [];
  return { calls, run: async (argv: string[]) => { calls.push(argv); return { code: 99, stdout: "", stderr: "unexpected process" }; } };
}

test("plugin install records generated files and leaves panel output untracked", async () => {
  const { ctx, fake } = setup();
  const root = join(ctx.pacerHome, "orca-plugin");
  const r = await pluginCli(["install"], ctx);
  expect(r.code).toBe(0);
  for (const file of ["orca-plugin.json", "worker.mjs", ".pacer-managed", "panel/live.html"]) expect(existsSync(join(root, file))).toBe(true);
  expect(readManifest(ctx).planners["orca-plugin"]?.files.map(f => f.action)).toEqual(["created", "created", "created"]);
  expect(readManifest(ctx).planners["orca-plugin"]?.files.some(f => f.path.endsWith("live.html"))).toBe(false);
  expect(r.out).toContain("development plugin paths");
  for (const cap of ["workspace:read", "terminal:send", "notifications:show", "events:subscribe", "storage", "settings:own"]) expect(r.out).toContain(cap);
  expect(fake.calls).toEqual([]);
});

test("plugin re-install leaves a worker-rewritten panel and all files unchanged", async () => {
  const { ctx } = setup();
  await pluginCli(["install"], ctx);
  const root = join(ctx.pacerHome, "orca-plugin");
  const before = PLUGIN_FILES.map(f => readFileSync(join(root, f.rel), "utf8"));
  const panel = join(root, "panel/live.html");
  writeFileSync(panel, "worker rendered this");
  const r = await pluginCli(["install"], ctx);
  expect(r.out).toContain("already installed, nothing changed");
  expect(PLUGIN_FILES.map(f => readFileSync(join(root, f.rel), "utf8"))).toEqual(before);
  expect(readFileSync(panel, "utf8")).toBe("worker rendered this");
});

test("plugin uninstall removes generated files, bridge key and empty directories", async () => {
  const { ctx, userData, fake } = setup();
  const root = join(ctx.pacerHome, "orca-plugin");
  await pluginCli(["install"], ctx);
  const data = join(userData, "plugins-data", "pacer.pacer");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "storage.json"), '{"link":{"v":1},"other":"keep"}');
  const r = await pluginCli(["uninstall"], ctx);
  expect(r.code).toBe(0);
  expect(existsSync(root)).toBe(false);
  expect(JSON.parse(readFileSync(join(data, "storage.json"), "utf8"))).toEqual({ other: "keep" });
  expect(r.out).toContain("development plugin paths");
  expect(fake.calls).toEqual([]);
});

test("plugin uninstall reports missing install", async () => {
  const { ctx } = setup();
  expect(await pluginCli(["uninstall"], ctx)).toMatchObject({ code: 1 });
});

test("plugin set validates values and writes isolated Orca settings", async () => {
  const { ctx, userData } = setup();
  expect(await pluginCli(["set", "transport", "http"], ctx)).toMatchObject({ code: 0 });
  expect(JSON.parse(readFileSync(join(userData, "plugins-data", "pacer.pacer", "settings.json"), "utf8"))).toEqual({ transport: "http" });
  expect((await pluginCli(["set", "transport", "ftp"], ctx)).code).toBe(2);
  expect((await pluginCli(["set", "port", "0"], ctx)).code).toBe(2);
  const settings = join(userData, "plugins-data", "pacer.pacer", "settings.json");
  writeFileSync(settings, "unreadable");
  expect((await pluginCli(["set", "transport", "bridge"], ctx)).code).toBe(1);
  expect(readFileSync(settings, "utf8")).toBe("unreadable");
});

test("plugin paths stay under a temporary home", async () => {
  const { ctx, home } = setup();
  expect(ctx.home).not.toBe(homedir());
  const before = readdirSync(home).sort();
  await pluginCli(["install"], ctx);
  expect(readdirSync(home).sort()).toEqual([...before, ".pacer"].sort());
  expect(ctx.pacerHome.startsWith(ctx.home)).toBe(true);
});
