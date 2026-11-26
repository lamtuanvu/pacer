import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/client";
import { Dashboard } from "../src/dashboard/controller";
import {
  encodeMultiAnswer,
  formSpecForQuestion,
  multiAnswerPayload,
  questionAnswerAct,
  QUESTION_ANSWER_MAX,
  toggleMultiSelection,
} from "../src/dashboard/screens/question-form";
import { initialState, reduceKey, trigger, type Item, type KeyContext, type ScreenId } from "../src/dashboard/state";
import { PLAIN_THEME } from "../src/dashboard/theme";
import type { RunQuestion } from "../src/dashboard/screens/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { ApiClient } from "../src/api/client";
import { validateQuestionAnswer } from "../src/workflow/question-schema";
import fixture from "./fixtures/ui/snapshot.json";
import { serviceAct } from "../src/dashboard/screens/common";
import { renderDashboard } from "../src/dashboard/render";

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;

const runsCtx = (items: Item[]): KeyContext => ({
  items, tabs: ["runs"] as ScreenId[], page: 10, wide: true, hasDetail: false, repos: [], supports: () => true,
});

const q = (partial: Partial<RunQuestion> & Pick<RunQuestion, "answerType">): RunQuestion => ({
  id: "q-1",
  runId: "r-aaaaaaaaaa",
  text: "Which path?",
  blocks: "step",
  status: "open",
  answerer: "person",
  rev: 2,
  ...partial,
});

describe("question form payloads", () => {
  test("single / multi / yes_no / approve_revise / text", () => {
    const single = formSpecForQuestion(q({
      answerType: "single",
      options: [{ value: "a", note: "fast" }, { value: "b", note: "safe" }],
      recommended: "b",
    }));
    expect(single.mode).toBe("single");
    expect(single.submit("b")).toEqual({
      type: "action",
      action: { label: "Answer recorded", op: "question.answer", params: { id: "q-1", answer: "b", expect_rev: 2 } },
    });

    const multi = formSpecForQuestion(q({
      answerType: "multi",
      options: [{ value: "a" }, { value: "b" }, { value: "c" }],
    }));
    expect(multi.mode).toBe("multi");
    // Toggle order b then a — payload must still be option order a,b
    const selected = toggleMultiSelection(toggleMultiSelection([], "c"), "a");
    expect(selected).toEqual(["c", "a"]);
    expect(multiAnswerPayload(q({
      answerType: "multi",
      options: [{ value: "a" }, { value: "b" }, { value: "c" }],
    }), selected)).toEqual({
      id: "q-1", answer: "a,c", expect_rev: 2,
    });
    expect(multi.submit("a,c")).toMatchObject({
      type: "action",
      action: { params: { answer: "a,c", expect_rev: 2 } },
    });

    const yn = formSpecForQuestion(q({ answerType: "yes_no", recommended: "yes" }));
    expect(yn.mode).toBe("yes_no");
    expect(yn.submit("no")).toMatchObject({ action: { params: { answer: "no" } } });

    const ar = formSpecForQuestion(q({
      answerType: "approve_revise",
      options: [{ value: "approve" }, { value: "revise" }],
    }));
    expect(ar.submit("revise", "tighten the tests")).toEqual({
      type: "action",
      action: {
        label: "Answer recorded",
        op: "question.answer",
        params: { id: "q-1", answer: "revise", expect_rev: 2, note: "tighten the tests" },
      },
    });

    const text = formSpecForQuestion(q({ answerType: "text" }));
    expect(text.mode).toBe("text");
    expect(text.submit("hello")).toMatchObject({ action: { params: { answer: "hello" } } });
  });

  test("multi payload round-trips through validateQuestionAnswer (1–3 picks, spaces)", () => {
    const options = [
      { value: "opt one" },
      { value: "opt two" },
      { value: "third choice" },
    ];
    for (const count of [1, 2, 3]) {
      const selected = options.slice(0, count).map(o => o.value).reverse(); // reverse toggle order
      const answer = encodeMultiAnswer(options, selected);
      expect(() => validateQuestionAnswer("multi", answer, options)).not.toThrow();
      expect(answer.split(",")).toEqual(options.slice(0, count).map(o => o.value));
    }
  });

  test("space toggles multi selection; enter encodes comma in option order", () => {
    const form = formSpecForQuestion(q({
      answerType: "multi",
      options: [{ value: "a" }, { value: "b" }],
    }));
    const item: Item = { id: "x", primary: { label: "Answer", effect: { type: "answer-form", form } }, actions: [], keys: {} };
    const ctx = runsCtx([item]);
    let state = trigger(initialState("runs"), item.primary).state;
    expect(state.overlay).toMatchObject({ kind: "answer", mode: "multi" });
    state = reduceKey(state, " ", ctx).state;
    expect(state.overlay).toMatchObject({ selected: ["a"] });
    state = reduceKey(state, "j", ctx).state;
    state = reduceKey(state, " ", ctx).state;
    expect(state.overlay).toMatchObject({ selected: ["a", "b"] });
    const done = reduceKey(state, "enter", ctx);
    expect(done.state.overlay?.kind).toBe("answer"); // stays open until controller success
    expect(done.effect).toMatchObject({
      type: "action",
      action: { op: "question.answer", params: { answer: "a,b", expect_rev: 2 } },
    });
  });

  test("yes_no accepts y/n", () => {
    const form = formSpecForQuestion(q({ answerType: "yes_no" }));
    const item: Item = { id: "x", primary: { label: "Answer", effect: { type: "answer-form", form } }, actions: [], keys: {} };
    const ctx = runsCtx([item]);
    const opened = trigger(initialState("runs"), item.primary).state;
    expect(reduceKey(opened, "y", ctx).effect).toMatchObject({ action: { params: { answer: "yes" } } });
    expect(reduceKey(opened, "n", ctx).effect).toMatchObject({ action: { params: { answer: "no" } } });
  });

  test("client refuses answers over the question.answer cap before close", () => {
    const form = formSpecForQuestion(q({ answerType: "text" }));
    const item: Item = { id: "x", primary: { label: "Answer", effect: { type: "answer-form", form } }, actions: [], keys: {} };
    const ctx = runsCtx([item]);
    let state = trigger(initialState("runs"), item.primary).state;
    for (const ch of "x".repeat(QUESTION_ANSWER_MAX)) state = reduceKey(state, ch, ctx).state;
    state = reduceKey(state, "y", ctx).state; // 2001st refused
    expect(state.overlay).toMatchObject({ kind: "answer", error: expect.stringContaining("2000") });
    if (state.overlay?.kind === "answer") {
      expect(state.overlay.note.length).toBe(QUESTION_ANSWER_MAX);
    }
    // A 2500-char payload (e.g. paste) is refused on enter without closing.
    state = {
      ...state,
      overlay: state.overlay?.kind === "answer"
        ? { ...state.overlay, note: "z".repeat(2500), error: undefined }
        : state.overlay,
    };
    const mid = reduceKey(state, "enter", ctx);
    expect(mid.effect).toBeUndefined();
    expect(mid.state.overlay).toMatchObject({ kind: "answer", error: expect.stringContaining("2000") });
    if (mid.state.overlay?.kind === "answer") expect(mid.state.overlay.note.length).toBe(2500);
  });

  test("keys hidden when ops are absent", () => {
    expect(questionAnswerAct({ question: q({ answerType: "text" }), supports: () => false })).toBeUndefined();
    expect(questionAnswerAct({
      humanStep: { runId: "r-aaaaaaaaaa", stepId: "ask", expectRev: 1 },
      supports: op => op === "run.answer",
    })?.effect.type).toBe("prompt");
  });

  test("single/multi with no options still offer a with an explanation", () => {
    const single = questionAnswerAct({
      question: q({ answerType: "single", options: [] }),
      supports: () => true,
    });
    expect(single?.effect).toMatchObject({
      type: "answer-form",
      form: {
        emptyHint: 'This question has no options; answer it with pacer answer q-1 "<your answer>"',
        options: [],
      },
    });
    const multi = questionAnswerAct({
      question: q({ id: "q_abcdefghij", answerType: "multi" }),
      supports: () => true,
    });
    expect(multi?.effect).toMatchObject({
      type: "answer-form",
      form: {
        emptyHint: 'This question has no options; answer it with pacer answer q_abcdefghij "<your answer>"',
      },
    });
  });

  test("whitespace-padded option values are refused on toggle and encode", () => {
    expect(() => encodeMultiAnswer([{ value: " a " }], [" a "])).toThrow(/whitespace/);
    const form = formSpecForQuestion(q({
      answerType: "multi",
      options: [{ value: " a " }, { value: "b" }],
    }));
    const item: Item = { id: "x", primary: { label: "Answer", effect: { type: "answer-form", form } }, actions: [], keys: {} };
    const ctx = runsCtx([item]);
    let state = trigger(initialState("runs"), item.primary).state;
    state = reduceKey(state, " ", ctx).state;
    expect(state.overlay).toMatchObject({ kind: "answer", error: expect.stringContaining("whitespace"), selected: [] });
  });

  test("double Enter while submitting does not fire a second answer", () => {
    const form = formSpecForQuestion(q({ answerType: "yes_no" }));
    const item: Item = { id: "x", primary: { label: "Answer", effect: { type: "answer-form", form } }, actions: [], keys: {} };
    const ctx = runsCtx([item]);
    const opened = trigger(initialState("runs"), item.primary).state;
    const first = reduceKey(opened, "y", ctx);
    expect(first.effect).toMatchObject({ action: { op: "question.answer" } });
    expect(first.state.overlay).toMatchObject({ submitting: true });
    const second = reduceKey(first.state, "y", ctx);
    expect(second.effect).toBeUndefined();
  });
});

describe("controller answer conflict and stop confirmation", () => {
  test("conflict reloads and reports the changed-question copy", async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const calls: { op: string; params: unknown }[] = [];
    const frames: string[] = [];
    const client: ApiClient = {
      kind: "http",
      hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "run.stop", "question.answer", "question.list"], events: [] }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
      call: async <T,>(op: string, params?: unknown): Promise<T> => {
        calls.push({ op, params });
        if (op === "question.answer") throw new ApiError("conflict", "stale");
        if (op === "run.list" || op === "question.list") return [] as T;
        if (op === "run.get") {
          return {
            run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
            steps: [], graphs: [],
          } as T;
        }
        return {} as T;
      },
      subscribe: () => () => {},
      close: () => {},
    };
    const dash = new Dashboard({
      client,
      theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
      now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
    });
    await dash.refresh();
    dash.state = { ...dash.state, screen: "runs", runView: "r-aaaaaaaaaa" };
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
    });
    expect(frames.at(-1)).toContain("This question changed; review it again.");
  });

  test("invalid_input keeps the answer overlay open with the typed text", async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const frames: string[] = [];
    const client: ApiClient = {
      kind: "http",
      hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "question.answer", "question.list"], events: [] }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
      call: async <T,>(op: string): Promise<T> => {
        if (op === "question.answer") throw new ApiError("invalid_input", "each multi answer must be one of: a, b");
        if (op === "run.list" || op === "question.list") return [] as T;
        if (op === "run.get") {
          return {
            run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
            steps: [], graphs: [],
          } as T;
        }
        return {} as T;
      },
      subscribe: () => () => {},
      close: () => {},
    };
    const dash = new Dashboard({
      client,
      theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
      now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
    });
    await dash.refresh();
    dash.state = {
      ...dash.state,
      screen: "runs",
      overlay: {
        kind: "answer",
        title: "Pick",
        mode: "multi",
        options: [{ value: "a", label: "a" }, { value: "b", label: "b" }],
        selected: ["a", "b"],
        note: "",
        index: 0,
        phase: "choose",
        submit: answer => ({
          type: "action",
          action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer, expect_rev: 1 } },
        }),
      },
    };
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "a,b", expect_rev: 1 } },
    });
    expect(dash.state.overlay?.kind).toBe("answer");
    expect(dash.state.overlay).toMatchObject({ selected: ["a", "b"], error: expect.stringContaining("multi") });
  });

  test("stop asks for confirmation", () => {
    const stop = {
      label: "Stop",
      effect: { type: "action" as const, action: { label: "Stop", op: "run.stop", params: { id: "r-aaaaaaaaaa", expect_rev: 1 } } },
      confirm: { title: "Stop this run?", yes: "Stop" },
      danger: true,
    };
    const item: Item = { id: "run:r-aaaaaaaaaa", actions: [], keys: { s: stop } };
    const ctx = runsCtx([item]);
    const asked = reduceKey(initialState("runs"), "s", ctx);
    expect(asked.state.overlay).toMatchObject({ kind: "confirm", title: "Stop this run?" });
    expect(asked.effect).toBeUndefined();
    const confirmed = reduceKey(asked.state, "y", ctx);
    expect(confirmed.effect).toEqual(stop.effect);
  });

  test("generic answer error resets submitting and keeps the overlay for retry", async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const frames: string[] = [];
    const client: ApiClient = {
      kind: "http",
      hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "question.answer", "question.list", "question.get"], events: [] }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
      call: async <T,>(op: string): Promise<T> => {
        if (op === "question.answer") throw new ApiError("unavailable", "service busy");
        if (op === "run.list" || op === "question.list") return [] as T;
        if (op === "question.get") return { status: "open" } as T;
        if (op === "run.get") {
          return {
            run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
            steps: [], graphs: [],
          } as T;
        }
        return {} as T;
      },
      subscribe: () => () => {},
      close: () => {},
    };
    const dash = new Dashboard({
      client,
      theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
      now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
    });
    await dash.refresh();
    dash.state = {
      ...dash.state,
      screen: "runs",
      overlay: {
        kind: "answer",
        title: "Pick",
        mode: "yes_no",
        options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        selected: [],
        note: "",
        index: 0,
        phase: "choose",
        submitting: true,
        submit: answer => ({
          type: "action",
          action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer, expect_rev: 1 } },
        }),
      },
    };
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
    });
    expect(dash.state.overlay?.kind).toBe("answer");
    expect(dash.state.overlay).toMatchObject({ submitting: false, error: expect.stringContaining("service busy") });
    expect(frames.at(-1)).toContain("service busy");
  });

  test("run.answer prompt branch keeps overlay open on failure for retry", async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const frames: string[] = [];
    const client: ApiClient = {
      kind: "http",
      hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "run.answer", "question.list"], events: [] }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
      call: async <T,>(op: string): Promise<T> => {
        if (op === "run.answer") throw new ApiError("unavailable", "orchestrator busy");
        if (op === "run.list" || op === "question.list") return [] as T;
        if (op === "run.get") {
          return {
            run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
            steps: [], graphs: [],
          } as T;
        }
        return {} as T;
      },
      subscribe: () => () => {},
      close: () => {},
    };
    const dash = new Dashboard({
      client,
      theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
      now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
    });
    await dash.refresh();
    dash.state = {
      ...dash.state,
      screen: "runs",
      overlay: {
        kind: "prompt",
        value: "ship it",
        submitting: true,
        spec: {
          title: "Answer",
          label: "Your answer",
          submit: (value: string) => ({
            type: "action",
            action: { label: "Answer", op: "run.answer", params: { id: "r-aaaaaaaaaa", step_id: "human", answer: value, expect_rev: 1 } },
          }),
        },
      },
    };
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "run.answer", params: { id: "r-aaaaaaaaaa", step_id: "human", answer: "ship it", expect_rev: 1 } },
    });
    expect(dash.state.overlay?.kind).toBe("prompt");
    expect(dash.state.overlay).toMatchObject({ value: "ship it", submitting: false, error: expect.stringContaining("orchestrator busy") });
    expect(frames.at(-1)).toContain("orchestrator busy");
  });

  test("non-ambiguous invalid_input and not_found keep overlay without question.get", async () => {
    for (const code of ["invalid_input", "not_found"] as const) {
      const s = structuredClone(fixture) as unknown as ClientSnapshot;
      const calls: string[] = [];
      const frames: string[] = [];
      const client: ApiClient = {
        kind: "http",
        hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "question.answer", "question.list", "question.get"], events: [] }),
        snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
        call: async <T,>(op: string): Promise<T> => {
          calls.push(op);
          if (op === "question.answer") throw new ApiError(code, `${code} detail`);
          if (op === "run.list" || op === "question.list") return [] as T;
          if (op === "run.get") {
            return {
              run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
              steps: [], graphs: [],
            } as T;
          }
          return {} as T;
        },
        subscribe: () => () => {},
        close: () => {},
      };
      const dash = new Dashboard({
        client,
        theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
        now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
      });
      await dash.refresh();
      dash.state = {
        ...dash.state,
        screen: "runs",
        overlay: {
          kind: "answer",
          title: "Pick",
          mode: "yes_no",
          options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
          selected: [],
          note: "",
          index: 0,
          phase: "choose",
          submitting: true,
          submit: answer => ({
            type: "action",
            action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer, expect_rev: 1 } },
          }),
        },
      };
      await dash.run({
        type: "action",
        action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
      });
      expect(dash.state.overlay?.kind).toBe("answer");
      expect(dash.state.overlay).toMatchObject({ submitting: false, error: expect.stringContaining(code) });
      expect(calls.filter(op => op === "question.get")).toEqual([]);
      expect(frames.at(-1)).toContain(code);
    }
  });

  test("timeout then success on retry; timeout where write landed shows stale conflict", async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    let answerCalls = 0;
    let getStatus: "open" | "answered" = "open";
    const frames: string[] = [];
    const client: ApiClient = {
      kind: "http",
      hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["run.list", "run.get", "question.answer", "question.list", "question.get"], events: [] }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
      call: async <T,>(op: string): Promise<T> => {
        if (op === "question.get") return { status: getStatus } as T;
        if (op === "question.answer") {
          answerCalls += 1;
          if (answerCalls === 1) {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            throw err;
          }
          return { status: "answered" } as T;
        }
        if (op === "run.list" || op === "question.list") return [] as T;
        if (op === "run.get") {
          return {
            run: { id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "T", status: "waiting", rev: 1, createdAt: s.at, updatedAt: s.at },
            steps: [], graphs: [],
          } as T;
        }
        return {} as T;
      },
      subscribe: () => () => {},
      close: () => {},
    };
    const dash = new Dashboard({
      client,
      theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp", timeZone: "UTC",
      now: () => s.at, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f),
    });
    await dash.refresh();
    const openOverlay = () => {
      dash.state = {
        ...dash.state,
        screen: "runs",
        overlay: {
          kind: "answer",
          title: "Pick",
          mode: "yes_no",
          options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
          selected: [],
          note: "",
          index: 0,
          phase: "choose",
          submitting: true,
          submit: answer => ({
            type: "action",
            action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer, expect_rev: 1 } },
          }),
        },
      };
    };
    openOverlay();
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
    });
    expect(dash.state.overlay).toMatchObject({ submitting: false, error: expect.stringMatching(/timeout/i) });

    // Retry succeeds.
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
    });
    expect(dash.state.overlay).toBeNull();
    expect(answerCalls).toBe(2);

    // Timeout where the write actually landed → conflict copy, no second write.
    answerCalls = 0;
    getStatus = "answered";
    openOverlay();
    await dash.run({
      type: "action",
      action: { label: "Answer", op: "question.answer", params: { id: "q-1", answer: "yes", expect_rev: 1 } },
    });
    expect(answerCalls).toBe(1);
    expect(dash.state.overlay).toBeNull();
    expect(frames.at(-1)).toContain("This question changed; review it again.");
  });
});

describe("multi focus marker and empty-options overlay (B1 / N6)", () => {
  test("multi mode shows › with the checkbox under PLAIN_THEME", async () => {
    const { renderDashboard } = await import("../src/dashboard/render");
    const { detectTheme } = await import("../src/dashboard/theme");
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const plain = detectTheme({ PACER_PLAIN: "1" }, true, { plain: true });
    const text = renderDashboard(s, 80, 24, s.at, {
      theme: plain,
      state: {
        screen: "runs",
        overlay: {
          kind: "answer",
          title: "Pick betas",
          mode: "multi",
          options: [{ value: "2", label: "2 beta" }, { value: "3", label: "3 gamma" }],
          selected: ["2"],
          note: "",
          index: 0,
          phase: "choose",
          submit: () => ({ type: "navigate", screen: "runs" }),
        },
      },
      version: "0.0.0-test",
    });
    expect(text).toMatch(/>\s*\[x\]\s*1 2 beta/);
    expect(text).toContain("Pick betas");
  });

  test("options-less question offers a with a visible explanation", () => {
    const act = questionAnswerAct({
      question: q({ id: "q_n6emptyopt", answerType: "single", options: [] }),
      supports: () => true,
    });
    expect(act?.label).toBe("Answer");
    expect(act?.effect).toMatchObject({
      type: "answer-form",
      form: {
        emptyHint: 'This question has no options; answer it with pacer answer q_n6emptyopt "<your answer>"',
        options: [],
      },
    });
  });

  test("empty-options overlay wraps the full pacer answer command into view", async () => {
    const { renderDashboard } = await import("../src/dashboard/render");
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const qid = "q_n6emptyopt";
    const hint = `This question has no options; answer it with pacer answer ${qid} "<your answer>"`;
    const text = renderDashboard(s, 80, 24, s.at, {
      theme: PLAIN_THEME,
      state: {
        screen: "runs",
        overlay: {
          kind: "answer",
          title: "Broken multi",
          mode: "multi",
          options: [],
          emptyHint: hint,
          selected: [],
          note: "",
          index: 0,
          phase: "choose",
          submit: () => ({ type: "navigate", screen: "runs" }),
        },
      },
      version: "0.0.0-test",
    });
    const collapsed = text
      .replace(/[│┃╭╮╰╯─═]/g, " ")
      .replace(/\s+/g, " ");
    expect(collapsed).toContain(hint);
    expect(text).toContain(qid);
    expect(text).toContain('"<your answer>"');
  });
});

describe("approvals and human steps take an explicit choice", () => {
  const base = { id: "q_1", runId: "run_aaaaaaaaaa", text: "Publish?", blocks: "step", status: "open", answerer: "person", rev: 1 };
  const cases = [
    { ...base, answerType: "approve_revise", askerKind: "human_step" },
    { ...base, answerType: "approve_revise", askerKind: "executor" },
    { ...base, answerType: "yes_no", askerKind: "human_step" },
    { ...base, answerType: "single", askerKind: "human_step", options: [{ value: "merge" }, { value: "drop" }] },
  ];
  for (const question of cases) {
    test(`Enter alone does not answer ${question.answerType} from ${question.askerKind}`, () => {
      const opened = trigger(initialState("home"), { label: "Answer", effect: { type: "answer-form", form: formSpecForQuestion(question) } });
      expect(opened.state.overlay).toMatchObject({ kind: "answer", index: -1 });
      const ctx = runsCtx([]);
      const first = reduceKey(opened.state, "enter", ctx);
      expect(first.effect).toBeUndefined();
      expect(first.state.overlay).toMatchObject({ kind: "answer", error: expect.stringContaining("Choose first") });
      const chosen = reduceKey(reduceKey(opened.state, "down", ctx).state, "enter", ctx);
      expect(chosen.effect).toMatchObject({ type: "action", action: { op: "question.answer" } });
    });
  }
  test("an ordinary single choice keeps its first option ready", () => {
    expect(formSpecForQuestion({ ...base, answerType: "single", askerKind: "executor", options: [{ value: "a" }] }).explicit).toBeUndefined();
  });
});

describe("confirming a one-click human-step answer", () => {
  const action = { label: "Approve", op: "question.answer", params: { id: "q_1", expect_rev: 1, answer: "approve" }, confirm: "Answer \"approve\" to: Publish?" };
  const ctx = { s: snapshot(), supports: () => true } as unknown as Parameters<typeof serviceAct>[0];
  const open = () => trigger(initialState("home"), serviceAct(ctx, action)).state;
  test("Enter cancels; only y answers", () => {
    expect(open().overlay).toMatchObject({ kind: "confirm", defaultNo: true });
    const entered = reduceKey(open(), "enter", runsCtx([]));
    expect(entered.effect).toBeUndefined();
    expect(entered.state.overlay).toBeNull();
    expect(reduceKey(open(), "y", runsCtx([])).effect).toMatchObject({ type: "action", action: { op: "question.answer" } });
  });
  test("the dialog says that Enter cancels", () => {
    const text = renderDashboard(snapshot(), 100, 30, snapshot().at, { theme: PLAIN_THEME, state: open(), version: "0.0.0-test", ops: [] });
    expect(text).toContain("n/⏎/Esc Cancel");
    expect(text).not.toContain("y/⏎");
  });
  test("other confirmations keep Enter as yes", () => {
    const stop = serviceAct(ctx, { label: "Stop run", op: "run.stop", params: { id: "run_aaaaaaaaaa", expect_rev: 1 }, confirm: "Stop this run?" });
    const state = trigger(initialState("home"), stop).state;
    expect(reduceKey(state, "enter", runsCtx([])).effect).toBeDefined();
  });
});
