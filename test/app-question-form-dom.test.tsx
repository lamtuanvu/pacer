/**
 * DOM interaction tests for QuestionForm payloads, revise note, and conflict Reload.
 */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { ApiError } from "../app/src/data/api";
import { Dialog } from "../app/src/ds/Dialog";
import { QUESTION_ANSWER_TOO_LONG, QUESTION_SUBMIT_ERROR } from "../src/view-model/runs";
import { enableFocusQueries, findAll, findAll as findAllIn, focusName, pressTab } from "./app-focus-dom";
import {
  CONFLICT_QUESTION,
  encodeMultiAnswer,
  QUESTION_ANSWER_MAX,
  QUESTION_NOTE_MAX,
  QuestionForm,
  type QuestionFormQuestion,
} from "../app/src/ds/QuestionForm";
import { validateQuestionAnswer } from "../src/workflow/question-schema";
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

function q(partial: Partial<QuestionFormQuestion> = {}): QuestionFormQuestion {
  return {
    id: "q_1",
    runId: "run_1",
    text: "Which approach?",
    answerType: "single",
    rev: 3,
    options: [
      { value: "ship", note: "Ship it" },
      { value: "hold", note: "Wait" },
    ],
    recommended: "ship",
    ...partial,
  };
}

type DomNode = {
  childNodes?: DomNode[];
  nodeType: number;
  tagName?: string;
  data?: string;
  value?: string;
  attrs?: Record<string, string>;
  _listeners?: Record<string, (e: unknown) => void>;
  l?: Record<string, (e: unknown) => void>;
  getAttribute?: (name: string) => string | null;
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

function findInput(root: DomNode, pred: (n: DomNode) => boolean) {
  return allNodes(root).find(n => {
    const tag = String(n.tagName || "").toLowerCase();
    return (tag === "input" || tag === "textarea") && pred(n);
  }) ?? null;
}

function fire(node: DomNode, type: string) {
  const event = {
    type,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    target: node,
    currentTarget: node,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() {},
  };
  const handler = node.l?.[`${type}false`] ?? node.l?.[`${type}true`] ?? node.l?.[type] ?? node._listeners?.[type];
  handler?.call(node, event);
}

function setControlValue(node: DomNode, value: string, eventType: "input" | "change") {
  node.value = value;
  node.attrs = { ...(node.attrs ?? {}), value };
  fire(node, eventType);
}

test("submit payloads: single, multi, text caps, yes_no, approve_revise note", async () => {
  const dom = installDom();
  try {
    const captured: Array<{ answer: string; note?: string; expect_rev: number }> = [];

    // --- single (recommended pre-selected) ---
    await mount(dom, <QuestionForm question={q({ answerType: "single", rev: 3 })} onSubmit={async input => { captured.push(input); }} />);
    await tick();
    submitForm(dom.container);
    await until(() => captured.length === 1, 2000);
    expect(captured[0]).toEqual({ answer: "ship", expect_rev: 3 });
    validateQuestionAnswer("single", captured[0]!.answer, q().options);
    await unmount(dom);

    // --- multi via encodeMultiAnswer matching server ---
    captured.length = 0;
    const multiQ = q({
      answerType: "multi",
      recommended: undefined,
      options: [{ value: "alpha" }, { value: "beta" }, { value: "gamma" }],
    });
    await mount(dom, <QuestionForm question={multiQ} onSubmit={async input => { captured.push(input); }} />);
    await tick();
    // Checkboxes are rendered in option order (alpha, beta, gamma); toggle alpha + gamma.
    const boxes = allNodes(dom.container as unknown as DomNode).filter(n =>
      String(n.tagName).toLowerCase() === "input" && n.getAttribute?.("type") === "checkbox");
    expect(boxes.length).toBe(3);
    fire(boxes[0]!, "change"); // alpha
    fire(boxes[2]!, "change"); // gamma
    await tick();
    submitForm(dom.container);
    await until(() => captured.length === 1, 2000);
    const expectedMulti = encodeMultiAnswer(multiQ.options!, ["alpha", "gamma"]);
    expect(expectedMulti).toBe("alpha,gamma");
    expect(captured[0]).toEqual({ answer: expectedMulti, expect_rev: 3 });
    validateQuestionAnswer("multi", captured[0]!.answer, multiQ.options);
    await unmount(dom);

    // --- text trim + 2000 cap ---
    captured.length = 0;
    await mount(dom, <QuestionForm question={q({ answerType: "text", options: undefined, recommended: undefined })} onSubmit={async input => { captured.push(input); }} />);
    await tick();
    const area = findInput(dom.container as unknown as DomNode, n => String(n.tagName).toLowerCase() === "textarea");
    expect(area).toBeTruthy();
    setControlValue(area!, `  ${"x".repeat(QUESTION_ANSWER_MAX + 50)}  `, "input");
    await tick();
    submitForm(dom.container);
    await until(() => captured.length === 1, 2000);
    expect(captured[0]!.answer).toBe("x".repeat(QUESTION_ANSWER_MAX));
    expect(captured[0]!.expect_rev).toBe(3);
    await unmount(dom);

    // --- yes_no ---
    captured.length = 0;
    await mount(dom, <QuestionForm
      question={q({ answerType: "yes_no", options: [{ value: "yes" }, { value: "no" }], recommended: "yes" })}
      onSubmit={async input => { captured.push(input); }}
    />);
    await tick();
    submitForm(dom.container);
    await until(() => captured.length === 1, 2000);
    expect(captured[0]).toEqual({ answer: "yes", expect_rev: 3 });
    validateQuestionAnswer("yes_no", captured[0]!.answer, [{ value: "yes" }, { value: "no" }]);
    await unmount(dom);

    // --- approve_revise: revise note required (whitespace-only disables Submit) ---
    captured.length = 0;
    await mount(dom, <QuestionForm
      question={q({
        answerType: "approve_revise",
        options: [{ value: "approve" }, { value: "revise" }],
        recommended: "approve",
      })}
      onSubmit={async input => { captured.push(input); }}
    />);
    await tick();
    const revise = findInput(dom.container as unknown as DomNode, n => n.getAttribute?.("type") === "radio" && n.getAttribute?.("value") === "revise");
    expect(revise).toBeTruthy();
    fire(revise!, "change");
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    const noteInput = allNodes(dom.container as unknown as DomNode).find(n => {
      if (String(n.tagName).toLowerCase() !== "input") return false;
      if (n.getAttribute?.("type") === "radio" || n.getAttribute?.("type") === "checkbox") return false;
      return true;
    });
    expect(noteInput).toBeTruthy();
    setControlValue(noteInput!, "   ", "input");
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    setControlValue(noteInput!, "please polish", "input");
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);
    submitForm(dom.container);
    await until(() => captured.length === 1, 2000);
    expect(captured[0]).toEqual({ answer: "revise", note: "please polish", expect_rev: 3 });
    expect(captured[0]!.note!.length).toBeLessThanOrEqual(QUESTION_NOTE_MAX);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("single option values are not silently truncated by QUESTION_ANSWER_MAX", async () => {
  const dom = installDom();
  try {
    const longOption = "o".repeat(QUESTION_ANSWER_MAX + 25);
    const payloads: Array<{ answer: string }> = [];
    await mount(dom, <QuestionForm
      question={q({
        answerType: "single",
        options: [{ value: longOption }, { value: "hold" }],
        recommended: longOption,
      })}
      onSubmit={async input => { payloads.push(input); }}
    />);
    await tick();
    submitForm(dom.container);
    await until(() => payloads.length === 1, 2000);
    expect(payloads[0]!.answer).toBe(longOption);
    expect(payloads[0]!.answer.length).toBeGreaterThan(QUESTION_ANSWER_MAX);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("Submit shows a visible aria-describedby hint when disabled for incomplete input", async () => {
  const dom = installDom();
  try {
    // approve_revise + revise + empty/whitespace note
    await mount(dom, <QuestionForm
      question={q({
        answerType: "approve_revise",
        options: [{ value: "approve" }, { value: "revise" }],
        recommended: "approve",
      })}
      onSubmit={async () => {}}
    />);
    await tick();
    const revise = findInput(dom.container as unknown as DomNode, n => n.getAttribute?.("type") === "radio" && n.getAttribute?.("value") === "revise");
    fire(revise!, "change");
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain("Add a revision note to submit");
    const submit = allNodes(dom.container as unknown as DomNode).find(n => {
      const walk = (node: DomNode): string => {
        if (node.nodeType === 3) return String(node.data ?? "");
        return (node.childNodes ?? []).map(walk).join("");
      };
      return walk(n).trim() === "Submit answer" && String(n.tagName).toLowerCase() === "button";
    });
    const describedBy = submit?.getAttribute?.("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(allNodes(dom.container as unknown as DomNode).some(n => n.getAttribute?.("id") === describedBy)).toBe(true);
    await unmount(dom);

    // text empty
    await mount(dom, <QuestionForm
      question={q({ answerType: "text", options: undefined, recommended: undefined })}
      onSubmit={async () => {}}
    />);
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain("Write an answer to submit");
    await unmount(dom);

    // multi nothing selected
    await mount(dom, <QuestionForm
      question={q({
        answerType: "multi",
        options: [{ value: "docs" }, { value: "tests" }],
        recommended: undefined,
      })}
      onSubmit={async () => {}}
    />);
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain("Choose at least one option");
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("conflict keeps controls disabled until Reload brings a fresh rev, then resubmit works", async () => {
  const dom = installDom();
  try {
    let submits = 0;
    let current = q({ rev: 1 });
    let reloads = 0;

    const renderForm = async () => {
      await mount(
        dom,
        <QuestionForm
          key={`${current.id}:${current.rev}`}
          question={current}
          focusTitle={reloads > 0}
          onSubmit={async input => {
            submits++;
            if (input.expect_rev !== current.rev) {
              throw new ApiError("conflict", "stale rev");
            }
            if (current.rev === 1) {
              throw new ApiError("conflict", "stale rev");
            }
          }}
          onConflict={() => {
            reloads++;
            current = q({ rev: 2, text: "Which approach? (edited)" });
          }}
        />,
      );
    };

    await renderForm();
    await tick();
    expect(domText(dom.container)).toContain("Which approach?");
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);

    submitForm(dom.container);
    await until(() => domText(dom.container).includes("This question changed")
      || domText(dom.container).includes(CONFLICT_QUESTION), 2000);
    expect(domText(dom.container)).toContain("This question changed");
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain("Reload");

    clickText(dom.container, "Reload");
    await tick();
    expect(reloads).toBe(1);
    await unmount(dom);
    await renderForm();
    await tick();

    expect(domText(dom.container)).toContain("(edited)");
    expect(domText(dom.container)).not.toContain("This question changed");
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);

    const before = submits;
    submitForm(dom.container);
    await until(() => submits > before, 2000);
    expect(submits).toBeGreaterThan(before);
    expect(domText(dom.container)).not.toContain("This question changed");
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("Dialog cycleDialogFocus still traps Tab at both ends", async () => {
  const { cycleDialogFocus } = await import("../app/src/ds/Dialog");
  const focused: string[] = [];
  const element = (name: string) => ({
    focus: () => focused.push(name),
    matches: () => false,
    closest: () => null,
    getClientRects: () => [1],
  }) as unknown as HTMLElement;
  const first = element("first"), last = element("last");
  const dialog = {
    querySelectorAll: () => [first, last],
    ownerDocument: { activeElement: last },
  } as unknown as HTMLDialogElement;
  let prevented = 0;
  cycleDialogFocus(dialog, { key: "Tab", shiftKey: false, preventDefault: () => { prevented++; } });
  expect(focused).toEqual(["first"]);
  (dialog.ownerDocument as { activeElement: unknown }).activeElement = first;
  cycleDialogFocus(dialog, { key: "Tab", shiftKey: true, preventDefault: () => { prevented++; } });
  expect(focused).toEqual(["first", "last"]);
  expect(prevented).toBe(2);
});

test("Tab order in the answer dialog: heading, one radio stop, note, submit, then Close", async () => {
  const dom = installDom();
  try {
    enableFocusQueries(dom);
    const question = q({
      answerType: "approve_revise",
      options: [{ value: "approve" }, { value: "revise" }],
      recommended: "approve",
    });
    await mount(dom, (
      <Dialog title="Answer question" close={() => {}}>
        <QuestionForm question={question} context="Asked by run B: Ship board" onSubmit={async () => {}} />
      </Dialog>
    ));
    await tick();
    expect(focusName(dom.doc.activeElement)).toBe("h2:Which approach?");
    const order = [1, 2, 3, 4, 5].map(() => pressTab(dom));
    expect(order).toEqual(["radio:approve", "input", "button:Submit answer", "button:Close", "radio:approve"]);
    expect(pressTab(dom, true)).toBe("button:Close");
    // The heading is described by the line that names the asking run.
    const title = findAll(dom.container, n => n.localName === "h2" && n.attrs["data-autofocus"] !== undefined)[0];
    const context = findAll(dom.container, n => n.localName === "p" && n.attrs.id === title.attrs["aria-describedby"])[0];
    expect(domText(context)).toBe("Asked by run B: Ship board");
    await unmount(dom);
  } finally {
    dom.restore();
  }
});

const liveRegions = (root: unknown) => findAllIn(root, n => n.attrs?.["aria-live"] === "polite");

test("live region announces option labels, and text questions have none", async () => {
  const dom = installDom();
  try {
    await mount(dom, <QuestionForm question={q({ answerType: "yes_no", options: undefined, recommended: "yes" })} onSubmit={async () => {}} />);
    await tick();
    expect(liveRegions(dom.container).map(domText)).toEqual(["Selected Yes"]);
    await unmount(dom);
    await mount(dom, <QuestionForm question={q({ answerType: "multi", options: [{ value: "docs" }, { value: "tests" }], recommended: "docs" })} onSubmit={async () => {}} />);
    await tick();
    expect(liveRegions(dom.container).map(domText)).toEqual(["Selected docs"]);
    await unmount(dom);
    await mount(dom, <QuestionForm question={q({ answerType: "text", options: undefined, recommended: undefined })} onSubmit={async () => {}} />);
    await tick();
    expect(liveRegions(dom.container)).toEqual([]);
    expect(domText(dom.container)).not.toContain("No answer selected");
    await unmount(dom);
  } finally {
    dom.restore();
  }
});

test("a multi answer over the cap is refused with a reason, never sliced", async () => {
  const dom = installDom();
  try {
    const long = ["a", "b", "c"].map(letter => ({ value: letter.repeat(900) }));
    const sent: string[] = [];
    await mount(dom, <QuestionForm question={q({ answerType: "multi", options: long, recommended: long[0]!.value })} onSubmit={async input => { sent.push(input.answer); }} />);
    await tick();
    const boxes = () => allNodes(dom.container as unknown as DomNode).filter(n => n.getAttribute?.("type") === "checkbox");
    await act(async () => { fire(boxes()[1]!, "change"); });
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);
    await act(async () => { fire(boxes()[2]!, "change"); });
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    expect(domText(dom.container)).toContain(QUESTION_ANSWER_TOO_LONG);
    await act(async () => { submitForm(dom.container); });
    await tick();
    expect(sent).toEqual([]);
    await unmount(dom);
  } finally {
    dom.restore();
  }
});

test("a failed submit shows plain words, not the service message", async () => {
  const dom = installDom();
  try {
    await mount(dom, <QuestionForm question={q()} onSubmit={async () => { throw new ApiError("internal", "question.answer exploded: SQLITE_BUSY"); }} />);
    await tick();
    await act(async () => { submitForm(dom.container); });
    await until(() => domText(dom.container).includes("Could not submit"), 2000);
    expect(domText(dom.container)).toContain(QUESTION_SUBMIT_ERROR);
    expect(domText(dom.container)).not.toContain("SQLITE_BUSY");
    expect(domText(dom.container)).not.toContain("question.answer");
    await unmount(dom);
  } finally {
    dom.restore();
  }
});

test("without question.answer the form has no submit control", async () => {
  const dom = installDom();
  try {
    await mount(dom, <QuestionForm question={q()} canAnswer={false} onSubmit={async () => {}} />);
    await tick();
    expect(domText(dom.container)).not.toContain("Submit answer");
    await unmount(dom);
  } finally {
    dom.restore();
  }
});
