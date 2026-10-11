import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { executorsFor, rankExecutors, type ProviderStatus } from "../src/engine/rank";
import type { Verdict } from "../src/types";

const strategy = (policy = "even", extra: Record<string, unknown> = {}) => validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {}, codex: {}, cursor: {},
    byteplus: { via: "opencode", model: "coding-plan/x", usage: "quota", quota_source: "arkcli" },
    meter: { via: "opencode", model: "go/y", usage: "metered", budget: { weekly_tokens: 1000 } },
    local: { via: "opencode", model: "lmstudio/q", usage: "unmetered" },
    ...extra,
  },
  pacing: { policy },
  routing: [
    { kinds: ["tests"], executors: ["claude-code", "byteplus", "local"] },
    { default: ["codex", "byteplus", "meter", "cursor", "local"] },
  ],
}, "/x");

function st(id: string, verdict: Verdict, o: Partial<ProviderStatus> & { used?: number; pace?: number; hours?: number } = {}): ProviderStatus {
  const usage = id === "local" ? "unmetered" : id === "meter" ? "metered" : id === "cursor" ? "reactive" : "quota";
  const binding = o.used === undefined ? null : {
    name: "weekly", usedPct: o.used, resetsAt: 1, lengthS: 1, paced: true, verdict,
    pace: o.pace, delta: o.pace !== undefined ? o.used - o.pace : undefined, activeHoursLeft: o.hours,
  };
  return { id, usage, windows: binding ? [binding] : [], binding, verdict, installed: true, stale: false, ...o } as ProviderStatus;
}

const statuses = (): Record<string, ProviderStatus> => ({
  "claude-code": st("claude-code", "ON_PACE", { used: 10, pace: 10 }),
  codex: st("codex", "BEHIND", { used: 10, pace: 40 }),
  byteplus: st("byteplus", "AHEAD", { used: 60, pace: 40 }),
  meter: st("meter", "OK"),
  cursor: st("cursor", "OK"),
  local: st("local", "OK"),
});

test("executorsFor uses the kind rule, then default", () => {
  const s = strategy();
  expect(executorsFor("tests", s)).toEqual(["claude-code", "byteplus", "local"]);
  expect(executorsFor("debug", s)).toEqual(["codex", "byteplus", "meter", "cursor", "local"]);
  expect(executorsFor(null, s)).toEqual(["codex", "byteplus", "meter", "cursor", "local"]);
});

test("planner is never its own executor", () => {
  const r = rankExecutors("tests", strategy(), statuses());
  expect(r.ranked.map((e) => e.id)).not.toContain("claude-code");
  expect(r.excluded).toContainEqual({ id: "claude-code", reason: "planner" });
});

test("even: furthest behind pace first; EXPIRING gets a boost", () => {
  const s = statuses();
  expect(rankExecutors(null, strategy(), s).ranked.map((e) => e.id)).toEqual(["codex", "meter", "cursor", "local", "byteplus"]);
  s.byteplus = st("byteplus", "EXPIRING", { used: 17, pace: 86, hours: 9 });
  expect(rankExecutors(null, strategy(), s).ranked[0].id).toBe("byteplus");
});

test("exhausted, not installed and paid-overflow rules exclude with reasons", () => {
  const s = statuses();
  s.codex = st("codex", "EXHAUSTED", { used: 100, pace: 30 });
  s.cursor = { ...st("cursor", "OK"), installed: false };
  const r = rankExecutors(null, strategy(), s);
  expect(r.excluded).toContainEqual({ id: "codex", reason: "exhausted" });
  expect(r.excluded).toContainEqual({ id: "cursor", reason: "not installed" });
  const paid = rankExecutors(null, strategy("even", { codex: { allow_paid: true } }), s);
  expect(paid.ranked.map((e) => e.id)).toContain("codex");
});

test("cheapest-first: unmetered, then flat subscriptions, then metered", () => {
  expect(rankExecutors(null, strategy("cheapest-first"), statuses()).ranked.map((e) => e.id))
    .toEqual(["local", "codex", "cursor", "byteplus", "meter"]);
});

test("burn-before-reset: most unused quota per remaining active hour first", () => {
  const s = statuses();
  s.codex = st("codex", "ON_PACE", { used: 50, pace: 50, hours: 50 });     // 50/50 = 1
  s.byteplus = st("byteplus", "ON_PACE", { used: 80, pace: 80, hours: 4 }); // 20/4  = 5
  expect(rankExecutors(null, strategy("burn-before-reset"), s).ranked[0].id).toBe("byteplus");
});

test("UNKNOWN providers stay usable but rank after known ones", () => {
  const s = statuses();
  s.codex = st("codex", "UNKNOWN");
  const ids = rankExecutors(null, strategy(), s).ranked.map((e) => e.id);
  expect(ids[ids.length - 1]).toBe("codex");
});
