// test/plugins-config.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, validateStrategy } from "../src/config/strategy";
import { EMPTY_PLUGINS, pluginsConfig, setPluginDisabled, setPluginGrant } from "../src/plugins/config";
import { fakeCtx } from "./helpers";

const base = "planner: claude-code\nproviders:\n  claude-code: {}\n";
function home(extra = "") {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), base + extra);
  return ctx;
}

test("a strategy without plugins gets the empty section", () => {
  expect(validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "x").plugins).toEqual(EMPTY_PLUGINS);
  expect(pluginsConfig(fakeCtx())).toEqual(EMPTY_PLUGINS);
});

test("plugins.disabled, installed grants and config parse and are validated", () => {
  const ctx = home("plugins:\n  disabled: [pacer-usage]\n  installed:\n    acme: { version: \"1.2.0\", capabilities: [tasks.read, log] }\n  config:\n    acme: { region: eu }\n");
  expect(loadStrategy(ctx).plugins).toEqual({ policy: {mode: "open"}, disabled: ["pacer-usage"], installed: { acme: { version: "1.2.0", capabilities: ["tasks.read", "log"] } }, config: { acme: { region: "eu" } } });
  const bad = home("plugins:\n  disabled: nope\n  installed:\n    acme: { version: 3 }\n");
  expect(() => loadStrategy(bad)).toThrow(/plugins\.disabled must be a list.*plugins\.installed\.acme\.version must be semver/s);
});

test("edits add and remove entries without disturbing the rest of the file", async () => {
  const ctx = home("# keep me\n");
  await setPluginDisabled(ctx, "pacer-usage", true);
  await setPluginGrant(ctx, "acme", { version: "1.0.0", capabilities: ["log"] });
  expect(pluginsConfig(ctx)).toEqual({ policy: {mode: "open"}, disabled: ["pacer-usage"], installed: { acme: { version: "1.0.0", capabilities: ["log"] } }, config: {} });
  await setPluginDisabled(ctx, "pacer-usage", false);
  await setPluginGrant(ctx, "acme", null);
  expect(pluginsConfig(ctx)).toEqual({ policy: {mode: "open"}, disabled: [], installed: {}, config: {} });
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("# keep me");
  await setPluginDisabled(ctx, "xx", true);
  await setPluginDisabled(ctx, "xx", true);
  expect(pluginsConfig(ctx).disabled).toEqual(["xx"]);
});
