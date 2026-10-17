import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Status } from "../src/engine/status";
import { installCursor } from "../src/install/cursor";
import { getMember, setMember } from "../src/install/jsonc";
import { policyText } from "../src/install/policy";
import { sessionStart } from "../src/install/session";
import { runInstall } from "../src/install/txn";
import { uninstallPlanner } from "../src/install/uninstall";
import { fakeCtx } from "./helpers";
import { PACER, snapshot } from "./install-helpers";

const MCP = '{\n\t"mcpServers": {"GitKraken": {"command":"gk", "args":["mcp"]}}\n}\n';
const HOOKS = '{"version":1,"hooks":{"sessionStart":[{"command":"gk hook","timeout":5}]}}\n';
function setup() {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".cursor");
  mkdirSync(dir);
  const mcp = join(dir, "mcp.json");
  const hooks = join(dir, "hooks.json");
  writeFileSync(mcp, MCP);
  writeFileSync(hooks, HOOKS);
  return { ctx, mcp, hooks, env: { ctx, mcp: true, pacerArgv: PACER } };
}

test("Cursor install preserves inline GitKraken config, is idempotent, and uninstalls byte-exactly", async () => {
  const { ctx, mcp, env } = setup();
  const original = snapshot(ctx.home);
  const first = await runInstall(env, "cursor", installCursor);
  expect(getMember(readFileSync(mcp, "utf8"), ["mcpServers", "pacer"]))
    .toEqual({ command: "/opt/pacer/bin/pacer", args: ["mcp"] });
  expect(readFileSync(mcp, "utf8")).toContain('"GitKraken": {"command":"gk", "args":["mcp"]}');
  expect(first.notes).toContain("Cursor has no user rule file; pacer's policy arrives through the sessionStart hook.");
  const installed = snapshot(ctx.home);
  expect((await runInstall(env, "cursor", installCursor)).touched).toEqual([]);
  expect(snapshot(ctx.home)).toEqual(installed);
  expect((await uninstallPlanner(ctx, "cursor"))!.notes).toEqual([]);
  expect(snapshot(ctx.home)).toEqual(original);
});

test("Cursor uninstall keeps another server added after install and keeps the backup", async () => {
  const { ctx, mcp, env } = setup();
  const result = await runInstall(env, "cursor", installCursor);
  writeFileSync(mcp, setMember(readFileSync(mcp, "utf8"), ["mcpServers", "other"], { command: "other" }));
  await uninstallPlanner(ctx, "cursor");
  const text = readFileSync(mcp, "utf8");
  expect(getMember(text, ["mcpServers"])).toEqual({ GitKraken: { command: "gk", args: ["mcp"] }, other: { command: "other" } });
  expect(text).toContain('"GitKraken": {"command":"gk", "args":["mcp"]}');
  expect(existsSync(result.record.files.find(file => file.path === mcp)!.backup!)).toBe(true);
});

test("Cursor hook entries have exact commands and timeouts, keeping existing hooks first", async () => {
  const { hooks, env } = setup();
  env.pacerArgv = ["/usr/bin/bun", "/workspace/pacer cli.ts"];
  await runInstall(env, "cursor", installCursor);
  expect(JSON.parse(readFileSync(hooks, "utf8"))).toEqual({ version: 1, hooks: {
    sessionStart: [{ command: "gk hook", timeout: 5 }, { command: "/usr/bin/bun '/workspace/pacer cli.ts' session-start --planner cursor", timeout: 15 }],
    subagentStart: [{ command: "/usr/bin/bun '/workspace/pacer cli.ts' guard --planner cursor", timeout: 15 }],
  } });
});

test("Cursor creates pretty MCP config for missing and empty files and removes fresh files on uninstall", async () => {
  for (const old of [null, "", "  \n"]) {
    const ctx = fakeCtx();
    const mcp = join(ctx.home, ".cursor", "mcp.json");
    if (old !== null) { mkdirSync(join(ctx.home, ".cursor")); writeFileSync(mcp, old); }
    const original = snapshot(ctx.home);
    await runInstall({ ctx, mcp: true, pacerArgv: PACER }, "cursor", installCursor);
    expect(readFileSync(mcp, "utf8")).toBe('{\n  "mcpServers": {\n    "pacer": {\n      "command": "/opt/pacer/bin/pacer",\n      "args": [\n        "mcp"\n      ]\n    }\n  }\n}\n');
    await uninstallPlanner(ctx, "cursor");
    expect(snapshot(ctx.home)).toEqual(original);
  }
});

test("Cursor uninstall drops only a parent created by pacer after user edits", async () => {
  for (const original of ['{"mine":1}', '{"mcpServers":{},"mine":1}']) {
    const { ctx, mcp, env } = setup();
    writeFileSync(mcp, original);
    await runInstall(env, "cursor", installCursor);
    expect(getMember(readFileSync(mcp, "utf8"), ["mcpServers", "pacer"]))
      .toEqual({ command: "/opt/pacer/bin/pacer", args: ["mcp"] });
    writeFileSync(mcp, setMember(readFileSync(mcp, "utf8"), ["mine"], 2));
    await uninstallPlanner(ctx, "cursor");
    expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual(original.includes("mcpServers") ? { mcpServers: {}, mine: 2 } : { mine: 2 });
  }
});

const st: Status = { generatedAt: 0, strategy: "test", planner: "cursor", mode: "normal", disabled: false, paused: null, modeHold: null,
  calendarPace: true, providers: [], executors: { ranked: [], excluded: [] } };
const BUDGET = "Subscription budget status (pacer):\nMode: NORMAL - Cursor is on pace. Delegate execution (multi-file edits, test/fix loops, boilerplate, migrations). Cursor may do tiny edits (about 20 lines, one file) itself.\nNo executor available. Cursor does the work; keep it lean.\nPace clock: calendar (not enough activity history yet)";

test("Cursor session start wraps policy and budget in additional_context JSON", async () => {
  const output = await sessionStart(fakeCtx(), "cursor", { status: async () => st });
  expect(output).toBe(JSON.stringify({ additional_context: policyText("cursor") + "\n\n" + BUDGET }));
});

test("PACER=off session start returns OFF without consulting status", async () => {
  let calls = 0;
  const deps = { status: async () => { calls++; throw new Error("must not run"); } };
  const off = "pacer delegation policy is OFF for this session (PACER=off). Do the work directly.";
  expect(await sessionStart(fakeCtx({ env: { PACER: "off" } }), "cursor", deps))
    .toBe(JSON.stringify({ additional_context: off }));
  expect(await sessionStart(fakeCtx({ env: { PACER: "off" } }), "codex", deps)).toBe(off);
  expect(calls).toBe(0);
});

test("session start keeps policy when status throws, including the default missing-strategy path", async () => {
  expect(await sessionStart(fakeCtx(), "cursor", { status: async () => { throw new Error("offline"); } }))
    .toBe(JSON.stringify({ additional_context: policyText("cursor") }));
  expect(await sessionStart(fakeCtx(), "cursor"))
    .toBe(JSON.stringify({ additional_context: policyText("cursor") }));
});

test("non-Cursor session start returns plain policy and rendered budget", async () => {
  expect(await sessionStart(fakeCtx(), "codex", { status: async () => st }))
    .toBe(policyText("codex") + "\n\n" + BUDGET);
});
