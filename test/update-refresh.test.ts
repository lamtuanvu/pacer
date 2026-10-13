import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshIntegrations } from "../src/commands/update-refresh";
import { writeManifest } from "../src/install/manifest";
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
    "claude-code: refreshed", "WARNING: codex: failed: bad config", "WARNING: cursor: failed: timed out", "opencode: unchanged",
  ]);
  expect(calls).toEqual(["claude-code", "codex", "cursor", "opencode"].map(planner => [path, "install", planner]));
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
