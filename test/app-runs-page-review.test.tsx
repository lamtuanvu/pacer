/** RunsPage: title ownership, paused reason, honest seen/error copy, gating, action runner and refresh order. */
import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { act } from "preact/test-utils";
import type { AttentionItem } from "../src/attention/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import {
  RUN_DETAIL_ERROR, RUN_QUESTIONS_ERROR, RUN_SEEN_ERROR, RUN_SEEN_OK, RUN_VIEW_PENDING,
  RUNS_REFRESH_ERROR, RUNS_UNAVAILABLE_DETAIL,
} from "../src/view-model/runs";
import { ActionContext } from "../app/src/data/action-context";
import { createActionRunner } from "../app/src/data/actions";
import { ApiError, type BrowserApi } from "../app/src/data/api";
import { initialState, type StoreState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { RunsPage } from "../app/src/screens/runs/RunsPage";
import { Layout } from "../app/src/shell/Layout";
import { resolveRoute, type Route } from "../app/src/router";
import { domText, installDom, mount, submitForm, tick, until, unmount, type TestDom } from "./app-setup-health-dom";
import { enableFocusQueries, findAll, focusName } from "./app-focus-dom";
import fixture from "./fixtures/ui/snapshot.json";

const OPS = ["run.list", "run.get", "run.seen", "question.answer", "question.get", "question.list"];
const query = { repo: null, scope: null };

const question: AttentionItem = {
  id: "att_1", kind: "question", severity: "decide", repo: null, title: "Which approach?", detail: "",
  raisedAt: 900, since: 900, actions: [], notify: "all", unblocks: "run",
  run: { id: "run_1", letter: "B", title: "Ship board", priority: "urgent" },
  question: { id: "q_1", rev: 1, answerType: "single", text: "Which approach?", blocks: "run", options: [{ value: "ship" }], recommended: "ship" },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "run_1", workflow: "pacer-dev/dev", title: "Ship board", status: "waiting", priority: "urgent", letter: "B", createdAt: 800, ...over,
});

function state(over: { ops?: string[]; attention?: AttentionItem[]; runs?: unknown[]; invalidations?: Record<string, number> } = {}): StoreState {
  return {
    ...initialState(),
    connected: true,
    invalidations: over.invalidations ?? {},
    features: { readModel: true, ops: new Set(over.ops ?? OPS) },
    snapshot: { seq: 1, at: 1000, tasks: [], attention: over.attention ?? [], runs: over.runs ?? [] } as unknown as ClientSnapshot,
  };
}

type Handler = (params: any) => unknown;
function api(handlers: Record<string, Handler> = {}, calls: string[] = []): BrowserApi {
  const defaults: Record<string, Handler> = {
    "run.list": () => [row()],
    "run.get": () => ({ run: { id: "run_1" }, steps: [], questions: [] }),
  };
  return {
    hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: OPS, events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
    call: async <T,>(op: string, params?: unknown) => {
      calls.push(op);
      return await (handlers[op] ?? defaults[op] ?? (() => ({})))(params) as T;
    },
  };
}

const page = (s: StoreState, a: BrowserApi, runId?: string) => (
  <TaskContext.Provider value={{ state: s, api: a }}><RunsPage query={query} runId={runId} /></TaskContext.Provider>
);

async function withDom(run: (dom: TestDom) => Promise<void>) {
  const dom = installDom();
  enableFocusQueries(dom);
  const warn = console.warn;
  console.warn = () => {};
  try { await run(dom); } finally {
    await unmount(dom);
    console.warn = warn;
    dom.restore();
  }
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
const control = (dom: TestDom, text: string) =>
  findAll(dom.container, n => (n.localName === "a" || n.localName === "button") && domText(n).trim() === text)[0];
const ages = (dom: TestDom) => findAll(dom.container, n => n.attrs.class === "runs-table-age" || n.className === "runs-table-age").map(n => domText(n));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test.each([["desktop", false], ["narrow", true]] as const)("the Runs screen has exactly one h1 (%s)", (_name, narrow) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: (media: string) => ({ matches: media.includes("max-width") ? narrow : !narrow }) } });
  try {
    for (const hash of ["#/runs", "#/runs/run_1"]) {
      const s = { ...state(), snapshot: fixture as unknown as ClientSnapshot, features: { readModel: true, ops: new Set(OPS) } };
      const html = renderToString(
        <Layout route={resolveRoute(hash) as Route} state={s} title="Runs">{page(s, api())}</Layout>,
      );
      expect(html.match(/<h1/g)).toHaveLength(1);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("paused runs show why in plain words", () => withDom(async dom => {
  const rows = [
    row({ id: "run_1", pausedReason: "pacing: strict", status: "running" }),
    row({ id: "run_2", title: "Second", letter: "C", pausedReason: "person", status: "running" }),
    row({ id: "run_3", title: "Third", letter: "D", status: "running" }),
  ];
  await mount(dom, page(state(), api({ "run.list": () => rows })));
  await settle();
  const cells = findAll(dom.container, n => (n.attrs.class ?? n.className) === "runs-table-status").map(domText);
  expect(cells[0]).toContain("Paused by strict pacing");
  expect(cells[1]).toContain("Paused by you");
  expect(cells[2]).not.toContain("Paused");
  expect(domText(dom.container)).not.toContain("pacing: strict");
}));

test("a paused snapshot run shows why before run.list answers", () => {
  const s = state({ runs: [{ id: "run_9", letter: "E", title: "Held", workflow: "w", status: "running", priority: "normal", waits_on: "nothing", paused_reason: "pacing: emergency" }] });
  expect(renderToString(page(s, api()))).toContain("Paused by emergency pacing");
});

test("Answer is offered only when the service offers question.answer", () => {
  expect(renderToString(page(state({ attention: [question] }), api()))).toContain("answer=q_1");
  const without = renderToString(page(state({ attention: [question], ops: ["run.list"] }), api()));
  expect(without).toContain("Needs your answer");
  expect(without).not.toContain("answer=q_1");
});

test("opening a run marks it seen and says so only after success", () => withDom(async dom => {
  const calls: string[] = [], gate = deferred<unknown>();
  await mount(dom, page(state(), api({ "run.seen": () => gate.promise }, calls), "run_1"));
  await settle();
  expect(calls.filter(op => op === "run.seen")).toHaveLength(1);
  expect(domText(dom.container)).toContain(RUN_VIEW_PENDING);
  expect(domText(dom.container)).not.toContain(RUN_SEEN_OK);
  await act(async () => { gate.resolve({}); });
  await settle();
  expect(domText(dom.container)).toContain(RUN_SEEN_OK);
  expect(domText(dom.container)).not.toContain("later phase");
}));

test("a failed run.seen shows a plain error and never claims success", () => withDom(async dom => {
  await mount(dom, page(state(), api({ "run.seen": () => { throw new ApiError("internal", "run.seen SQLITE_BUSY"); } }), "run_1"));
  await settle();
  expect(domText(dom.container)).toContain(RUN_SEEN_ERROR);
  expect(domText(dom.container)).not.toContain(RUN_SEEN_OK);
  expect(domText(dom.container)).not.toContain("SQLITE_BUSY");
}));

test("without run.seen the page claims nothing about it", () => withDom(async dom => {
  const calls: string[] = [];
  await mount(dom, page(state({ ops: ["run.list", "run.get"] }), api({}, calls), "run_1"));
  await settle();
  expect(calls).not.toContain("run.seen");
  expect(domText(dom.container)).not.toContain(RUN_SEEN_OK);
  expect(domText(dom.container)).not.toContain(RUN_SEEN_ERROR);
}));

test.each([
  ["question.list", { "run.get": () => ({ run: {}, steps: [] }), "question.list": () => { throw new ApiError("internal", "boom question.list"); } }, RUN_QUESTIONS_ERROR],
  ["run.get", { "run.get": () => { throw new ApiError("internal", "boom run.get"); } }, RUN_DETAIL_ERROR],
] as const)("a failed %s is shown in plain words", (_op, handlers, words) => withDom(async dom => {
  await mount(dom, page(state(), api(handlers as Record<string, Handler>), "run_1"));
  await settle();
  expect(domText(dom.container)).toContain(words);
  expect(domText(dom.container)).not.toContain("boom");
}));

test("list failure and missing run.list never show service text or op names", () => withDom(async dom => {
  await mount(dom, page(state(), api({ "run.list": () => { throw new ApiError("internal", "boom run.list"); } })));
  await settle();
  expect(domText(dom.container)).toContain(RUNS_REFRESH_ERROR);
  expect(domText(dom.container)).not.toContain("boom");
  const unavailable = renderToString(page(state({ ops: [] }), api()));
  expect(unavailable).toContain(RUNS_UNAVAILABLE_DETAIL);
  expect(unavailable).not.toContain("run.list");
}));

test("a detail refresh that finishes after the list does not drop the list", () => withDom(async dom => {
  const detail = deferred<unknown>();
  await mount(dom, page(state({ runs: [{ id: "run_1", letter: "B", title: "Ship board", workflow: "w", status: "waiting", priority: "urgent", waits_on: "you" }] }), api({ "run.get": () => detail.promise }), "run_1"));
  await settle();
  expect(ages(dom)).toEqual(["Age:3m ago"]);
  await act(async () => { detail.resolve({ run: {}, steps: [], questions: [] }); });
  await settle();
  expect(ages(dom)).toEqual(["Age:3m ago"]);
}));

test("an older post-submit refresh cannot overwrite a newer one", () => withDom(async dom => {
  const lists = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let n = 0;
  const a = api({ "run.list": () => lists[n++]!.promise });
  await mount(dom, page(state({ attention: [question] }), a));
  await act(async () => { lists[0]!.resolve([row({ title: "First" })]); });
  await settle();
  await act(async () => { control(dom, "Answer").click(); });
  await settle();
  await act(async () => { submitForm(dom.container); });
  await settle();
  expect(n).toBe(2);
  await mount(dom, page(state({ attention: [], invalidations: { runs: 1 } }), a));
  await settle();
  expect(n).toBe(3);
  await act(async () => { lists[2]!.resolve([row({ title: "Newest title" })]); });
  await settle();
  await act(async () => { lists[1]!.resolve([row({ title: "Stale title" })]); });
  await settle();
  expect(domText(dom.container)).toContain("Newest title");
  expect(domText(dom.container)).not.toContain("Stale title");
}));

test("answering goes through the action runner, names the run, and focuses the Runs heading", () => withDom(async dom => {
  const direct: string[] = [], viaRunner: string[] = [];
  const a = api({}, direct);
  const runner = createActionRunner({ call: async <T,>(op: string) => { viaRunner.push(op); return {} as T; }, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
  await mount(dom, <ActionContext.Provider value={runner}>{page(state({ attention: [question] }), a)}</ActionContext.Provider>);
  await settle();
  await act(async () => { control(dom, "Answer").click(); });
  await settle();
  expect(domText(dom.container)).toContain("Asked by run B: Ship board");
  await act(async () => { submitForm(dom.container); });
  await tick();
  await until(() => domText(dom.container).includes("Answer submitted"), 2000);
  expect(viaRunner).toEqual(["question.answer"]);
  expect(direct).not.toContain("question.answer");
  expect(focusName(dom.doc.activeElement)).toBe("h1:Runs");
}));
