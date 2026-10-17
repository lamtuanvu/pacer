import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { helloBody, toApiError } from "../src/api/protocol";
import { eventsSince } from "../src/api/events";
import { loadStrategy } from "../src/config/strategy";
import { emptySnapshot, parseEnvelope, reduce } from "../src/link/envelope";
import * as config from "../src/core/config";
import * as setup from "../src/core/setup";
import { fakeCtx } from "./helpers";

async function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");
  return ctx;
}
async function error(p: Promise<unknown>) {
  try { await p; throw Error("expected failure"); } catch (e) { return toApiError(e); }
}

test("config.get returns allow-listed values, sources and planner candidates", async () => {
  const ctx = await configured();
  expect(await callOp(ctx, "config.get", {})).toMatchObject({
    keys: { planner: { value: "claude-code", source: join(ctx.pacerHome, "strategy.yaml") }, "pacing.accounts": { value: "spread", source: "default" } },
    planners: expect.arrayContaining(["claude-code", "codex"]),
  });
});

test("config.set returns the change and publishes exactly one config event", async () => {
  const ctx = await configured();
  expect(await callOp(ctx, "config.set", { key: "pacing.policy", value: "even" })).toMatchObject({ key: "pacing.policy", previous: "priority", value: "even", diff: expect.stringContaining("even"), undo: "pacer config set pacing.policy priority" });
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config")).toEqual([{ seq: expect.any(Number), at: ctx.now, type: "config", data: { area: "config", at: ctx.now } }]);
});

test("invalid settings and missing planner integration choice neither write nor publish", async () => {
  const ctx = await configured(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  expect((await error(callOp(ctx, "config.set", { key: "pacing.policy", value: "bad" }))).code).toBe("invalid_input");
  expect(await error(callOp(ctx, "config.set", { key: "planner", value: "codex" }))).toMatchObject({ code: "invalid_input", hint: expect.stringContaining('integrations: "install" or "skip"') });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(eventsSince(ctx, 0).events).toEqual([]);
});

test("planner skip leaves agent files alone", async () => {
  const ctx = await configured();
  await callOp(ctx, "config.set", { key: "planner", value: "codex", integrations: "skip" });
  expect(loadStrategy(ctx).planner.agent).toBe("codex");
  for (const folder of [".claude", ".codex", ".cursor", ".config/opencode"]) expect(existsSync(join(ctx.home, folder))).toBe(false);
});

test("agent preview, consent, connect and disconnect use only the temp home", async () => {
  const ctx = await configured();
  const preview = await callOp(ctx, "agent.preview", { agent: "codex" }) as { files: string[]; undo: string };
  expect(preview.files).toContain(join(ctx.home, ".codex/skills/pacer/SKILL.md"));
  expect(preview.undo).toBe("pacer uninstall codex");
  expect((await error(callOp(ctx, "agent.connect", { agent: "codex" }))).code).toBe("not_allowed");
  expect(eventsSince(ctx, 0).events).toEqual([]);
  const result = await callOp(ctx, "agent.connect", { agent: "codex", consent: true }) as { installed: string[] };
  expect(result.installed).toContain(preview.files[0]);
  expect(existsSync(preview.files[0])).toBe(true);
  expect(await callOp(ctx, "agent.disconnect", { agent: "codex" })).toMatchObject({ removed: expect.arrayContaining([preview.files[0]]) });
  expect(existsSync(preview.files[0])).toBe(false);
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config").map(e => e.type)).toEqual(["config", "config"]);
});

test("setup.init creates a strategy without connecting agents and preserves existing files", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "setup.init", { planner: "codex" })).toEqual({ strategy: join(ctx.pacerHome, "strategy.yaml") });
  expect(loadStrategy(ctx).planner.agent).toBe("codex");
  expect(existsSync(join(ctx.home, ".codex"))).toBe(false);
  const path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  await callOp(ctx, "setup.init", { planner: "codex" });
  expect(readFileSync(path, "utf8")).toBe(before);
  await callOp(ctx, "setup.init", { planner: "claude-code" });
  expect(loadStrategy(ctx).planner.agent).toBe("claude-code");
});

test("plugin installation and notifications round-trip", async () => {
  const ctx = await configured();
  expect(await callOp(ctx, "plugin.install", {})).toEqual({ path: join(ctx.pacerHome, "orca-plugin") });
  expect(existsSync(join(ctx.pacerHome, "orca-plugin/orca-plugin.json"))).toBe(true);
  expect(await callOp(ctx, "notifications.get", {})).toEqual({ level: "important" });
  expect(await callOp(ctx, "notifications.set", { level: "all" })).toEqual({ level: "all" });
  expect(await callOp(ctx, "notifications.get", {})).toEqual({ level: "all" });
  expect((await error(callOp(ctx, "notifications.set", { level: "bad" }))).code).toBe("invalid_input");
});

test("version.get, service.status and hello describe the additive capabilities", async () => {
  const ctx = await configured();
  expect(await callOp(ctx, "version.get", {})).toMatchObject({ pacer: expect.any(String), protocol: "2.7.0", service: { installed: false, running: false } });
  expect(await callOp(ctx, "service.status", {})).toEqual({ installed: false, running: false });
  expect(helloBody().events).toContain("config");
});


test("consent is enforced directly in core", async () => {
  const ctx = await configured();
  expect((await error(config.set(ctx, "planner", "codex"))).code).toBe("invalid_input");
  expect((await error(setup.agentConnect(ctx, "codex"))).code).toBe("not_allowed");
  expect(existsSync(join(ctx.home, ".codex"))).toBe(false);
});

test("failed planner installation rolls back without publishing", async () => {
  const ctx = await configured(), path = join(ctx.pacerHome, "strategy.yaml");
  const before = "accounts: {personal: {kind: claude, home: ~/.claude}, team: {kind: codex, orca_account: missing}}\nplanner: claude-code#personal\nrouting: [{default: [codex#team]}]\n";
  writeFileSync(path, before);
  expect((await error(callOp(ctx, "config.set", {key: "planner", value: "codex#team", integrations: "install"}))).code).toBe("invalid_input");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(eventsSince(ctx, 0).events).toEqual([]);
});

test("config envelopes validate and advance the sequence without changing snapshot content", () => {
  const snapshot = emptySnapshot();
  const envelope = parseEnvelope({v: 1, type: "config", data: {area: "setup", at: 42}});
  expect(envelope).toEqual({v: 1, type: "config", data: {area: "setup", at: 42}});
  expect(reduce(snapshot, envelope!, 42)).toEqual({...snapshot, seq: 1, at: 42});
  expect(parseEnvelope({v: 1, type: "config", data: {area: "setup"}})).toBeNull();
  expect(parseEnvelope({v: 1, type: "future", data: {}})).toBeNull();
});
