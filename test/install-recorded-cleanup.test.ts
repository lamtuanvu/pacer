import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { installPlanner } from "../src/install";
import { readManifest } from "../src/install/manifest";
import { cleanupRecordedPlanner } from "../src/install/recorded-cleanup";

test("recorded cleanup restores existing config without treating resource placeholders as observations", async () => {
  const ctx = fakeCtx({ which: () => null });
  const folder = join(ctx.home, ".codex"), config = join(folder, "config.toml");
  mkdirSync(folder);
  const original = '# user config\nmodel = "example"\n';
  writeFileSync(config, original, { mode: 0o600 });
  await installPlanner({ ctx, pacerArgv: ["/opt/pacer/bin/pacer"], mcp: true }, "codex");
  expect(readFileSync(config, "utf8")).toContain("[mcp_servers.pacer]");
  const report = await cleanupRecordedPlanner(ctx, "codex");
  expect(report).not.toBeNull();
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(readManifest(ctx).planners.codex).toBeUndefined();
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(existsSync(join(folder, "skills/pacer/SKILL.md"))).toBe(false);
});
