import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { loadStrategy } from "../src/config/strategy";
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
  for (const usage of ["install <planner> [--mcp|--no-mcp]", "uninstall <planner>", "init [--planner <id>] [--yes] [--service] [--agents a,b] [--no-dashboard] [--json]", "doctor [--json]"]) {
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
  expect(loadStrategy(ctx).planner).toEqual({ agent: "codex", account: "codex" });
  expect(loadStrategy(ctx).legacy).toBe(false);
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

import { symlinkSync, rmSync } from "node:fs";
import { uninstallAll } from "../src/install/uninstall-all";
import { readManifest, writeManifest } from "../src/install/manifest";
import { PLUGIN_RECORD } from "../src/link/paths";
import { MARKER, servicePath } from "../src/service";

function allFixture() {
  const ctx = fakeCtx();
  const binary = join(ctx.home, "pacer");
  writeFileSync(binary, "fake binary");
  ctx.env.PACER_BIN = binary;
  return { ctx, binary };
}

test("uninstall --all prints the full plan and refuses non-TTY without --yes", async () => {
  const { ctx, binary } = allFixture();
  expect((await main(["install", "codex"], ctx)).code).toBe(0);
  const manifest = readManifest(ctx);
  const folder = join(ctx.home, "work-account");
  manifest.planners["codex#work"] = { ...manifest.planners.codex, account: "work", folder, files: [] };
  manifest.planners.service = { ...manifest.planners.codex, files: [] };
  manifest.planners[PLUGIN_RECORD] = { ...manifest.planners.codex, files: [] };
  writeManifest(ctx, manifest);
  const result = await uninstallAll(["--all"], ctx, { tty: false });
  expect(result.code).toBe(2);
  for (const text of ["codex#work", folder, "service", "plugin", ctx.pacerHome, binary, "left in place (use --binary to delete)"]) expect(result.out).toContain(text);
  expect(result.err).toContain("rerun with --yes");
  expect(readManifest(ctx).planners.codex).toBeDefined();
  expect(existsSync(binary)).toBe(true);
});

test("uninstall --all restores agent backups before service, plugin, home and binary", async () => {
  const { ctx, binary } = allFixture();
  const config = join(ctx.home, ".codex/config.toml");
  mkdirSync(join(ctx.home, ".codex"));
  const original = '# original\nmodel = "example"\n';
  writeFileSync(config, original);
  expect((await main(["install", "codex", "--mcp"], ctx)).code).toBe(0);
  const manifest = readManifest(ctx);
  manifest.planners["codex#work"] = { ...manifest.planners.codex, files: [], folder: join(ctx.home, "account") };
  manifest.planners[PLUGIN_RECORD] = { ...manifest.planners.codex, files: [] };
  writeManifest(ctx, manifest);
  const unit = servicePath(ctx, "linux");
  mkdirSync(join(ctx.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unit, MARKER);
  const order: string[] = [];
  const result = await uninstallAll(["--all", "--yes", "--binary", "--json"], ctx, {
    platform: "linux",
    service: () => ({ async uninstall() {
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(readManifest(ctx).planners["codex#work"]).toBeUndefined();
      order.push("service");
    } }),
    plugin: async () => {
      order.push("plugin");
      return { planner: PLUGIN_RECORD, restored: [], removed: [], reverted: [], notes: [] };
    },
    removeHome: path => { order.push("home"); rmSync(path, { recursive: true }); },
    removeBinary: path => { order.push("binary"); rmSync(path); },
  });
  expect(result.code).toBe(0);
  expect(order).toEqual(["service", "plugin", "home", "binary"]);
  const parsed = JSON.parse(result.out);
  expect(parsed.results.map((step: { kind: string }) => step.kind)).toEqual(["agent", "agent", "service", "plugin", "home", "binary"]);
  expect(parsed.results.every((step: { status: string }) => step.status === "ok")).toBe(true);
  expect(existsSync(ctx.pacerHome)).toBe(false);
  expect(existsSync(binary)).toBe(false);
});

test("uninstall --all continues through individual failures and reports exit 1", async () => {
  const { ctx } = allFixture();
  expect((await main(["install", "codex"], ctx)).code).toBe(0);
  const manifest = readManifest(ctx);
  manifest.planners.service = { ...manifest.planners.codex, files: [] };
  manifest.planners[PLUGIN_RECORD] = { ...manifest.planners.codex, files: [] };
  writeManifest(ctx, manifest);
  const order: string[] = [];
  const result = await uninstallAll(["--all", "--yes", "--binary", "--json"], ctx, {
    agent: async () => { order.push("agent"); throw new Error("agent failure"); },
    service: () => ({ async uninstall() { order.push("service"); throw new Error("service failure"); } }),
    plugin: async () => { order.push("plugin"); throw new Error("plugin failure"); },
    removeHome: () => { order.push("home"); throw new Error("home failure"); },
    removeBinary: () => { order.push("binary"); },
  });
  expect(result.code).toBe(1);
  // An agent restore failed, so PACER_HOME (its backups) is kept.
  expect(order).toEqual(["agent", "service", "plugin", "binary"]);
  expect(JSON.parse(result.out).results.map((step: { status: string }) => step.status)).toEqual(["failed", "failed", "failed", "failed", "ok"]);
});

test("uninstall --all recognizes failures returned as undo notes", async () => {
  const { ctx } = allFixture();
  expect((await main(["install", "codex"], ctx)).code).toBe(0);
  const result = await uninstallAll(["--all", "--yes"], ctx, {
    agent: async () => ({ planner: "codex", restored: [], removed: [], reverted: [], notes: ["cannot revert config: permission denied"] }),
  });
  expect(result.code).toBe(1);
  expect(result.out).toContain("failed: agent codex");
  expect(result.out).toContain("permission denied");
  expect(existsSync(ctx.pacerHome)).toBe(true);
});

test("uninstall --all refuses root, HOME and symlinks resolving to HOME before any undo", async () => {
  for (const kind of ["root", "home", "symlink"]) {
    const { ctx, binary } = allFixture();
    if (kind === "root") ctx.pacerHome = "/";
    else if (kind === "home") ctx.pacerHome = ctx.home;
    else symlinkSync(ctx.home, ctx.pacerHome);
    let called = false;
    const result = await uninstallAll(["--all", "--yes", "--binary"], ctx, {
      removeHome: () => { called = true; }, removeBinary: () => { called = true; },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("unsafe PACER_HOME");
    expect(called).toBe(false);
    expect(existsSync(binary)).toBe(true);
  }
});

test("uninstall --all uses one TTY confirmation after printing the plan", async () => {
  const { ctx } = allFixture();
  const events: string[] = [];
  const result = await uninstallAll(["--all"], ctx, {
    tty: true, print: text => { events.push(text); },
    confirm: async question => { events.push(question); return false; },
    removeHome: () => { throw new Error("must not delete after declining"); },
  });
  expect(result.code).toBe(0);
  expect(events.length).toBe(2);
  expect(events[0]).toContain("Uninstall plan:");
  expect(events[1]).toBe("Remove all of this? [y/N] ");
  expect(result.err).toContain("cancelled");
});

test("uninstall --all CLI supports JSON, leaves the binary by default and validates flags", async () => {
  const { ctx, binary } = allFixture();
  mkdirSync(ctx.pacerHome);
  const result = await main(["uninstall", "--all", "--yes", "--json"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).results).toEqual([expect.objectContaining({ kind: "home", status: "ok" })]);
  expect(existsSync(ctx.pacerHome)).toBe(false);
  expect(existsSync(binary)).toBe(true);
  expect((await main(["uninstall", "--all", "codex"], ctx)).code).toBe(2);
  expect((await main(["uninstall", "--binary"], ctx)).code).toBe(2);
  expect((await main(["help"], ctx)).out).toContain("uninstall --all [--yes] [--binary] removes everything");
});

test("uninstall --all --binary never deletes the development Bun runtime", async () => {
  const ctx = fakeCtx();
  let removed = false;
  const result = await uninstallAll(["--all", "--yes", "--binary", "--json"], ctx, {
    removeBinary: () => { removed = true; }, removeHome: () => { removed = true; },
  });
  expect(result.code).toBe(1);
  expect(result.err).toContain("Bun/Node runtime");
  expect(removed).toBe(false);
});

test("uninstall --all --binary unlinks only the selected binary", async () => {
  const { ctx, binary } = allFixture();
  const sibling = join(ctx.home, "other-tool");
  writeFileSync(sibling, "keep");
  const result = await main(["uninstall", "--all", "--yes", "--binary"], ctx);
  expect(result.code).toBe(0);
  expect(existsSync(binary)).toBe(false);
  expect(readFileSync(sibling, "utf8")).toBe("keep");
});

test("uninstall --all requires --binary when PACER_HOME contains the binary", async () => {
  const { ctx } = allFixture();
  mkdirSync(ctx.pacerHome);
  const binary = join(ctx.pacerHome, "pacer");
  writeFileSync(binary, "binary");
  ctx.env.PACER_BIN = binary;
  const refused = await main(["uninstall", "--all", "--yes"], ctx);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("rerun with --binary");
  expect(existsSync(binary)).toBe(true);
  const approved = await main(["uninstall", "--all", "--yes", "--binary"], ctx);
  expect(approved.code).toBe(0);
  expect(existsSync(binary)).toBe(false);
});

test("uninstall --all runs the existing login service and plugin uninstall paths", async () => {
  const { ctx } = allFixture();
  const { installPlugin } = await import("../src/plugin/install");
  await installPlugin({ ctx, pacerArgv: [ctx.env.PACER_BIN!] });
  const unit = servicePath(ctx, "linux");
  mkdirSync(join(ctx.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unit, `# ${MARKER}\n`);
  const commands: string[][] = [];
  ctx.run = async argv => { commands.push(argv); return { code: 0, stdout: "", stderr: "" }; };
  const result = await uninstallAll(["--all", "--yes", "--json"], ctx, { platform: "linux" });
  expect(result.code).toBe(0);
  expect(commands).toEqual([
    ["systemctl", "--user", "disable", "--now", "pacer-serve.service"],
    ["systemctl", "--user", "daemon-reload"],
  ]);
  expect(existsSync(unit)).toBe(false);
  expect(existsSync(ctx.pacerHome)).toBe(false);
  expect(JSON.parse(result.out).results.map((step: { kind: string }) => step.kind)).toEqual(["service", "plugin", "home"]);
});

test("uninstall --all reverts per-account folders recorded before strategy changes", async () => {
  const { ctx } = allFixture();
  mkdirSync(ctx.pacerHome);
  const strategy = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(strategy, "accounts:\n  work: {kind: codex, home: ~/.work-agent}\nplanner: codex#work\n");
  expect((await main(["install", "codex#work"], ctx)).code).toBe(0);
  const hooks = join(ctx.home, ".work-agent/hooks.json");
  expect(existsSync(hooks)).toBe(true);
  writeFileSync(strategy, "planner: codex\nproviders: {codex: {}}\n");
  const result = await main(["uninstall", "--all", "--yes", "--json"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).plan[0]).toEqual(expect.objectContaining({ target: "codex#work", paths: expect.arrayContaining([join(ctx.home, ".work-agent")]) }));
  expect(existsSync(hooks)).toBe(false);
  expect(existsSync(ctx.pacerHome)).toBe(false);
});

test("uninstall --all keeps PACER_HOME when an agent restore fails", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "install-manifest.json"), JSON.stringify({ version: 1, planners: { "claude-code": { files: [] } } }));
  let removed = false;
  const r = await uninstallAll(["--all", "--yes"], ctx, { tty: false, agent: async () => { throw new Error("cannot restore settings.json"); }, removeHome: () => { removed = true; } });
  expect(r.code).toBe(1);
  expect(removed).toBe(false);
  expect(r.out).toContain("failed: home");
});
