/**
 * DOM interaction tests for QuestionForm conflict → Reload → resubmit.
 * Uses the shared app DOM harness (test/app-setup-health-dom.ts).
 */
import { expect, test } from "bun:test";
import { ApiError } from "../app/src/data/api";
import { CONFLICT_QUESTION, QuestionForm, type QuestionFormQuestion } from "../app/src/ds/QuestionForm";
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
    rev: 1,
    options: [
      { value: "ship", note: "Ship it" },
      { value: "hold", note: "Wait" },
    ],
    recommended: "ship",
    ...partial,
  };
}

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

    // First submit hits conflict (rev still 1).
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("This question changed")
      || domText(dom.container).includes(CONFLICT_QUESTION), 2000);
    expect(domText(dom.container)).toContain("This question changed");
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    // Reload is offered after conflict (N6 live driver asserts focus lands on it).
    expect(domText(dom.container)).toContain("Reload");

    // Reload refreshes to rev 2 and remounts a clean form.
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
