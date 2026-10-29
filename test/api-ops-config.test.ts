import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { helloBody, toApiError } from "../src/api/protocol";
import { eventsSince } from "../src/api/events";
import { loadStrategy, type Strategy } from "../src/config/strategy";
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
  } finally {server.stop();}
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

test("delegated task launch mode defaults to interactive and validates its values", async () => {
  const ctx = await configured(), path = join(ctx.pacerHome, "strategy.yaml");
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.launch_mode": {value: "interactive", source: "default"}}});
  const before = readFileSync(path, "utf8");
  for (const value of ["pty", "Headless", "", 1, true]) {
    const failure = await error(callOp(ctx, "config.set", {key: "execution.launch_mode", value}));
    expect(failure.code).toBe("invalid_input");
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  expect(await callOp(ctx, "config.set", {key: "execution.launch_mode", value: "headless"})).toMatchObject({value: "headless", previous: "interactive", undo: "pacer config set execution.launch_mode interactive"});
  expect(Bun.YAML.parse(readFileSync(path, "utf8"))).toMatchObject({execution: {launch_mode: "headless"}});
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.launch_mode": {value: "headless", source: path}}});
});

test("concurrent conflicting machine capacity changes return conflict", async () => {
  const ctx = await configured();
  const first = callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 3});
  const second = error(callOp(ctx, "config.set", {key: "execution.local_max_tasks", value: 4}));
  expect((await second).code).toBe("conflict");
  await first;
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.local_max_tasks": {value: 3}}});
});

test("execution.backend maps auto and unset to direct, writes orca or direct and the op wires Orca readiness", async () => {
  const ctx = await configured(), path = join(ctx.pacerHome, "strategy.yaml"), calls: string[][] = [];
  ctx.run = async argv => { calls.push(argv); return {code: 127, stdout: "", stderr: "not available in tests"}; };
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.backend": {value: "direct", source: "default"}}});
  writeFileSync(path, readFileSync(path, "utf8") + "execution: {backend: auto}\n");
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.backend": {value: "direct", source: path}}});
  expect(calls).toEqual([]);
  const warned = await callOp(ctx, "config.set", {key: "execution.backend", value: "orca"}) as Record<string, unknown>;
  expect(warned).toMatchObject({value: "orca", previous: "direct", undo: "pacer config set execution.backend direct", warning: "Orca isn't running; tasks run directly until it is."});
  expect(warned.notes).toBeUndefined();
  expect(loadStrategy(ctx).execution).toMatchObject({backend: "orca"});
  expect(calls[0]?.slice(0, 2)).toEqual(["orca", "status"]);
  await callOp(ctx, "config.set", {key: "execution.backend", value: "direct"});
  expect(readFileSync(path, "utf8")).toContain("backend: direct");
  const before = readFileSync(path, "utf8");
  for (const value of ["auto", "bogus"]) expect(await error(callOp(ctx, "config.set", {key: "execution.backend", value}))).toMatchObject({code: "invalid_input", message: "execution.backend must be orca or direct"});
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("core config.set warns from injected backend readiness only for orca", async () => {
  const ctx = await configured(), seen: unknown[] = [];
  ctx.run = async () => { throw Error("core must not query Orca"); };
  const set = (value: string, backendReady?: (c: typeof ctx, s: Strategy, id: string) => Promise<boolean>) => config.set(ctx, "execution.backend", value, {backendReady});
  const ready = async (_: unknown, s: Strategy, id: string) => { seen.push([s.execution, id]); return true; };
  expect((await set("orca", ready)).warning).toBeUndefined();
  expect(seen).toEqual([[{backend: "orca"}, "orca"]]);
  expect(await set("orca", async () => false)).toMatchObject({warning: "Orca isn't running; tasks run directly until it is.", notes: ["Orca isn't running; tasks run directly until it is."]});
  expect(await set("orca", async () => { throw Error("orca crashed"); })).toMatchObject({warning: expect.stringContaining("Orca isn't running")});
  expect((await set("orca")).warning).toBeUndefined();
  seen.length = 0; expect((await set("direct", ready)).warning).toBeUndefined(); expect(seen).toEqual([]);
});

test("PACER_BACKEND controls the displayed backend and suppresses readiness warnings", async () => {
  const ctx = await configured();
  ctx.env.PACER_BACKEND = "orca";
  expect(config.get(ctx).keys["execution.backend"]).toEqual({value: "orca", source: "env PACER_BACKEND"});
  expect(await callOp(ctx, "config.get", {})).toMatchObject({keys: {"execution.backend": {value: "orca", source: "env PACER_BACKEND"}}});
  let probes = 0;
  const result = await config.set(ctx, "execution.backend", "direct", {backendReady: async () => { probes++; return false; }});
  expect(result).toMatchObject({value: "direct", hint: expect.stringContaining("PACER_BACKEND"), notes: [expect.stringContaining("PACER_BACKEND")]});
  expect(result.warning).toBeUndefined();
  expect(probes).toBe(0);
  const apiResult = await callOp(ctx, "config.set", {key: "execution.backend", value: "orca"});
  expect(apiResult).toMatchObject({hint: expect.stringContaining("PACER_BACKEND")});
  expect((apiResult as {warning?: string}).warning).toBeUndefined();
  ctx.env.PACER_BACKEND = "other";
  expect(config.get(ctx).keys["execution.backend"]).toEqual({value: "direct", source: "env PACER_BACKEND"});
});

test("backend readiness runs after the edit lock is released and times out", async () => {
  const ctx = await configured();
  let start!: () => void;
  const probeStarted = new Promise<void>(resolve => { start = resolve; });
  let finish!: (value: boolean) => void;
  const probe = new Promise<boolean>(resolve => { finish = resolve; });
  const first = config.set(ctx, "execution.backend", "orca", {backendReady: async () => { start(); return probe; }});
  await probeStarted;
  const second = await config.set(ctx, "execution.backend", "direct");
  expect(second.value).toBe("direct");
  finish(true);
  expect((await first).warning).toBeUndefined();
  const began = Date.now();
  const timeout = await config.set(ctx, "execution.backend", "orca", {backendReady: async () => new Promise<boolean>(() => {})});
  expect(timeout.warning).toBe(config.ORCA_NOT_RUNNING);
  expect(Date.now() - began).toBeLessThan(3500);
});

test("config.get only offers detected terminals alongside Automatic", async () => {
  const ctx = await configured();
  const detected = join(ctx.home, "Applications", "Ghostty.app");
  mkdirSync(detected, {recursive:true});
  ctx.which = name => name === "ghostty" ? "/fixture/bin/ghostty" : null;
  const result = await callOp(ctx, "config.get", {}) as {terminalChoices:{value:string;label:string}[]};
  expect(result.terminalChoices[0]).toEqual({value:"auto",label:"Automatic"});
  expect(result.terminalChoices).toContainEqual({value:"ghostty",label:"Ghostty"});
  if (process.platform !== "darwin") expect(result.terminalChoices).toHaveLength(2);
  else for (const choice of result.terminalChoices.slice(1)) {
    const app = ({"ghostty":"Ghostty","iterm":"iTerm","terminal-app":"Terminal"} as Record<string,string>)[choice.value];
    expect(["/Applications", join(ctx.home,"Applications"), "/System/Applications/Utilities"].some(root => existsSync(join(root, `${app}.app`)))).toBe(true);
  }
});
