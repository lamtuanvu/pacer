import { expect, test } from "bun:test";
import { usageView, windowWords, resetWords, freshnessWords, figureWords, usageSourceWords, usageWindowView, usageSources } from "../src/view-model/usage";
import { verdictWords, paceStatus, verdictLabels } from "../src/view-model/words";
import { localTs } from "./helpers";
import type { UsageState } from "../src/types";

const now = localTs(2026, 11, 20, 10, 0); // a Friday, 10:00 local

function state(over: Partial<UsageState> = {}): UsageState {
  return {
    scope: { account: "claude" },
    source: "provider-cli",
    figure: { usedPct: 68.4, window: "weekly", lengthS: 7 * 86400, resetsAt: now + 4 * 86400 },
    windows: [],
    limit: null,
    blockedRunners: [],
    observedAt: now - 180,
    freshness: "fresh",
    verdict: "ON_PACE",
    eligibility: { state: "eligible", reasons: [], evaluatedAt: now, validUntil: null, evidenceAgeS: 0, availability: "ready", budget: "permitted", spendingRisk: "unknown" },
    spend: null,
    error: null,
    ...over,
  };
}

test("a null record is a state, never a number", () => {
  for (const view of [usageView(null, now), usageView(undefined, now)]) {
    expect(view.figure).toBe("Usage unknown");
    expect(view.meter).toBeNull();
    expect(view.tone).toBe("neutral");
    expect(view.verdictLabel).toBe("Usage unknown");
    expect(view.reset).toBe("");
    expect(view.freshness).toBe("");
  }
});

test("an active limit quotes Out of quota over the limit window and reset", () => {
  const view = usageView(state({
    figure: { usedPct: 100, window: "limit", lengthS: 21600, resetsAt: now + 3600 },
    limit: { until: now + 3600, observedAt: now, manual: false },
    verdict: "EXHAUSTED",
  }), now);
  expect(view.figure).toBe("Out of quota");
  expect(view.meter).toBe(100);
  expect(view.window).toBe("limit");
  expect(view.reset).toBe(`resets ${new Date((now + 3600) * 1000).toLocaleTimeString("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" })}`);
  expect(view.tone).toBe("bad");
  expect(view.verdictLabel).toBe("Out of quota");
});

test("reactive without a limit has no figure; unmetered says Unmetered", () => {
  const reactive = usageView(state({ figure: null, windows: [], source: "reactive", verdict: "OK", observedAt: null, freshness: "unknown" }), now);
  expect(reactive.figure).toBe("No usage figure");
  expect(reactive.meter).toBeNull();
  expect(reactive.freshness).toBe("");
  expect(reactive.verdictLabel).toBe("Available");
  const unmetered = usageView(state({ figure: null, windows: [], source: "unmetered", verdict: "UNMETERED", observedAt: null, freshness: "unknown" }), now);
  expect(unmetered.figure).toBe("Unmetered");
  expect(unmetered.verdictLabel).toBe("Unmetered");
  expect(unmetered.tone).toBe("good");
});

test("a measured figure is rounded once, with window words and freshness", () => {
  const view = usageView(state(), now);
  expect(view.figure).toBe("68%");
  expect(view.meter).toBe(68);
  expect(view.window).toBe("week");
  expect(view.freshness).toBe("Updated 3m ago");
  expect(view.source).toBe("Provider reading");
  expect(view.verdictLabel).toBe("On pace");
  expect(view.tone).toBe("good");
});

test("the one reset format: same day time, weekday within 7 days, date beyond", () => {
  const sameDay = localTs(2026, 11, 20, 14, 0);
  const inDays = (d: number) => localTs(2026, 11, 20 + d, 14, 0);
  expect(resetWords(sameDay, now)).toBe("resets 14:00");
  expect(resetWords(inDays(1), now)).toBe("resets Sat 14:00");
  expect(resetWords(inDays(6), now)).toBe("resets Thu 14:00");
  expect(resetWords(inDays(7), now)).toBe("resets 27 Nov");
  expect(resetWords(null, now)).toBe("reset unknown");
  expect(usageView(state({ figure: { usedPct: 10, window: "5h", lengthS: 5 * 3600, resetsAt: inDays(8) } }), now).reset).toBe("resets 28 Nov");
});

test("freshness words: fresh, historical and unknown", () => {
  expect(freshnessWords(state({ freshness: "fresh", observedAt: now - 3600 }), now)).toBe("Updated 1h ago");
  expect(freshnessWords(state({ freshness: "historical", observedAt: now - 26 * 3600 }), now)).toBe("Reading 26h old · refresh");
  expect(freshnessWords(state({ freshness: "historical", observedAt: null }), now)).toBe("Reading of unknown age · refresh");
  expect(freshnessWords(state({ freshness: "unknown", observedAt: null }), now)).toBe("");
});

test("window words come from the window name, never assumed", () => {
  expect(windowWords("weekly")).toBe("week");
  expect(windowWords("week")).toBe("week");
  expect(windowWords("7d")).toBe("week");
  expect(windowWords("monthly")).toBe("month");
  expect(windowWords("daily")).toBe("day");
  expect(windowWords("5h")).toBe("5 h");
  expect(windowWords("limit")).toBe("limit");
  expect(windowWords("quarterly")).toBe("quarterly");
  expect(windowWords(null)).toBe("");
});

test("source labels come from the one map", () => {
  expect(usageSources["provider-cli"]).toBe("Provider reading");
  expect(usageSourceWords("status-line")).toBe("Status line");
  expect(usageSourceWords("reactive")).toBe("Observed limits");
  expect(usageSourceWords("unmetered")).toBe("No quota limit");
  expect(usageSourceWords("unknown")).toBe("Source unknown");
  expect(usageSourceWords(undefined)).toBe("Source unknown");
});

test("every verdict has exactly one label; OK and UNMETERED agree everywhere", () => {
  const expected: Record<string, string> = {
    EXHAUSTED: "Out of quota", NEAR_LIMIT: "Near limit", AHEAD: "Ahead of pace", BEHIND: "Behind pace",
    EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", OK: "Available", ON_PACE: "On pace",
    UNMETERED: "Unmetered", UNKNOWN: "Usage unknown", unknown: "Usage unknown",
  };
  for (const [verdict, label] of Object.entries(expected)) {
    expect(verdictLabels[verdict]?.label).toBe(label);
    expect(verdictWords(verdict)).toBe(label);
  }
  expect(verdictWords("OK")).toBe("Available");
  expect(verdictWords("UNMETERED")).toBe("Unmetered");
  expect(paceStatus("OK").label).toBe("Available");
  expect(paceStatus("UNMETERED").label).toBe("Unmetered");
  expect(paceStatus("NEAR_LIMIT").label).toBe("Near limit");
  expect(paceStatus("on_pace").label).toBe("On pace");
  expect(paceStatus("mystery").label).toBe("Usage unknown");
});

test("figureWords mirrors the view's figure and meter", () => {
  expect(figureWords(state())).toEqual({ figure: "68%", meter: 68 });
  expect(figureWords(state({ figure: { usedPct: 100, window: "limit", lengthS: 21600, resetsAt: now }, limit: { until: now, observedAt: now, manual: true } })))
    .toEqual({ figure: "Out of quota", meter: 100 });
  expect(figureWords(null)).toEqual({ figure: "Usage unknown", meter: null });
});

test("window views quote each window with the shared words", () => {
  const view = usageWindowView({ name: "5h", usedPct: 41.6, resetsAt: now + 2 * 3600, lengthS: 5 * 3600, paced: true, stale: false, verdict: "ON_PACE" }, now);
  expect(view).toEqual({ label: "5 h", figure: "42%", meter: 42, reset: `resets ${new Date((now + 2 * 3600) * 1000).toLocaleTimeString("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" })}`, tone: "good", stale: false, verdictLabel: "On pace" });
  expect(usageWindowView({ name: "weekly", usedPct: null, resetsAt: null, lengthS: 7 * 86400, paced: true, stale: true, verdict: "UNKNOWN" }, now).figure).toBe("Usage unknown");
});

test("tones follow the verdict table", () => {
  expect(usageView(state({ verdict: "EXHAUSTED" }), now).tone).toBe("bad");
  expect(usageView(state({ verdict: "NEAR_LIMIT" }), now).tone).toBe("warn");
  expect(usageView(state({ verdict: "AHEAD" }), now).tone).toBe("warn");
  expect(usageView(state({ verdict: "OK" }), now).tone).toBe("good");
  expect(usageView(state({ verdict: "UNMETERED" }), now).tone).toBe("good");
  expect(usageView(state({ verdict: "UNKNOWN" }), now).tone).toBe("neutral");
});
