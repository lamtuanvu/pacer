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
    // The fix opens the affected agent.
    expect(html).toMatch(/href="#\/settings\/agents\?agent=[^"]+"/);
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

test("a long question stays in its own reason column, keeps the meta readable and never collapses into the actions", () => {
  const longQuestion = "Which database should we pick and why?. ".repeat(16); // > 600 chars
  const longRepo = "github.com/a-very-long-owner-name/another-very-long-repository-name";
  const now = Math.floor(Date.now() / 1000);
  const snap = structuredClone(fixture) as unknown as ClientSnapshot;
  const base = { ...(snap.tasks[0] as unknown as Record<string, unknown>) } as Record<string, unknown>;
  // A needs_input question task with a very long question and a very long repo name.
  snap.tasks = [{ ...base, id: "t-long-question", title: "Decide how to proceed", state: "needs_input", question: { text: longQuestion, at: now - 366 * 3600 - 540 }, repo: { key: longRepo, label: longRepo, path: "/tmp/long" } } as never];
  snap.attention = [{
    id: "question:long", kind: "question", severity: "decide",
    repo: { key: longRepo, label: longRepo, path: "/tmp/long" },
    taskId: "t-long-question", executor: "codex#team@devbox",
    title: "Decide how to proceed", detail: longQuestion,
    raisedAt: now - 366 * 3600 - 540, since: now - 366 * 3600 - 540,
    actions: [{ label: "Answer", op: "task.answer", params: { id: "t-long-question" } }], notify: "important",
  } as never];
  const html = renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), snapshot: snap }, api: {} as never }}><NeedsYouPage query={{ repo: null, scope: null }} /></TaskContext.Provider></ActionContext.Provider>);

  // The row renders.
  expect(html).toContain('class="ny-item"');
  expect(html).toContain('data-attention-id="question:long"');
  // The question text is confined to its own .ny-reason element with the full text as a title fallback (UI-11).
  expect(html).toContain('class="ny-reason"');
  expect(html).toContain('title="Codex asks: Which database should we pick and why?');
  expect(html).toContain(longQuestion);
  // The repo name lives inside .ny-meta, ellipsized with a title attribute exposing the full name.
  expect(html).toContain('class="ny-mono"');
  expect(html).toMatch(/title="github\.com\/a-very-long-owner-name\/another-very-long-repository-name"/);
  // .ny-reason and .ny-meta sit inside the .ny-content link; .ny-actions is a sibling grid cell after the link
  // closes, so the question text can never push the meta into or under the buttons.
  expect(html).toMatch(/class="pc-text-action ny-content"[\s\S]*class="ny-reason"[\s\S]*class="ny-meta ny-cap"[\s\S]*<\/a>\s*<span class="ny-actions">/);
  expect(html).toContain(">Answer</a>");
  expect(html).toContain(">Open in workspace</a>");
});

test("a run's own items are listed with their actions, though no task carries them", () => {
  const now = Math.floor(Date.now() / 1000);
  const snap = structuredClone(fixture) as unknown as ClientSnapshot;
  const run = { id: "run_aaaaaaaaaa", letter: "A", title: "Ship it", priority: "normal" as const };
  const base = { repo: null, raisedAt: now - 60, since: now - 60, notify: "important" as const, run };
  snap.attention = [
    { ...base, id: "question:q_pub", kind: "question", severity: "blocked", title: "Publish?", detail: "Needs your approval.",
      question: { id: "q_pub", text: "Publish?", answerType: "approve_revise", rev: 1 },
      actions: [{ label: "Approve", op: "question.answer", params: { id: "q_pub", expect_rev: 1, answer: "approve" }, confirm: "Answer?" }] },
    { ...base, id: "question:q_text", kind: "question", severity: "blocked", title: "Which name?", detail: "Asked by the workflow planner.",
      question: { id: "q_text", text: "Which name?", answerType: "text", rev: 1 }, actions: [] },
    { ...base, id: "step_failed:run_aaaaaaaaaa:work#1", kind: "orchestrator_failed", severity: "blocked", title: "Step \"work\" failed", detail: "Retry it, or skip it to continue.",
      actions: [{ label: "Retry step", op: "step.retry", params: { id: run.id, step: "work", expect_rev: 4 } }, { label: "Skip step", op: "step.skip", params: { id: run.id, step: "work", expect_rev: 4 }, confirm: "Skip?" }] },
  ] as never;
  const html = renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), snapshot: snap }, api: {} as never }}><NeedsYouPage query={{ repo: null, scope: null }} /></TaskContext.Provider></ActionContext.Provider>);
  for (const item of snap.attention as unknown as { id: string }[]) expect(html).toContain(`data-attention-id="${item.id.replaceAll('"', "&quot;")}"`);
  expect(html).toContain("3 items are waiting on you");
  expect(html).toMatch(/Questions <span class="ny-cap">2</);
  expect(html).toMatch(/Failed <span class="ny-cap">1</);
  expect(html).toContain(">Approve</button>");
  expect(html).toContain(">Retry step</button>");
  expect(html).toContain(">Skip step</button>");
  expect(html).toMatch(/href="#\/runs\/run_aaaaaaaaaa"[^>]*>Answer in run<\/a>/);
});
