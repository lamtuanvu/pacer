import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { readAccountUsage, usageRefreshCapability } from "../src/usage";
import type { AccountCfg } from "../src/config/accounts";
import * as codex from "../src/usage/codex";
import * as codexLive from "../src/usage/codex-live";
import { fakeCtx } from "./helpers";

test("idle Codex refresh reads account limits through its CLI without a turn", async () => {
  const calls: { argv: string[]; stdin?: string; env?: Record<string, string | undefined> }[] = [];
  const ctx = fakeCtx({ now: 1_800_000_000, run: async (argv, _timeout, options) => {
    calls.push({ argv, stdin: options?.stdin, env: options?.env });
    return { code: 0, stderr: "", stdout: [
      JSON.stringify({ id: 1, result: { userAgent: "codex" } }),
      JSON.stringify({ id: 2, result: { rateLimits: {
        primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: ctx.now + 3600 },
        secondary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: ctx.now + 86400 },
      } } }),
    ].join("\n") + "\n" };
  } });
  const home = join(ctx.home, "work-codex");
  const strategy = validateStrategy({ planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, work: { kind: "codex", home } }, routing: [{ default: ["codex#work"] }] }, "/strategy");
  const reading = await readAccountUsage(ctx, strategy.accounts.work, [], true);
  expect(reading.windows.map(w => [w.name, w.usedPct])).toEqual([["5h", 24], ["weekly", 62]]);
  expect(reading.capturedAt).toBe(ctx.now);
  expect(calls).toHaveLength(1);
  expect(calls[0].argv).toContain("app-server");
  expect(calls[0].stdin).toContain("account/rateLimits/read");
  expect(calls[0].env?.CODEX_HOME).toBe(home);
  expect(usageRefreshCapability(strategy.accounts.work)).toBe("provider-command");
});

test("idle Claude refresh remains passive and does not spawn an agent", async () => {
  let calls = 0;
  const ctx = fakeCtx({ run: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; } });
  const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "/strategy");
  const reading = await readAccountUsage(ctx, strategy.accounts["claude-code"], [], true);
  expect(reading.capturedAt).toBeNull();
  expect(calls).toBe(0);
  expect(usageRefreshCapability(strategy.accounts["claude-code"])).toBe("passive-log");
});

test("active refresh waits for a passive read, then makes its own provider request", async () => {
  let finishFirst!: (value: { code: number; stdout: string; stderr: string }) => void;
  const first = new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { finishFirst = resolve; });
  let calls = 0;
  const response = { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
  const ctx = fakeCtx({ readOnly: true, run: async () => ++calls === 1 ? first : response });
  const account = { name: "plan", kind: "endpoint", usage: "quota", quotaSource: "arkcli" } as AccountCfg;
  const passive = readAccountUsage(ctx, account, []);
  await Promise.resolve();
  const active = readAccountUsage(ctx, account, [], true);
  finishFirst(response);
  await Promise.all([passive, active]);
  expect(calls).toBe(2);
});

test("an older passive Codex log cannot replace a newer provider reading after cache expiry", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  const account = { name: "work", kind: "codex", usage: "quota" } as AccountCfg;
  const live = spyOn(codexLive, "readCodexLive").mockResolvedValue({
    windows: [{ name: "weekly", usedPct: 40, resetsAt: null, lengthS: 604800, paced: true }],
    capturedAt: ctx.now, stale: false, source: "provider-cli",
  });
  const logs = spyOn(codex, "readCodex").mockResolvedValue({
    windows: [{ name: "weekly", usedPct: 20, resetsAt: null, lengthS: 604800, paced: true }],
    capturedAt: ctx.now - 300, stale: false, source: "session-log",
  });
  try {
    await readAccountUsage(ctx, account, [], true);
    ctx.now += 61;
    const later = await readAccountUsage(ctx, account, []);
    expect(later.windows[0]?.usedPct).toBe(40);
    expect(later.source).toBe("provider-cli");
    expect(logs).toHaveBeenCalledTimes(1);
    logs.mockResolvedValue({ windows: [{ name: "weekly", usedPct: 10, resetsAt: null, lengthS: 604800, paced: true }], capturedAt: null, stale: false, source: "session-log" });
    ctx.now += 61;
    expect((await readAccountUsage(ctx, account, [])).windows[0]?.usedPct).toBe(40);
  } finally { live.mockRestore(); logs.mockRestore(); }
});
