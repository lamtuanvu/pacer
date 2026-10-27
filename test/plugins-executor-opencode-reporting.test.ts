import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "../plugins/agent-session";
import { planOwnedOpenCodeReporting, validateOwnedOpenCodeConfig } from "../src/plugins/executor-opencode-reporting";
import { fakeCtx, tmpDir } from "./helpers";
import { loadStrategy } from "../src/config/strategy";
import { resolveRunner } from "../src/config/runner-id";
import { pluginRegistry } from "../src/plugins";

function fixture() {
  const home = tmpDir(), pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: codex\nproviders: {opencode: {via: opencode, model: test/model, usage: unmetered}}\n", { mode: 0o600 });
  return { ctx: fakeCtx({ home, pacerHome }), dir: join(pacerHome, "runs", "t-owned", "1") };
}

test("owned OpenCode report plan preserves private config and fixes artifact path", () => {
  const { ctx, dir } = fixture(), id = "ses_owned";
  const launch = prepare({ agent: "opencode", version: "2.1.2", newSessionId: id,
    request: "Talk", workspace: ctx.home, runDir: dir, attachments: [], permissionPolicy: "native" });
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "provider/model",
    plugins: ["existing-plugin"], provider: { custom: { secret: "private-fixture" } } }) };
  const config = validateOwnedOpenCodeConfig(env);
  expect(resolveRunner(loadStrategy(ctx), "opencode")).toMatchObject({ agent: "opencode", host: null });
  expect(resolveRunner(loadStrategy(ctx), "opencode")?.id).toBe("opencode#opencode");
  expect(pluginRegistry(ctx).list(ctx).find(item => item.id === "pacer-agent-session"))
    .toMatchObject({ bundled: true, enabled: true, publisher: "pacer" });
  const planned = planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir, launch, env, config);
  expect(planned.file.name).toBe("opencode-report-plugin");
  expect(planned.file.mode).toBe(0o600);
  expect(planned.file.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(planned.file.content).toContain(id);
  const parsed = JSON.parse(planned.env.OPENCODE_CONFIG_CONTENT!);
  expect(parsed).toMatchObject({ model: "provider/model", provider: { custom: { secret: "private-fixture" } },
    plugins: ["existing-plugin", join(dir, "report-plugin")] });
});

test("owned OpenCode report plan refuses malformed config and foreign adapter shape", () => {
  const { ctx, dir } = fixture(), id = "ses_owned";
  const launch = prepare({ agent: "opencode", version: "2.1.2", newSessionId: id,
    request: "Talk", workspace: ctx.home, runDir: dir, attachments: [], permissionPolicy: "native" });
  for (const value of ["[]", "{", '{"plugins":{}}', '{"plugins":[1]}'])
    expect(() => validateOwnedOpenCodeConfig({ OPENCODE_CONFIG_CONTENT: value })).toThrow();
  const env = { OPENCODE_CONFIG_CONTENT: "{}" }, config = validateOwnedOpenCodeConfig(env);
  expect(() => planOwnedOpenCodeReporting(ctx, "codex", id, dir, launch, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode@foreign", id, dir, launch, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir,
    { ...launch, reporting: { ...launch.reporting!, configEnv: "FOREIGN" } }, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir,
    { ...launch, reporting: { ...launch.reporting!, configKey: "foreign" } }, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir,
    { ...launch, reporting: { ...launch.reporting!, source: "x".repeat(16_385) } }, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", "other", dir, launch, env, config)).toThrow();
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir, launch,
    { OPENCODE_CONFIG_CONTENT: '{"changed":true}' }, config)).toThrow();
});

test("disabled bundled adapter cannot issue a reporting artifact", async () => {
  const { ctx, dir } = fixture(), id = "ses_owned";
  const launch = prepare({ agent: "opencode", version: "2.1.2", newSessionId: id,
    request: "Talk", workspace: ctx.home, runDir: dir, attachments: [], permissionPolicy: "native" });
  await pluginRegistry(ctx).disable(ctx, "pacer-agent-session");
  const env = { OPENCODE_CONFIG_CONTENT: "{}" };
  expect(() => planOwnedOpenCodeReporting(ctx, "opencode#opencode", id, dir, launch,
    env, validateOwnedOpenCodeConfig(env))).toThrow();
});
