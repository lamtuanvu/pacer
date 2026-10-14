import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPlanner } from "../src/install";
import { uninstallPlanner } from "../src/install/uninstall";
import { readManifest } from "../src/install/manifest";
import { setupCmd } from "../src/commands/setup";
import { fakeCtx } from "./helpers";
import { PACER } from "./install-helpers";

export function accountCtx(agent = "claude-code") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `accounts:\n  personal: {kind: ${agent === "codex" ? "codex" : "claude"}}\n  work: {kind: ${agent === "codex" ? "codex" : "claude"}, home: ~/.work-agent}\nplanner: ${agent}#work\nrouting:\n  - default: [${agent}]\n`);
  return ctx;
}
for (const agent of ["claude-code", "codex"] as const) {
  test(`${agent} installs the whole integration on its account and uninstalls recorded paths`, async () => {
    const ctx = accountCtx(agent);
    const folder = join(ctx.home, ".work-agent");
    const r = await installPlanner({ ctx, pacerArgv: PACER }, { agent, account: "work" });
    expect(existsSync(join(folder, "skills/pacer/SKILL.md"))).toBe(true);
    expect(existsSync(join(folder, agent === "codex" ? "hooks.json" : "settings.json"))).toBe(true);
    expect(existsSync(join(ctx.home, agent === "codex" ? ".codex" : ".claude"))).toBe(false);
    expect(r.record.folder).toBe(folder);
    expect(readManifest(ctx).planners[`${agent}#work`]).toBeDefined();
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
    const unrelated = join(ctx.home, agent === "codex" ? ".codex" : ".claude", "keep");
    mkdirSync(join(unrelated, ".."), { recursive: true }); writeFileSync(unrelated, "untouched");
    await uninstallPlanner(ctx, { agent, account: "work" });
    expect(existsSync(join(folder, "skills/pacer/SKILL.md"))).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("untouched");
  });
}
test("init asks for the planner agent then that agent's account", async () => {
  const ctx = accountCtx(); const questions: string[] = [];
  const result = await setupCmd(["--agents", "claude-code", "--no-dashboard"], ctx, {
    tty: true, orcaInstalled: false, print: () => {}, confirm: async () => false,
    question: async q => { questions.push(q); return ""; },
    service: () => ({ status: async () => ({ installed: true, loaded: true, running: true, pid: null, lastExitCode: null, healthy: true, plistPath: "", binaryPath: null, binaryMatches: true }), install: async () => [] }),
  });
  expect(result.code).toBe(0);
  expect(questions[0]).toContain("planner");
  expect(questions[1]).toContain("account");
  expect(questions[1]).toContain("work");
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("planner: claude-code#work");
});

test("Orca planner integration uses only an existing derived account folder", async () => {
  const ctx = accountCtx(); ctx.env.ORCA_USER_DATA_PATH = join(ctx.home, "orca-data");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  work: {kind: claude, orca_account: work-id}\nplanner: claude-code#work\n");
  expect(() => installPlanner({ctx, pacerArgv: PACER}, {agent: "claude-code", account: "work"})).toThrow("account folder not found");
  const folder = join(ctx.env.ORCA_USER_DATA_PATH, "claude-profiles/work-id/home");
  mkdirSync(folder, {recursive: true});
  const report = await installPlanner({ctx, pacerArgv: PACER}, {agent: "claude-code", account: "work"});
  expect(report.record.folder).toBe(folder);
  expect(existsSync(join(folder, "settings.json"))).toBe(true);
  expect(existsSync(join(ctx.home, ".claude"))).toBe(false);
});

test("Claude MCP install and manifest uninstall commands use the recorded account environment", async () => {
  const ctx = accountCtx(); const environments: (Record<string, string | undefined> | undefined)[] = [];
  ctx.run = async (_, __, options) => {environments.push(options?.env); return {code: 0, stdout: "", stderr: ""};};
  await installPlanner({ctx, pacerArgv: PACER, mcp: true}, {agent: "claude-code", account: "work"});
  await uninstallPlanner(ctx, {agent: "claude-code", account: "work"});
  expect(environments.length).toBeGreaterThan(2);
  expect(environments.every(env => env?.CLAUDE_CONFIG_DIR === join(ctx.home, ".work-agent"))).toBe(true);
});

test("CLI installs and uninstalls a planner runner id", async () => {
  const { main } = await import("../src/cli");
  const ctx = accountCtx();
  expect((await main(["install", "claude-code#work"], ctx)).code).toBe(0);
  expect(existsSync(join(ctx.home, ".work-agent/settings.json"))).toBe(true);
  expect((await main(["uninstall", "claude-code#work"], ctx)).code).toBe(0);
  expect(existsSync(join(ctx.home, ".work-agent/settings.json"))).toBe(false);
});

test("default account installation ignores a foreign session folder and records its own folder", async () => {
  const ctx = accountCtx("codex"); ctx.env.CODEX_HOME = join(ctx.home, "foreign");
  const r = await installPlanner({ctx, pacerArgv: PACER}, {agent: "codex", account: "personal"});
  expect(r.record.folder).toBe(join(ctx.home, ".codex"));
  expect(r.record.configEnv).toBeUndefined();
  expect(existsSync(join(ctx.home, ".codex/skills/pacer/SKILL.md"))).toBe(true);
  expect(existsSync(join(ctx.home, "foreign/skills/pacer/SKILL.md"))).toBe(false);
});

test("CLI uninstall accepts an explicit default-account runner id", async () => {
  const { main } = await import("../src/cli"); const ctx = accountCtx("codex");
  await installPlanner({ctx, pacerArgv: PACER}, {agent: "codex", account: "personal"});
  expect((await main(["uninstall", "codex#personal"], ctx)).code).toBe(0);
  expect(existsSync(join(ctx.home, ".codex/hooks.json"))).toBe(false);
});

test("init selects the sole non-default account after choosing another planner agent", async () => {
  const ctx = accountCtx();
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, readFileSync(path, "utf8").replace("  work:", "  team: {kind: codex, home: ~/.codex-team}\n  work:"));
  const r = await setupCmd(["--no-dashboard"], ctx, {
    tty: true, orcaInstalled: false, print: () => {}, confirm: async () => false,
    question: async () => "2",
    service: () => ({status: async () => ({installed: true, loaded: true, running: true, pid: null, lastExitCode: null, healthy: true, plistPath: "", binaryPath: null, binaryMatches: true}), install: async () => []}),
  });
  expect(r.code).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("planner: codex#team");
});
