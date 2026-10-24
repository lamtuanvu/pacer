import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshIntegrations } from "../src/commands/update-refresh";
import { writeManifest } from "../src/install/manifest";
import { pluginDir } from "../src/plugin/install";
import { fakeCtx, installLegacyPlugin } from "./helpers";

test("refresh runs replacement reconciliation once for default and named records and reports each outcome", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async argv => {
    calls.push(argv);
    expect(readFileSync(argv[0], "utf8")).toBe("new binary");
    return { code: 1, stdout: JSON.stringify([{ target: "codex#work", state: "refreshed" }, { target: "claude-code", state: "conflict", detail: "customized skill", hint: "reconnect" }]), stderr: "" };
  } });
  const path = join(ctx.home, "new-pacer"); writeFileSync(path, "new binary");
  writeManifest(ctx, { version: 1, planners: Object.fromEntries(["codex#work", "claude-code", "service"].map(planner => [planner, { planner, installedAt: 0, pacerArgv: ["old"], files: [], commands: [], notes: [] }])) });
  expect(await refreshIntegrations(ctx, path)).toEqual(["codex#work: refreshed", "WARNING: claude-code: conflict: customized skill. reconnect"]);
  expect(calls).toEqual([[path, "integrations", "refresh", "--json"]]);
});

test("refresh with no recorded integrations does nothing", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("must not run"); } });
  expect(await refreshIntegrations(ctx, "/new/pacer")).toEqual([]);
});

test("refresh preserves optional MCP choices without executing agent CLIs", async () => {
  const { installPlanner } = await import("../src/install");
  const { PACER } = await import("./install-helpers");
  const { findCommand } = await import("../src/commands");
  for (const mcp of [true, false]) {
    const ctx = fakeCtx({ which: () => null, env: { PACER_BIN: PACER[0] } });
    for (const planner of ["codex", "cursor", "opencode"] as const) await installPlanner({ ctx, pacerArgv: PACER, mcp }, planner);
    const config = join(ctx.home, ".codex/config.toml");
    const before = existsSync(config) ? readFileSync(config, "utf8") : null;
    ctx.run = async argv => {
      expect(argv).toEqual([...PACER, "integrations", "refresh", "--json"]);
      const result = await findCommand("integrations")!.run(argv.slice(2), ctx);
      return { code: result.code, stdout: result.out, stderr: result.err };
    };
    expect(await refreshIntegrations(ctx, PACER[0])).toEqual(["codex: refreshed", "cursor: refreshed", "opencode: refreshed"]);
    expect(existsSync(config) ? readFileSync(config, "utf8") : null).toBe(before);
  }
});

test("replacement failure is reported without falling back to unsafe reinstall", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("timed out"); } });
  writeManifest(ctx, { version: 1, planners: { codex: { planner: "codex", installedAt: 0, pacerArgv: [], files: [], commands: [], notes: [] } } });
  expect((await refreshIntegrations(ctx, "/new/pacer"))[0]).toContain("WARNING");
});

test("refresh leaves retired plugin installs untouched and never creates an unrecorded plugin", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("must not run"); } });
  expect(existsSync(pluginDir(ctx))).toBe(false);
  const root = await installLegacyPlugin(ctx), before = readFileSync(join(root, "worker.mjs"), "utf8");
  expect(await refreshIntegrations(ctx, "/new/pacer")).toEqual([]);
  expect(readFileSync(join(root, "worker.mjs"), "utf8")).toBe(before);
});
