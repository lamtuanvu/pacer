import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installClaude } from "./install-plugin-adapter";
import { installCodex } from "./install-plugin-adapter";
import { installCursor } from "./install-plugin-adapter";
import { installOpencode } from "./install-plugin-adapter";
import { removeHooks } from "../src/install/hookjson";
import { runInstall } from "./install-plugin-adapter";
import { uninstallPlanner } from "./install-plugin-adapter";
import { fakeCtx } from "./helpers";
import { PACER, recordingRun } from "./install-helpers";

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test("Claude preserves HTTP and prompt hooks without string commands", async () => {
  const ctx = fakeCtx();
  const path = join(ctx.home, ".claude/settings.json");
  const stop = [{ hooks: [{ type: "http", url: "http://x" }, { type: "prompt", prompt: "check" }] }];
  put(path, JSON.stringify({ hooks: { Stop: stop } }));
  await runInstall({ ctx, mcp: true, pacerArgv: PACER }, "claude-code", installClaude);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.Stop).toEqual(stop);
});

for (const fmt of ["claude", "cursor"] as const) {
  test(`removeHooks skips non-string commands in ${fmt}`, () => {
    const hooks = [{ type: "http", url: "http://x" }, { command: null }, { command: 1 }];
    const doc = { hooks: { Stop: fmt === "claude" ? [{ hooks }] : hooks } };
    expect(removeHooks(doc, fmt, command => command.includes("pacer"))).toEqual({ doc, removed: [] });
  });
}

for (const [planner, folder, filename, installer, matcher] of [
  ["claude-code", ".claude", "settings.json", installClaude, "Agent|Task"],
  ["codex", ".codex", "hooks.json", installCodex, "spawn_agent"],
] as const) {
  for (const moved of [false, true]) {
    test(`${planner} ${moved ? "relocation" : "reinstall"} preserves later user hook indices`, async () => {
      const ctx = fakeCtx();
      const env = { ctx, mcp: true, pacerArgv: PACER };
      await runInstall(env, planner, installer);
      const path = join(ctx.home, folder, filename);
      const doc = JSON.parse(readFileSync(path, "utf8"));
      const user = { matcher, hooks: [{ type: "command", command: "user-hook" }] };
      doc.hooks.PreToolUse.push(user);
      put(path, JSON.stringify(doc, null, 2) + "\n");
      const before = readFileSync(path, "utf8");
      const config = join(ctx.home, ".codex/config.toml");
      const state = '\n[hooks.state."PreToolUse:1:0"]\ntrusted_hash = "user-trust"\n';
      if (planner === "codex") put(config, readFileSync(config, "utf8") + state);
      const result = await runInstall({ ctx, mcp: true, pacerArgv: moved ? ["/new/pacer"] : PACER }, planner, installer);
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(after.hooks.PreToolUse[1]).toEqual(user);
      expect(after.hooks.PreToolUse[0].hooks[0].command).toBe(`${moved ? "/new/pacer" : PACER[0]} guard --planner ${planner}`);
      if (!moved) {
        expect(result.touched).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(before);
      }
      if (planner === "codex") expect(readFileSync(config, "utf8")).toContain(state);
    });
  }
}

test("Codex relocates owned MCP table after markers are stripped", async () => {
  const ctx = fakeCtx();
  await runInstall({ ctx, mcp: true, pacerArgv: PACER }, "codex", installCodex);
  const path = join(ctx.home, ".codex/config.toml");
  const state = '[hooks.state."PreToolUse:1:0"]\ntrusted_hash = "keep"\n';
  put(path, readFileSync(path, "utf8").replace(/^# (?:>>>|<<<) pacer (?:>>>|<<<)\n/gm, "") + state);
  const result = await runInstall({ ctx, mcp: true, pacerArgv: ["/new/pacer"] }, "codex", installCodex);
  const text = readFileSync(path, "utf8");
  expect((Bun.TOML.parse(text) as any).mcp_servers.pacer.command).toBe("/new/pacer");
  expect(text).toContain(state);
  expect(result.notes.join("\n")).not.toContain("already defines");
});

test("quiet unsuccessful commands do not add notes", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: recordingRun(calls, 1) });
  const result = await runInstall({ ctx, mcp: true, pacerArgv: PACER }, "claude-code", tx => tx.run(["claude", "mcp", "remove"], undefined, { quiet: true }));
  expect(calls).toEqual([["claude", "mcp", "remove"]]);
  expect(result.notes).toEqual([]);
});

test("reinstall replaces historical notes with this run's notes", async () => {
  const ctx = fakeCtx();
  const env = { ctx, mcp: true, pacerArgv: PACER };
  await runInstall(env, "codex", tx => { tx.notes.push("old", "shared"); });
  const result = await runInstall(env, "codex", tx => { tx.notes.push("shared", "new"); });
  expect(result.record.notes).toEqual(["shared", "new"]);
});

test("unchanged reinstall does not rewrite the manifest", async () => {
  const ctx = fakeCtx();
  const env = { ctx, mcp: true, pacerArgv: PACER };
  await runInstall(env, "codex", installCodex);
  const path = join(ctx.pacerHome, "install-manifest.json");
  utimesSync(path, 1000, 1000);
  const before = readFileSync(path, "utf8");
  await runInstall(env, "codex", installCodex);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(statSync(path).mtimeMs).toBe(1000000);
});

for (const content of ["", " \n\t "]) {
  for (const [planner, relative] of [
    ["claude-code", ".claude/settings.json"], ["cursor", ".cursor/hooks.json"],
    ["opencode", ".config/opencode/opencode.json"], ["opencode", ".config/opencode/opencode.jsonc"],
  ]) {
    test(`${relative} accepts ${content ? "whitespace" : "empty"} content and restores it`, async () => {
      const ctx = fakeCtx();
      const path = join(ctx.home, relative!);
      put(path, content);
      const env = { ctx, mcp: true, pacerArgv: PACER };
      if (planner === "opencode") await installOpencode(env);
      else await runInstall(env, planner!, planner === "cursor" ? installCursor : installClaude);
      expect(JSON.parse(readFileSync(path, "utf8"))).toBeObject();
      await uninstallPlanner(ctx, planner!);
      expect(readFileSync(path, "utf8")).toBe(content);
    });
  }
}
