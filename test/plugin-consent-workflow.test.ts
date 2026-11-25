import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { shutdownPlugins } from "../src/plugins";
import { pluginRegistry } from "../src/plugins";
import { workflowNames } from "../src/plugins/registry";
import { pluginsConfig, setPluginGrant } from "../src/plugins/config";
import { fakeCtx, tmpDir } from "./helpers";
import { BUNDLED } from "../src/plugins/bundled";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function home() {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir, pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: Date.now() / 1000,
  });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}

function install(ctx: ReturnType<typeof fakeCtx>, id: string, workflows: string[], version = "1.0.0") {
  const dir = join(ctx.pacerHome, "plugins", id);
  mkdirSync(dir, { recursive: true });
  const contributes: Record<string, object> = {};
  for (const name of workflows) contributes[name] = {};
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({
    id, version, publisher: "test", host: ">=1.12.0",
    entry: "main.ts", contributes: { workflow: contributes }, capabilities: [{ name: "log" }],
  }));
  writeFileSync(join(dir, "main.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async () => ({ workflows: [] }),
  },
});
`);
  chmodSync(join(dir, "main.ts"), 0o755);
}

test("install prompt lists workflows; grant stores names", async () => {
  const ctx = home();
  install(ctx, "fx-consent", ["feature", "router"]);
  const asked = await callOp(ctx, "plugin.enable", { id: "fx-consent" }) as {
    state: string; needs?: string[]; workflows?: string[];
  };
  expect(asked).toMatchObject({ state: "needs_grant", needs: ["log"], workflows: ["feature", "router"] });
  await callOp(ctx, "plugin.enable", { id: "fx-consent", grant: true });
  expect(pluginsConfig(ctx).installed["fx-consent"]).toMatchObject({
    version: "1.0.0", capabilities: ["log"], workflows: ["feature", "router"],
  });
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toMatch(/workflows:/);
}, 20000);

test("upgrade that adds a workflow prompts again; same names do not; removing a name does not", async () => {
  const ctx = home();
  install(ctx, "fx-up", ["feature"], "1.0.0");
  await callOp(ctx, "plugin.enable", { id: "fx-up", grant: true });
  expect((await callOp(ctx, "plugin.enable", { id: "fx-up" }) as { state: string }).state).toMatch(/^(idle|starting|ready)$/);

  // Same names, new version still re-records but grantCovers passes when workflows covered.
  install(ctx, "fx-up", ["feature"], "1.0.1");
  pluginRegistry(ctx).list(ctx);
  // Version change with same workflows: enable without grant should still work if capabilities covered…
  // grantCovers checks capabilities and workflows, not version. Version mismatch alone does not needs_grant.
  expect((await callOp(ctx, "plugin.enable", { id: "fx-up" }) as { state: string }).state).toMatch(/^(idle|starting|ready)$/);

  // Adding a workflow asks again.
  install(ctx, "fx-up", ["feature", "router"], "1.1.0");
  pluginRegistry(ctx).list(ctx);
  const again = await callOp(ctx, "plugin.enable", { id: "fx-up" }) as { state: string; workflows?: string[] };
  expect(again).toMatchObject({ state: "needs_grant", workflows: ["feature", "router"] });
  await callOp(ctx, "plugin.enable", { id: "fx-up", grant: true });

  // Removing a name does not ask again.
  install(ctx, "fx-up", ["feature"], "1.2.0");
  pluginRegistry(ctx).list(ctx);
  expect((await callOp(ctx, "plugin.enable", { id: "fx-up" }) as { state: string }).state).toMatch(/^(idle|starting|ready)$/);
}, 30000);

test("hand-edited grant missing a workflow name still requires consent", async () => {
  const ctx = home();
  install(ctx, "fx-hand", ["feature", "router"]);
  await callOp(ctx, "plugin.enable", { id: "fx-hand", grant: true });
  await setPluginGrant(ctx, "fx-hand", { version: "1.0.0", capabilities: ["log"], workflows: ["feature"] });
  pluginRegistry(ctx).list(ctx);
  expect(await callOp(ctx, "plugin.enable", { id: "fx-hand" })).toMatchObject({
    state: "needs_grant", workflows: ["feature", "router"],
  });
}, 20000);

test("reinstall and sideload cannot bypass workflow consent", async () => {
  const ctx = home();
  install(ctx, "fx-side", ["feature"], "1.0.0");
  await callOp(ctx, "plugin.enable", { id: "fx-side", grant: true });
  expect((await callOp(ctx, "plugin.enable", { id: "fx-side" }) as { state: string }).state).toMatch(/^(idle|starting|ready)$/);

  install(ctx, "fx-side", ["feature", "extra"], "1.0.1");
  pluginRegistry(ctx).list(ctx);
  expect(await callOp(ctx, "plugin.enable", { id: "fx-side" })).toMatchObject({
    state: "needs_grant", needs: ["log"], workflows: expect.arrayContaining(["feature", "extra"]),
  });
  await callOp(ctx, "plugin.enable", { id: "fx-side", grant: true });
  expect((await callOp(ctx, "plugin.enable", { id: "fx-side" }) as { state: string }).state).toMatch(/^(idle|starting|ready)$/);

  install(ctx, "fx-side", ["feature", "extra", "labs"], "1.0.2");
  pluginRegistry(ctx).list(ctx);
  expect(await callOp(ctx, "plugin.enable", { id: "fx-side" })).toMatchObject({
    state: "needs_grant", needs: ["log"], workflows: expect.arrayContaining(["feature", "extra", "labs"]),
  });
}, 30000);

test("bundled plugins never need a workflow grant", () => {
  const withWorkflow = BUNDLED.filter(b => workflowNames(b.manifest).length > 0);
  // Bundled path skips grantCovers; pacer-dev contributes workflows and never prompts.
  expect(withWorkflow.map(b => b.manifest.id)).toEqual(["pacer-dev"]);
  expect(workflowNames(withWorkflow[0]!.manifest).sort()).toEqual(["ask", "bug", "feature", "router"]);
});
