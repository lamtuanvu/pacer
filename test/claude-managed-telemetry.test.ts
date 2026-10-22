import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureManagedClaudeStatusLine } from "../src/install/claude-managed-telemetry";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";

test("managed Claude account gains passive usage capture without losing settings", () => {
  const ctx = fakeCtx({which: () => "/opt/pacer/bin/pacer"});
  const folder = join(ctx.home, ".claude-work");
  mkdirSync(folder);
  const settings = join(folder, "settings.json");
  writeFileSync(settings, '{"theme":"dark"}\n');
  const account = validateStrategy({planner: "claude-code#work", accounts: {
    work: {kind: "claude", home: folder},
  }}, "test").accounts.work;

  expect(ensureManagedClaudeStatusLine(ctx, account)).toBe(true);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
    theme: "dark", statusLine: {type: "command", command: "/opt/pacer/bin/pacer statusline"},
  });
  expect(statSync(settings).mode & 0o777).toBe(0o600);
  expect(ensureManagedClaudeStatusLine(ctx, account)).toBe(false);
});

test("managed Claude account keeps a custom status line", () => {
  const ctx = fakeCtx({which: () => "/opt/pacer/bin/pacer"});
  const folder = join(ctx.home, ".claude-work");
  mkdirSync(folder);
  const settings = join(folder, "settings.json");
  const original = '{"statusLine":{"type":"command","command":"custom-line"}}\n';
  writeFileSync(settings, original);
  const account = validateStrategy({planner: "claude-code#work", accounts: {
    work: {kind: "claude", home: folder},
  }}, "test").accounts.work;

  expect(ensureManagedClaudeStatusLine(ctx, account)).toBe(false);
  expect(readFileSync(settings, "utf8")).toBe(original);
});

test("managed Claude account does not persist a temporary sandbox command", () => {
  const ctx = fakeCtx({which: () => null});
  const folder = join(ctx.home, ".claude-work");
  mkdirSync(folder);
  ctx.env.PACER_BIN = join(ctx.home, ".work", "live", "sandbox", "bin", "pacer");
  const account = validateStrategy({planner: "claude-code#work", accounts: {
    work: {kind: "claude", home: folder},
  }}, "test").accounts.work;

  expect(ensureManagedClaudeStatusLine(ctx, account)).toBe(false);
  expect(existsSync(join(folder, "settings.json"))).toBe(false);
});
