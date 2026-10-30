import { expect, test } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import type { PluginManifest } from "../src/plugins/protocol";
import { withPlannerInstall } from "../src/plugins/planner-install";
async function fixture(slow: boolean) {
  const ctx = fakeCtx(),
    folder = join(ctx.home, ".codex"),
    binary = join(ctx.home, "fixture-tool");
  await mkdir(folder);
  await mkdir(ctx.pacerHome);
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[2],process.argv[3]);if(process.argv[3]==='forward'&&${slow})await Bun.sleep(10000);`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "fixture-tool" ? binary : null);
  const manifest: PluginManifest = {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [folder + "/**"] },
      { name: "fs.write", scopes: [folder + "/**"] },
      { name: "process.spawn", scopes: ["fixture-tool"] },
    ],
    tier: "free",
    reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/install.ts"),
      ],
      cwd: ctx.home,
      env: {},
    }),
  });
  return {
    ctx,
    folder,
    registry,
    close: async () => {
      await registry.shutdown();
      await rm(ctx.home, { recursive: true, force: true });
    },
  };
}
test("caller cancellation while an admitted command runs drains it and compensates with retained pins", async () => {
  const f = await fixture(true),
    controller = new AbortController();
  try {
    const work = withPlannerInstall(
      { ctx: f.ctx, pacerArgv: ["pacer"], folder: f.folder },
      "synthetic",
      {
        pluginId: "sp06-install",
        roots: [f.folder],
        binaries: ["fixture-tool"],
        registry: f.registry,
        signal: controller.signal,
      },
    );
    const rejected = work.then(
      () => ({ resolved: true }),
      (error) => error,
    );
    const deadline = Date.now() + 3000;
    while (!(await Bun.file(join(f.folder, "command")).exists())) {
      if (Date.now() > deadline) throw Error("command not admitted");
      await Bun.sleep(5);
    }
    controller.abort();
    expect(await rejected).toMatchObject({ code: "plugin_unavailable" });
    expect(await readFile(join(f.folder, "command"), "utf8")).toBe("undo");
    expect(await Bun.file(join(f.folder, "settings.json")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(f.ctx.pacerHome, "install-manifest.json")).exists(),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test("child loss after actual command reply and before final plan still compensates", async () => {
  const f = await fixture(false);
  try {
    await expect(
      withPlannerInstall(
        { ctx: f.ctx, pacerArgv: ["fixture-crash"], folder: f.folder },
        "synthetic",
        {
          pluginId: "sp06-install",
          roots: [f.folder],
          binaries: ["fixture-tool"],
          registry: f.registry,
        },
      ),
    ).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(await readFile(join(f.folder, "command"), "utf8")).toBe("undo");
    expect(await Bun.file(join(f.folder, "settings.json")).exists()).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});
test("caller cancellation after final candidate does not abandon admitted journal settlement", async () => {
  const f = await fixture(false),
    controller = new AbortController();
  try {
    const report = await withPlannerInstall(
      { ctx: f.ctx, pacerArgv: ["pacer"], folder: f.folder },
      "synthetic",
      {
        pluginId: "sp06-install",
        roots: [f.folder],
        binaries: [],
        registry: f.registry,
        signal: controller.signal,
        beforeCommit: () => controller.abort(),
      },
    );
    expect(report.record.planner).toBe("synthetic");
    expect(await readFile(join(f.folder, "settings.json"), "utf8")).toBe(
      "installed",
    );
    expect(
      await Bun.file(
        join(f.ctx.pacerHome, "install-transaction.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test("config generation retirement rejects old pending admission while parent compensation survives", async () => {
  const f = await fixture(true);
  try {
    await writeFile(
      join(f.ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders:\n  claude-code: {}\n",
    );
    const work = withPlannerInstall(
      { ctx: f.ctx, pacerArgv: ["pacer"], folder: f.folder },
      "synthetic",
      {
        pluginId: "sp06-install",
        roots: [f.folder],
        binaries: ["fixture-tool"],
        registry: f.registry,
      },
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const deadline = Date.now() + 3000;
    while (!(await Bun.file(join(f.folder, "command")).exists())) {
      if (Date.now() > deadline) throw Error("command not admitted");
      await Bun.sleep(5);
    }
    await writeFile(
      join(f.ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    sp06-install:\n      generation: changed\n",
    );
    f.registry.refresh(f.ctx);
    expect((await work).error).toMatchObject({ code: "plugin_unavailable" });
    expect(await readFile(join(f.folder, "command"), "utf8")).toBe("undo");
  } finally {
    await f.close();
  }
});
