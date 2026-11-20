import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStrategy, type Strategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { buildAccounts, buildExecutors, buildPlanner } from "../src/api/read-model/capacity";
import { list as accountsList } from "../src/core/accounts";
import { check as limitsCheck } from "../src/core/limits";
import { renderHook } from "../src/render/hook";
import { markExhausted } from "../src/usage/reactive";
import { claudeCachePaths } from "../src/usage/claude";
import { writeUsageEntry } from "../src/usage/store";
import { accountEvidenceScope, recordExecutionEvidence } from "../src/core/evidence";
import { fakeCtx, withLoginIndicators, localTs } from "./helpers";
import { cleanupUsageFixtures } from "./usage-plugin-fixtures";
import type { Ctx, UsageState } from "../src/types";

afterEach(cleanupUsageFixtures);

// Cross-surface contract (ADR 0030 §6): for each fixture state, computeStatus's account and
// runner records, the snapshot rows, account.list, limits.check and the hook text quote the
// same figure, verdict, reset and freshness, and account and runner verdicts follow the
// account rule instead of contradicting each other.

const now = localTs(2026, 11, 20, 10, 0);
const PLANNER = "planner: claude-code\n";
const CURSOR = "planner: cursor\naccounts:\n  cursor: {kind: cursor}\nrunners:\n  cursor: {}\nrouting:\n  - default: [cursor]\n";
const CURSOR_UNMETERED = "planner: cursor\naccounts:\n  cursor: {kind: cursor, usage: unmetered}\nrunners:\n  cursor: {}\nrouting:\n  - default: [cursor]\n";
const CLAUDE = `${PLANNER}accounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\nrouting:\n  - default: [claude-code]\n`;
const EXT = "planner: opencode\naccounts:\n  claude: {kind: claude}\nhosts:\n  devbox: {ssh: devbox, accounts: {claude: {home: ~/claude-devbox}}}\nrunners:\n  claude-code: {}\n  claude-code@devbox: {host: devbox}\nrouting:\n  - default: [claude-code, claude-code@devbox]\n";
const PAIRED = "planner: claude-code\naccounts:\n  claude: {kind: claude}\nhosts:\n  devbox: {ssh: devbox, accounts: {claude: {home: ~/claude-devbox}}}\nrunners:\n  claude-code: {}\n  claude-code@devbox: {host: devbox}\nrouting:\n  - default: [claude-code, claude-code@devbox]\n";

function load(ctx: Ctx, text: string): Strategy {
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), text);
  return loadStrategy(ctx);
}

function claudeRateLimit(ctx: Ctx, account: Parameters<typeof claudeCachePaths>[1], body: Record<string, unknown>): void {
  const file = claudeCachePaths(ctx, account)[0]!;
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(body));
}

function claudeReading(capturedAt: number, weekly: number, fiveHour: number, reset: {weekly?: number; fiveHour?: number} = {}) {
  return {
    seven_day: {used_percentage: weekly, resets_at: reset.weekly ?? capturedAt + 3 * 86400},
    five_hour: {used_percentage: fiveHour, resets_at: reset.fiveHour ?? capturedAt + 2 * 3600},
    captured_at: capturedAt,
  };
}

/** Every surface quotes the same record. */
async function surfaces(ctx: Ctx, s: Strategy, account: string, planner?: string) {
  const st = await computeStatus(ctx, s, {profile: null});
  const record = st.accounts!.find(a => a.name === account)!.usageState!;
  const listRows = await accountsList(ctx);
  const listRow = listRows.find(a => a.name === account)!.usageState!;
  const limitsRows = await limitsCheck(ctx, s);
  const limitsRow = limitsRows.find(a => a.account === account)!;
  const quoted = (u: UsageState) => ({
    figure: u.figure, verdict: u.verdict, freshness: u.freshness,
    resetsAt: u.figure?.resetsAt ?? null, window: u.figure?.window ?? null,
    blockedRunners: u.blockedRunners, limit: u.limit,
  });
  // account.list and limits.check quote the same record fields.
  expect(quoted(listRow)).toEqual(quoted(record));
  expect({verdict: limitsRow.verdict, usedPct: limitsRow.usedPct, window: limitsRow.window, resetsAt: limitsRow.resetsAt, stale: limitsRow.stale})
    .toEqual({verdict: record.verdict, usedPct: record.figure?.usedPct ?? null, window: record.figure?.window ?? null,
      resetsAt: record.figure?.resetsAt ?? null, stale: record.freshness === "historical"});
  // Snapshot rows carry the record and derive their quoted fields from it.
  const summary = buildAccounts(st, s, ctx).find(a => a.name === account)!;
  expect(summary.usageState).toEqual(record);
  expect({verdict: summary.verdict, usedPct: summary.usedPct, window: summary.window, resetsAt: summary.resetsAt, stale: summary.stale})
    .toEqual({verdict: record.verdict, usedPct: record.figure?.usedPct ?? null, window: record.figure ? record.figure.window : null,
      resetsAt: record.figure?.resetsAt ?? null, stale: record.freshness === "historical"});
  const accountRunners = st.providers.filter(p => p.account === account);
  for (const provider of accountRunners) {
    const row = buildExecutors(st, s, [], ctx.now, ctx).find(r => r.id === provider.id)!;
    expect(row.usageState).toEqual(provider.usageState);
    expect(row.usedPct).toBe(provider.usageState!.figure?.usedPct ?? null);
    expect(row.stale).toBe(provider.usageState!.freshness === "historical");
    // A runner may be EXHAUSTED while the account is not only when the account lists it as
    // blocked; an account never keeps a measured verdict while all of its runners are blocked.
    if (provider.usageState!.verdict === "EXHAUSTED" && record.verdict !== "EXHAUSTED")
      expect(record.blockedRunners.some(b => b.runner === provider.id)).toBe(true);
    if (record.blockedRunners.length && accountRunners.every(p =>
      record.blockedRunners.some(b => b.runner === p.id && b.model === (s.runners[p.id]?.model ?? "default") && b.reason === "quota_failure")))
      expect(record.verdict).toBe("EXHAUSTED");
  }
  // The hook quotes the same figure and verdict in words.
  const text = renderHook(st, planner ?? s.planner.agent);
  if (record.figure) expect(text).toContain(`${record.figure.window} ${record.figure.usedPct.toFixed(0)}%`);
  return {st, record, text};
}

test("(a) a reactive account with an active limit mark is EXHAUSTED on every surface", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CURSOR);
  markExhausted(ctx, "cursor", now + 3600, {manual: true});
  const {record} = await surfaces(ctx, s, "cursor");
  expect(record.limit).toEqual({until: now + 3600, observedAt: now, manual: true});
  expect(record.figure).toEqual({usedPct: 100, window: "limit", lengthS: 21600, resetsAt: now + 3600});
  expect(record.verdict).toBe("EXHAUSTED");
  expect(record.freshness).toBe("fresh");
  expect(record.blockedRunners).toEqual([{runner: "cursor", model: "default", until: now + 3600, reason: "quota_failure"}]);
  const runner = (await computeStatus(ctx, s, {profile: null})).providers.find(p => p.id === "cursor")!.usageState!;
  expect(runner.verdict).toBe("EXHAUSTED");
  expect(runner.figure).toEqual(record.figure);
});

test("(b) a reactive account without a mark has no figure, not a zero", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CURSOR);
  const {record, text} = await surfaces(ctx, s, "cursor");
  expect(record.figure).toBeNull();
  expect(record.windows).toEqual([]);
  expect(record.limit).toBeNull();
  expect(record.observedAt).toBeNull();
  expect(record.freshness).toBe("unknown");
  expect(record.verdict).toBe("OK");
  expect(record.blockedRunners).toEqual([]);
  expect(record.error).toBeNull();
  expect(text).toContain("Eligible");
});

test("(c) a failed read over an older stored reading is historical for the account and the runner", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  const account = s.accounts.claude!;
  writeUsageEntry(ctx, accountEvidenceScope(account, s.hosts).identity, "claude-code", {
    source: "session-log", capturedAt: now - 3 * 3600, stale: false,
    availability: {state: "ready", reason: "usage_observed", validUntil: null},
    windows: [{name: "weekly", usedPct: 40, resetsAt: now + 3 * 86400, lengthS: 7 * 86400, paced: true}],
  });
  const {record} = await surfaces(ctx, s, "claude");
  expect(record.figure).toEqual({usedPct: 40, window: "weekly", lengthS: 7 * 86400, resetsAt: now + 3 * 86400});
  expect(record.freshness).toBe("historical");
  // The stored window is still inside its freshness cap, so the measured verdict stands;
  // the failed refresh shows as history and an uncertain fallback instead.
  expect(record.verdict).toBe("ON_PACE");
  expect(record.error?.message).toContain("no Claude rate-limit data");
  // The failed read is stamped with the time of the read, not the stored reading's capture.
  expect(record.error?.at).toBe(now);
  expect(record.eligibility.state).toBe("uncertain");
  expect(record.eligibility.reasons.map(r => r.code)).toContain("refresh_failed");
  const runner = (await computeStatus(ctx, s, {profile: null})).providers.find(p => p.id === "claude-code")!.usageState!;
  expect(runner.freshness).toBe("historical");
  expect(runner.eligibility.state).toBe("uncertain");
  expect(runner.eligibility.reasons.map(r => r.code)).toContain("refresh_failed");
  // The account and runner histories agree: same figure, same freshness.
  expect(runner.figure).toEqual(record.figure);
});

test("(d) a days-old quota reading keeps its age; a fresh execution fact does not pin it", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  const account = s.accounts.claude!;
  claudeRateLimit(ctx, account, claudeReading(now - 3 * 86400, 40, 20));
  await recordExecutionEvidence(ctx, accountEvidenceScope(account, s.hosts),
    {endedAt: now - 60, exitCode: 0, timedOut: false, classification: "success"});
  const {record, text} = await surfaces(ctx, s, "claude");
  // The binding budget fact is the days-old quota reading, so both records age it.
  expect(record.observedAt).toBe(now - 3 * 86400);
  expect(record.freshness).toBe("historical");
  expect(record.verdict).toBe("UNKNOWN");
  expect(record.eligibility.state).toBe("uncertain");
  const runner = (await computeStatus(ctx, s, {profile: null})).providers.find(p => p.id === "claude-code")!.usageState!;
  expect(runner.observedAt).toBe(now - 3 * 86400);
  expect(runner.freshness).toBe("historical");
  // Two days and more print as days in the hook.
  expect(text).toContain("observed 3d ago");
});

test("(e) a runner-scoped limit blocks one of two runners without exhausting the account", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, EXT);
  const scope = accountEvidenceScope(s.accounts.claude!, s.hosts);
  markExhausted(ctx, "claude", now + 3600, {scope: {...scope, runner: "claude-code", model: "default", host: "local"}});
  const {st, record} = await surfaces(ctx, s, "claude");
  const local = st.providers.find(p => p.id === "claude-code")!.usageState!;
  const remote = st.providers.find(p => p.id === "claude-code@devbox")!.usageState!;
  expect(local.limit).toEqual({until: now + 3600, observedAt: now, manual: false});
  expect(local.figure).toEqual({usedPct: 100, window: "limit", lengthS: 21600, resetsAt: now + 3600});
  expect(local.verdict).toBe("EXHAUSTED");
  // The other runner keeps its own record: no limit, no figure.
  expect(remote.limit).toBeNull();
  expect(remote.figure).toBeNull();
  expect(remote.verdict).toBe("UNKNOWN");
  expect(remote.freshness).toBe("historical");
  expect(remote.error?.message).toContain("no Claude rate-limit data");
  // The account lists the blocked runner but is not EXHAUSTED: not every runner is blocked.
  expect(record.blockedRunners).toEqual([{runner: "claude-code", model: "default", until: now + 3600, reason: "quota_failure"}]);
  expect(record.verdict).toBe("UNKNOWN");
  expect(record.limit).toBeNull();
});

test("(f) 5h and weekly windows keep their own freshness; the record quotes the binding window", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  const account = s.accounts.claude!;
  // The reading is 3h old: past the 2h cap of the 5h window, inside the 24h cap of the weekly one.
  claudeRateLimit(ctx, account, claudeReading(now - 3 * 3600, 40, 20));
  const {st, record, text} = await surfaces(ctx, s, "claude");
  const byName = Object.fromEntries(record.windows.map(w => [w.name, w]));
  expect(byName["5h"]).toMatchObject({usedPct: 20, stale: true, verdict: "UNKNOWN"});
  expect(byName.weekly).toMatchObject({usedPct: 40, stale: false});
  expect(byName.weekly.verdict).not.toBe("UNKNOWN");
  // The binding window is the live weekly one; the record is historical because a window is.
  expect(record.figure).toEqual({usedPct: 40, window: "weekly", lengthS: 7 * 86400, resetsAt: byName.weekly.resetsAt});
  expect(record.freshness).toBe("historical");
  const runner = st.providers.find(p => p.id === "claude-code")!.usageState!;
  expect(runner.figure).toEqual(record.figure);
  expect(runner.windows.find(w => w.name === "5h")).toMatchObject({stale: true});
  expect(text).toContain("weekly 40%");
  expect(text).toContain("[historical]");
  // The planner meter quotes the same binding window.
  const planner = buildPlanner(st);
  expect(planner).toMatchObject({usedPct: 40, window: "weekly", resetsAt: byName.weekly.resetsAt});
});

test("(g) an unmetered account reports UNMETERED on every surface", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CURSOR_UNMETERED);
  const {st, record} = await surfaces(ctx, s, "cursor");
  expect(record.verdict).toBe("UNMETERED");
  expect(record.figure).toBeNull();
  expect(record.windows).toEqual([]);
  expect(record.limit).toBeNull();
  expect(record.freshness).toBe("unknown");
  expect(record.observedAt).toBeNull();
  expect(record.spend).toBeNull();
  const runner = st.providers.find(p => p.id === "cursor")!.usageState!;
  expect(runner.verdict).toBe("UNMETERED");
  expect(runner.figure).toBeNull();
  expect(runner.observedAt).toBeNull();
  // An unmetered planner runner holds normal mode.
  expect(st.mode).toBe("normal");
});

test("(h) two limits: a record quotes the latest end and its rows quote the figure", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, PAIRED);
  const scope = accountEvidenceScope(s.accounts.claude!, s.hosts);
  const T1 = now + 3600, T2 = now + 7200;
  // An account-scope execution limit ends at T1; a later runner-scoped one ends at T2 > T1.
  await recordExecutionEvidence(ctx, scope, {endedAt: now, exitCode: 1, timedOut: false, classification: "quota", until: T1});
  await recordExecutionEvidence(ctx, {...scope, runner: "claude-code", model: "default", host: "local"},
    {endedAt: now, exitCode: 1, timedOut: false, classification: "quota", until: T2});
  const st = await computeStatus(ctx, s, {profile: null});
  const record = st.accounts!.find(a => a.name === "claude")!.usageState!;
  const local = st.providers.find(p => p.id === "claude-code")!.usageState!;
  // The runner record carries the latest end and quotes it; its binding window is only the older one.
  expect(local.limit!.until).toBe(T2);
  expect(local.figure).toEqual({usedPct: 100, window: "limit", lengthS: 21600, resetsAt: T2});
  // The account record quotes its own (account-scope) limit.
  expect(record.figure).toEqual({usedPct: 100, window: "limit", lengthS: 21600, resetsAt: T1});
  expect(record.limit!.until).toBe(T1);
  // account.list quotes the same account record fields (its blockedRunners may mask a
  // runner id that contains @, which the listing's privacy pass redacts).
  const listRow = (await accountsList(ctx)).find(a => a.name === "claude")!.usageState!;
  expect({figure: listRow.figure, verdict: listRow.verdict, freshness: listRow.freshness, limit: listRow.limit})
    .toEqual({figure: record.figure, verdict: record.verdict, freshness: record.freshness, limit: record.limit});
  const limitsRow = (await limitsCheck(ctx, s)).find(a => a.account === "claude")!;
  expect(limitsRow).toMatchObject({verdict: "EXHAUSTED", usedPct: 100, window: "limit", resetsAt: T1});
  // The snapshot's account row carries the record and quotes it.
  const summary = buildAccounts(st, s, ctx).find(a => a.name === "claude")!;
  expect(summary.usageState).toEqual(record);
  expect(summary).toMatchObject({verdict: "EXHAUSTED", usedPct: 100, window: "limit", resetsAt: T1});
  // Every planner-runner surface quotes T2 from the record, not its binding window.
  const row = buildExecutors(st, s, [], ctx.now, ctx).find(r => r.id === "claude-code")!;
  expect(row.usageState).toEqual(local);
  expect(row.usedPct).toBe(100);
  expect(buildPlanner(st)).toMatchObject({usedPct: 100, window: "limit", resetsAt: T2});
  expect(renderHook(st, "claude-code")).toContain("limit 100% EXHAUSTED");
});

test("mode follows the planner's runner record, not the account summary", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  const scope = accountEvidenceScope(s.accounts.claude!, s.hosts);
  markExhausted(ctx, "claude", now + 3600, {scope: {...scope, runner: "claude-code", model: "default", host: "local"}});
  const st = await computeStatus(ctx, s, {profile: null});
  expect(st.mode).toBe("emergency");
  expect(st.accounts!.find(a => a.name === "claude")!.verdict).toBe("EXHAUSTED");
});

test("an expired mark stops constraining records and eligibility", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CURSOR);
  markExhausted(ctx, "cursor", now - 3600, {manual: true});
  const {record} = await surfaces(ctx, s, "cursor");
  expect(record.limit).toBeNull();
  expect(record.verdict).toBe("OK");
  expect(record.blockedRunners).toEqual([]);
});

test("account.list and the snapshot never contradict on signed-in state", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  const st = await computeStatus(ctx, s, {profile: null});
  const rows = buildAccounts(st, s, ctx);
  const list = await accountsList(ctx);
  const signed = Object.fromEntries(rows.map(r => [r.name, r.signedIn]));
  // The same per-runner derivation feeds both: neither side reports a signed-out account the
  // other shows signed in. Planner-only accounts may still probe at account scope in
  // account.list, which the 2s snapshot build cannot afford, so true and null may differ there.
  for (const row of list) expect((row.signedIn ?? null) === false).toBe(signed[row.name] === false);
});

test("a stale reading downgrades account and runner eligibility the same way (D7)", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CLAUDE);
  claudeRateLimit(ctx, s.accounts.claude!, claudeReading(now - 3 * 86400, 40, 20));
  const st = await computeStatus(ctx, s, {profile: null});
  const record = st.accounts!.find(a => a.name === "claude")!.usageState!;
  const runner = st.providers.find(p => p.id === "claude-code")!.usageState!;
  expect(record.freshness).toBe("historical");
  expect(runner.freshness).toBe("historical");
  expect(record.eligibility.state).toBe(runner.eligibility.state);
  expect(record.eligibility.state).not.toBe("eligible");
});

test("marks written under an alias key match the runner like executorExclusion (D9)", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  const s = load(ctx, CURSOR);
  markExhausted(ctx, "cursor", now + 3600, {manual: true});
  const {executorExclusion} = await import("../src/executors/availability");
  expect(executorExclusion(ctx, s, "cursor")).toBe("exhausted");
  const {record} = await surfaces(ctx, s, "cursor");
  expect(record.verdict).toBe("EXHAUSTED");
});
