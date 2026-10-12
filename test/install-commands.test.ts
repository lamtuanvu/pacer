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
  const installed = await main(["install", "codex"], ctx);
  expect(installed.code).toBe(0);
  expect(installed.out).toContain("edited " + join(dir, "config.toml"));
  expect(installed.out).toContain(".pacer-bak-");
  expect(installed.out).toContain("Undo with: pacer uninstall codex");
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain("[mcp_servers.pacer]");
  const again = await main(["install", "codex"], ctx);
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
  for (const usage of ["install <planner>", "uninstall <planner>", "init [--force] [--planner <p>]", "doctor [--json]"]) {
    expect(result.out).toContain(usage.padEnd(47));
  }
});

test("install errors return code 1 and roll back earlier edits", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".codex");
  mkdirSync(dir);
  writeFileSync(join(dir, "hooks.json"), "broken JSON");
  const result = await main(["install", "codex"], ctx);
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
  expect((await main(["init", "--planner", "codex"], ctx)).code).toBe(0);
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
