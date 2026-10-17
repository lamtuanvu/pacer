import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { attentionGroups, attentionText } from "../src/view-model/panel";

test("panel preserves older service heuristics when attention is absent", () => {
  const task = { id: "t1", goal: "Fix it", state: "failed", executor: "codex", backend: null, worktree: null, updatedAt: 100 };
  const groups = attentionGroups({ ...emptySnapshot(), tasks: [task] }, 200);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.latest.id).toBe("t1");
  expect(attentionText(groups[0]!, 200)).toContain("Failed");
  expect(attentionGroups({ ...emptySnapshot(), tasks: [task], attention: [] }, 200)).toEqual([]);
});

test("panel uses service items including non-task items in service order", () => {
  const item = { id: "setup:x", kind: "setup" as const, severity: "decide" as const, repo: null, title: "Set up", detail: "Service detail", raisedAt: 1, since: 1, notify: "all" as const, actions: [] };
  const groups = attentionGroups({ ...emptySnapshot(), attention: [item, { ...item, id: "setup:y", title: "Next" }] }, 999999);
  expect(groups.map(g => g.goal)).toEqual(["Set up", "Next"]);
  expect(attentionText(groups[0]!, 999999)).toBe("Service detail");
  expect(groups[0]?.tasks).toEqual([]);
});
