import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { ExecutorRow } from "../src/api/read-model/types";
import { NeedsYouPage } from "../app/src/screens/needs-you/NeedsYou";
import { TaskContext } from "../app/src/screens/task-shared";
import { ActionContext } from "../app/src/data/action-context";
import { createActionRunner } from "../app/src/data/actions";
import { initialState } from "../app/src/data/store";

const runner = createActionRunner({ call: async () => ({} as never), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
function renderRows(overrides: Partial<ExecutorRow>[]) {
  const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
  const ready = snapshot.executors!.find(row => row.rank !== "planner")!;
  snapshot.executors = overrides.map((row, index) => ({ ...ready, rank: index, state: "ready", stale: false, usedPct: 20, ...row }));
  return renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), snapshot }, api: {} as never }}><NeedsYouPage query={{ repo: null, scope: null }} /></TaskContext.Provider></ActionContext.Provider>);
}
for (const state of ["blocked", "failing", "exhausted", "down", "disabled"] as const) {
  test(`Needs you warns about ${state} executors`, () => {
    const html = renderRows([{ state, reason: "Needs a fix" }]);
    expect(html).toContain("1 agent can't take work");
    expect(html).toContain('pc-card pc-card--warn');
    expect(html).toContain('href="#/settings/executors"');
    expect(html).toContain("Needs a fix");
  });
}
test("Needs you includes stale and unknown readings and excludes planners and unmetered capacity", () => {
  const html = renderRows([{ stale: true }, { usedPct: null }, { rank: "planner", state: "blocked" }, { usedPct: null, paceReason: "unmetered" }]);
  expect(html).toContain("2 agents can't take work");
  expect(renderRows([{ usedPct: null, paceReason: "unmetered" }])).not.toContain("Fix in Agents");
});
for (const state of ["uncertain", "eligible"] as const) test(`Needs you includes unknown budget evidence with ${state} eligibility and a cached percentage`, () => {
  const html = renderRows([{ eligibility: { state, budget: "unknown", availability: "ready", evaluatedAt: 0, validUntil: null, evidenceAgeS: null, reasons: [], spendingRisk: "unknown" } }]);
  expect(html).toContain("1 agent can't take work");
});
test("Needs you retains the exact footnote and uses workspace copy for review session links", () => {
  const html = renderRows([]);
  expect(html).toContain("Answering, retrying or accepting here resumes the task where it stopped. Everything you do is recorded in the task's dispatch trace.");
  expect(html).toMatch(/href="#\/workspace\?task=[^"&]+"[^>]*>Open workspace<\/a>/);
  expect(html).not.toContain(">Dispatch trace</a>");
});
