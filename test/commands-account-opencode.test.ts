import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {accountCmd} from "../src/commands/accounts";
import {loadStrategy} from "../src/config/strategy";
import {parseCatalog} from "../src/endpoints/catalog";
import {fakeCtx} from "./helpers";

const providers = parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8")));
async function setup() {
  const ctx = fakeCtx({run: async argv => argv.slice(0, 3).join(" ") === "opencode auth list" ? {code: 0, stdout: JSON.stringify([{id: "openrouter", name: "OpenRouter", connections: []}]), stderr: ""} : {code: 1, stdout: "", stderr: ""}});
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "cache", "models.json"), JSON.stringify({fetchedAt: ctx.now, providers}));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  return ctx;
}

test("uses the recommended model and cap without prompts", async () => {
  const ctx = await setup();
  const r = await accountCmd(["add", "opencode", "openrouter", "--cap-usd", "10", "--no-test"], ctx, {});
  expect(r).toMatchObject({code: 0});
  expect(r.out).toContain("Not tested: opencode#openrouter (openrouter/qwen/qwen3-coder) · cap $10/week");
  expect(loadStrategy(ctx).accounts.openrouter.weeklyUsd).toBe(10);
});

test("accepts an explicit model and name, and rejects a bad cap", async () => {
  const ctx = await setup();
  expect((await accountCmd(["add", "opencode", "openrouter", "--model", "z-ai/glm-5.3", "--name", "or-glm", "--no-test"], ctx, {})).out).toContain("opencode#or-glm (openrouter/z-ai/glm-5.3)");
  expect((await accountCmd(["add", "opencode", "openrouter", "--cap-usd", "0", "--no-test"], ctx, {})).err).toContain("--cap-usd must be a positive number of dollars");
});
