import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { RankedExecutor, ProviderStatus } from "../src/engine/rank";
import { balanceByLoad, utilization } from "../src/engine/balance";
import { slotLimit, type SlotUse } from "../src/engine/slots";
import type { Verdict } from "../src/types";

const strategy = (policy = "priority", pacingExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => validateStrategy({
  planner: "claude-code",
  accounts: {
    "claude-code": { kind: "claude" },
    codex: { kind: "codex" },
    tse: { kind: "endpoint", usage: "quota", quota_source: "arkcli" },
    meter: { kind: "endpoint", usage: "metered" },
    a: { kind: "endpoint", usage: "quota", quota_source: "arkcli" },
    b: { kind: "endpoint", usage: "quota", quota_source: "arkcli" },
  },
  runners: {
    codex: { max_tasks: 3 },
    "opencode#tse": { model: "go/t", max_tasks: 3 },
    "opencode#meter": { model: "go/m", max_tasks: 4 },
    "opencode#a": { model: "go/a", max_tasks: 3, ...(extra.runners as Record<string, Record<string, unknown>>)?.a },
    "opencode#b": { model: "go/b", max_tasks: 4, ...(extra.runners as Record<string, Record<string, unknown>>)?.b },
    ...(extra.runners as Record<string, Record<string, unknown>>),
  },
  pacing: { policy, balance: "least-loaded", ...pacingExtra },
  routing: [{ default: ["codex", "opencode#a", "opencode#b", "opencode#tse", "opencode#meter"] }],
}, "/x");

const rank = (id: string, o: Partial<RankedExecutor> = {}): RankedExecutor => ({ id, score: 0, verdict: "ON_PACE", reason: "on pace", ...o });

const status = (id: string, o: Partial<ProviderStatus> & { usageKind?: ProviderStatus["usage"] } = {}): ProviderStatus => ({
  id, usage: o.usageKind ?? "quota", windows: o.windows ?? [], binding: null, verdict: o.verdict ?? "ON_PACE",
  installed: true, stale: false, ...o,
} as ProviderStatus);

const byId = (entries: [string, Partial<ProviderStatus> & { usageKind?: ProviderStatus["usage"] }][]): Record<string, ProviderStatus> =>
  Object.fromEntries(entries.map(([id, o]) => [id, status(id, o)]));

const use = (used: Record<string, number>): SlotUse => ({ byExecutor: used, byHost: {}, local: 0 });

test("off returns the same order without touching the input", () => {
  const s = strategy("priority", { balance: "off" });
  const list = [rank("opencode#tse"), rank("codex")];
  expect(balanceByLoad(list, s, use({ codex: 2 }), byId([["codex", {}], ["opencode#tse", {}]]))).toEqual(list);
  expect(list.map((e) => e.id)).toEqual(["opencode#tse", "codex"]);
});

test("least-loaded alternates equal-capacity executors", () => {
  const s = strategy();
  const list = [rank("codex"), rank("opencode#tse")];
  expect(balanceByLoad(list, s, use({ codex: 1 }), byId([["codex", {}], ["opencode#tse", {}]])).map((e) => e.id))
    .toEqual(["opencode#tse", "codex"]);
  expect(list.map((e) => e.id)).toEqual(["codex", "opencode#tse"]);
});

test("ties keep the policy order", () => {
  const s = strategy();
  const list = [rank("codex"), rank("opencode#tse")];
  expect(balanceByLoad(list, s, use({}), byId([["codex", {}], ["opencode#tse", {}]])).map((e) => e.id))
    .toEqual(["codex", "opencode#tse"]);
});

test("each executor's own max_tasks decides", () => {
  const s = strategy();
  const list = [rank("opencode#a"), rank("opencode#b")];
  // a: 1/3 = 0.33 runs ahead of b: 2/4 = 0.5.
  expect(balanceByLoad(list, s, use({ "opencode#a": 1, "opencode#b": 2 }), byId([["opencode#a", {}], ["opencode#b", {}]])).map((e) => e.id))
    .toEqual(["opencode#a", "opencode#b"]);
});

test("bands never mix: verdict tiers, near-limit band and uncertain last", () => {
  const s = strategy();
  // EXPIRING stays ahead of an emptier ON_PACE.
  const fear = [rank("codex", { verdict: "EXPIRING" as Verdict }), rank("opencode#tse")];
  expect(balanceByLoad(fear, s, use({ codex: 2 }), byId([["codex", {}], ["opencode#tse", {}]])).map((e) => e.id))
    .toEqual(["codex", "opencode#tse"]);
  // NEAR_LIMIT gets its own band behind the normal one.
  const near = [rank("opencode#a"), rank("opencode#b", { verdict: "NEAR_LIMIT" as Verdict })];
  expect(balanceByLoad(near, s, use({ "opencode#a": 3 }), byId([["opencode#a", {}], ["opencode#b", {}]])).map((e) => e.id))
    .toEqual(["opencode#a", "opencode#b"]);
  // AHEAD stays behind an emptier normal band.
  const ahead = [rank("opencode#a"), rank("opencode#b", { verdict: "AHEAD" as Verdict })];
  expect(balanceByLoad(ahead, s, use({ "opencode#a": 3 }), byId([["opencode#a", {}], ["opencode#b", {}]])).map((e) => e.id))
    .toEqual(["opencode#a", "opencode#b"]);
  // An uncertain fallback never swaps with a certain candidate, even an emptier one.
  const uncertain = [rank("opencode#a", { verdict: "UNKNOWN" as Verdict }), rank("opencode#tse", { fallback: "uncertain" })];
  expect(balanceByLoad(uncertain, s, use({ "opencode#a": 1 }), byId([["opencode#a", {}], ["opencode#tse", {}]])).map((e) => e.id))
    .toEqual(["opencode#a", "opencode#tse"]);
});

test("cheapest-first keeps metered behind quota even when empty", () => {
  const s = strategy("cheapest-first");
  const list = [rank("opencode#a"), rank("opencode#meter")];
  const statuses = byId([["opencode#a", {}], ["opencode#meter", { usageKind: "metered" as const }]]);
  expect(balanceByLoad(list, s, use({ "opencode#a": 3 }), statuses).map((e) => e.id)).toEqual(["opencode#a", "opencode#meter"]);
});

test("priority mixes metered and subscription", () => {
  const s = strategy("priority");
  const list = [rank("codex"), rank("opencode#meter")];
  const statuses = byId([["codex", {}], ["opencode#meter", { usageKind: "metered" as const }]]);
  expect(balanceByLoad(list, s, use({ codex: 2 }), statuses).map((e) => e.id)).toEqual(["opencode#meter", "codex"]);
});

test("fill keeps an unyielded account ahead", () => {
  const s = strategy("priority", { accounts: "fill" });
  const list = [rank("opencode#b"), rank("opencode#a")];
  const statuses = byId([
    ["opencode#b", {}],
    ["opencode#a", { windows: [{ name: "weekly", usedPct: 95, resetsAt: 0, lengthS: 1, paced: true, verdict: "ON_PACE" as Verdict }] }],
  ]);
  // b (1/4) is unyielded and stays ahead of a (yielded, 0/3); without the yield band a would pass b.
  expect(balanceByLoad(list, s, use({ "opencode#b": 1 }), statuses).map((e) => e.id)).toEqual(["opencode#b", "opencode#a"]);
});

test("missing max_tasks uses limit 1 and never divides by zero", () => {
  // The undefined-model endpoint account resolves as a runner declaration; no max_tasks means limit 1.
  const s = validateStrategy({
    planner: "claude-code",
    accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" }, meter: { kind: "endpoint", usage: "metered" } },
    runners: { "opencode#meter": { model: "go/m" } },
    pacing: { policy: "priority", balance: "least-loaded" },
    routing: [{ default: ["codex", "opencode#meter"] }],
  }, "/x");
  expect(slotLimit(s, "opencode#meter").executor).toBe(1);
  expect(utilization(s, "opencode#meter", use({}))).toBe(0);
  expect(Number.isFinite(utilization(s, "opencode#meter", use({})))).toBe(true);
  // codex 0/3 and the uncapped 0/1 tie at 0; the policy order decides, no NaN reorders.
  const list = [rank("codex"), rank("opencode#meter")];
  expect(balanceByLoad(list, s, use({}), byId([["codex", {}], ["opencode#meter", { usageKind: "metered" as const }]])).map((e) => e.id))
    .toEqual(["codex", "opencode#meter"]);
});

test("reason carries the load note in bands of two or more", () => {
  const s = strategy();
  const list = [rank("codex"), rank("opencode#tse")];
  const out = balanceByLoad(list, s, use({ codex: 1 }), byId([["codex", {}], ["opencode#tse", {}]]));
  expect(out[0].reason.endsWith("· load 0/3")).toBe(true);
  expect(out[1].reason.endsWith("· load 1/3")).toBe(true);
  // A band of one keeps its reason untouched.
  const one = balanceByLoad([rank("codex")], s, use({ codex: 1 }), byId([["codex", {}]]));
  expect(one[0].reason).toBe("on pace");
});
