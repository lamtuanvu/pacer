import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { PACER } from "./install-helpers";
import { installPlanner } from "../src/install";
import { readManifest, writeManifest } from "../src/install/manifest";
import { parseJsonc } from "../src/install/jsonc";
import { integrationFreshness, reconcileIntegrations } from "../src/install/reconcile";
import { runDoctor } from "../src/install/doctor";
import { sha256 } from "../src/install/fsx";

const userConfig = '{\n\t// Keep this comment\n\t"mcp": {"context7": {"type": "remote", "url": "https://example.com/mcp"},},\n\t"theme": "dark",\n}\n';

const service = async () => ({
  installed: true, loaded: true, running: true, pid: null, lastExitCode: null,
  healthy: true, plistPath: "", binaryPath: null, binaryMatches: true,
});

/** Install with MCP on, then demote the record to legacy (no MCP choice) like an older pacer left behind. */
async function connectedOpencode() {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
  const dir = join(ctx.home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.json"), userConfig);
  await installPlanner({ ctx, pacerArgv: PACER, mcp: true }, "opencode");
  const manifest = readManifest(ctx);
  delete manifest.planners.opencode.mcp;
  writeManifest(ctx, manifest);
  return { ctx, configPath: join(dir, "opencode.json") };
}

test("reinstall without MCP retires a stale opencode.json record and doctor stops warning", async () => {
  const { ctx, configPath } = await connectedOpencode();
  // Something else removed the mcp.pacer member; user content is intact.
  writeFileSync(configPath, userConfig);
  await installPlanner({ ctx, pacerArgv: PACER }, "opencode");
  expect(readManifest(ctx).planners.opencode.files.some(file => file.path === configPath)).toBe(false);
  expect(readFileSync(configPath, "utf8")).toBe(userConfig);
  expect((await integrationFreshness(ctx, "opencode")).state).not.toBe("conflict");
  await reconcileIntegrations(ctx);
  expect((await integrationFreshness(ctx, "opencode")).state).toBe("current");
  const checks = await runDoctor(ctx, { service });
  expect(checks.find(check => check.name === "Integration freshness opencode")?.level).toBe("ok");
  expect(checks.find(check => check.name === "Planner check opencode")?.level).toBe("ok");
  expect(checks.find(check => check.name === "Install opencode")?.level).toBe("ok");
});

test("reinstall without MCP removes only the pacer member and retires the record entry", async () => {
  const { ctx, configPath } = await connectedOpencode();
  // The mcp.pacer member is still present on disk.
  await installPlanner({ ctx, pacerArgv: PACER }, "opencode");
  const doc = parseJsonc(readFileSync(configPath, "utf8")) as any;
  expect(doc.mcp.pacer).toBeUndefined();
  expect(doc.mcp.context7).toEqual({ type: "remote", url: "https://example.com/mcp" });
  expect(doc.theme).toBe("dark");
  const record = readManifest(ctx).planners.opencode;
  expect(record.files.some(file => file.path === configPath)).toBe(false);
  expect(record.files.some(file => file.path.endsWith("AGENTS.md"))).toBe(true);
  expect(record.files.some(file => file.path.endsWith(join("skills", "pacer", "SKILL.md")))).toBe(true);
});

test("reinstall with MCP on keeps the opencode.json entry refreshed", async () => {
  const { ctx, configPath } = await connectedOpencode();
  await installPlanner({ ctx, pacerArgv: PACER, mcp: true }, "opencode");
  const record = readManifest(ctx).planners.opencode;
  const entry = record.files.find(file => file.path === configPath);
  expect(entry?.afterHash).toBe(sha256(readFileSync(configPath, "utf8")));
  expect((parseJsonc(readFileSync(configPath, "utf8")) as any).mcp.pacer).toBeDefined();
});

test("reinstall without MCP retires stale codex and cursor MCP records too", async () => {
  for (const [agent, configPath] of [
    ["codex", (home: string) => join(home, ".codex", "config.toml")],
    ["cursor", (home: string) => join(home, ".cursor", "mcp.json")],
  ] as const) {
    const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
    await installPlanner({ ctx, pacerArgv: PACER, mcp: true }, agent);
    const path = configPath(ctx.home);
    const manifest = readManifest(ctx);
    delete manifest.planners[agent].mcp;
    writeManifest(ctx, manifest);
    // Something else removed the member/table; unrelated user content stays.
    const withoutPacer = agent === "codex"
      ? 'model = "keep"\n[mcp_servers.other]\ncommand = "other"\n'
      : '{"mcpServers":{"other":{"command":"other","args":["mcp"]}}}';
    writeFileSync(path, withoutPacer);
    await installPlanner({ ctx, pacerArgv: PACER }, agent);
    expect(readManifest(ctx).planners[agent].files.some(file => file.path === path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(withoutPacer);
  }
});
