import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { homeModel } from "../app/src/model/home";

test("home derives planner pace without treating missing quota as zero", () => {
  expect(homeModel(emptySnapshot(), []).planner).toBeNull();
  const snapshot = { ...emptySnapshot(), budget: { generatedAt: 1, planner: "claude-code", strategy: "default", mode: "strict", providers: [{ id: "claude-code", verdict: "AHEAD", usedPct: 70, pacePct: 40, resetsAt: 900, window: "weekly", stale: false }], ranked: [] } };
  const model = homeModel(snapshot, []);
  expect(model.planner).toMatchObject({ used: 70, pace: 40, tone: "warn", resetsAt: 900 });
  expect(model.mode).toBe("strict");
  expect(model.headline).toContain("ahead of pace");
});

test("attention includes unreviewed work, limits and broken runners once; running excludes dismissed", () => {
  const task = { id: "t1", goal: "Review me", state: "done", executor: "codex", backend: null, worktree: null, updatedAt: 1 };
  const snapshot = { ...emptySnapshot(), tasks: [task, { ...task, id: "t2", review: { accepted: true, kind: null, note: null, at: 1 } }, { ...task, id: "t3", state: "running" }] };
  const model = homeModel(snapshot, [{ id: "cursor", state: "exhausted", until: 900, reason: null }, { id: "local", state: "broken", until: null, reason: "Key rejected" }]);
  expect(model.attention.map(a => a.label)).toEqual(["Review", "Limit", "Not working"]);
  expect(model.attention[0]?.href).toBe("#/tasks/t1");
  expect(model.attention[2]?.detail).toContain("Key rejected");
  expect(model.running.map(t => t.id)).toEqual(["t3"]);
});
