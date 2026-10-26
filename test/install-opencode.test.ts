import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PACER, snapshot } from "./install-helpers";
import { installOpencode, opencodeConfigPath, opencodeDir } from "./install-plugin-adapter";
import { parseJsonc } from "../src/install/jsonc";
import { readManifest } from "../src/install/manifest";
import { uninstallPlanner } from "./install-plugin-adapter";

const agents = "# My instructions\n\n<!-- context7 -->\nKeep using context7.\n<!-- /context7 -->\n";
const config = '{\n\t// Keep this comment\n\t"mcp": {"context7": {"type": "remote", "url": "https://example.com/mcp"},},\n\t"theme": "dark",\n}\n';

function setup() {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, agents);
  return { ctx, dir, agentsPath, env: { ctx, mcp: true, pacerArgv: PACER } };
}

test("JSONC comments and context7 survive install; reinstall is idle and uninstall restores exact bytes", async () => {
  const { ctx, dir, agentsPath, env } = setup();
  const path = join(dir, "opencode.jsonc");
  writeFileSync(path, config);
  const before = snapshot(ctx.home);
  const result = await installOpencode(env);
  const installed = readFileSync(path, "utf8");
  expect(installed).toContain('// Keep this comment\n\t"mcp":');
  expect(installed).toContain('"context7": {"type": "remote", "url": "https://example.com/mcp"},');
  expect(installed).toContain('\t"theme": "dark",');
  expect(parseJsonc(installed).mcp).toEqual({
    context7: { type: "remote", url: "https://example.com/mcp" },
    pacer: { type: "local", command: ["/opt/pacer/bin/pacer", "mcp"], enabled: true },
  });
  expect(readFileSync(agentsPath, "utf8")).toStartWith(agents);
  expect(readFileSync(agentsPath, "utf8")).toContain("<!-- >>> pacer >>> -->");
  expect(readFileSync(agentsPath, "utf8")).toContain("pacer status --json");
  expect(result.notes.join("\n")).toContain("policy-only");
  expect(result.touched).toEqual([agentsPath, join(dir,"skills/pacer/SKILL.md"), path]);
  const installedSnapshot = snapshot(ctx.home);
  expect((await installOpencode(env)).touched).toEqual([]);
  expect(snapshot(ctx.home)).toEqual(installedSnapshot);
  await uninstallPlanner(ctx, "opencode");
  expect(snapshot(ctx.home)).toEqual(before);
});

test("opencode.jsonc is preferred when both config files exist", async () => {
  const { ctx, dir, env } = setup();
  const json = join(dir, "opencode.json");
  const jsonc = join(dir, "opencode.jsonc");
  writeFileSync(json, "invalid but not selected\n");
  writeFileSync(jsonc, config);
  expect(opencodeConfigPath(ctx)).toBe(jsonc);
  await installOpencode(env);
  expect(readFileSync(json, "utf8")).toBe("invalid but not selected\n");
  expect(parseJsonc(readFileSync(jsonc, "utf8")).mcp).toHaveProperty("pacer.enabled", true);
});

test("XDG_CONFIG_HOME contains the policy and newly created schema config", async () => {
  const ctx = fakeCtx();
  ctx.env.XDG_CONFIG_HOME = join(ctx.home, "xdg");
  const dir = join(ctx.home, "xdg", "opencode");
  expect(opencodeDir(ctx)).toBe(dir);
  expect(opencodeConfigPath(ctx)).toBe(join(dir, "opencode.json"));
  const before = snapshot(ctx.home);
  await installOpencode({ ctx, mcp: true, pacerArgv: ["/usr/bin/bun", "/work/pacer/src/cli.ts"] });
  expect(existsSync(join(dir, "opencode.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"))).toEqual({
    $schema: "https://opencode.ai/config.json",
    mcp: { pacer: { type: "local", command: ["/usr/bin/bun", "/work/pacer/src/cli.ts", "mcp"], enabled: true } },
  });
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("pacer delegation policy (OpenCode");
  expect(existsSync(join(ctx.home, ".config", "opencode", "AGENTS.md"))).toBe(false);
  await uninstallPlanner(ctx, "opencode");
  expect(snapshot(ctx.home)).toEqual(before);
});

test("invalid JSONC rejects with its path and rolls AGENTS.md back to the original snapshot", async () => {
  const { ctx, dir, env } = setup();
  const path = join(dir, "opencode.jsonc");
  writeFileSync(path, '{"mcp": broken}');
  const before = snapshot(ctx.home);
  await expect(installOpencode(env)).rejects.toThrow(path);
  expect(snapshot(ctx.home)).toEqual(before);
  expect(readManifest(ctx).planners.opencode).toBeUndefined();
});

test("uninstall drops a pacer-created mcp parent but preserves later user edits", async () => {
  const { ctx, dir, env } = setup();
  const path = join(dir, "opencode.json");
  const original = '{\n  "theme": "dark"\n}\n';
  writeFileSync(path, original);
  await installOpencode(env);
  expect(parseJsonc(readFileSync(path, "utf8")).mcp).toHaveProperty("pacer.enabled", true);
  writeFileSync(path, readFileSync(path, "utf8") + "// user edit\n");
  await uninstallPlanner(ctx, "opencode");
  expect(readFileSync(path, "utf8")).toBe(original + "// user edit\n");
});

test("uninstall retains a pre-existing empty mcp parent after user edits", async () => {
  const { ctx, dir, env } = setup();
  const path = join(dir, "opencode.json");
  writeFileSync(path, '{"mcp": {}, "theme": "dark"}\n');
  await installOpencode(env);
  expect(parseJsonc(readFileSync(path, "utf8")).mcp).toHaveProperty("pacer.enabled", true);
  writeFileSync(path, readFileSync(path, "utf8") + "// user edit\n");
  await uninstallPlanner(ctx, "opencode");
  expect(parseJsonc(readFileSync(path, "utf8"))).toEqual({ mcp: {}, theme: "dark" });
  expect(readFileSync(path, "utf8")).toContain("// user edit");
});
