import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshIntegrations } from "../src/commands/update-refresh";
import { writeManifest } from "../src/install/manifest";
import { PLUGIN_RECORD } from "../src/link/paths";
import { installPlugin, pluginDir } from "../src/plugin/install";
import { fakeCtx } from "./helpers";

test("refresh runs the new binary for recorded planners without MCP flags and continues after failures", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async argv => {
    calls.push(argv);
    expect(readFileSync(argv[0]!, "utf8")).toBe("new binary");
    if (argv[2] === "codex") return { code: 1, stdout: "", stderr: "bad config\nmore" };
    if (argv[2] === "cursor") throw Error("timed out");
    return { code: 0, stdout: argv[2] === "opencode" ? "already installed, nothing changed\nUndo with: pacer uninstall opencode" : "edited skill", stderr: "" };
  } });
  const path = join(ctx.home, "new-pacer"); writeFileSync(path, "new binary");
  writeManifest(ctx, { version: 1, planners: Object.fromEntries(["claude-code", "codex", "cursor", "opencode", "orca-plugin", "service"].map(planner => [planner, { planner, installedAt: 0, pacerArgv: ["old"], files: [], commands: [], notes: [] }])) });
  expect(await refreshIntegrations(ctx, path)).toEqual([
    "claude-code: refreshed", "WARNING: codex: failed: bad config", "WARNING: cursor: failed: timed out", "opencode: unchanged", "orca-plugin: refreshed (turn pacer off and on in Orca Settings > Plugins to load it)",
  ]);
  expect(calls).toEqual([...["claude-code", "codex", "cursor", "opencode"].map(planner => [path, "install", planner]), [path, "plugin", "install"]]);
});

test("refresh with no installed planners does nothing", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("must not run"); } });
  expect(await refreshIntegrations(ctx, "/new/pacer")).toEqual([]);
});

test("refresh preserves enabled and disabled MCP choices for every planner", async () => {
  const { installPlanner } = await import("../src/install");
  const { snapshot, PACER } = await import("./install-helpers");
  for (const mcp of [true, false]) {
    let claudeRegistered = false;
    const calls: string[][] = [];
    const ctx = fakeCtx({ which: () => "claude", run: async argv => {
      calls.push(argv);
      if (argv[0] === "claude") {
        const code = argv[2] === "get" && !claudeRegistered ? 1 : 0;
        if (argv[2] === "add") claudeRegistered = true;
        if (argv[2] === "remove") claudeRegistered = false;
        return { code, stdout: "", stderr: "" };
      }
      // Emulate the new binary's install dispatch without passing an MCP flag.
      const { renderInstall } = await import("../src/install");
      const report = await installPlanner({ ctx, pacerArgv: [argv[0]!] }, argv[2] as "codex");
      return { code: 0, stdout: renderInstall(report), stderr: "" };
    } });
    for (const planner of ["claude-code", "codex", "cursor", "opencode"] as const) await installPlanner({ ctx, pacerArgv: PACER, mcp }, planner);
    const before = snapshot(ctx.home);
    // An old embedded skill should be overwritten by the refreshed binary.
    writeFileSync(join(ctx.home, ".claude/skills/pacer/SKILL.md"), "old skill");
    calls.length = 0;
    await refreshIntegrations(ctx, PACER[0]!);
    expect(snapshot(ctx.home)).toEqual(before);
    expect(claudeRegistered).toBe(mcp);
    expect(calls).toEqual(["claude-code", "codex", "cursor", "opencode"].map(planner => [...PACER, "install", planner]));
  }
});


test("refresh repairs the managed plugin with the replacement installer and reports unchanged on repeat", async () => {
  const path = "/replacement/pacer";
  const ctx = fakeCtx({ run: async (argv, timeout) => {
    expect(argv).toEqual([path, "plugin", "install"]);
    expect(timeout).toBe(30000);
    return { code: 0, stdout: (await installPlugin({ ctx, pacerArgv: [path] })).text, stderr: "" };
  } });
  await installPlugin({ ctx, pacerArgv: ["old-pacer"] });
  const manifestPath = join(pluginDir(ctx), "orca-plugin.json");
  const original = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, "old plugin");
  expect(await refreshIntegrations(ctx, path)).toEqual(["orca-plugin: refreshed (turn pacer off and on in Orca Settings > Plugins to load it)"]);
  expect(readFileSync(manifestPath, "utf8")).toBe(original);
  expect(await refreshIntegrations(ctx, path)).toEqual(["orca-plugin: unchanged"]);
});

test("refresh never installs an unrecorded plugin", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async argv => { calls.push(argv); return { code: 0, stdout: "edited skill", stderr: "" }; } });
  writeManifest(ctx, { version: 1, planners: { codex: { planner: "codex", installedAt: 0, pacerArgv: ["old"], files: [], commands: [], notes: [] } } });
  expect(await refreshIntegrations(ctx, "/new/pacer")).toEqual(["codex: refreshed"]);
  expect(calls).toEqual([["/new/pacer", "install", "codex"]]);
  expect(existsSync(pluginDir(ctx))).toBe(false);
});

test("plugin refresh failures warn with only the first line", async () => {
  for (const fixture of [
    { result: { code: 1, stdout: "", stderr: "bad plugin\nmore" }, want: "bad plugin" },
    { result: { code: 2, stdout: "bad output\r\nmore", stderr: "" }, want: "bad output" },
    { result: { code: 3, stdout: "", stderr: "" }, want: "exit 3" },
    { error: Error("timed out\nmore"), want: "timed out" },
    { error: "failed\r\nmore", want: "failed" },
  ]) {
    const ctx = fakeCtx({ run: async argv => {
      expect(argv).toEqual(["/new/pacer", "plugin", "install"]);
      if ("error" in fixture) throw fixture.error;
      return fixture.result!;
    } });
    writeManifest(ctx, { version: 1, planners: { [PLUGIN_RECORD]: { planner: PLUGIN_RECORD, installedAt: 0, pacerArgv: ["old"], files: [], commands: [], notes: [] } } });
    expect(await refreshIntegrations(ctx, "/new/pacer")).toEqual([`WARNING: orca-plugin: failed: ${fixture.want}`]);
  }
});
