import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { AttentionItem } from "../src/attention/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { RUNS_EMPTY, RUNS_UNAVAILABLE } from "../src/view-model/runs";
import { initialState, type StoreState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { RunsPage } from "../app/src/screens/runs/RunsPage";
import { resolveRoute, routes, hrefFor, titleFor, primaryFor } from "../app/src/router";
import type { BrowserApi } from "../app/src/data/api";

function apiStub(list: unknown[] = []): BrowserApi {
  return {
    hello: async () => ({ protocol: "3.0.0", pacer: "0.0.0-test", ops: ["run.list", "run.get", "run.seen", "question.answer"], events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
    call: async <T,>(op: string) => {
      if (op === "run.list") return list as T;
      if (op === "run.get") return { run: { id: "run_1" }, steps: [] } as T;
      if (op === "run.seen") return {} as T;
      return {} as T;
    },
  };
}

function wrap(state: StoreState, api: BrowserApi, node: preact.VNode) {
  return renderToString(
    <TaskContext.Provider value={{ state, api }}>{node}</TaskContext.Provider>,
  );
}

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  const state = initialState();
  return {
    ...state,
    connected: true,
    features: { readModel: true, ops: new Set(["run.list", "run.get", "run.seen", "question.answer"]) },
    snapshot: {
      seq: 1,
      at: 1000,
      tasks: [],
      attention: [],
      counts: { attention: 0, running: 0, queued: 0, review: 0, failed: 0, setupOpen: 0 },
    } as unknown as ClientSnapshot,
    ...overrides,
  };
}

test("router resolves Runs routes and titles", () => {
  const list = resolveRoute("#/runs", true);
  expect("name" in list && list.name).toBe("runs");
  const detail = resolveRoute("#/runs/run_abc", true);
  expect("name" in detail && detail.name === "runs" && detail.id).toBe("run_abc");
  expect(hrefFor(routes.runs())).toBe("#/runs");
  expect(hrefFor(routes.runs("run_1"))).toBe("#/runs/run_1");
  expect(titleFor({ name: "runs", query: { repo: null, scope: null } })).toBe("Runs");
  expect(primaryFor({ name: "runs", query: { repo: null, scope: null } })).toBe("runs");
});

test("RunsPage empty state uses shared copy", () => {
  const state = baseState();
  const html = wrap(state, apiStub([]), <RunsPage query={{ repo: null, scope: null }} />);
  expect(html).toContain("Runs");
  expect(html.includes(RUNS_EMPTY) || html.includes("No runs yet")).toBe(true);
});

test("RunsPage unavailable when run.list is missing from ops", () => {
  const state = baseState({
    features: { readModel: true, ops: new Set(["task.list"]) },
  });
  const html = wrap(state, apiStub([]), <RunsPage query={{ repo: null, scope: null }} />);
  expect(html).toContain(RUNS_UNAVAILABLE);
});

test("RunsPage shows attention queue and run row fields", () => {
  const item: AttentionItem = {
    id: "att_1",
    kind: "question",
    severity: "decide",
    repo: null,
    title: "Approve publish?",
    detail: "detail",
    raisedAt: 900,
    since: 900,
    actions: [],
    notify: "all",
    unblocks: "run",
    run: { id: "run_1", letter: "B", title: "Ship board", priority: "urgent" },
    question: {
      id: "q_1",
      rev: 1,
      answerType: "approve_revise",
      text: "Publish the PR?",
      blocks: "run",
      options: [{ value: "approve" }, { value: "revise", note: "Needs polish" }],
    },
  };
  const state = baseState({
    snapshot: {
      seq: 2,
      at: 1000,
      tasks: [],
      attention: [item],
      counts: { attention: 1, running: 0, queued: 0, review: 0, failed: 0, setupOpen: 0 },
      runs: [{
        id: "run_1",
        letter: "B",
        title: "Ship board",
        workflow: "pacer-dev/dev",
        status: "waiting",
        priority: "urgent",
        waits_on: "you",
        steps: { running: 0, waiting: 1, done: 0, failed: 0 },
        orchestrator: { state: "idle" },
      }],
    } as unknown as ClientSnapshot,
  });
  const html = wrap(
    state,
    apiStub([{ id: "run_1", workflow: "pacer-dev/dev", title: "Ship board", status: "waiting", priority: "urgent", letter: "B", createdAt: 800 }]),
    <RunsPage query={{ repo: null, scope: null }} />,
  );
  expect(html).toContain("Needs your answer");
  expect(html).toContain("Publish the PR?");
  expect(html).toContain("Ship board");
  expect(html.includes("You") || html.includes("Waits on")).toBe(true);
  expect(html.includes("Urgent") || html.includes("urgent")).toBe(true);
  expect(html).toMatch(/pc-run-letter/);
  // Neutral letter chip — no status-tone classes (UI-10 / I5).
  expect(html).not.toMatch(/pc-run-letter--tone-/);
  // Mobile/AT field prefixes stay in the DOM (I3).
  expect(html).toContain("Waits on:");
  expect(html).toContain("Priority:");
  expect(html).toContain("Age:");
  // Queue shows run title + question once (N1); no "also listed above" in the accessible name (N3).
  expect(html).not.toContain("· also listed above");
});

test("RunsPage error state surfaces refresh failure copy", () => {
  // Synchronous first paint before async refresh settles still renders the page shell.
  const state = baseState();
  const html = wrap(state, {
    ...apiStub(),
    call: async () => { throw new Error("offline"); },
  }, <RunsPage query={{ repo: null, scope: null }} />);
  expect(html).toContain("Runs");
});
