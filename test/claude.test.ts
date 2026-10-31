import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeCachePaths, readClaude, captureClaudeStreamUsage, captureClaudeStreamUsageFile, claudeResultFromStream } from "../src/usage/claude";
import { validateStrategy } from "../src/config/strategy";


const SAMPLE = {
  five_hour: { used_percentage: 2, resets_at: 1791643200 },
  seven_day: { used_percentage: 4, resets_at: "2026-10-17T05:00:00Z" },
  captured_at: 1791633891.03,
};

test("Claude stream quota events populate only the selected account without credentials", async () => {
  const ctx = fakeCtx();
  const account = validateStrategy({planner: "claude-code", accounts: {
    main: {kind: "claude"}, work: {kind: "claude", home: "~/.claude-work"},
  }}, "test").accounts.work;
  const stream = ["broken JSON", JSON.stringify({type: "rate_limit_event", session_id: "private-session", rate_limit_info: {
    status: "allowed_warning", unifiedWindows: {
      seven_day: {utilization: 0.94, resetsAt: ctx.now + 86400},
      five_hour: {utilization: 0, resetsAt: ctx.now + 3600},
    },
  }})].join("\n");
  expect(captureClaudeStreamUsage(ctx, account, stream)).toBe(true);
  const reading = await readClaude(ctx, account);
  expect(reading.windows.map(w => w.usedPct)).toEqual([94, 0]);
  expect(reading.capturedAt).toBe(ctx.now);
  expect(statSync(claudeCachePaths(ctx, account)[0]).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(claudeCachePaths(ctx, account)[0])).mode & 0o777).toBe(0o700);
  expect((await readClaude(ctx)).capturedAt).toBeNull();
  expect(await Bun.file(claudeCachePaths(ctx, account)[0]).text()).not.toContain("private-session");
  expect(captureClaudeStreamUsage(ctx, account, JSON.stringify({type: "rate_limit_event", rate_limit_info: {
    unifiedWindows: {seven_day: {utilization: 42}},
  }}))).toBe(false);
  expect((await readClaude(ctx, account)).windows[0].usedPct).toBe(94);
  expect(captureClaudeStreamUsage(ctx, account, JSON.stringify({type: "rate_limit_event", rate_limit_info: {
    rateLimitType: "seven_day", utilization: 0.01,
  }}))).toBe(false);
  expect((await readClaude(ctx, account)).windows.map(w => w.usedPct)).toEqual([94, 0]);
});

test("completed Claude stream refreshes the named account and keeps the readable result", async () => {
  const ctx = fakeCtx();
  const account = validateStrategy({planner: "claude-code", accounts: {
    main: {kind: "claude"}, work: {kind: "claude", home: "~/.claude-work"},
  }}, "test").accounts.work;
  const path = join(ctx.home, "stdout");
  writeFileSync(path, [
    JSON.stringify({type: "assistant", message: {content: [{type: "text", text: "intermediate"}]}}),
    JSON.stringify({type: "rate_limit_event", rate_limit_info: {unifiedWindows: {
      seven_day: {utilization: 0.57, resetsAt: ctx.now + 86400},
      five_hour: {utilization: 0.12, resetsAt: ctx.now + 3600},
    }}}),
    JSON.stringify({type: "result", result: "Finished the task"}),
  ].join("\n"));
  expect(await captureClaudeStreamUsageFile(ctx, account, path)).toBe(true);
  expect((await readClaude(ctx, account)).windows.map(w => w.usedPct)).toEqual([57, 12]);
  expect((await readClaude(ctx)).capturedAt).toBeNull();
  expect(claudeResultFromStream(await Bun.file(path).text())).toBe("Finished the task");
});

async function put(path: string, data: unknown, mtime: number) {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data));
  utimesSync(path, mtime, mtime);
}

test("reads weekly (paced) and 5h (unpaced) windows", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await put(claudeCachePaths(ctx)[0], SAMPLE, 1791633891);
  const r = await readClaude(ctx);
  expect(r.error).toBeUndefined();
  expect(r.source).toBe("status-line");
  expect(r.stale).toBe(false);
  expect(r.capturedAt).toBeCloseTo(1791633891.03);
  expect(r.windows).toEqual([
    { name: "weekly", usedPct: 4, resetsAt: Date.parse("2026-10-17T05:00:00Z") / 1000, lengthS: 604800, paced: true },
    { name: "5h", usedPct: 2, resetsAt: 1791643200, lengthS: 18000, paced: false },
  ]);
});

test("prefers the newer of the pacer cache and the legacy budget file", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  const [pacerPath, legacyPath] = claudeCachePaths(ctx);
  expect(legacyPath).toBe(join(ctx.home, ".claude", "state", "budget", "claude.json"));
  await put(pacerPath, { ...SAMPLE, captured_at: 1000, seven_day: { used_percentage: 10, resets_at: 1792213200 } }, 3000);
  await put(legacyPath, { ...SAMPLE, captured_at: 2000, seven_day: { used_percentage: 20, resets_at: 1792213200 } }, 2000);
  expect((await readClaude(ctx)).windows[0].usedPct).toBe(20);
});

test("missing data is an error reading; freshness of old data is left to the engine", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  const none = await readClaude(ctx);
  expect(none.windows).toEqual([]);
  expect(none.error).toContain("no Claude rate-limit data");
  await put(claudeCachePaths(ctx)[0], { ...SAMPLE, captured_at: 1791640000 - 90000 }, 1);
  expect((await readClaude(ctx)).stale).toBe(false);
});
