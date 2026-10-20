import { eligibility } from "./fixtures/eligibility";
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
    { kinds: ["tests"], executors: ["claude-code", "opencode#byteplus", "opencode#local"] },
    { default: ["codex", "opencode#byteplus", "opencode#meter", "cursor", "opencode#local"] },
  ],
}, "/x");

function st(id: string, verdict: Verdict, o: Partial<ProviderStatus> & { used?: number; pace?: number; hours?: number } = {}): ProviderStatus {
  const usage = id === "opencode#local" ? "unmetered" : id === "opencode#meter" ? "metered" : (id === "cursor" || id === "agy") ? "reactive" : "quota";
  const binding = o.used === undefined ? null : {
    name: "weekly", usedPct: o.used, resetsAt: 1, lengthS: 1, paced: true, verdict,
    pace: o.pace, delta: o.pace !== undefined ? o.used - o.pace : undefined, activeHoursLeft: o.hours,
  };
  return { eligibility: verdict === "EXHAUSTED" ? { ...eligibility("ineligible"), budget: "exhausted", reasons: [{ code: "budget_exhausted", evidenceIds: [] }] } : eligibility(verdict === "UNKNOWN" ? "uncertain" : "eligible"), id, usage, windows: binding ? [binding] : [], binding, verdict, installed: true, stale: false, ...o } as ProviderStatus;
}

const statuses = (): Record<string, ProviderStatus> => ({
  "claude-code": st("claude-code", "ON_PACE", { used: 10, pace: 10 }),
  codex: st("codex", "BEHIND", { used: 10, pace: 40 }),
  byteplus: st("opencode#byteplus", "AHEAD", { used: 60, pace: 40 }),
  meter: st("opencode#meter", "OK"),
  cursor: st("cursor", "OK"),
  local: st("opencode#local", "OK"),
});

test("executorsFor uses the kind rule, then default", () => {
  const s = strategy();
  expect(executorsFor("tests", s)).toEqual(["claude-code", "opencode#byteplus", "opencode#local"]);
  expect(executorsFor("debug", s)).toEqual(["codex", "opencode#byteplus", "opencode#meter", "cursor", "opencode#local"]);
  expect(executorsFor(null, s)).toEqual(["codex", "opencode#byteplus", "opencode#meter", "cursor", "opencode#local"]);
});

test("planner is never its own executor", () => {
  const r = rankExecutors("tests", strategy(), statuses());
  expect(r.ranked.map((e) => e.id)).not.toContain("claude-code");
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "claude-code", account: "claude-code", reason: "planner" }));
});

test("even: furthest behind pace first; EXPIRING gets a boost", () => {
  const s = statuses();
  expect(rankExecutors(null, strategy(), s).ranked.map((e) => e.id)).toEqual(["codex", "opencode#meter", "cursor", "opencode#local", "opencode#byteplus"]);
  s.byteplus = st("opencode#byteplus", "EXPIRING", { used: 17, pace: 86, hours: 9 });
  expect(rankExecutors(null, strategy(), s).ranked[0].id).toBe("opencode#byteplus");
});

test("exhausted, not installed and paid-overflow rules exclude with reasons", () => {
  const s = statuses();
  s.codex = st("codex", "EXHAUSTED", { used: 100, pace: 30 });
  s.cursor = { ...st("cursor", "OK"), installed: false };
  const r = rankExecutors(null, strategy(), s);
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "codex", account: "codex", reason: "Budget exhausted; paid execution is not allowed" }));
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "cursor", account: "cursor", reason: "not installed" }));
  s.codex.eligibility = { ...eligibility(), budget: "exhausted" };
  const paid = rankExecutors(null, strategy("even", { codex: { allow_paid: true } }), s);
  expect(paid.ranked.map((e) => e.id)).toContain("codex");
});

test("cheapest-first: unmetered, then flat subscriptions, then metered", () => {
  expect(rankExecutors(null, strategy("cheapest-first"), statuses()).ranked.map((e) => e.id))
    .toEqual(["opencode#local", "codex", "cursor", "opencode#byteplus", "opencode#meter"]);
});

test("burn-before-reset: most unused quota per remaining active hour first", () => {
  const s = statuses();
  s.codex = st("codex", "ON_PACE", { used: 50, pace: 50, hours: 50 });     // 50/50 = 1
  s.byteplus = st("opencode#byteplus", "ON_PACE", { used: 80, pace: 80, hours: 4 }); // 20/4  = 5
  expect(rankExecutors(null, strategy("burn-before-reset"), s).ranked[0].id).toBe("opencode#byteplus");
});

test("UNKNOWN providers stay usable but rank after known ones", () => {
  const s = statuses();
  s.codex = st("codex", "UNKNOWN");
  const ids = rankExecutors(null, strategy(), s).ranked.map((e) => e.id);
  expect(ids[ids.length - 1]).toBe("codex");
});

const priorityStrategy = (order?: string[]) => validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {}, codex: {}, cursor: {}, agy: {},
    byteplus: { via: "opencode", model: "coding-plan/x", usage: "quota", quota_source: "arkcli" },
    local: { via: "opencode", model: "lmstudio/q", usage: "unmetered" },
  },
  pacing: { policy: "priority", ...(order ? { order } : {}) },
  routing: [{ default: ["codex", "cursor", "agy", "opencode#byteplus", "opencode#local", "claude-code"] }],
}, "/x");

const priorityStatuses = (): Record<string, ProviderStatus> => Object.fromEntries(
  ["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local"].map((id) =>
    [id, st(id, id === "opencode#local" || id === "cursor" || id === "agy" ? "OK" : "ON_PACE")]),
);

test("priority: normal candidates follow executor preferences and exclude the planner", () => {
  const r = rankExecutors(null, priorityStrategy(), priorityStatuses());
  expect(r.ranked.map((e) => e.id)).toEqual(["codex", "cursor", "agy", "opencode#byteplus", "opencode#local"]);
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "claude-code", account: "claude-code", reason: "planner" }));
});

test("priority: exhausted providers are excluded", () => {
  const statuses = priorityStatuses();
  statuses.codex = st("codex", "EXHAUSTED");
  const r = rankExecutors(null, priorityStrategy(), statuses);
  expect(r.ranked.map((e) => e.id)).toEqual(["cursor", "agy", "opencode#byteplus", "opencode#local"]);
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "codex", account: "codex", reason: "Budget exhausted; paid execution is not allowed" }));
});

test("priority: EXPIRING goes first", () => {
  const statuses = priorityStatuses();
  statuses.byteplus = st("opencode#byteplus", "EXPIRING");
  expect(rankExecutors(null, priorityStrategy(), statuses).ranked.map((e) => e.id))
    .toEqual(["opencode#byteplus", "codex", "cursor", "agy", "opencode#local"]);
});

test("priority: AHEAD goes last", () => {
  const statuses = priorityStatuses();
  statuses.codex = st("codex", "AHEAD");
  expect(rankExecutors(null, priorityStrategy(), statuses).ranked.map((e) => e.id))
    .toEqual(["cursor", "agy", "opencode#byteplus", "opencode#local", "codex"]);
});

test("priority: uncertain candidates follow all eligible choices", () => {
  const statuses = priorityStatuses();
  statuses.cursor = st("cursor", "UNKNOWN");
  expect(rankExecutors(null, priorityStrategy(), statuses).ranked.map((e) => e.id))
    .toEqual(["codex", "agy", "opencode#byteplus", "opencode#local", "cursor"]);
});

test("priority: custom order expands opencode and appends remaining candidates", () => {
  expect(rankExecutors(null, priorityStrategy(["opencode", "codex"]), priorityStatuses()).ranked.map((e) => e.id))
    .toEqual(["opencode#byteplus", "opencode#local", "codex", "cursor", "agy"]);
});

test("priority: scores strictly decrease with position and preserve reasons", () => {
  const r = rankExecutors(null, priorityStrategy(), priorityStatuses());
  expect(r.ranked.map((e) => e.score)).toEqual([5, 4, 3, 2, 1]);
  expect(r.ranked[0].reason).toBe("on pace");
});

test("priority: uncertain providers retain their relative order after eligible choices", () => {
  const statuses = priorityStatuses();
  statuses.codex = st("codex", "UNKNOWN");
  statuses.cursor = st("cursor", "UNKNOWN");
  statuses.local = st("opencode#local", "UNKNOWN");
  expect(rankExecutors(null, priorityStrategy(), statuses).ranked.map((e) => e.id))
    .toEqual(["agy", "opencode#byteplus", "codex", "cursor", "opencode#local"]);
});

test("priority: guardrails preserve order within EXPIRING and AHEAD groups", () => {
  const statuses = priorityStatuses();
  statuses.codex = st("codex", "AHEAD");
  statuses.cursor = st("cursor", "EXPIRING");
  statuses.agy = st("agy", "AHEAD");
  statuses.byteplus = st("opencode#byteplus", "EXPIRING");
  expect(rankExecutors(null, priorityStrategy(), statuses).ranked.map((e) => e.id))
    .toEqual(["cursor", "opencode#byteplus", "opencode#local", "codex", "agy"]);
});

test("priority: overlapping preferences and duplicate routes place each candidate once", () => {
  const s = priorityStrategy(["opencode#local", "opencode", "opencode#local", "opencode", "codex"]);
  s.routing[0].executors.push("codex", "opencode#local");
  expect(rankExecutors(null, s, priorityStatuses()).ranked.map((e) => e.id))
    .toEqual(["opencode#local", "opencode#byteplus", "codex", "cursor", "agy"]);
});

test("priority: installation, configuration and paid-overflow exclusions are preserved", () => {
  const s = priorityStrategy();
  const statuses = priorityStatuses();
  statuses.codex = st("codex", "EXHAUSTED");
  s.accounts.codex.allowPaid = true;
  statuses.codex.eligibility = { ...eligibility(), budget: "exhausted" };
  statuses.cursor.installed = false;
  delete statuses.agy;
  s.routing[0].executors.push("missing");
  const r = rankExecutors(null, s, statuses);
  expect(r.ranked.map((e) => e.id)).toEqual(["codex", "opencode#byteplus", "opencode#local"]);
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "cursor", account: "cursor", reason: "not installed" }));
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "agy", account: "agy", reason: "not configured" }));
  expect(r.excluded).toContainEqual(expect.objectContaining({ id: "missing", reason: "not configured" }));
});
