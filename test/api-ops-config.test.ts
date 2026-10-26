import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { helloBody, toApiError } from "../src/api/protocol";
import { eventsSince } from "../src/api/events";
import { loadStrategy } from "../src/config/strategy";
import { emptySnapshot, parseOutboxEvent, reduce } from "../src/link/envelope";
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

test("retired plugin install refuses and notifications round-trip", async () => {
  const ctx = await configured();
  expect(await error(callOp(ctx, "plugin.install", {}))).toMatchObject({ code: "not_allowed", hint: expect.stringContaining("pacer plugin uninstall") });
  expect(existsSync(join(ctx.pacerHome, "orca-plugin"))).toBe(false);
  expect(await callOp(ctx, "notifications.get", {})).toEqual({ level: "important" });
  expect(await callOp(ctx, "notifications.set", { level: "all" })).toEqual({ level: "all" });
  expect(await callOp(ctx, "notifications.get", {})).toEqual({ level: "all" });
  expect((await error(callOp(ctx, "notifications.set", { level: "bad" }))).code).toBe("invalid_input");
});

test("version.get, service.status and hello describe the additive capabilities", async () => {
  const ctx = await configured();
  expect(await callOp(ctx, "version.get", {})).toMatchObject({ pacer: expect.any(String), protocol: "3.0.0", service: { installed: false, running: false } });
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
  const envelope = parseOutboxEvent({type: "config", data: {area: "setup", at: 42}});
  expect(envelope).toEqual({type: "config", data: {area: "setup", at: 42}});
  expect(reduce(snapshot, envelope!, 42)).toEqual({...snapshot, seq: 1, at: 42});
  expect(parseOutboxEvent({type: "config", data: {area: "setup"}})).toBeNull();
  expect(parseOutboxEvent({type: "future", data: {}})).toBeNull();
});

test("cookie config-set restricts terminal presets while bearer and CLI allow templates", async () => {
  const {startServer}=await import("../src/serve/http");
  const {createCode}=await import("../src/serve/app-auth");
  const ctx=await configured();
  // Keep unrelated usage lifecycle events out of this config authorization fixture.
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {usage: reactive}, codex: {usage: reactive}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(origin + path, init);
  try {
    const auth=await request(`/app/auth?code=${createCode(ctx)}`),cookie=auth.headers.get("set-cookie")!.split(";")[0];
    const set=(value:string,bearer=false)=>request("/v2/ops/config.set",{method:"POST",headers:bearer
      ?{authorization:`Bearer ${server.token}`}:{cookie,origin,"x-pacer-client":"app"},body:JSON.stringify({key:"terminal.open",value})});
    const path=join(ctx.pacerHome,"strategy.yaml"),before=readFileSync(path,"utf8");
    const denied=await set("foot {cmd}");
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({error:{message:expect.stringContaining("preset"),hint:expect.stringContaining("pacer config set")}});
    expect(readFileSync(path,"utf8")).toBe(before);expect(eventsSince(ctx,0).events).toEqual([]);
    // Request fields cannot grant template permission to the app.
    const spoof=await request("/v2/ops/config.set",{method:"POST",headers:{cookie,origin,"x-pacer-client":"app"},body:JSON.stringify({key:"terminal.open",value:"foot {cmd}",allowTerminalTemplate:true})});
    expect(spoof.status).toBe(400);
    for(const preset of ["ghostty","iterm","terminal-app","wezterm","kitty","alacritty","gnome-terminal","x-terminal-emulator","auto"])
      expect((await set(preset)).status).toBe(200);
    const allowed=await set("foot {cmd}",true);
    expect(await allowed.json()).toMatchObject({result:{value:"foot {cmd}"}});
    expect(allowed.status).toBe(200);
    expect(loadStrategy(ctx).terminal?.open).toBe("foot {cmd}");
    await config.set(ctx,"terminal.open","alacritty -e {cmd}");
    expect(loadStrategy(ctx).terminal?.open).toBe("alacritty -e {cmd}");
  } finally {await server.stop();}
});

test("machine parallel tasks validates whole numbers 1..16, preserves invalid edits and provides undo", async () => {
  const ctx = await configured(), path = join(ctx.pacerHome, "strategy.yaml");
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.local_max_tasks": {value: 2, source: "default"}}});
  for (const value of [1, 16, "3"]) {
    expect(await callOp(ctx, "config.set", {key: "execution.local_max_tasks", value})).toMatchObject({value: Number(value), undo: expect.stringContaining("pacer config set execution.local_max_tasks")});
  }
  const before = readFileSync(path, "utf8"), count = eventsSince(ctx, 0).events.length;
  for (const value of [0, 17, 1.5, "1.5", true, "bad", ""]) {
    expect((await error(callOp(ctx, "config.set", {key: "execution.local_max_tasks", value}))).code).toBe("invalid_input");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(eventsSince(ctx, 0).events.length).toBe(count);
  }
  const result = await callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 4});
  expect(result).toMatchObject({previous: 3, undo: "pacer config set execution.local_max_tasks 3"});
  await callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 3});
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.local_max_tasks": {value: 3, source: path}}});
});

test("concurrent conflicting machine capacity changes return conflict", async () => {
  const ctx = await configured();
  const first = callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 3});
  const second = error(callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 4}));
  expect((await second).code).toBe("conflict");
  await first;
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.local_max_tasks": {value: 3}}});
});
