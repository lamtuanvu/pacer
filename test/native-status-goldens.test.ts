import { afterAll } from "bun:test";
import { cleanupTestTmp, fakeCtx } from "./helpers";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AccountEvidence, Evidence, EvidenceScope } from "../src/evidence/types";
import type { Ctx, UsageKind, UsageReading, UsageSource, UsageWindow } from "../src/types";
import { markFreshness } from "../src/usage/freshness";
import { emptyEvidence, evidenceFact, readingEvidence, reconcileEvidence } from "../src/engine/evidence";
import { writeUsageEntry } from "../src/usage/store";

// The Rust pacer-status crate replays these recordings against its own
// freshness::mark_freshness, evidence ports and usage store (crates/status/
// tests/goldens.rs). Re-record with UPDATE_M3_GOLDENS=1 after changing
// TypeScript; a plain run must stay green against the committed fixtures.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "m3", "status");
const SCOPE: EvidenceScope = { account: "one", identity: "a".repeat(64) };
const ID = "a".repeat(64);
const NOW = 1_000_000;

type Case = { name: string; input: unknown; expected: unknown };
let cases: Case[] = [];

const record = (module: string): void => {
  const text = JSON.stringify(cases, null, 2) + "\n";
  if (process.env.UPDATE_M3_GOLDENS === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(join(FIXTURE_DIR, `${module}.json`), text);
  }
  expect(JSON.parse(readFileSync(join(FIXTURE_DIR, `${module}.json`), "utf8"))).toEqual(cases);
};

afterAll(cleanupTestTmp);

test("markFreshness goldens match the TypeScript freshness rules", () => {
  cases = [];
  const reading = (over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows: [], capturedAt: NOW, stale: false, ...over }) as UsageReading;
  const window = (name: string, over: Record<string, unknown> = {}) =>
    ({ name, usedPct: null, resetsAt: null, lengthS: 18000, paced: false, ...over });
  // A fresh quota reading with 5h/7d windows stays fresh.
  recordCase("fresh", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
    window("7d", { usedPct: 10, resetsAt: null, lengthS: 604800 }),
  ], capturedAt: NOW - 100 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // Past the 5h cap the short window turns stale while a 7d window stays fresh.
  recordCase("short-window-stale", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
    window("7d", { usedPct: 10, resetsAt: null, lengthS: 604800 }),
  ], capturedAt: NOW - 7200 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A future capturedAt is stale.
  recordCase("future-capturedAt", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
  ], capturedAt: NOW + 3600 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A null capturedAt is stale.
  recordCase("null-capturedAt", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
  ], capturedAt: null }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A reactive limit window whose resetsAt has passed is stale.
  recordCase("reactive-limit-reset", { reading: reading({ source: "reactive", windows: [
    window("limit", { usedPct: 100, resetsAt: NOW, lengthS: 18000 }),
  ] }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // An unmetered reading with no windows keeps its own stale flag.
  recordCase("unmetered-stale-true", { reading: reading({ source: "unmetered", stale: true }), now: NOW },
    (i: any) => markFreshness(i.reading, i.now));
  // A limit window on a non-contract source ignores the old capturedAt.
  recordCase("non-contract-limit", { reading: reading({ source: "status-line", windows: [
    window("limit", { usedPct: 100, resetsAt: null, lengthS: 18000 }),
  ], capturedAt: NOW - 100000 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  record("freshness");
});

test("evidence goldens match the TypeScript evidence functions", () => {
  cases = [];
  // evidenceFact ids pin the JavaScript number spelling (integer, fractional, 1e21, null).
  factCase("int", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("fractional", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 0.1 + 0.2, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("1e21", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 1e21, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("null-value", { source: "provider-cli", observedAt: null, validUntil: null, reason: "quota_observed", value: null });
  factCase("budget-policy", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true }, budgetPolicy: "model.fast" });

  const qr = (windows: any[], over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows, capturedAt: NOW, stale: false, ...over }) as UsageReading;
  const w5 = { name: "5h", usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000, paced: false };
  const w7 = { name: "7d", usedPct: 10, resetsAt: null, lengthS: 604800, paced: true };
  // 1: a quota reading with two windows.
  readingCase("quota-windows", "quota", qr([w5, w7]));
  // 2: a reactive reading with limit at usedPct 0 is skipped.
  readingCase("reactive-limit-skipped", "reactive", qr([{ ...w5, name: "limit", usedPct: 0, resetsAt: null }], { source: "reactive" }));
  // 3: an availability reading.
  readingCase("availability", "quota", qr([w5], { source: "status-line",
    availability: { state: "ready", reason: "usage_observed", validUntil: NOW + 7200 } }));
  // 4: a metered reading with spendUsd only.
  readingCase("metered-spend", "metered", qr([], { source: "metered", spendUsd: 12.4,
    spending: { creditsAvailable: true, creditBalance: null, paidConsumption: "observed" } }));
  // 5: a reading with error gets no usage_observed.
  readingCase("error-no-usage", "quota", qr([], { source: "status-line", capturedAt: null, stale: true, error: "down" }));
  // 6: alternatives with one remote reading.
  readingCase("alternatives", "quota", qr([w5], {
    alternatives: [{ windows: [{ name: "5h", usedPct: 30, resetsAt: NOW + 3600, lengthS: 18000, paced: false }], capturedAt: NOW, stale: false, source: "session-log" as const }],
  }));
  // 7: reading.evidence given, returned as is.
  const given = emptyEvidence() as AccountEvidence;
  given.budget.push(fact("given" as any, NOW, "quota_observed", { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true }) as Evidence<UsageWindow>);
  readingCase("given-evidence", "quota", qr([], { evidence: given }));

  const budgetOf = (f: { budget: Evidence<unknown>[] }) => ({ ...emptyEvidence(), budget: f.budget } as AccountEvidence);
  const accept = (f: AccountEvidence) => f;
  // 1: newest-observation wins.
  reconcileCase("newest-observation", budgetOf({ budget: [fact("provider-cli", NOW - 100, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }), NOW);
  // 2: configuration beats provider-cli at equal time.
  reconcileCase("config-beats-provider-cli", budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("configuration", NOW, "config_limit", { ...w5, name: "5h", usedPct: 90 })] }), NOW);
  // 3: equal-authority different values become a conflict.
  reconcileCase("equal-authority-conflict", budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("session-log", NOW, "quota_observed", { ...w5, usedPct: 35 })] }), NOW);
  // 4: the Codex 0h artifact is retired by a newer same-budgetPolicy witness.
  reconcileCase("zero-hour-retired", budgetOf({ budget: [fact("session-log", NOW - 86400, "quota_observed",
    { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w7)] }), NOW);
  // 5: a newer under-97 measurement drops an older execution limit.
  reconcileCase("newer-measurement-drops-execution-limit", budgetOf({ budget: [fact("execution", NOW - 7200, "quota_failure",
    { name: "limit", usedPct: 100, resetsAt: NOW + 7200, lengthS: 21600, paced: false })] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w7), fact("session-log", NOW, "quota_observed", { ...w7, usedPct: 30 })] }), NOW);
  // 6: an expired cooldown limit is dropped.
  reconcileCase("expired-cooldown", budgetOf({ budget: [fact("execution", NOW - 86400, "quota_failure",
    { name: "limit", usedPct: 100, resetsAt: NOW - 100, lengthS: 21600, paced: false })] }),
    accept(emptyEvidence()), NOW);
  // 7: an omitted lapsed window is retired by a newer same-source witness.
  reconcileCase("omitted-lapsed-window-retired", budgetOf({ budget: [fact("status-line", NOW - 20000, "quota_observed",
    { name: "5h", usedPct: 14, resetsAt: NOW - 1000, lengthS: 18000, paced: false })] }),
    budgetOf({ budget: [fact("status-line", NOW, "quota_observed", w7)] }), NOW);
  // 8: availability with validUntil older than 7 days is pruned.
  reconcileCase("availability-pruned", { ...emptyEvidence(), availability: [fact("execution", NOW - 30 * 86400, "execution_success", "ready")] } as AccountEvidence,
    accept(emptyEvidence()), NOW);
  // 9: conflict ids are sorted and dropped when the fact is gone.
  reconcileCase("conflict-sorted-dropped", budgetOf({ budget: [
    fact("provider-cli", NOW, "quota_observed", w5), fact("session-log", NOW, "quota_observed", { ...w5, usedPct: 35 }) ] }),
    accept(emptyEvidence()), NOW);
  record("evidence");
});

test("usage-store goldens match the TypeScript write rule", () => {
  cases = [];
  const reading = (pct: number, over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows: [{ name: "weekly", usedPct: pct, resetsAt: null, lengthS: 604800, paced: true }], capturedAt: NOW, ...over }) as UsageReading;
  const filesBytes = (ctx: Ctx): string | null =>
    existsSync(join(ctx.pacerHome, "state", "usage", `${ID}.json`))
      ? readFileSync(join(ctx.pacerHome, "state", "usage", `${ID}.json`), "utf8") : null;
  const store = (name: string, readOnly: boolean, writes: { now: number; key: string; reading: UsageReading }[]): void => {
    cases.push({
      name: `usage-store:${name}`, input: { readOnly, writes },
      expected: (() => {
        const ctx = fakeCtx({ now: writes[0].now, readOnly });
        for (const w of writes) writeUsageEntry({ ...ctx, now: w.now }, ID, w.key, w.reading);
        const bytes = filesBytes(ctx);
        return { bytes };
      })(),
    });
  };
  // 1: first write.
  store("first-write", false, [{ now: NOW, key: "one", reading: reading(10) }]);
  // 2: an identical reading within the refresh-ahead window -> no rewrite (same bytes).
  store("no-rewrite-fresh", false, [
    { now: NOW, key: "one", reading: reading(10) },
    { now: NOW + 300, key: "one", reading: reading(10, { capturedAt: NOW + 300 }) },
  ]);
  // 3: the same shape shortly before it lapses -> rewrite.
  store("rewrite-before-lapse", false, [
    { now: NOW, key: "one", reading: reading(10, { windows: [{ name: "5h", usedPct: 10, resetsAt: null, lengthS: 18000, paced: false }] }) },
    { now: NOW + 6600, key: "one", reading: reading(10, { windows: [{ name: "5h", usedPct: 10, resetsAt: null, lengthS: 18000, paced: false }], capturedAt: NOW + 6600 }) },
  ]);
  // 4: a superseded key older than 7 days is pruned.
  store("superseded-key-pruned", false, [
    { now: NOW, key: "old-key", reading: reading(5) },
    { now: NOW + 8 * 86400, key: "one", reading: reading(30, { capturedAt: NOW + 8 * 86400 }) },
  ]);
  // 5: readOnly -> no file.
  store("readonly-no-file", true, [{ now: NOW, key: "one", reading: reading(10) }]);
  record("usage-store");
});

function recordCase(name: string, input: unknown, run: (i: any) => unknown): void {
  cases.push({ name, input, expected: run(input) });
}
function fact(source: UsageSource | "execution" | "configuration", observedAt: number, reason: string, value: unknown, budgetPolicy?: string) {
  return evidenceFact<unknown>(SCOPE, source, observedAt, null, reason, value, budgetPolicy);
}
function factCase(key: string, o: { source: UsageSource | "execution" | "configuration"; observedAt: number | null; validUntil: number | null; reason: string; value: unknown; budgetPolicy?: string }): void {
  const input: Record<string, unknown> = { scope: SCOPE, source: o.source, observedAt: o.observedAt, validUntil: o.validUntil, reason: o.reason, value: o.value };
  if (o.budgetPolicy !== undefined) input.budgetPolicy = o.budgetPolicy;
  cases.push({ name: `fact:${key}`, input, expected: evidenceFact(SCOPE, o.source, o.observedAt, o.validUntil, o.reason, o.value, o.budgetPolicy as any) });
}
function readingCase(name: string, usage: UsageKind, r: UsageReading): void {
  cases.push({ name: `reading:${name}`, input: { scope: SCOPE, reading: r, usage }, expected: readingEvidence(SCOPE, r, usage) });
}
function reconcileCase(name: string, previous: AccountEvidence, incoming: AccountEvidence, now: number): void {
  cases.push({ name: `reconcile:${name}`, input: { previous, incoming, now }, expected: reconcileEvidence(previous, incoming, now) });
}