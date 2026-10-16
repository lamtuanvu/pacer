import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openInTerminal, type TerminalDeps } from "../src/terminal/open";
import * as config from "../src/core/config";
import { fakeCtx, realRun } from "./helpers";

function deps(overrides: Partial<TerminalDeps> = {}) {
  const calls: string[][] = [];
  return { calls, deps: { platform: "darwin", which: () => "/usr/bin/fake", orcaAvailable: async () => false, env: {}, run: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; }, ...overrides } as TerminalDeps };
}
test("macOS uses Terminal with a private quoted script", async () => {
  const ctx = fakeCtx(), d = deps();
  const result = await openInTerminal(ctx, { argv: ["codex", "login"], env: { CODEX_HOME: "/tmp/a b" }, title: "Sign in" }, d.deps);
  expect(result).toEqual({ opened: true, target: "terminal", command: "CODEX_HOME='/tmp/a b' codex login" });
  expect(d.calls[0]?.slice(0, 3)).toEqual(["open", "-a", "Terminal"]);
  const script = d.calls[0]![3]!;
  expect(readFileSync(script, "utf8")).toContain("CODEX_HOME='/tmp/a b' codex login");
  expect(statSync(script).mode & 0o777).toBe(0o700);
});
test("terminal.app is configured and read through config", async () => {
  const ctx = fakeCtx(), d = deps();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  expect(config.get(ctx).keys["terminal.app"].value).toBe("Terminal");
  await config.set(ctx, "terminal.app", "Ghostty");
  expect(config.get(ctx).keys["terminal.app"].value).toBe("Ghostty");
  await openInTerminal(ctx, { argv: ["codex", "login"], title: "Login" }, d.deps);
  expect(d.calls[0]?.slice(0, 3)).toEqual(["open", "-a", "Ghostty"]);
  await expect(config.set(ctx, "terminal.app", "unknown")).rejects.toThrow();
});
test("headless Linux returns the copyable command", async () => {
  const ctx = fakeCtx(), d = deps({ platform: "linux", which: () => null });
  expect(await openInTerminal(ctx, { argv: ["codex", "login"], title: "Login" }, d.deps)).toEqual({ opened: false, target: "none", command: "codex login" });
  expect(d.calls).toEqual([]);
});
test("auto tries Orca, then Linux terminal, then tmux", async () => {
  const ctx = fakeCtx(), d = deps({ platform: "linux", orcaAvailable: async () => true, env: { TMUX: "session" }, run: async argv => {
    d.calls.push(argv);
    if (argv[0] === "orca") return { code: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { id: "repo::path" } } }), stderr: "" };
    return { code: argv[0] === "tmux" ? 0 : 1, stdout: "", stderr: "" };
  } });
  expect((await openInTerminal(ctx, { argv: ["codex", "login"], title: "Login" }, d.deps)).target).toBe("tmux");
  expect(d.calls.map(c => c[0])).toEqual(["orca", "orca", "x-terminal-emulator", "tmux"]);
  expect(d.calls[1]).toContain("id:repo::path");
});
test("explicit Orca uses the supplied selector and confirms a terminal handle", async () => {
  const ctx = fakeCtx(), d = deps({ orcaAvailable: async () => true, run: async argv => {
    d.calls.push(argv); return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term:1" } } }), stderr: "" };
  } });
  expect((await openInTerminal(ctx, { argv: ["codex", "login"], title: "Login", target: "orca", worktree: "id:work" }, d.deps)).target).toBe("orca");
  expect(d.calls[0]).toContain("id:work");
});
test("scripts preserve literal arguments and environment values with quotes", async () => {
  const ctx = fakeCtx(), d = deps();
  const value = "a 'quoted' $(echo unsafe) value";
  await openInTerminal(ctx, { argv: ["sh", "-c", 'printf "%s\\n%s" "$CODEX_HOME" "$1"', "sh", value], env: { CODEX_HOME: value }, title: "Quotes" }, d.deps);
  const result = await realRun([d.calls[0]![3]!], 5000);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${value}\n${value}`);
});
test("opening a terminal removes scripts older than one hour", async () => {
  const ctx = fakeCtx(), d = deps();
  await openInTerminal(ctx, { argv: ["true"], title: "Old" }, d.deps);
  const old = d.calls[0]![3]!; utimesSync(old, new Date(0), new Date(0));
  await openInTerminal(ctx, { argv: ["true"], title: "New" }, d.deps);
  expect(existsSync(old)).toBe(false);
  expect(readdirSync(join(ctx.pacerHome, "terminal"))).toHaveLength(1);
});
