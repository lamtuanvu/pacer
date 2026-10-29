import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { installPlanner } from "../src/install";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
for (const agent of ["claude-code", "codex", "cursor", "opencode"] as const)
  test(`${agent} real install caller selects and invokes planner plugin`, async () => {
    const ctx = fakeCtx({ which: () => null });
    await mkdir(ctx.pacerHome, { recursive: true });
    try {
      const result = await installPlanner(
        { ctx, pacerArgv: ["pacer"], mcp: false },
        agent,
      );
      expect(result.record.planner).toBe(agent);
      expect(result.record.files.length).toBeGreaterThan(0);
      const info = pluginRegistry(ctx)
        .list(ctx)
        .find((value) => value.id === "pacer-planners");
      expect(info?.state).toBe("ready");
      expect(info?.pid).toBeGreaterThan(0);
    } finally {
      await shutdownPlugins(ctx);
      await rm(ctx.home, { recursive: true, force: true });
    }
  });

test("Claude uninstall command uses a distinct actual parent-brokered plugin call", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { uninstallPlanner } = await import("../src/install/uninstall");
  const ctx = fakeCtx(),
    binary = join(ctx.home, "claude"),
    effect = join(ctx.home, "command-effect");
  await mkdir(ctx.pacerHome, { recursive: true });
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(effect)},process.argv[3]);`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "claude" ? binary : null);
  ctx.run = async () => {
    throw Error("legacy command path must not run");
  };
  try {
    await installPlanner(
      { ctx, pacerArgv: ["pacer"], mcp: true },
      "claude-code",
    );
    expect(await readFile(effect, "utf8")).toBe("add");
    const report = await uninstallPlanner(ctx, "claude-code");
    expect(await readFile(effect, "utf8")).toBe("remove");
    expect(report?.notes.join("\n")).not.toContain("legacy command path");
  } finally {
    await shutdownPlugins(ctx);
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("disabled planner has no install fallback while generic host file uninstall remains available", async () => {
  const { writeFile } = await import("node:fs/promises"),
    { uninstallPlanner } = await import("../src/install/uninstall");
  const ctx = fakeCtx({ which: () => null });
  await mkdir(ctx.pacerHome, { recursive: true });
  try {
    await installPlanner({ ctx, pacerArgv: ["pacer"] }, "codex");
    await writeFile(
      join(ctx.pacerHome, "strategy.yaml"),
      "planner: codex\nproviders:\n  codex: {}\nplugins:\n  disabled: [pacer-planners]\n",
    );
    pluginRegistry(ctx).refresh(ctx);
    const report = await uninstallPlanner(ctx, "codex");
    expect(report?.removed.length).toBeGreaterThan(0);
    expect(await Bun.file(join(ctx.home, ".codex/AGENTS.md")).exists()).toBe(
      false,
    );
    await expect(
      installPlanner({ ctx, pacerArgv: ["pacer"] }, "codex"),
    ).rejects.toThrow("plugin unavailable");
  } finally {
    await shutdownPlugins(ctx);
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("actual readonly planner.check reports file integrity without changing files or manifest", async () => {
  const { plannerCheck } = await import("../src/plugins/planner-check"),
    { readFile, writeFile } = await import("node:fs/promises");
  const ctx = fakeCtx({ which: () => null });
  await mkdir(ctx.pacerHome, { recursive: true });
  try {
    const report = await installPlanner({ ctx, pacerArgv: ["pacer"] }, "codex"),
      manifest = join(ctx.pacerHome, "install-manifest.json");
    const before = await readFile(manifest, "utf8"),
      first = await plannerCheck(ctx, "codex", report.record);
    expect(first.intact).toBe(true);
    expect(first.files.length).toBe(report.record.files.length);
    const hooks = join(ctx.home, ".codex/hooks.json");
    await writeFile(hooks, "user changed hooks");
    expect((await plannerCheck(ctx, "codex", report.record)).intact).toBe(
      false,
    );
    expect(await readFile(hooks, "utf8")).toBe("user changed hooks");
    expect(await readFile(manifest, "utf8")).toBe(before);
  } finally {
    await shutdownPlugins(ctx);
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("real planner plugin writes the current Claude guard hook and pipefail skill text (F7 golden)", async () => {
  const { readFile } = await import("node:fs/promises");
  const ctx = fakeCtx({ which: () => null });
  await mkdir(ctx.pacerHome, { recursive: true });
  try {
    const result = await installPlanner({ ctx, pacerArgv: ["pacer"], mcp: false }, "claude-code");
    const settings = JSON.parse(await readFile(join(ctx.home, ".claude", "settings.json"), "utf8"));
    const guard = settings.hooks.PreToolUse.find((entry: { matcher?: string }) => entry.matcher === "Agent|Task|Bash");
    expect(guard?.hooks).toEqual([expect.objectContaining({ type: "command", timeout: 15 })]);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const skill = result.record.files.map(file => typeof file === "string" ? file : (file as { path: string }).path).find(path => path.endsWith("SKILL.md"));
    expect(skill).toBeDefined();
    const text = await readFile(skill!, "utf8");
    expect(text).toContain("acceptance_pipefail");
    expect(text).toContain("set -o pipefail;");
  } finally {
    await shutdownPlugins(ctx);
    await rm(ctx.home, { recursive: true, force: true });
  }
});
