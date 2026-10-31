import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeCtx } from "./helpers";
import { PACER, recordingRun, snapshot } from "./install-helpers";
import { runInstall } from "./install-plugin-adapter";
import { applyUndo, readManifest } from "../src/install/manifest";
import { uninstallPlanner } from "./install-plugin-adapter";
import { editStatuslineScript, installClaude, resolveScript } from "./install-plugin-adapter";

function legacyHome() {
  const calls: string[][] = [];
  const ctx = fakeCtx({ which: () => "/usr/bin/claude", run: recordingRun(calls) });
  const put = (name: string, text: string) => {
    const path = join(ctx.home, ".claude", name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path;
  };
  const legacy = ["scripts/budget/budget_status.py", "scripts/budget/subagent_guard.py", "scripts/budget/budget-status", "rules/model-delegation.md", "agents/delegation/codex-executor.md", "agents/delegation/byteplus-executor.md"];
  for (const name of legacy) put(name, `legacy ${name}\n`);
  put("rules/context7.md", "unrelated\n");
  const script = put("statusline.sh", "#!/bin/sh\ninput=$(cat)\n# Persist Claude's rate-limit windows for ~/.claude/scripts/budget/budget-status\nif true; then\n  echo ~/.claude/state/budget/claude.json\nfi\necho mine\n# L4: cross-subscription pacing...\nif true; then\n  ~/.claude/scripts/budget/budget-status --line\nfi\n\nexit 0\n");
  const original = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "other-start" }] }, { hooks: [{ type: "command", command: "$HOME/.claude/scripts/budget/budget-status --hook", timeout: 15, statusMessage: "Checking subscription budgets" }] }],
      PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "other-tool" }] }, { matcher: "Agent|Task", hooks: [{ type: "command", command: "$HOME/.claude/scripts/budget/subagent_guard.py", timeout: 15 }] }],
    },
    statusLine: { type: "command", command: script },
  };
  const settings = put("settings.json", JSON.stringify(original, null, 2) + "\n");
  return { ctx, calls, legacy, script, settings, original, install: (argv = PACER) => runInstall({ ctx, mcp: true, pacerArgv: argv }, "claude-code", installClaude) };
}

test("Claude migration replaces legacy hooks and scripts and registers MCP", async () => {
  const f = legacyHome();
  await f.install();
  expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ ...f.original, hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "other-start" }] }, { hooks: [{ command: "/opt/pacer/bin/pacer msg hook session --planner claude-code", timeout: 15, type: "command", statusMessage: "Checking subscription budgets" }] }],
    PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "other-tool" }] }, { matcher: "Agent|Task|Bash", hooks: [{ command: "/opt/pacer/bin/pacer guard --planner claude-code", timeout: 15, type: "command" }] }],
    Stop: [{ hooks: [{ command: "/opt/pacer/bin/pacer msg hook stop --planner claude-code", timeout: 10, type: "command" }] }],
    UserPromptSubmit: [{ hooks: [{ command: "/opt/pacer/bin/pacer msg hook prompt --planner claude-code", timeout: 10, type: "command" }] }],
  } });
  const script = readFileSync(f.script, "utf8");
  expect(script).toContain('# >>> pacer >>>\nprintf \'%s\' "$input" | /opt/pacer/bin/pacer statusline 2>/dev/null\n# <<< pacer <<<\n\nexit 0\n');
  expect(script).not.toContain("scripts/budget");
  expect(script).toContain("echo mine\n");
  for (const name of f.legacy) expect(existsSync(join(f.ctx.home, ".claude", name))).toBe(false);
  expect(readFileSync(join(f.ctx.home, ".claude/rules/context7.md"), "utf8")).toBe("unrelated\n");
  expect(readFileSync(join(f.ctx.home, ".claude/rules/pacer.md"), "utf8")).toContain("pacer");
  expect(f.calls).toEqual([["/usr/bin/claude", "mcp", "remove", "-s", "user", "pacer"], ["/usr/bin/claude", "mcp", "add", "-s", "user", "pacer", "--", ...PACER, "mcp"]]);
});

test("Claude reinstall is byte-idempotent and uninstall after two installs restores original", async () => {
  const f = legacyHome(); const original = snapshot(f.ctx.home);
  await f.install(); const installed = snapshot(f.ctx.home);
  expect((await f.install()).touched).toEqual([]);
  expect(snapshot(f.ctx.home)).toEqual(installed);
  const report = await uninstallPlanner(f.ctx, "claude-code");
  expect(snapshot(f.ctx.home)).toEqual(original);
  expect(report!.notes).toEqual(["removed MCP server pacer (/usr/bin/claude mcp remove -s user pacer)"]);
  expect(f.calls.at(-1)).toEqual(["/usr/bin/claude", "mcp", "remove", "-s", "user", "pacer"]);
});

test("Claude reinstall replaces the previous status hook without adding a SessionStart entry", async () => {
  const f = legacyHome();
  const settings = JSON.parse(readFileSync(f.settings, "utf8"));
  settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: "/old/pacer status --hook claude-code" }] });
  writeFileSync(f.settings, JSON.stringify(settings, null, 2) + "\n");
  await f.install();
  const groups = JSON.parse(readFileSync(f.settings, "utf8")).hooks.SessionStart;
  expect(groups.filter((g: any) => g.hooks.some((h: any) => h.command.includes("pacer msg hook session")))).toHaveLength(1);
  expect(JSON.stringify(groups)).not.toContain("status --hook claude-code");
});

test("Claude moved binary replaces hooks and script block instead of duplicating", async () => {
  const f = legacyHome(); const original = snapshot(f.ctx.home);
  await f.install(); await f.install(["/new/pacer"]);
  const settings = readFileSync(f.settings, "utf8");
  expect(settings).not.toContain("/opt/pacer");
  expect(settings.match(/\/new\/pacer/g)).toHaveLength(4);
  const script = readFileSync(f.script, "utf8");
  expect(script).not.toContain("/opt/pacer");
  expect(script.match(/# >>> pacer >>>/g)).toHaveLength(1);
  expect(script).toContain("/new/pacer statusline");
  await uninstallPlanner(f.ctx, "claude-code");
  expect(snapshot(f.ctx.home)).toEqual(original);
});

test("Claude rewritten settings keep theme while restoring legacy hooks and retaining backup", async () => {
  const f = legacyHome(); await f.install();
  const settings = JSON.parse(readFileSync(f.settings, "utf8"));
  writeFileSync(f.settings, JSON.stringify({ ...settings, theme: "dark" }, null, 2) + "\n");
  const report = await uninstallPlanner(f.ctx, "claude-code");
  expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual({ ...f.original, theme: "dark" });
  expect(report!.reverted).toContain(f.settings);
  expect(report!.notes.join("\n")).toContain(".pacer-bak-");
});

test("fresh Claude home creates statusLine without CLI and round-trips", async () => {
  const ctx = fakeCtx({ which: () => null }); const original = snapshot(ctx.home);
  const result = await runInstall({ ctx, mcp: true, pacerArgv: PACER }, "claude-code", installClaude);
  const settings = JSON.parse(readFileSync(join(ctx.home, ".claude/settings.json"), "utf8"));
  expect(settings.statusLine).toEqual({ type: "command", command: "/opt/pacer/bin/pacer statusline" });
  expect(result.notes.join("\n")).toContain("claude CLI not found: register the MCP server yourself");
  await uninstallPlanner(ctx, "claude-code"); expect(snapshot(ctx.home)).toEqual(original);
});

test("Claude leaves npx statusline alone with a pipe-JSON note", async () => {
  const f = legacyHome(); writeFileSync(f.settings, JSON.stringify({ ...f.original, statusLine: { type: "command", command: "npx ccstatusline" } }));
  const script = readFileSync(f.script, "utf8");
  const result = await f.install();
  expect(JSON.parse(readFileSync(f.settings, "utf8")).statusLine.command).toBe("npx ccstatusline");
  expect(readFileSync(f.script, "utf8")).toBe(script);
  expect(result.notes.join("\n")).toContain("JSON");
  expect(result.notes.join("\n")).toContain("/opt/pacer/bin/pacer statusline");
});

test("unparseable Claude settings rolls back all changes and does not record manifest", async () => {
  const f = legacyHome(); writeFileSync(f.settings, "{ broken"); const original = snapshot(f.ctx.home);
  await expect(f.install()).rejects.toThrow("settings.json");
  expect(snapshot(f.ctx.home)).toEqual(original);
  expect(readManifest(f.ctx).planners["claude-code"]).toBeUndefined();
});

test("statusline script requires cat input and inserts before exit or appends", () => {
  expect(editStatuslineScript("echo mine\n", "pacer")).toBeNull();
  for (const text of ["input=$(cat)\necho mine\n\nexit 0\n", "input=$(cat)\necho mine\n"]) {
    const next = editStatuslineScript(text, "pacer")!;
    expect(next).toContain('printf \'%s\' "$input" | pacer statusline 2>/dev/null');
    expect(next).toContain("echo mine\n");
    if (text.includes("exit 0")) expect(next.indexOf("# <<< pacer <<<")).toBeLessThan(next.indexOf("exit 0"));
  }
});

test("resolveScript accepts existing absolute single tokens with home expansion", () => {
  const f = legacyHome();
  expect(resolveScript("~/.claude/statusline.sh", f.ctx.home)).toBe(f.script);
  expect(resolveScript("$HOME/.claude/statusline.sh", f.ctx.home)).toBe(f.script);
  expect(resolveScript(f.script, f.ctx.home)).toBe(f.script);
  expect(resolveScript("relative.sh", f.ctx.home)).toBeNull();
  expect(resolveScript(`${f.script} --arg`, f.ctx.home)).toBeNull();
  expect(resolveScript("/missing/script", f.ctx.home)).toBeNull();
});

test("edited statusline restores both legacy blocks at their anchors and preserves user edits", async () => {
  const f = legacyHome();
  const original = readFileSync(f.script, "utf8");
  await f.install();
  writeFileSync(f.script, readFileSync(f.script, "utf8") + "# user edit\n");
  await f.install(["/new/pacer"]);
  const report = await uninstallPlanner(f.ctx, "claude-code");
  expect(readFileSync(f.script, "utf8")).toBe(original + "# user edit\n");
  expect(report!.reverted).toContain(f.script);
});

test("edited statusline appends a legacy block and notes when its anchor disappeared", async () => {
  const f = legacyHome();
  await f.install();
  writeFileSync(f.script, readFileSync(f.script, "utf8").replace("input=$(cat)\n", "input=other\n"));
  const report = await uninstallPlanner(f.ctx, "claude-code");
  const text = readFileSync(f.script, "utf8");
  expect(text).toContain("# Persist Claude's rate-limit windows");
  expect(text).toContain("input=other\n");
  expect(text).toEndWith("# Persist Claude's rate-limit windows for ~/.claude/scripts/budget/budget-status\nif true; then\n  echo ~/.claude/state/budget/claude.json\nfi\n");
  expect(report!.notes.join("\n")).toContain("anchor");
});

test("realistic blank-separated statusline round-trips exactly after user edits", async () => {
  const f = legacyHome();
  const original = readFileSync(f.script, "utf8")
    .replace("#!/bin/sh\n", "#!/bin/sh\n# My statusline\n\n")
    .replace("input=$(cat)\n", "input=$(cat)\n\n")
    .replace("echo mine\n", '[ -n "$line3" ] && printf "%s\\n" "$line3"\n\n');
  writeFileSync(f.script, original);
  await f.install();
  writeFileSync(f.script, readFileSync(f.script, "utf8") + "# appended by user\n");
  await uninstallPlanner(f.ctx, "claude-code");
  expect(readFileSync(f.script, "utf8")).toBe(original + "# appended by user\n");
});

test("L4 restores at the pacer marker even when its preceding line changes", async () => {
  const f = legacyHome();
  const original = readFileSync(f.script, "utf8");
  await f.install();
  writeFileSync(f.script, readFileSync(f.script, "utf8").replace("echo mine\n", "echo edited\n"));
  await uninstallPlanner(f.ctx, "claude-code");
  expect(readFileSync(f.script, "utf8")).toBe(original.replace("echo mine\n", "echo edited\n"));
});

test("restore searches repeated anchors forward and retains block order", () => {
  expect(applyUndo("fi\nmiddle\nfi\nend\n", [{ kind: "block", style: "hash", restore: [
    { text: "first\n", anchor: "middle\n" },
    { text: "second\n", anchor: "fi\n" },
  ] }])).toBe("fi\nmiddle\nfirst\nfi\nsecond\nend\n");
});

test("L4 at end of file retains its blank separator after an earlier user edit", async () => {
  const f = legacyHome();
  const original = readFileSync(f.script, "utf8").replace("echo mine\n", "echo mine\n\n").replace("\nexit 0\n", "");
  writeFileSync(f.script, original);
  await f.install();
  writeFileSync(f.script, readFileSync(f.script, "utf8").replace("echo mine", "echo edited"));
  await uninstallPlanner(f.ctx, "claude-code");
  expect(readFileSync(f.script, "utf8")).toBe(original.replace("echo mine", "echo edited"));
});
