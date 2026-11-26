/**
 * RunsPage-level DOM tests for real reloadAnswer wiring and submit note spread.
 */
import { expect, test } from "bun:test";
import type { AttentionItem } from "../src/attention/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { CONFLICT_QUESTION } from "../src/view-model/runs";
import { ApiError, type BrowserApi } from "../app/src/data/api";
import { initialState, type StoreState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { RunsPage } from "../app/src/screens/runs/RunsPage";
import { act } from "preact/test-utils";
import {
  clickText,
  domText,
  installDom,
  isDisabled,
  mount,
  submitForm,
  tick,
  until,
  unmount,
} from "./app-setup-health-dom";

function attentionItem(rev: number, text = "Which approach?"): AttentionItem {
  return {
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
      rev,
      answerType: "single",
      text,
      blocks: "run",
      options: [{ value: "ship" }, { value: "hold" }],
      recommended: "ship",
    },
  };
}

function baseState(item: AttentionItem): StoreState {
  const state = initialState();
  return {
    ...state,
    connected: true,
    features: {
      readModel: true,
      ops: new Set(["run.list", "run.get", "run.seen", "question.answer", "question.get"]),
    },
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
  };
}

type DomNode = {
  childNodes?: DomNode[];
  nodeType: number;
  tagName?: string;
  data?: string;
  value?: string;
  _listeners?: Record<string, (e: unknown) => void>;
  l?: Record<string, (e: unknown) => void>;
  getAttribute?: (name: string) => string | null;
  click?: () => void;
};

function allNodes(root: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 1) out.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return out;
}

function clickByText(root: DomNode, text: string) {
  const node = allNodes(root).find(n => {
    const walk = (node: DomNode): string => {
      if (node.nodeType === 3) return String(node.data ?? "");
      return (node.childNodes ?? []).map(walk).join("");
    };
    const t = walk(n).trim();
    return t === text && (String(n.tagName).toLowerCase() === "a" || String(n.tagName).toLowerCase() === "button");
  });
  if (!node?.click) throw new Error(`clickByText: no control with text "${text}"`);
  node.click();
}

test("RunsPage reloadAnswer refetches question.get rev then resubmit succeeds", async () => {
  const dom = installDom();
  try {
    let serverRev = 1;
    const answerCalls: Array<Record<string, unknown>> = [];
    let getCalls = 0;

    const api: BrowserApi = {
      hello: async () => ({
        protocol: "3.0.0",
        pacer: "0.0.0-test",
        ops: ["run.list", "run.get", "run.seen", "question.answer", "question.get"],
        events: [],
      }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
      call: async <T,>(op: string, params?: unknown) => {
        if (op === "run.list") {
          return [{
            id: "run_1",
            workflow: "pacer-dev/dev",
            title: "Ship board",
            status: "waiting",
            priority: "urgent",
            letter: "B",
            createdAt: 800,
          }] as T;
        }
        if (op === "question.get") {
          getCalls++;
          return {
            id: "q_1",
            runId: "run_1",
            rev: serverRev,
            answerType: "single",
            text: serverRev > 1 ? "Which approach? (edited)" : "Which approach?",
            blocks: "run",
            options: [{ value: "ship" }, { value: "hold" }],
            recommended: "ship",
            status: "open",
          } as T;
        }
        if (op === "question.answer") {
          const p = params as { expect_rev: number; answer: string; note?: string };
          answerCalls.push(p);
          if (p.expect_rev !== serverRev) throw new ApiError("conflict", "stale rev");
          return {} as T;
        }
        return {} as T;
      },
    };

    // Snapshot attention stays at rev 1 — Reload must not rely on it.
    await mount(dom, (
      <TaskContext.Provider value={{ state: baseState(attentionItem(1)), api }}>
        <RunsPage query={{ repo: null, scope: null }} />
      </TaskContext.Provider>
    ));
    await tick();
    await until(() => domText(dom.container).includes("Ship board"), 2000);

    clickByText(dom.container as unknown as DomNode, "Answer");
    await tick();
    await until(() => domText(dom.container).includes("Submit answer"), 2000);

    // Stale submit while server already moved ahead.
    serverRev = 2;
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("This question changed")
      || domText(dom.container).includes(CONFLICT_QUESTION), 2000);
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain("Reload");

    clickText(dom.container, "Reload");
    await until(() => getCalls >= 1 && domText(dom.container).includes("(edited)"), 3000);
    expect(getCalls).toBeGreaterThanOrEqual(1);
    expect(domText(dom.container)).not.toContain("This question changed");
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);

    const before = answerCalls.length;
    submitForm(dom.container);
    await until(() => answerCalls.length > before, 2000);
    expect(answerCalls.at(-1)).toMatchObject({ answer: "ship", expect_rev: 2 });
    await until(() => domText(dom.container).includes("Answer submitted"), 2000);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("RunsPage Reload failure shows error inside the dialog with Close available", async () => {
  const dom = installDom();
  try {
    let answerAttempt = 0;
    const api: BrowserApi = {
      hello: async () => ({
        protocol: "3.0.0",
        pacer: "0",
        ops: ["run.list", "question.answer", "question.get"],
        events: [],
      }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
      call: async <T,>(op: string, params?: unknown) => {
        if (op === "run.list") {
          return [{
            id: "run_1", workflow: "pacer-dev/dev", title: "Ship board",
            status: "waiting", priority: "urgent", letter: "B", createdAt: 800,
          }] as T;
        }
        if (op === "question.answer") {
          answerAttempt++;
          throw new ApiError("conflict", "stale rev");
        }
        if (op === "question.get") {
          throw new ApiError("internal", "reload boom");
        }
        return {} as T;
      },
    };

    await mount(dom, (
      <TaskContext.Provider value={{ state: baseState(attentionItem(1)), api }}>
        <RunsPage query={{ repo: null, scope: null }} />
      </TaskContext.Provider>
    ));
    await tick();
    clickByText(dom.container as unknown as DomNode, "Answer");
    await until(() => domText(dom.container).includes("Submit answer"), 2000);
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("Reload"), 2000);
    clickText(dom.container, "Reload");
    await until(() => domText(dom.container).includes("Couldn't reload this question. Close and try again."), 3000);
    expect(domText(dom.container)).toContain("Couldn't reload this question. Close and try again.");
    expect(domText(dom.container)).not.toContain("question.get");
    expect(domText(dom.container)).not.toContain("reload boom");
    expect(domText(dom.container)).toContain("Close");
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("RunsPage Reload keeps conflict when question.get returns the same rev", async () => {
  const dom = installDom();
  try {
    let getCalls = 0;
    const api: BrowserApi = {
      hello: async () => ({
        protocol: "3.0.0", pacer: "0",
        ops: ["run.list", "question.answer", "question.get"], events: [],
      }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
      call: async <T,>(op: string, params?: unknown) => {
        if (op === "run.list") {
          return [{
            id: "run_1", workflow: "pacer-dev/dev", title: "Ship board",
            status: "waiting", priority: "urgent", letter: "B", createdAt: 800,
          }] as T;
        }
        if (op === "question.answer") throw new ApiError("conflict", "stale rev");
        if (op === "question.get") {
          getCalls++;
          return {
            id: "q_1", runId: "run_1", rev: 1, status: "open",
            answerType: "single", text: "Which approach?", blocks: "run",
            options: [{ value: "ship" }, { value: "hold" }], recommended: "ship",
            artifact: "art_keep", stepId: "gate", attempt: 1, branch: "main",
          } as T;
        }
        return {} as T;
      },
    };

    await mount(dom, (
      <TaskContext.Provider value={{ state: baseState(attentionItem(1)), api }}>
        <RunsPage query={{ repo: null, scope: null }} />
      </TaskContext.Provider>
    ));
    await tick();
    clickByText(dom.container as unknown as DomNode, "Answer");
    await until(() => domText(dom.container).includes("Submit answer"), 2000);
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("Reload"), 2000);
    clickText(dom.container, "Reload");
    await until(() => getCalls >= 1, 3000);
    expect(domText(dom.container)).toContain("This question changed");
    expect(domText(dom.container)).toContain("Reload");
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("RunsPage Reload closes the form when question.get is no longer open", async () => {
  const dom = installDom();
  try {
    let getCalls = 0;
    const api: BrowserApi = {
      hello: async () => ({
        protocol: "3.0.0", pacer: "0",
        ops: ["run.list", "question.answer", "question.get"], events: [],
      }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
      call: async <T,>(op: string) => {
        if (op === "run.list") {
          return [{
            id: "run_1", workflow: "pacer-dev/dev", title: "Ship board",
            status: "waiting", priority: "urgent", letter: "B", createdAt: 800,
          }] as T;
        }
        if (op === "question.answer") throw new ApiError("conflict", "stale rev");
        if (op === "question.get") {
          getCalls++;
          return {
            id: "q_1", runId: "run_1", rev: 2, status: "withdrawn",
            answerType: "single", text: "Which approach?", blocks: "run",
            options: [{ value: "ship" }],
          } as T;
        }
        return {} as T;
      },
    };

    await mount(dom, (
      <TaskContext.Provider value={{ state: baseState(attentionItem(1)), api }}>
        <RunsPage query={{ repo: null, scope: null }} />
      </TaskContext.Provider>
    ));
    await tick();
    clickByText(dom.container as unknown as DomNode, "Answer");
    await until(() => domText(dom.container).includes("Submit answer"), 2000);
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("Reload"), 2000);
    clickText(dom.container, "Reload");
    await until(() => getCalls >= 1 && domText(dom.container).includes("This question is no longer open"), 3000);
    expect(domText(dom.container)).toContain("This question is no longer open");
    expect(domText(dom.container)).not.toContain("Submit answer");
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("pickAnsweringQuestion prefers the higher rev between reloaded and queue", async () => {
  const { pickAnsweringQuestion } = await import("../app/src/screens/runs/RunsPage");
  const base = {
    id: "q_1",
    runId: "run_1",
    text: "Q",
    answerType: "single" as const,
    rev: 2,
  };
  const reloaded = { ...base, rev: 2, text: "reloaded-2" };
  const fromQueue = {
    question: { ...base, rev: 5, text: "queue-5" },
    itemTitle: "Ship board",
  };
  const picked = pickAnsweringQuestion({
    answerId: "q_1",
    reloaded,
    fromQueue,
    held: { question: { ...base, rev: 1 }, itemTitle: "held" },
  });
  expect(picked?.question.rev).toBe(5);
  expect(picked?.question.text).toBe("queue-5");

  const kept = pickAnsweringQuestion({
    answerId: "q_1",
    reloaded: { ...base, rev: 4, text: "reloaded-4" },
    fromQueue: { question: { ...base, rev: 3, text: "queue-3" }, itemTitle: "Ship board" },
    held: null,
  });
  expect(kept?.question.rev).toBe(4);
  expect(kept?.question.text).toBe("reloaded-4");
});

test("RunsPage submitAnswer spreads note into question.answer params", async () => {
  const dom = installDom();
  try {
    const answerCalls: Array<Record<string, unknown>> = [];
    const item = attentionItem(1);
    item.question = {
      ...item.question!,
      answerType: "approve_revise",
      text: "Publish?",
      options: [{ value: "approve" }, { value: "revise" }],
      recommended: "revise",
    };
    const api: BrowserApi = {
      hello: async () => ({
        protocol: "3.0.0", pacer: "0",
        ops: ["run.list", "question.answer", "question.get"], events: [],
      }),
      snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
      call: async <T,>(op: string, params?: unknown) => {
        if (op === "run.list") {
          return [{
            id: "run_1", workflow: "pacer-dev/dev", title: "Ship board",
            status: "waiting", priority: "urgent", letter: "B", createdAt: 800,
          }] as T;
        }
        if (op === "question.answer") {
          answerCalls.push(params as Record<string, unknown>);
          return {} as T;
        }
        return {} as T;
      },
    };

    await mount(dom, (
      <TaskContext.Provider value={{ state: baseState(item), api }}>
        <RunsPage query={{ repo: null, scope: null }} />
      </TaskContext.Provider>
    ));
    await tick();
    // Let the initial run.list refresh settle before opening the dialog.
    await new Promise(resolve => setTimeout(resolve, 40));
    await act(async () => { clickByText(dom.container as unknown as DomNode, "Answer"); });
    await until(() => domText(dom.container).includes("Revision note"), 2000);
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);

    await act(async () => {
      const noteNode = allNodes(dom.container as unknown as DomNode).find(n => {
        if (String(n.tagName).toLowerCase() !== "input") return false;
        const type = n.getAttribute?.("type");
        return type !== "radio" && type !== "checkbox";
      });
      if (!noteNode) throw new Error("revision note input missing");
      noteNode.value = "needs polish";
      const event = {
        type: "input",
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        target: noteNode,
        currentTarget: noteNode,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() {},
      };
      const handler = noteNode.l?.inputfalse ?? noteNode.l?.inputtrue ?? noteNode.l?.input ?? noteNode._listeners?.input;
      if (!handler) throw new Error("note input has no input handler");
      handler.call(noteNode, event);
    });
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);
    await act(async () => { submitForm(dom.container); });
    await until(() => answerCalls.length === 1, 2000);
    expect(answerCalls[0]).toMatchObject({
      id: "q_1",
      answer: "revise",
      expect_rev: 1,
      note: "needs polish",
    });
  } finally {
    await unmount(dom);
    dom.restore();
  }
});
