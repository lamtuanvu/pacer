// test/plugins-cli.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installFixture } from "../conformance/install";
import { findCommand } from "../src/commands/index";
import { pluginsCmd } from "../src/commands/plugins";
import { shutdownPlugins } from "../src/plugins";
import { fakeCtx } from "./helpers";

const base = mkdtempSync(join(tmpdir(), "pacer-plugins-cli-"));
function home() {
  const dir = join(base, `h${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, now: Date.now() / 1000 });
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}

test("pacer plugin is one command for both the Orca verbs and the plugin system", () => {
  expect(findCommand("plugin")?.usage).toContain("list|enable|disable|remove|doctor");
});

test("list, enable --yes, doctor, disable and remove print readable lines and JSON", async () => {
  const ctx = home();
  installFixture("good", join(ctx.pacerHome, "plugins"));
  expect((await pluginsCmd(["list"], ctx)).out).toMatch(/fx-good\s+1\.0\.0\s+needs_grant/);
  const refused = await pluginsCmd(["enable", "fx-good"], ctx);
  expect(refused.code).toBe(1); expect(refused.err).toContain("log, config.get");
  expect(await pluginsCmd(["enable", "fx-good", "--yes"], ctx)).toMatchObject({ code: 0, out: expect.stringContaining("fx-good: idle") });
  const doctor = await pluginsCmd(["doctor", "fx-good", "--json"], ctx);
  expect(JSON.parse(doctor.out).reports[0]).toMatchObject({ id: "fx-good", ok: true });
  expect((await pluginsCmd(["doctor"], ctx)).out).toMatch(/fx-good\s+ok/);
  expect((await pluginsCmd(["disable", "fx-good"], ctx)).out).toContain("fx-good: disabled");
  expect((await pluginsCmd(["remove", "fx-good"], ctx)).out).toContain("removed fx-good");
  expect((await pluginsCmd(["bogus"], ctx)).code).toBe(2);
  expect((await pluginsCmd(["run", "nope"], ctx)).err).toContain("no bundled plugin nope");
  await shutdownPlugins(ctx);
}, 20000);

test("doctor shows host requirements only for protocol refusals, without duplication", async () => {
  const ctx = home();
  installFixture("slow", join(ctx.pacerHome, "plugins"));
  installFixture("old-protocol", join(ctx.pacerHome, "plugins"));
  await pluginsCmd(["enable", "fx-slow", "--yes"], ctx);
  const timeout = await pluginsCmd(["doctor", "fx-slow"], ctx);
  expect(timeout.code).toBe(1);
  expect(timeout.out).toContain("plugin_timeout");
  expect(timeout.out).not.toContain("(needs host");
  const refused = await pluginsCmd(["doctor", "fx-old"], ctx);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("refused");
  expect(refused.out).toContain("needs host ^0");
  expect(refused.out.match(/needs host/g)).toHaveLength(1);
}, 20000);
