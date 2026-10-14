import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import { fakeCtx } from "./helpers";

test("install codex then uninstall codex restores the original files", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" } });
  const dir = join(ctx.home, ".codex");
  mkdirSync(dir);
  const original = "# user's config\nmodel = \"example\"\n";
  writeFileSync(join(dir, "config.toml"), original);
  const installed = await main(["install", "codex", "--mcp"], ctx);
  expect(installed.code).toBe(0);
  expect(installed.out).toContain("edited " + join(dir, "config.toml"));
  expect(installed.out).toContain(".pacer-bak-");
  expect(installed.out).toContain("Undo with: pacer uninstall codex");
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain("[mcp_servers.pacer]");
  const again = await main(["install", "codex", "--mcp"], ctx);
  expect(again.code).toBe(0);
  expect(again.out).toContain("already installed, nothing changed");
  expect(again.out).not.toContain("edited ");
  expect(again.out).not.toContain("created ");
  const undone = await main(["uninstall", "codex"], ctx);
  expect(undone.code).toBe(0);
  expect(undone.out).toContain("restored " + join(dir, "config.toml"));
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(dir, "hooks.json"))).toBe(false);
  expect((await main(["uninstall", "codex"], ctx)).code).toBe(1);
});

test("install and uninstall reject an unknown or missing planner with code 2", async () => {
  const ctx = fakeCtx();
  for (const command of ["install", "uninstall"]) {
    const result = await main([command, "unknown"], ctx);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown planner");
    expect((await main([command], ctx)).code).toBe(2);
  }
});

test("help lists install, uninstall, init and doctor", async () => {
  const result = await main(["help"], fakeCtx());
  expect(result.code).toBe(0);
  for (const usage of ["install <planner> [--mcp|--no-mcp]", "uninstall <planner>", "init [--planner <id>] [--yes] [--agents a,b] [--no-dashboard] [--json]", "doctor [--json]"]) {
    expect(result.out).toContain(usage.padEnd(47));
  }
});

test("install errors return code 1 and roll back earlier edits", async () => {
  const ctx = fakeCtx();
  ctx.env.PACER_BIN = "/opt/pacer/bin/pacer";
  const dir = join(ctx.home, ".codex");
  mkdirSync(dir);
  writeFileSync(join(dir, "hooks.json"), "broken JSON");
  const result = await main(["install", "codex", "--mcp"], ctx);
  expect(result.code).toBe(1);
  expect(result.err).toContain(join(dir, "hooks.json"));
  expect(existsSync(join(dir, "config.toml"))).toBe(false);
  expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
});

test("doctor reports failed checks with exit 1 in text and JSON", async () => {
  const ctx = fakeCtx({ which: () => null });
  const text = await main(["doctor"], ctx);
  expect(text.code).toBe(1);
  expect(text.out).toContain("[FAIL] Strategy");
  const json = await main(["doctor", "--json"], ctx);
  expect(json.code).toBe(1);
  expect(JSON.parse(json.out)).toContainEqual(expect.objectContaining({ name: "Strategy", level: "fail" }));
});

test("init and internal activity dispatch write their outputs in the context home", async () => {
  const ctx = fakeCtx();
  // Service is already installed in this isolated fixture; no manager registration.
  mkdirSync(join(ctx.home, "Library/LaunchAgents"), { recursive: true });
  mkdirSync(join(ctx.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(ctx.home, "Library/LaunchAgents/com.pacer.serve.plist"), "fixture");
  writeFileSync(join(ctx.home, ".config/systemd/user/pacer-serve.service"), "fixture");
  expect((await main(["init", "--planner", "codex", "--no-dashboard"], ctx)).code).toBe(0);
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("planner: codex");
  expect((await main(["_activity"], ctx)).code).toBe(0);
  expect(existsSync(join(ctx.pacerHome, "activity.json"))).toBe(true);
});

test("session-start dispatch provides Cursor context and fails open", async () => {
  const result = await main(["session-start", "--planner", "cursor"], fakeCtx());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).additional_context).toContain("pacer");
});

test("guard reads stubbed stdin and always exits 0, including read failures", async () => {
  const original = io.readStdin;
  let reads = 0;
  try {
    io.readStdin = async () => { reads++; return JSON.stringify({ subagent_type: "Explore", task: "inspect" }); };
    const result = await main(["guard", "--planner", "cursor"], fakeCtx());
    expect(reads).toBe(1);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ permission: "allow" });
    io.readStdin = async () => { throw new Error("stdin unavailable"); };
    const failedRead = await main(["guard", "--planner", "cursor"], fakeCtx());
    expect(failedRead.code).toBe(0);
    expect(JSON.parse(failedRead.out)).toEqual({ permission: "allow" });
    expect((await main(["guard", "--planner", "unknown"], fakeCtx())).code).toBe(0);
    expect((await main(["guard", "cursor"], fakeCtx())).out).toBe("");
  } finally { io.readStdin = original; }
});

test("statusline reads stdin and stores Claude rate limits", async () => {
  const original = io.readStdin;
  const ctx = fakeCtx();
  try {
    io.readStdin = async () => JSON.stringify({ rate_limits: { seven_day: { utilization: 25 } } });
    const result = await main(["statusline"], ctx);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Budget ?");
    expect(JSON.parse(readFileSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"), "utf8")).seven_day.utilization).toBe(25);
    io.readStdin = async () => { throw new Error("stdin unavailable"); };
    expect((await main(["statusline"], ctx)).code).toBe(0);
  } finally { io.readStdin = original; }
});

test("development install warns with the exact baked shell command", async () => {
  const { installPlanner, renderInstall } = await import("../src/install");
  const ctx = fakeCtx();
  const result = await installPlanner({ ctx, pacerArgv: ["/opt/bun", "/repo with spaces/src/cli.ts"] }, "codex");
  const text = renderInstall(result);
  expect(text).toContain("WARNING");
  expect(text).toContain("/opt/bun '/repo with spaces/src/cli.ts'");
});

test("installer refuses transient worktree argv before writing files", async () => {
  const { installPlanner } = await import("../src/install");
  const ctx = fakeCtx();
  await expect(installPlanner({ ctx, pacerArgv: ["/bun", "/repo/.worktrees/fix/src/cli.ts"] }, "codex")).rejects.toThrow("PACER_BIN");
  expect(existsSync(join(ctx.home, ".codex"))).toBe(false);
});

test("Claude command-only MCP changes appear in install and uninstall summaries", async () => {
  let registered = false;
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" }, which: () => "claude", run: async argv => {
    const verb = argv[2];
    const code = verb === "get" && !registered ? 1 : 0;
    if (verb === "add") registered = true;
    if (verb === "remove") registered = false;
    return { code, stdout: "", stderr: "" };
  } });
  await main(["install", "claude-code"], ctx);
  const added = await main(["install", "claude-code", "--mcp"], ctx);
  expect(added.out).toContain("registered MCP server pacer (claude mcp add -s user pacer -- /opt/pacer/bin/pacer mcp)");
  expect(added.out).not.toContain("nothing changed");
  const removed = await main(["install", "claude-code", "--no-mcp"], ctx);
  expect(removed.out).toContain("removed MCP server pacer (claude mcp remove -s user pacer)");
  expect(removed.out).not.toContain("nothing changed");
  expect((await main(["install", "claude-code", "--no-mcp"], ctx)).out).toContain("MCP server pacer was not registered");
  await main(["install", "claude-code", "--mcp"], ctx);
  expect((await main(["uninstall", "claude-code"], ctx)).out).toContain("removed MCP server pacer (claude mcp remove -s user pacer)");
});

test("failed Claude MCP removal never claims success or nothing changed", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" }, which: () => "claude", run: async argv => ({ code: argv[2] === "get" ? 0 : 1, stdout: "", stderr: "permission denied" }) });
  await main(["install", "claude-code"], ctx);
  const report = await main(["install", "claude-code", "--no-mcp"], ctx);
  expect(report.out).toContain("failed (exit 1): permission denied");
  expect(report.out).not.toContain("removed MCP server");
  expect(report.out).not.toContain("nothing changed");
});

test("failed Claude MCP registration is reported without a success claim", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" }, which: () => "claude", run: async argv => ({ code: argv[2] === "add" ? 1 : 0, stdout: "", stderr: "registration denied" }) });
  await main(["install", "claude-code"], ctx);
  const report = await main(["install", "claude-code", "--mcp"], ctx);
  expect(report.out).toContain("failed (exit 1): registration denied");
  expect(report.out).not.toContain("registered MCP server");
  expect(report.out).not.toContain("nothing changed");
});
