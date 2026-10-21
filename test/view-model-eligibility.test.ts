import { expect, test } from "bun:test";
import { eligibilityPresentation } from "../src/view-model/eligibility";
import { eligibility } from "./fixtures/eligibility";
import { renderText } from "../src/render/text";
import { computeStatus } from "../src/engine/status";
import { buildExecutors } from "../src/api/read-model/capacity";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx, withLoginIndicators } from "./helpers";
import { executorStatus, routingStatus } from "../app/src/model/executors";

test("missing legacy decision is unknown, while uncertain fallback includes reason and evidence age", () => {
  expect(eligibilityPresentation(undefined, 100).label).toBe("Eligibility unknown");
  const display = eligibilityPresentation({ ...eligibility("uncertain"), evaluatedAt: 100, evidenceAgeS: 60 }, 160);
  expect(display.label).toBe("Uncertain fallback");
  expect(display.detail).toContain("budget");
  expect(display.age).toBe("observed 2m ago");
  expect(routingStatus({ verdict: "OK" }).label).toBe("Eligibility unknown");
  expect(executorStatus({ id: "codex", state: "ok", until: null, reason: null }).label).toBe("Eligibility unknown");
});
test("API and CLI display the core decision without deriving availability from quota percentages", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const s = validateStrategy({ planner: "claude-code", providers: { codex: { allow_paid: true } } }, "/x");
  const st = await computeStatus(ctx, s, { profile: null, readings: new Map([["codex", {
    source: "session-log", capturedAt: ctx.now, stale: false, windows: [{ name: "5h", usedPct: 100, resetsAt: ctx.now + 3600, lengthS: 18000, paced: false }],
  }]]) });
  const p = st.providers.find(p => p.id === "codex")!;
  expect(p.eligibility?.state).toBe("eligible");
  const row = buildExecutors(st, s, [], ctx.now).find(e => e.id === "codex")!;
  expect(row.eligibility).toEqual(p.eligibility);
  expect(row.state).not.toBe("exhausted");
  expect(renderText(st)).toContain("Eligible");
});
