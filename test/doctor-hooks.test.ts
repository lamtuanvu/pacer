import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { claudeHookChecks, claudeHooksApplicable, probeClaudeHandlers } from "../src/install/doctor-hooks";
import { editClaudeSettings } from "../src/install/claude";

function fixture() {
  const ctx = fakeCtx();
  const folder = join(ctx.home, ".claude");
  mkdirSync(folder, { recursive: true });
  const settings = JSON.parse(editClaudeSettings(null, {
    session: "pacer status --hook claude-code", guard: "pacer guard --planner claude-code", statusline: "pacer statusline",
  }, ctx.home).text);
  const save = () => writeFileSync(join(folder, "settings.json"), JSON.stringify(settings));
  save();
  return { ctx, folder, settings, save };
}

for (const namedConfigured of [true, false]) {
  test(`nonselected named Claude integration stays unverified with ${namedConfigured ? "valid named/missing default" : "invalid named/valid default"} settings`, async () => {
    const { loadStrategy } = await import("../src/config/strategy");
    const { writeManifest } = await import("../src/install/manifest");
    const { ctx, folder, settings } = fixture();
    const namedFolder = join(ctx.home, "work");
    mkdirSync(namedFolder, { recursive: true });
    writeFileSync(join(namedFolder, "settings.json"), namedConfigured ? JSON.stringify(settings) : "{}");
    if (namedConfigured) rmSync(folder, { recursive: true });
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: codex\naccounts:\n  default: {kind: codex, source: default}\n  work: {kind: claude, source: external, home: ${namedFolder}}\nrunners:\n  codex: {}\n  claude-code#work: {}\nrouting:\n  - default: [claude-code#work]\n`);
    writeManifest(ctx, { version: 1, planners: { "claude-code#work": {
      planner: "claude-code#work", account: "work", folder: namedFolder,
      installedAt: ctx.now, pacerArgv: ["pacer"], commands: [], notes: [], files: [],
    } } });
    const strategy = loadStrategy(ctx);
    expect(claudeHooksApplicable(ctx, strategy)).toBe(true);
    const checks = claudeHookChecks(ctx, strategy);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "Claude hook configuration", level: "info", evidence: "unverified" });
    expect(checks[0]?.detail).toContain("not selected");
    expect(checks[0]?.fix).toContain("select");
    expect(JSON.stringify(checks)).not.toContain(folder);
  });
}

test("configured hooks never imply Claude host invocation", () => {
  const { ctx } = fixture();
  const checks = claudeHookChecks(ctx);
  expect(checks.find(c => c.name === "Claude hook configuration")?.evidence).toBe("configured");
  expect(checks.find(c => c.name === "Claude host invocation")?.evidence).toBe("unverified");
  expect(checks.find(c => c.name === "Claude guard scope")?.detail).toContain("direct edits");
});

test("disabled, malformed, partial and wrong matcher settings cannot pass configuration", () => {
  for (const change of [
    (s: any) => { s.disableAllHooks = true; },
    (s: any) => { s.hooks.PreToolUse[0].matcher = "Read"; },
    (s: any) => { delete s.hooks.SessionStart; },
    (s: any) => { s.hooks.PreToolUse[0].hooks[0].async = true; },
    (s: any) => { s.hooks.SessionStart[0].matcher = "compact"; },
    (s: any) => { s.hooks = []; },
  ]) {
    const { ctx, settings, save } = fixture(); change(settings); save();
    expect(claudeHookChecks(ctx).find(c => c.name === "Claude hook configuration")?.level).toBe("warn");
  }
  const { ctx, folder } = fixture();
  writeFileSync(join(folder, "settings.json"), '{"secret":"do-not-echo",');
  const checks = claudeHookChecks(ctx);
  expect(checks.find(c => c.name === "Claude hook configuration")?.level).toBe("warn");
  expect(JSON.stringify(checks)).not.toContain("do-not-echo");
});

test("account folder and environment override mismatch are explicit without executing settings commands", () => {
  const { ctx, settings, save } = fixture();
  ctx.env.CLAUDE_CONFIG_DIR = join(ctx.home, "other");
  settings.hooks.SessionStart[0].hooks[0].command = "pacer status --hook claude-code; touch unsafe"; save();
  ctx.run = async () => { throw Error("must not execute config"); };
  const checks = claudeHookChecks(ctx);
  expect(checks.find(c => c.name === "Claude config folder")?.level).toBe("warn");
  expect(checks.find(c => c.name === "Claude hook configuration")?.level).toBe("warn");
});

test("safe fixture probes exercise deny, allow, Task, Agent and session context without host claims", async () => {
  const check = await probeClaudeHandlers();
  expect(check).toMatchObject({ level: "ok", evidence: "tested", name: "Claude handler probes" });
  expect(check.detail).toContain("fixture");
});

test("selected named Claude account is inspected independently of the default home", async () => {
  const { loadStrategy } = await import("../src/config/strategy");
  const { ctx } = fixture();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), `planner: claude-code#work
accounts:
  work: {kind: claude, source: external, home: ${join(ctx.home,"work")}}
runners:
  claude-code#work: {}
routing:
  - default: [claude-code#work]
`);
  const checks = claudeHookChecks(ctx, loadStrategy(ctx));
  expect(checks.find(c => c.name === "Claude config folder")?.detail).toContain(join(ctx.home,"work"));
  expect(checks.find(c => c.name === "Claude hook configuration")?.level).toBe("warn");
});

test("setup does not treat intact disabled Claude settings as a working connection", async () => {
  const { checkSetup } = await import("../src/setup/check");
  const { writeManifest } = await import("../src/install/manifest");
  const { sha256 } = await import("../src/install/fsx");
  const { ctx, folder, settings, save } = fixture();
  mkdirSync(ctx.pacerHome,{recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
  const record = () => writeManifest(ctx,{version:1,planners:{"claude-code":{planner:"claude-code",installedAt:ctx.now,pacerArgv:["pacer"],commands:[],notes:[],files:[{path:join(folder,"settings.json"),action:"created",afterHash:sha256(JSON.stringify(settings)),undo:[]}]}}});
  record();
  let result = await checkSetup(ctx,{snapshotProbe:false,deferStatus:true});
  expect(result.integration).toEqual({configuration:"configured",invocation:"unverified"});
  expect(result.items.find(i=>i.id==="connect")?.detail).toContain("runtime invocation unverified");
  settings.disableAllHooks=true; save(); record();
  result = await checkSetup(ctx,{snapshotProbe:false,deferStatus:true});
  expect(result.items.find(i=>i.id==="connect")?.status).toBe("pending");
  expect(result.integration?.configuration).toBe("unverified");
});

test('unresolved selected Orca home cannot certify intact default hooks', async () => {
  const {loadStrategy} = await import('../src/config/strategy');
  const {ctx} = fixture();
  mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'planner: claude-code#work\naccounts:\n  work: {kind: claude, source: orca, orca_account: unavailable}\nrunners:\n  claude-code#work: {}\nrouting:\n  - default: [claude-code#work]\n');
  const checks = claudeHookChecks(ctx, loadStrategy(ctx));
  expect(checks.find(c=>c.name==='Claude config folder')).toMatchObject({level:'warn',evidence:'unverified'});
  expect(checks.find(c=>c.name==='Claude hook configuration')).toMatchObject({level:'warn',evidence:'unverified'});
  expect(checks.some(c=>c.level==='ok')).toBe(false);
});

test('registered hook executable must exist and be executable without running settings', async () => {
  const {writeManifest} = await import('../src/install/manifest');
  const {shellCommand} = await import('../src/install/fsx');
  const {chmodSync} = await import('node:fs');
  const {ctx,settings,save} = fixture();
  const command = join(ctx.home, 'old pacer');
  writeManifest(ctx,{version:1,planners:{'claude-code':{planner:'claude-code',installedAt:ctx.now,pacerArgv:[command],commands:[],notes:[],files:[]}}});
  settings.hooks.SessionStart[0].hooks[0].command = `${shellCommand([command])} status --hook claude-code`;
  settings.hooks.PreToolUse[0].hooks[0].command = `${shellCommand([command])} guard --planner claude-code`;
  save();
  ctx.run = async()=>{throw Error('must not run settings');};
  const result = ()=>claudeHookChecks(ctx).find(c=>c.name==='Claude hook configuration');
  expect(result()).toMatchObject({level:'warn',evidence:'unverified'});
  writeFileSync(command, '#!/bin/sh\nexit 0\n');
  chmodSync(command,0o644);
  expect(result()?.level).toBe('warn');
  chmodSync(command,0o755);
  expect(result()).toMatchObject({level:'ok',evidence:'configured'});
});
