import { accountEvidenceScope } from "../src/evidence/scope";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { list, signin } from "../src/core/accounts";
import { loadStrategy } from "../src/config/strategy";
import { readAccountUsage } from "../src/usage";
import * as codex from "../src/usage/codex";
import * as codexLive from "../src/usage/codex-live";
import { markAuthFailed, readAuthFailures } from "../src/usage/auth";
import { fakeCtx } from "./helpers";

function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `accounts:\n  personal: {kind: claude}\n  codex: {kind: codex, home: "${join(ctx.home, "codex team's home")}"}\n  api: {kind: endpoint, usage: unmetered}\nplanner: claude-code\nrouting:\n  - default: [codex#codex]\npacing: {order: [codex#codex], policy: priority}\n`);
  return ctx;
}

afterEach(() => { mock.restore(); });

test("a Codex usage authentication failure signs out the account until a successful read", async () => {
  const ctx = configured();
  // Signed in per the login indicator, logged in before the failure below.
  const home = join(ctx.home, "codex team's home");
  mkdirSync(home, {recursive: true}); writeFileSync(join(home, "auth.json"), "{}");
  utimesSync(join(home, "auth.json"), ctx.now - 3600, ctx.now - 3600);
  const read = spyOn(codex, "readCodex").mockResolvedValue({windows: [], capturedAt: null, stale: false, error: "401 Unauthorized"});
  expect((await list(ctx)).find(a => a.name === "codex")?.signedIn).toBe(false);
  expect(readAuthFailures(ctx)).toEqual({codex: ctx.now});
  read.mockResolvedValue({windows: [], capturedAt: ctx.now + 61, stale: false, source: "session-log"});
  ctx.now += 61;
  expect((await list(ctx)).find(a => a.name === "codex")?.signedIn).toBe(true);
  expect(readAuthFailures(ctx)).toEqual({});
});

test("auth patterns are case insensitive and unrelated usage failures preserve the mark", async () => {
  const ctx = configured();
  for (const message of ["NOT LOGGED IN", "Please Log In", "HTTP 401", "Unauthorized", "Authentication failed"]) {
    markAuthFailed(ctx, "codex", message);
    expect(readAuthFailures(ctx).codex).toBe(ctx.now);
  }
  spyOn(codex, "readCodex").mockResolvedValue({windows: [], capturedAt: null, stale: false, error: "network unavailable"});
  await readAccountUsage(ctx, loadStrategy(ctx).accounts.codex, []);
  expect(readAuthFailures(ctx).codex).toBe(ctx.now);
  markAuthFailed(ctx, "personal", "network unavailable");
  expect(readAuthFailures(ctx).personal).toBeUndefined();
});

test("account rows expose executor ids and removal locks, with the planner taking priority", async () => {
  const rows = await list(configured());
  expect(rows.find(a => a.name === "personal")).toMatchObject({locked: "Planner — can't remove"});
  expect(rows.find(a => a.name === "codex")).toMatchObject({locked: "In use by 1 executor(s)", executors: ["codex#codex"]});
  expect(rows.find(a => a.name === "api")).toMatchObject({executors: []});
  expect(rows.find(a => a.name === "api")?.locked).toBeUndefined();
});

test("signin opens Codex login with its quoted account home through the terminal opener", async () => {
  const ctx = configured();
  ctx.env.TERM_PROGRAM = "Apple_Terminal";
  const calls: string[][] = [];
  const result = await signin(ctx, "codex", {target: "terminal"}, {
    platform: "darwin", which: () => "/bin/open", env: {}, orcaAvailable: async () => false,
    run: async argv => { calls.push(argv); return {code: 0, stdout: "", stderr: ""}; },
  });
  expect(result).toMatchObject({opened: true, target: "terminal"});
  expect(calls[0].slice(0, 3)).toEqual(["open", "-a", "Terminal"]);
  const script = readFileSync(calls[0][3], "utf8");
  expect(script).toContain("CODEX_HOME=");
  expect(script).toContain("codex login");
  const bin = join(ctx.home, "fixture-bin"), receipt = join(ctx.home, "login-argv");
  mkdirSync(bin, {mode: 0o700});
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$CODEX_HOME" "$@" > "$PACER_TEST_LOGIN"\n`, {mode: 0o700});
  const child = Bun.spawn(["/bin/sh", calls[0][3]], {
    env: {PATH: `${bin}:/usr/bin:/bin`, PACER_TEST_LOGIN: receipt}, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(readFileSync(receipt, "utf8").trim().split("\n")).toEqual([join(ctx.home, "codex team's home"), "login"]);
  expect(result.command).toContain("codex login");
});

test("account.signin supports headless fallback, validates targets and refuses endpoint accounts", async () => {
  const ctx = configured();
  const terminal = {platform: "linux" as const, which: () => null, env: {}, orcaAvailable: async () => false};
  expect(await callOp(ctx, "account.signin", {name: "personal"}, {terminal})).toMatchObject({opened: false, target: "none", command: expect.stringContaining("CLAUDE_CONFIG_DIR=")});
  await expect(callOp(ctx, "account.signin", {name: "api"}, {terminal})).rejects.toMatchObject({code: "not_allowed"});
  await expect(callOp(ctx, "account.signin", {name: "missing"}, {terminal})).rejects.toMatchObject({code: "invalid_input"});
  await expect(callOp(ctx, "account.signin", {name: "codex", target: "bad"}, {terminal})).rejects.toMatchObject({code: "invalid_input"});
});

test("a cached successful reading cannot erase a newer attempt's auth failure", async () => {
  const ctx = configured();
  const read = spyOn(codex, "readCodex").mockResolvedValue({windows: [], capturedAt: ctx.now, stale: false});
  const live = spyOn(codexLive, "readCodexLive").mockResolvedValue({windows: [], capturedAt: ctx.now, stale: false});
  const account = loadStrategy(ctx).accounts.codex;
  await readAccountUsage(ctx, account, []);
  ctx.now += 1;
  markAuthFailed(ctx, "codex", "please log in", {scope:accountEvidenceScope(account)});
  expect((await list(ctx)).find(a => a.name === "codex")?.signedIn).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  await readAccountUsage(ctx, account, [], true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(live).toHaveBeenCalledTimes(1);
  expect(readAuthFailures(ctx).codex).toBe(ctx.now);
  ctx.now += 1; live.mockResolvedValue({windows: [], capturedAt: ctx.now, stale: false});
  await readAccountUsage(ctx, account, [], true);
  expect(readAuthFailures(ctx)).toEqual({});
});
