import { describe, expect, test } from "bun:test";
import { assistantEntry } from "../app/src/shell/assistant-entry";
import { cardFailure, cardParams, defaultScope, parseFrames, scopeChoices } from "../app/src/shell/assistant/model";
import type { ActionCard } from "../src/assistant/types";

const card = (over: Partial<ActionCard> = {}): ActionCard => ({ id: "c", op: "dispatch.retry", params: { id: "t-1", expect_rev: 4 }, title: "Retry", summary: "s", editable: [{ name: "feedback", label: "Feedback", value: "" }], why: "", state: "pending", ...over });

describe("assistant app model", () => {
  test("scope choices appear only where a task or repository is in view, and a task wins by default", () => {
    expect(scopeChoices({}).map(c => c.value)).toEqual(["dispatch"]);
    const both = scopeChoices({ taskId: "t-1", repo: "/r", repoLabel: "node" });
    expect(both.map(c => c.value)).toEqual(["task", "dispatch", "repo"]);
    expect(both[2]!.label).toBe("Repository · node");
    expect(defaultScope(both)).toBe("task");
    expect(defaultScope(scopeChoices({ repo: "/r" }), "repo")).toBe("repo");
    expect(defaultScope(scopeChoices({}), "repo")).toBe("dispatch");
  });
  test("stream frames parse across chunk boundaries and ignore malformed ones", () => {
    const a = parseFrames('data: {"status":"Thinking…"}\n\ndata: {"del');
    expect(a.frames).toEqual([{ status: "Thinking…" }]);
    const b = parseFrames(`${a.rest}ta":"hi"}\n\ndata: not json\n\ndata: {"done":{"state":"done"}}\n\n`);
    expect(b.frames).toEqual([{ delta: "hi" }, { done: { state: "done" } }]);
    expect(b.rest).toBe("");
    expect(parseFrames(": keepalive\n\n").frames).toEqual([]);
  });
  test("edited card fields override the proposal, and an emptied optional field is dropped", () => {
    expect(cardParams(card(), { feedback: " use the cache " })).toEqual({ id: "t-1", expect_rev: 4, feedback: "use the cache" });
    expect(cardParams(card(), {})).toEqual({ id: "t-1", expect_rev: 4 });
    const answer = card({ op: "dispatch.answer", editable: [{ name: "text", label: "Answer", value: "yes" }], params: { id: "t-1", expect_rev: 4, text: "yes" } });
    expect(cardParams(answer, { text: "no" }).text).toBe("no");
  });
  test("a conflict reads as a stale card, never as a code", () => {
    expect(cardFailure({ code: "conflict" })).toMatchObject({ state: "stale" });
    expect(cardFailure({ code: "conflict" }).message).not.toMatch(/conflict/i);
    expect(cardFailure({ code: "not_allowed", message: "Paused." })).toEqual({ state: "failed", message: "Paused." });
  });
  test("the entry point delivers a request made before the sheet loaded, once, and reports availability", () => {
    const seen: unknown[] = [];
    assistantEntry.ask({ text: "early", newConversation: true });
    const off = assistantEntry.listen(r => seen.push(r));
    expect(seen).toEqual([{ text: "early", newConversation: true }]);
    assistantEntry.ask({ text: "later" });
    expect(seen).toHaveLength(2);
    off();
    let changes = 0;
    const stop = assistantEntry.watch(() => changes++);
    assistantEntry.setAvailable(true); assistantEntry.setAvailable(true); assistantEntry.setAvailable(false);
    expect([changes, assistantEntry.available()]).toEqual([2, false]);
    stop();
  });
});
