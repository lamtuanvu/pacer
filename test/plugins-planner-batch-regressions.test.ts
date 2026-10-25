import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { installLegacyPlugin } from "./helpers";
import { installPlanner } from "../src/install";
import { agentPreview } from "../src/core/setup";
import { uninstallPlugin } from "../src/plugin/install";
import { readManifest, writeManifest } from "../src/install/manifest";
import { checkSetup } from "../src/setup/check";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import { reconcileIntegrations } from "../src/install/reconcile";

test("named and explicit default Codex folders override foreign CODEX_HOME in install and named consent", async () => {
  const ctx = fakeCtx({ which: () => null }),
    work = join(ctx.home, "accounts/work"),
    global = join(ctx.home, "foreign");
  ctx.env.CODEX_HOME = global;
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(
    join(ctx.pacerHome, "strategy.yaml"),
    JSON.stringify({
      planner: "codex#work",
      accounts: {
        personal: { kind: "codex" },
        work: { kind: "codex", home: work },
      },
      routing: [{ default: ["codex#work"] }],
    }),
  );
  const preview = await agentPreview(ctx, "codex");
  expect(preview.files).toContain(join(work, "skills/pacer/SKILL.md"));
  expect(preview.files).not.toContain(join(global, "skills/pacer/SKILL.md"));
  const named = await installPlanner(
    { ctx, pacerArgv: ["pacer"], mcp: false },
    { agent: "codex", account: "work" },
  );
  expect(named.record.files.map((x) => x.path)).toContain(
    join(work, "skills/pacer/SKILL.md"),
  );
  await installPlanner(
    { ctx, pacerArgv: ["pacer"], mcp: false },
    { agent: "codex", account: "personal" },
  );
  expect(
    await Bun.file(join(ctx.home, ".codex/skills/pacer/SKILL.md")).exists(),
  ).toBe(true);
  expect(await Bun.file(join(global, "skills/pacer/SKILL.md")).exists()).toBe(
    false,
  );
});

test("host-only reserved legacy plugin undo works without a plugin peer and rejects forged private destinations", async () => {
  const ctx = fakeCtx({ which: () => null });
  const root = await installLegacyPlugin(ctx);
  const result = await uninstallPlugin(ctx, "linux");
  expect(result?.removed).toContain(join(root, "worker.mjs"));
  expect(readManifest(ctx).planners["orca-plugin"]).toBeUndefined();
  await installLegacyPlugin(ctx);
  const manifest = readManifest(ctx),
    token = join(ctx.pacerHome, "secrets/example.key");
  await mkdir(join(ctx.pacerHome, "secrets"), { recursive: true });
  await writeFile(token, "synthetic");
  manifest.planners["orca-plugin"].files[0].path = token;
  writeManifest(ctx, manifest);
  await expect(uninstallPlugin(ctx, "linux")).rejects.toMatchObject({
    code: "capability_denied",
  });
  expect(await readFile(token, "utf8")).toBe("synthetic");
  expect(
    pluginRegistry(ctx)
      .list(ctx)
      .find((x) => x.id === "pacer-planners")?.state,
  ).not.toBe("ready");
});

test("cheap readonly setup uses generic integrity with disabled planner and never dispatches a child", async () => {
  const ctx = fakeCtx({ which: () => null });
  await installPlanner({ ctx, pacerArgv: ["pacer"], mcp: false }, "codex");
  await writeFile(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: codex\nproviders: {codex: {}}\nplugins: {disabled: [pacer-planners]}\n",
  );
  await shutdownPlugins(ctx);
  const registry = pluginRegistry(ctx),
    original = registry.call.bind(registry);
  let calls = 0;
  registry.call = (async () => {
    calls++;
    throw Error("cheap check must not dispatch a plugin");
  }) as any;
  try {
    const before = await readFile(
      join(ctx.pacerHome, "install-manifest.json"),
      "utf8",
    );
    expect(
      (
        await checkSetup(
          { ...ctx, readOnly: true },
          { snapshotProbe: false, deferStatus: true },
        )
      ).items.find((x) => x.id === "connect")?.status,
    ).toBe("done");
    expect(calls).toBe(0);
    await writeFile(join(ctx.home, ".codex/AGENTS.md"), "user customization");
    expect(
      (
        await checkSetup(
          { ...ctx, readOnly: true },
          { snapshotProbe: false, deferStatus: true },
        )
      ).items.find((x) => x.id === "connect")?.status,
    ).toBe("pending");
    expect(calls).toBe(0);
    expect(
      await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
    ).toBe(before);
  } finally {
    registry.call = original;
  }
});

test("missing-plugin command undo retains record and home on per-agent and generic all cleanup", async () => {
  const { uninstallPlanner } = await import("../src/install/uninstall"),
    { uninstallAll } = await import("../src/install/uninstall-all");
  const ctx = fakeCtx({ which: () => null });
  await mkdir(ctx.pacerHome, { recursive: true });
  writeManifest(ctx, {
    version: 1,
    planners: {
      "claude-code": {
        planner: "claude-code",
        installedAt: ctx.now,
        pacerArgv: ["pacer"],
        files: [],
        commands: [{ undo: ["claude", "undo"] }],
        notes: [],
      },
    },
  });
  await writeFile(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {codex: {}}\nplugins: {disabled: [pacer-planners]}\n",
  );
  const before = await readFile(
    join(ctx.pacerHome, "install-manifest.json"),
    "utf8",
  );
  await expect(uninstallPlanner(ctx, "claude-code")).rejects.toThrow(
    "recorded command undo is pending",
  );
  let removed = false;
  const result = await uninstallAll(["--all", "--yes", "--json"], ctx, {
    removeHome: () => {
      removed = true;
    },
  });
  expect(result.code).toBe(1);
  expect(removed).toBe(false);
  expect(
    await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
  ).toBe(before);
  expect(
    pluginRegistry(ctx)
      .list(ctx)
      .find((x) => x.id === "pacer-planners")?.state,
  ).not.toBe("ready");
});

test("generic all recorded file and command cleanup pins host binary and starts no planner child", async () => {
  const { uninstallAll } = await import("../src/install/uninstall-all"),
    { sha256 } = await import("../src/install/fsx");
  const ctx = fakeCtx({ which: () => null }),
    binary = join(ctx.home, "claude"),
    effect = join(ctx.home, "undo-effect"),
    file = join(ctx.home, ".claude/rules/pacer.md");
  await mkdir(join(ctx.home, ".claude/rules"), { recursive: true });
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(file, "owned");
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(effect)},process.argv[2]+':'+process.env.HOME);`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "claude" ? binary : null);
  writeManifest(ctx, {
    version: 1,
    planners: {
      "claude-code": {
        planner: "claude-code",
        installedAt: ctx.now,
        pacerArgv: ["pacer"],
        files: [
          {
            path: file,
            action: "created",
            undo: [],
            afterHash: sha256("owned"),
          },
        ],
        commands: [{ undo: ["claude", "undo"] }],
        notes: [],
      },
    },
  });
  const registry = pluginRegistry(ctx),
    original = registry.call;
  let calls = 0;
  registry.call = (async () => {
    calls++;
    throw Error("generic cleanup must never call a planner");
  }) as any;
  try {
    const result = await uninstallAll(["--all", "--yes", "--json"], ctx);
    expect(result.code).toBe(0);
    expect(calls).toBe(0);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await readFile(effect, "utf8")).toBe("undo:" + ctx.home);
    expect(
      await Bun.file(join(ctx.pacerHome, "install-manifest.json")).exists(),
    ).toBe(false);
  } finally {
    registry.call = original;
  }
});

test("detailed Doctor invokes the actual ordinary planner.check handler", async () => {
  const { runDoctor } = await import("../src/install/doctor");
  const ctx = fakeCtx({ which: () => null, env: { PACER_PORT: "0" } });
  ctx.env.CODEX_HOME = join(ctx.home, "legacy-split-codex");
  await installPlanner({ ctx, pacerArgv: ["pacer"], mcp: false }, "codex");
  await writeFile(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: codex\nproviders: {codex: {}}\n",
  );
  const registry = pluginRegistry(ctx),
    original = registry.call.bind(registry),
    methods: string[] = [];
  registry.call = (async (...args: any[]) => {
    methods.push(args[2]);
    return await (original as any)(...args);
  }) as any;
  try {
    const checks = await runDoctor(ctx, {
      status: async () => {
        throw Error("synthetic status unavailable");
      },
      service: async () =>
        ({
          installed: false,
          running: false,
          healthy: false,
          binaryMatches: false,
        }) as any,
    });
    expect(methods).toContain("planner.check");
    expect(checks.find((x) => x.name === "Planner check codex")).toMatchObject({
      level: "ok",
      evidence: "configured",
    });
  } finally {
    registry.call = original;
  }
});

test("generic all file-only cleanup succeeds disabled while failed or forged recorded commands preserve retry state", async () => {
  const { uninstallAll } = await import("../src/install/uninstall-all"),
    { sha256 } = await import("../src/install/fsx");
  for (const variant of ["files", "nonzero", "forged"] as const) {
    const ctx = fakeCtx({ which: () => null }),
      binary = join(ctx.home, "claude"),
      file = join(ctx.home, ".claude/rules/pacer.md");
    await mkdir(join(ctx.home, ".claude/rules"), { recursive: true });
    await mkdir(ctx.pacerHome, { recursive: true });
    await writeFile(file, "owned");
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(7);`, {
      mode: 0o700,
    });
    ctx.which = (name) => (name === "claude" ? binary : null);
    writeManifest(ctx, {
      version: 1,
      planners: {
        "claude-code": {
          planner: "claude-code",
          installedAt: ctx.now,
          pacerArgv: ["pacer"],
          files: [
            {
              path: file,
              action: "created",
              undo: [],
              afterHash: sha256("owned"),
            },
          ],
          commands:
            variant === "files"
              ? []
              : [
                  {
                    undo: [variant === "forged" ? "/bin/sh" : "claude", "undo"],
                  },
                ],
          notes: [],
        },
      },
    });
    await writeFile(
      join(ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {codex: {}}\nplugins: {disabled: [pacer-planners]}\n",
    );
    const before = await readFile(
      join(ctx.pacerHome, "install-manifest.json"),
      "utf8",
    );
    const result = await uninstallAll(["--all", "--yes", "--json"], ctx);
    expect(result.code).toBe(variant === "files" ? 0 : 1);
    if (variant !== "files") {
      expect(await readFile(file, "utf8")).toBe("owned");
      expect(
        await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
      ).toBe(before);
    }
    expect(
      pluginRegistry(ctx)
        .list(ctx)
        .find((x) => x.id === "pacer-planners")?.state,
    ).not.toBe("ready");
  }
});

test("fixed legacy private journal recovery restores native bytes and 0700 without exposing secrets paths", async () => {
  const { recoverPlannerInstall } = await import(
      "../src/plugins/planner-recovery"
    ),
    { withInstallLock } = await import("../src/install/lock"),
    { stat } = await import("node:fs/promises");
  const ctx = fakeCtx({ which: () => null }),
    root = await installLegacyPlugin(ctx),
    path = join(root, "worker.mjs"),
    journal = join(ctx.pacerHome, "install-transaction.json");
  await writeFile(path, "after", { mode: 0o700 });
  await writeFile(
    journal,
    JSON.stringify({
      schema: 1,
      manifestHash: "0".repeat(64),
      files: [{ path, before: "before", after: "after", beforeMode: 0o700 }],
    }),
  );
  await withInstallLock(ctx, () => recoverPlannerInstall(ctx));
  expect(await readFile(path, "utf8")).toBe("before");
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect(await Bun.file(journal).exists()).toBe(false);
  const secret = join(ctx.pacerHome, "secrets/example.key");
  await mkdir(join(ctx.pacerHome, "secrets"));
  await writeFile(secret, "after");
  await writeFile(
    journal,
    JSON.stringify({
      schema: 1,
      manifestHash: "0".repeat(64),
      files: [
        { path: secret, before: "before", after: "after", beforeMode: 0o600 },
      ],
    }),
  );
  await expect(
    withInstallLock(ctx, () => recoverPlannerInstall(ctx)),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(await readFile(secret, "utf8")).toBe("after");
});

test("actual per-agent uninstall preserves recorded undos when the agent removal fails", async () => {
  const { uninstallPlanner } = await import("../src/install/uninstall");
  const ctx = fakeCtx({ which: () => null }),
    binary = join(ctx.home, "claude");
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.exit(process.argv[3]==='get'?0:7);`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "claude" ? binary : null);
  writeManifest(ctx, {
    version: 1,
    planners: {
      "claude-code": {
        planner: "claude-code",
        installedAt: ctx.now,
        pacerArgv: ["pacer"],
        files: [],
        commands: [
          { undo: ["claude", "mcp", "remove", "-s", "user", "pacer"] },
        ],
        notes: [],
      },
    },
  });
  const before = await readFile(
    join(ctx.pacerHome, "install-manifest.json"),
    "utf8",
  );
  await expect(uninstallPlanner(ctx, "claude-code")).rejects.toThrow(
    "recorded command undo failed",
  );
  expect(
    await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
  ).toBe(before);
});
