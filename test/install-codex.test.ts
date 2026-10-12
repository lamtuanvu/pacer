import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockText } from "../src/install/blocks";
import { codexMcpBlock, installCodex } from "../src/install/codex";
import { policyText } from "../src/install/policy";
import { runInstall } from "../src/install/txn";
import { uninstallPlanner } from "../src/install/uninstall";
import { fakeCtx } from "./helpers";
import { PACER, snapshot } from "./install-helpers";

function setup(existing = true) {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".codex");
  const config = join(dir, "config.toml");
  const agents = join(dir, "AGENTS.md");
  const hooks = join(dir, "hooks.json");
  const gkStart = { hooks: [{ type: "command", command: "gk session-start", timeout: 8 }] };
  const gkGuard = { matcher: "spawn_agent", hooks: [{ type: "command", command: "gk guard" }] };
  if (existing) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, 'model = "gpt-6"\n[mcp_servers.gk]\ncommand = "gk"\n');
    writeFileSync(agents, "");
    writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [gkStart], PreToolUse: [gkGuard] } }));
  }
  return { ctx, config, agents, hooks, gkStart, gkGuard, env: { ctx, pacerArgv: PACER } };
}

test("Codex writes exact MCP block and parseable argv, including dev paths", async () => {
  const { env, config } = setup();
  env.pacerArgv = ["/path with spaces/bun", '/repo/quote"here/cli.ts'];
  const body = '[mcp_servers.pacer]\ncommand = "/path with spaces/bun"\nargs = ["/repo/quote\\\"here/cli.ts","mcp"]\n';
  expect(codexMcpBlock(env.pacerArgv)).toBe(body);
  await runInstall(env, "codex", installCodex);
  const text = readFileSync(config, "utf8");
  expect(text).toBe('model = "gpt-6"\n[mcp_servers.gk]\ncommand = "gk"\n\n# >>> pacer >>>\n' + body + '# <<< pacer <<<\n');
  expect((Bun.TOML.parse(text) as any).mcp_servers.pacer).toEqual({ command: env.pacerArgv[0], args: [env.pacerArgv[1], "mcp"] });
});

test("Codex appends exact hooks after existing trusted groups and writes policy and trust note", async () => {
  const { env, hooks, agents, gkStart, gkGuard } = setup();
  const result = await runInstall(env, "codex", installCodex);
  expect(JSON.parse(readFileSync(hooks, "utf8"))).toEqual({ hooks: {
    SessionStart: [gkStart, { hooks: [{ command: "/opt/pacer/bin/pacer status --hook codex", timeout: 15, type: "command", statusMessage: "Checking subscription budgets" }] }],
    PreToolUse: [gkGuard, { matcher: "spawn_agent", hooks: [{ command: "/opt/pacer/bin/pacer guard --planner codex", timeout: 15, type: "command" }] }],
  } });
  expect(readFileSync(agents, "utf8")).toBe(blockText(policyText("codex"), "md"));
  expect(result.notes).toContain("Codex may ask you to review and trust the new pacer hooks the next time it starts.");
});

test("Codex install is idempotent and uninstall restores every original byte", async () => {
  const { ctx, env } = setup();
  const original = snapshot(ctx.home);
  const first = await runInstall(env, "codex", installCodex);
  expect(first.touched).toHaveLength(3);
  const installed = snapshot(ctx.home);
  const again = await runInstall(env, "codex", installCodex);
  expect(again.touched).toEqual([]);
  expect(snapshot(ctx.home)).toEqual(installed);
  await uninstallPlanner(ctx, "codex");
  expect(snapshot(ctx.home)).toEqual(original);
});

test("Codex leaves user-defined plain and quoted pacer tables untouched", async () => {
  for (const name of ["pacer", '"pacer"']) {
    const { ctx, env, config } = setup();
    const original = `model = "custom"\n[mcp_servers.${name}]\ncommand = "mine"\nargs = ["own"]\n`;
    writeFileSync(config, original);
    const result = await runInstall(env, "codex", installCodex);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(result.notes.join("\n")).toContain("already defines [mcp_servers.pacer]; left it unchanged");
    expect(result.record.files.some(file => file.path === config)).toBe(false);
    await uninstallPlanner(ctx, "codex");
    expect(readFileSync(config, "utf8")).toBe(original);
  }
});

test("Codex uninstall removes unmarked MCP table while preserving appended hooks state", async () => {
  const { ctx, env, config } = setup();
  await runInstall(env, "codex", installCodex);
  expect(readFileSync(config, "utf8")).toContain("[mcp_servers.pacer]");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^# (?:>>>|<<<) pacer (?:>>>|<<<)\n/gm, "") + '[hooks.state]\ntrusted_hash = "keep-me"\n');
  await uninstallPlanner(ctx, "codex");
  const text = readFileSync(config, "utf8");
  expect(text).not.toContain("mcp_servers.pacer");
  expect(text).toContain('[hooks.state]\ntrusted_hash = "keep-me"\n');
  expect((Bun.TOML.parse(text) as any).hooks.state.trusted_hash).toBe("keep-me");
  expect((Bun.TOML.parse(text) as any).mcp_servers.gk.command).toBe("gk");
});

test("Codex fresh-home uninstall deletes all created files", async () => {
  const { ctx, env, config, agents, hooks } = setup(false);
  await runInstall(env, "codex", installCodex);
  for (const path of [config, agents, hooks]) expect(existsSync(path)).toBe(true);
  const result = await uninstallPlanner(ctx, "codex");
  expect(result!.removed.sort()).toEqual([config, agents, hooks].sort());
  for (const path of [config, agents, hooks]) expect(existsSync(path)).toBe(false);
});

test("Codex reinstall after binary relocation replaces MCP and hooks without duplicates", async () => {
  const { ctx, env, config, hooks, gkStart, gkGuard } = setup();
  const original = snapshot(ctx.home);
  await runInstall(env, "codex", installCodex);
  env.pacerArgv = ["/new path/pacer"];
  await runInstall(env, "codex", installCodex);
  expect((Bun.TOML.parse(readFileSync(config, "utf8")) as any).mcp_servers.pacer).toEqual({ command: "/new path/pacer", args: ["mcp"] });
  const doc = JSON.parse(readFileSync(hooks, "utf8"));
  expect(doc.hooks.SessionStart).toEqual([gkStart, { hooks: [{ command: "'/new path/pacer' status --hook codex", timeout: 15, type: "command", statusMessage: "Checking subscription budgets" }] }]);
  expect(doc.hooks.PreToolUse).toEqual([gkGuard, { matcher: "spawn_agent", hooks: [{ command: "'/new path/pacer' guard --planner codex", timeout: 15, type: "command" }] }]);
  expect(readFileSync(config, "utf8").match(/\[mcp_servers.pacer\]/g)).toHaveLength(1);
  await uninstallPlanner(ctx, "codex");
  expect(snapshot(ctx.home)).toEqual(original);
});
