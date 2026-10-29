import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { withPlannerInstall } from "../src/plugins/planner-install";
import type { PluginManifest } from "../src/plugins/protocol";
test("actual child prepared plan is settled through parent SDK journal preserving unrelated manifest record", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.home, "planner");
  await mkdir(folder);
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(join(folder, "settings.json"), "before", { mode: 0o700 });
  const unrelated = {
    planner: "other",
    installedAt: 1,
    pacerArgv: ["pacer"],
    files: [],
    commands: [],
    notes: [],
  };
  await writeFile(
    join(ctx.pacerHome, "install-manifest.json"),
    JSON.stringify({ version: 1, planners: { other: unrelated } }),
  );
  const manifest: PluginManifest = {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.5",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [folder + "/**"] },
      { name: "fs.write", scopes: [folder + "/**"] },
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
      env: { PATH: process.env.PATH },
    }),
  });
  try {
    const report = await withPlannerInstall(
      { ctx, pacerArgv: ["pacer"], folder },
      "synthetic",
      { pluginId: "sp06-install", roots: [folder], binaries: [], registry },
    );
    expect(await readFile(join(folder, "settings.json"), "utf8")).toBe(
      "installed",
    );
    const saved = JSON.parse(
      await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
    );
    expect(saved.version).toBe(1);
    expect(saved.planners.other).toEqual(unrelated);
    expect(saved.planners.synthetic).toEqual(report.record);
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(false);
    expect((await stat(report.record.files[0]!.backup!)).mode & 0o777).toBe(
      0o700,
    );
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});
test("same-byte replacement of an observed selected ancestor is refused before journal or destination effects", async () => {
  const { renameSync, mkdirSync, writeFileSync } = await import("node:fs");
  const ctx = fakeCtx(),
    root = join(ctx.home, "selected"),
    folder = join(root, "nested");
  await mkdir(folder, { recursive: true });
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(join(folder, "settings.json"), "before", { mode: 0o600 });
  const manifest: PluginManifest = {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.5",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [root + "/**"] },
      { name: "fs.write", scopes: [root + "/**"] },
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
  try {
    await expect(
      withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", {
        pluginId: "sp06-install",
        roots: [root],
        binaries: [],
        registry,
        beforeCommit: () => {
          renameSync(folder, folder + "-original");
          mkdirSync(folder, { mode: 0o700 });
          writeFileSync(join(folder, "settings.json"), "before", {
            mode: 0o600,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
    expect(await readFile(join(folder, "settings.json"), "utf8")).toBe(
      "before",
    );
    expect(
      await Bun.file(join(ctx.pacerHome, "install-manifest.json")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(false);
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("actual child consumes oversized immutable prior projection and returns a multibyte chunked candidate", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.home, "planner");
  await mkdir(folder);
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(join(folder, "settings.json"), "界".repeat(230000), {
    mode: 0o700,
  });
  const prior = {
    planner: "synthetic",
    folder,
    installedAt: 1,
    pacerArgv: ["pacer"],
    files: [],
    commands: [],
    notes: ["界".repeat(400000)],
  };
  await writeFile(
    join(ctx.pacerHome, "install-manifest.json"),
    JSON.stringify({ version: 1, planners: { synthetic: prior } }),
  );
  const manifest: PluginManifest = {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.5",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [folder + "/**"] },
      { name: "fs.write", scopes: [folder + "/**"] },
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
  try {
    const report = await withPlannerInstall(
      { ctx, pacerArgv: ["pacer"], folder },
      "synthetic",
      { pluginId: "sp06-install", roots: [folder], binaries: [], registry },
    );
    expect(report.record.installedAt).toBe(1);
    expect(await readFile(join(folder, "settings.json"), "utf8")).toBe(
      "installed",
    );
    expect(await readFile(report.record.files[0]!.backup!, "utf8")).toBe(
      "界".repeat(230000),
    );
    await withPlannerInstall({ctx,pacerArgv:["pacer"],folder},"synthetic",{pluginId:"sp06-install",operation:"uninstall",roots:[folder],binaries:[],registry});
    expect(await readFile(join(folder,"settings.json"),"utf8")).toBe("界".repeat(230000));
    expect(JSON.parse(await readFile(join(ctx.pacerHome,"install-manifest.json"),"utf8")).planners).toEqual({});
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});

for (const stage of ["apply", "manifest"])
  test(`native ${stage} failure awaits SDK file rollback and preserves 0700 before image`, async () => {
    const { spyOn } = await import("bun:test"),
      { writeNative, NativeWriteError } = await import(
        "../src/plugins/write-native"
      );
    const ctx = fakeCtx(),
      folder = join(ctx.home, "planner");
    await mkdir(folder);
    await mkdir(ctx.pacerHome);
    await writeFile(join(folder, "settings.json"), "before", { mode: 0o700 });
    const manifest: PluginManifest = {
      id: "sp06-install",
      version: "1.0.0",
      publisher: "pacer",
      host: "^1.5",
      contributes: { planner: {} },
      capabilities: [
        { name: "fs.read", scopes: [folder + "/**"] },
        { name: "fs.write", scopes: [folder + "/**"] },
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
    const native = writeNative(),
      rename = native.renameAt;
    let injected = false;
    const hook = spyOn(native, "renameAt").mockImplementation(
      (from, old, to, name) => {
        if (
          !injected &&
          name ===
            (stage === "apply" ? "settings.json" : "install-manifest.json")
        ) {
          injected = true;
          throw new NativeWriteError(5);
        }
        rename(from, old, to, name);
      },
    );
    try {
      await expect(
        withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", {
          pluginId: "sp06-install",
          roots: [folder],
          binaries: [],
          registry,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(injected).toBe(true);
      expect(await readFile(join(folder, "settings.json"), "utf8")).toBe(
        "before",
      );
      expect((await stat(join(folder, "settings.json"))).mode & 0o777).toBe(
        0o700,
      );
      expect(
        await Bun.file(
          join(ctx.pacerHome, "install-transaction.json"),
        ).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(ctx.pacerHome, "install-manifest.json")).exists(),
      ).toBe(false);
    } finally {
      hook.mockRestore();
      await registry.shutdown();
      await rm(ctx.home, { recursive: true, force: true });
    }
  });
