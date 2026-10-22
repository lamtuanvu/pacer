import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../src/config/strategy";
import { renderOpencodeConfig, writeOpencodeConfig } from "../src/endpoints/opencode-config";
import { runnerEnv } from "../src/exec/launch";
import { selectBackend } from "../src/exec/backend";
import { fakeCtx } from "./helpers";

const secret = "sk-config-test-only-secret";
function setup(key = "env:ENDPOINT_TEST_KEY") {
  const ctx = fakeCtx({env: {ENDPOINT_TEST_KEY: secret}});
  mkdirSync(ctx.pacerHome, {recursive: true});
  const raw = {planner: "claude-code", accounts: {main: {kind: "claude"}, "test-api": {kind: "endpoint", usage: "unmetered", connection: {api: "openai-compatible", base_url: "https://example.test/v1", key, models: [{id: "model", context: 128000, output: 16000, tools: true}]}}, local: {kind: "endpoint", usage: "unmetered", model: "external/model"}}, routing: [{default: ["opencode#test-api", "opencode#local"]}]};
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
  return {ctx, raw, strategy: loadStrategy(ctx)};
}
test("generated config contains managed providers and env placeholders only", () => {
  const {strategy} = setup();
  const rendered = renderOpencodeConfig(strategy);
  expect(rendered).toMatchInlineSnapshot(`
    {
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "pacer-test-api": {
          "models": {
            "model": {
              "limit": {
                "context": 128000,
                "output": 16000,
              },
              "name": "model",
              "tool_call": true,
            },
          },
          "name": "test-api (pacer)",
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "apiKey": "{env:PACER_KEY_TEST_API}",
            "baseURL": "https://example.test/v1",
          },
        },
      },
    }
  `);
  expect(JSON.stringify(rendered)).not.toContain(secret);
  expect(renderOpencodeConfig(setup("none").strategy).provider["pacer-test-api"].options).not.toHaveProperty("apiKey");
});
test("writer creates a private config and replaces stale contents", async () => {
  const {ctx, raw} = setup();
  const path = await writeOpencodeConfig(ctx);
  expect(path).toBe(join(ctx.pacerHome, "opencode", "opencode.json"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "opencode")).mode & 0o777).toBe(0o700);
  raw.accounts["test-api"].connection.base_url = "http://localhost:1234/v1";
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
  await writeOpencodeConfig(ctx);
  expect(readFileSync(path, "utf8")).toContain("http://localhost:1234/v1");
  expect(readFileSync(path, "utf8")).not.toContain(secret);
});
test("runnerEnv reads keys at launch and repairs missing or stale config", async () => {
  const {ctx, strategy} = setup(); const runner = strategy.runners["opencode#test-api"];
  const env = await runnerEnv(ctx, runner);
  expect(env).toEqual({OPENCODE_CONFIG_CONTENT: JSON.stringify({default_agent:"build",model:runner.model}), OPENCODE_CONFIG: join(ctx.pacerHome, "opencode", "opencode.json"), PACER_KEY_TEST_API: secret});
  ctx.env.ENDPOINT_TEST_KEY = "rotated";
  writeFileSync(env.OPENCODE_CONFIG, "stale");
  expect((await runnerEnv(ctx, runner)).PACER_KEY_TEST_API).toBe("rotated");
  expect(JSON.parse(readFileSync(env.OPENCODE_CONFIG, "utf8")).provider).toHaveProperty("pacer-test-api");
  delete ctx.env.ENDPOINT_TEST_KEY;
  await expect(runnerEnv(ctx, runner)).rejects.toThrow("Key missing");
  expect(await runnerEnv(ctx, strategy.runners["opencode#local"])).toEqual({OPENCODE_CONFIG_CONTENT: JSON.stringify({default_agent:"build",model:strategy.runners["opencode#local"].model})});
});
test("key none launches with config only", async () => {
  const {ctx, strategy} = setup("none");
  const env = await runnerEnv(ctx, strategy.runners["opencode#test-api"]);
  expect(Object.keys(env).sort()).toEqual(["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]);
  expect(existsSync(env.OPENCODE_CONFIG)).toBe(true);
});
test("connection endpoints bypass Orca even when forced; external providers also require permission bypass", async () => {
  const {ctx, strategy} = setup(); ctx.env.PACER_BACKEND = "orca";
  let checked = false;
  const orca = {id: "orca", available: async () => {checked = true; return true;}, runAttempt: async () => {throw Error("must not launch");}};
  expect((await selectBackend(ctx, strategy, [orca], "opencode#test-api")).id).toBe("direct");
  expect(checked).toBe(false);
  expect((await selectBackend(ctx, strategy, [orca], "opencode#local")).id).toBe("direct");
});
test("account changes regenerate the config, retaining only current connections", async () => {
  const {accountCmd} = await import("../src/commands/accounts");
  const {ctx, raw} = setup();
  const path = writeOpencodeConfig(ctx);
  // This connection has no runner, so the existing remove command can remove it.
  raw.routing = [{default: ["opencode#local"]}];
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
  expect((await accountCmd(["rm", "test-api"], ctx)).code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).provider).toEqual({});
});

test("OpenCode model and agent are invocation-scoped config for full TUI compatibility", async () => {
  const {ctx, strategy} = setup();
  ctx.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({theme:"custom",provider:{custom:{name:"retained"}}});
  for (const id of ["opencode#test-api", "opencode#local"]) {
    const env = await runnerEnv(ctx, strategy.runners[id]);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      theme:"custom", provider:{custom:{name:"retained"}},default_agent:"build",model:strategy.runners[id].model,
    });
  }
});

test("invalid inline OpenCode config fails without logging its contents", async () => {
  const {ctx, strategy} = setup();
  for (const value of [secret, "[]", "null", '"not-an-object"']) {
    ctx.env.OPENCODE_CONFIG_CONTENT = value;
    const message = await runnerEnv(ctx, strategy.runners["opencode#local"]).then(() => "unexpected success", error => error.message);
    expect(message).toBe("Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object");
    expect(message).not.toContain(secret);
  }
});
