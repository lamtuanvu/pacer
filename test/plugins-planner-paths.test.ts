import { expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PlannerResources } from "../src/plugins/planner-resources";
import { PluginRegistry } from "../src/plugins/registry";
import { plannerSelectedSources } from "../src/plugins/planner-selection";
import { plannerPrivatePath } from "../src/plugins/planner-private-paths";
test("planner roots cannot include HOME or alternate-case credential trees",()=>{
  const ctx=fakeCtx();
  expect(plannerPrivatePath(ctx,ctx.home)).toBe(true);
  expect(plannerPrivatePath(ctx,join(ctx.home,".Config/GH/hosts.yml"))).toBe(process.platform==="darwin");
});
import type { PluginManifest } from "../src/plugins/protocol";
test("actual peer reads exact selected account under PACER_HOME but cannot read siblings or private/native credential stores", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.pacerHome, "accounts/team");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "settings.json"), "selected");
  const manifest: PluginManifest = {
    id: "sp06-read",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: ["${HOME}/**", "${PACER_HOME}/**"] },
    ],
    tier: "free",
    reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/read.ts"),
      ],
      cwd: ctx.home,
      env: {},
    }),
  });
  const read = async (path: string) => {
    const lease = new PlannerResources(ctx, {
      purpose: "install",
      binaries: [],
      cwd: ctx.home,
      roots: [folder],
    });
    try {
      return await registry.call<any>(
        ctx,
        "sp06-read",
        "planner.install",
        { path },
        { plannerResources: lease },
      );
    } finally {
      await lease.dispose();
    }
  };
  try {
    expect(await read(join(folder, "settings.json"))).toMatchObject({
      text: "selected",
    });
    for (const path of [
      join(ctx.pacerHome, "accounts/sibling/settings.json"),
      join(ctx.pacerHome, "token"),
      join(ctx.pacerHome, "install-manifest.json"),
      join(ctx.pacerHome, "plugins/entry"),
      join(folder, "auth.json"),
      join(folder, "cli-config.json"),
      join(ctx.home, ".ssh/id_ed25519"),
    ])
      await expect(read(path)).rejects.toMatchObject({
        code: "capability_denied",
      });
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});
test("configured status-line paths cannot select Cursor native credentials, SSH keys or host state", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.home, ".claude");
  await mkdir(folder, { recursive: true });
  try {
    for (const target of [
      join(ctx.home, ".cursor/cli-config.json"),
      join(ctx.home, ".ssh/id_ed25519"),
      join(ctx.home, "Library/Keychains/login.keychain-db"),
      join(ctx.pacerHome, "token"),
    ]) {
      await writeFile(
        join(folder, "settings.json"),
        JSON.stringify({ statusLine: { command: target } }),
      );
      expect(plannerSelectedSources(ctx, "claude-code", folder)).toEqual([]);
      const lease = new PlannerResources(ctx, {
        purpose: "install",
        binaries: [],
        cwd: ctx.home,
        roots: [folder],
        files: [target],
      });
      try {
        expect(lease.permits(target)).toBe(false);
      } finally {
        await lease.dispose();
      }
    }
    const script = join(ctx.home, "my-statusline.sh");
    await writeFile(script, "#!/bin/sh\ninput=$(cat)\n", { mode: 0o700 });
    await writeFile(
      join(folder, "settings.json"),
      JSON.stringify({ statusLine: { command: script } }),
    );
    expect(plannerSelectedSources(ctx, "claude-code", folder)).toEqual([
      script,
    ]);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("selected enclosing PACER_HOME cannot expose its secrets tree through direct or actual-child capabilities", async () => {
  const ctx = fakeCtx();
  const secret = join(ctx.pacerHome, "secrets/example.key");
  await mkdir(join(ctx.pacerHome, "secrets/nested"), { recursive: true });
  await writeFile(secret, "synthetic-key-only");
  const manifest: PluginManifest = {
    id: "sp06-read",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    tier: "free",
    reentrant: false,
    capabilities: [
      { name: "fs.read", scopes: ["${HOME}/**", "${PACER_HOME}/**"] },
      { name: "fs.write", scopes: ["${HOME}/**", "${PACER_HOME}/**"] },
    ],
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/read.ts"),
      ],
      cwd: ctx.home,
      env: {},
    }),
  });
  try {
    for (const path of [
      join(ctx.pacerHome, "secrets"),
      secret,
      join(ctx.pacerHome, "secrets/nested/new"),
    ]) {
      expect(plannerPrivatePath(ctx, path)).toBe(true);
      const lease = new PlannerResources(ctx, {
        purpose: "install",
        binaries: [],
        cwd: ctx.home,
        roots: [ctx.pacerHome],
        files: [path],
      });
      try {
        expect(lease.permits(path)).toBe(false);
      } finally {
        await lease.dispose();
      }
    }
    for (const [method, input] of [
      ["capability.fs.read", { path: secret }],
      [
        "capability.fs.list",
        { dir: join(ctx.pacerHome, "secrets"), glob: "**/*" },
      ],
      [
        "capability.fs.readRange",
        {
          path: secret,
          offset: 0,
          length: 4,
          expected: { size: 18, mtimeMs: 0, inode: 0, device: 0, mode: 384 },
        },
      ],
      [
        "capability.fs.write",
        { path: secret, text: "must-not-write", mode: 384 },
      ],
    ] as const) {
      const lease = new PlannerResources(ctx, {
        purpose: "install",
        binaries: [],
        cwd: ctx.home,
        roots: [ctx.pacerHome],
        files: [secret],
      });
      try {
        await expect(
          registry.call(
            ctx,
            "sp06-read",
            "planner.install",
            { method, input },
            { plannerResources: lease },
          ),
        ).rejects.toMatchObject({ code: "capability_denied" });
      } finally {
        await lease.dispose();
      }
    }
    expect(await Bun.file(secret).text()).toBe("synthetic-key-only");
  } finally {
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  }
});
