import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PACER, recordingRun, snapshot } from "./install-helpers";
import { applyUndo, mergeUndo, piecesPresent, readManifest } from "../src/install/manifest";
import { InstallError, runInstall } from "../src/install/txn";
import { uninstallPlanner } from "../src/install/uninstall";
import { upsertBlock } from "../src/install/blocks";

const block = [{ kind: "block", style: "md" }] as const;
function setup() {
  const ctx = fakeCtx();
  const path = join(ctx.home, "AGENTS.md");
  writeFileSync(path, "mine\n");
  return { ctx, path, env: { ctx, pacerArgv: PACER } };
}

test("backup once across re-edits; uninstall restores bytes and removes record", async () => {
  const { ctx, path, env } = setup();
  const original = snapshot(ctx.home);
  const first = await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "one", "md"), [...block]); });
  const second = await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "two", "md"), [...block]); });
  expect(second.record.files[0].backup).toBe(first.record.files[0].backup);
  expect(Object.keys(snapshot(ctx.home)).filter(p => p.includes("pacer-bak"))).toHaveLength(1);
  const idle = await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "two", "md"), [...block]); });
  expect(idle.touched).toEqual([]);
  expect((await uninstallPlanner(ctx, "codex"))!.restored).toEqual([path]);
  expect(snapshot(ctx.home)).toEqual(original);
  expect(readManifest(ctx).planners.codex).toBeUndefined();
  expect(await uninstallPlanner(ctx, "codex")).toBeNull();
});

test("user edits trigger surgical removal and retain backup, including after reinstall", async () => {
  for (const reinstall of [false, true]) {
    const { ctx, path, env } = setup();
    const result = await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "one", "md"), [...block]); });
    writeFileSync(path, readFileSync(path, "utf8") + "user\n");
    if (reinstall) await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "two", "md"), [...block]); });
    const report = await uninstallPlanner(ctx, "codex");
    expect(readFileSync(path, "utf8")).toBe("mine\n\nuser\n");
    expect(existsSync(result.record.files[0].backup!)).toBe(true);
    expect(report!.notes.join("\n")).toContain(result.record.files[0].backup!);
  }
});

test("created and moved files round-trip; repeated move is skipped", async () => {
  const { ctx, path, env } = setup();
  const original = snapshot(ctx.home);
  const created = join(ctx.home, "nested", "new.md");
  const result = await runInstall(env, "codex", tx => {
    tx.moveAside(path); tx.moveAside(path);
    tx.edit(created, () => "new\n", []);
  });
  expect(result.notes).toHaveLength(1);
  expect(existsSync(path)).toBe(false);
  await uninstallPlanner(ctx, "codex");
  expect(snapshot(ctx.home)).toEqual(original);
});

test("throwing edit is InstallError and rollback restores this run's snapshot", async () => {
  const { ctx, path, env } = setup();
  const original = snapshot(ctx.home);
  await expect(runInstall(env, "codex", tx => {
    tx.edit(path, () => "changed", [...block]);
    tx.edit(join(ctx.home, "new"), () => "new", []);
    tx.edit(join(ctx.home, "broken"), () => { throw new Error("bad JSON"); }, []);
  })).rejects.toBeInstanceOf(InstallError);
  expect(snapshot(ctx.home)).toEqual(original);
  expect(readManifest(ctx).planners.codex).toBeUndefined();
});

test("rollback of reinstall preserves prior content and backup", async () => {
  const { ctx, path, env } = setup();
  await runInstall(env, "codex", tx => { tx.edit(path, old => upsertBlock(old!, "one", "md"), [...block]); });
  const before = snapshot(ctx.home);
  await expect(runInstall(env, "codex", tx => {
    tx.edit(path, old => upsertBlock(old!, "two", "md"), [...block]);
    throw new Error("abort");
  })).rejects.toThrow("abort");
  expect(snapshot(ctx.home)).toEqual(before);
});

test("commands deduplicate persistent undo, run undo on rollback, and note exit 127", async () => {
  const { ctx, env } = setup();
  const calls: string[][] = [];
  ctx.run = recordingRun(calls);
  const result = await runInstall(env, "codex", async tx => {
    await tx.run(["register"], ["unregister"]);
    await tx.run(["register"], ["unregister"]);
  });
  expect(result.record.commands).toEqual([{ undo: ["unregister"] }]);
  await uninstallPlanner(ctx, "codex");
  expect(calls).toEqual([["register"], ["register"], ["unregister"]]);
  calls.length = 0;
  await expect(runInstall(env, "codex", async tx => {
    await tx.run(["register"], ["unregister"]); throw new Error("abort");
  })).rejects.toThrow("abort");
  expect(calls).toEqual([["register"], ["unregister"]]);
  ctx.run = recordingRun(calls, 127);
  const failed = await runInstall(env, "codex", async tx => { await tx.run(["missing"]); });
  expect(failed.notes).toEqual(["`missing` failed (exit 127): not available"]);
});

test("applyUndo removes each kind in order and preserves JSON member surroundings", () => {
  expect(applyUndo("mine\n\n<!-- >>> pacer >>> -->\none\n<!-- <<< pacer <<< -->\n", [...block])).toBe("mine\n");
  expect(applyUndo('top = 1\n[mcp_servers.pacer]\ncommand = "pacer"\n[next]\nx = 2\n', [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe("top = 1\n[next]\nx = 2\n");
  expect(applyUndo('[mcp_servers.pacer]\nx = 1', [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe("");
  expect(applyUndo('{\n  "mcp": {"pacer": {}},\n  "mine": true\n}\n', [{ kind: "json-member", path: ["mcp", "pacer"], dropEmpty: ["mcp"] }])).toBe('{\n  "mine": true\n}\n');
  expect(applyUndo('{"hooks":{"SessionStart":[{"hooks":[{"command":"pacer"}]}]},"statusLine":{},"mine":1}', [
    { kind: "hooks", format: "claude", commands: ["pacer"], restore: [{ event: "SessionStart", hook: { type: "command", command: "legacy" } }] },
    { kind: "json-key", key: "statusLine" },
  ])).toBe(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "legacy" }] }] }, mine: 1 }, null, 2) + "\n");
});

test("piecesPresent detects owned pieces and never throws on malformed documents", () => {
  expect(piecesPresent(upsertBlock("", "one", "md"), [...block])).toBe(true);
  expect(piecesPresent("mine", [...block])).toBe(false);
  expect(piecesPresent('{"mcp":{"pacer":{}}}', [{ kind: "json-member", path: ["mcp", "pacer"] }])).toBe(true);
  expect(piecesPresent('bad', [{ kind: "json-key", key: "pacer" }])).toBe(false);
  expect(piecesPresent('[pacer]\nx=1', [{ kind: "toml-table", table: "pacer" }])).toBe(true);
  expect(piecesPresent('{"hooks":{"sessionStart":[{"command":"pacer"}]}}', [{ kind: "hooks", format: "cursor", commands: ["pacer"], restore: [] }])).toBe(true);
});

test("mergeUndo unions hooks and deduplicates ownership operations", () => {
  expect(mergeUndo([...block, { kind: "hooks", format: "cursor", commands: ["old"], restore: [] }], [...block, { kind: "hooks", format: "cursor", commands: ["new", "old"], restore: [{ event: "sessionStart", hook: { command: "legacy" } }] }])).toEqual([...block, { kind: "hooks", format: "cursor", commands: ["old", "new"], restore: [{ event: "sessionStart", hook: { command: "legacy" } }] }]);
});

test("TOML table undo accepts trailing header comments and leaves the next table intact", () => {
  const text = '[mcp_servers.pacer] # managed\ncommand = "pacer"\n[next]\nx = 2\n';
  expect(applyUndo(text, [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe('[next]\nx = 2\n');
  expect(piecesPresent(text, [{ kind: "toml-table", table: "mcp_servers.pacer" }])).toBe(true);
});
