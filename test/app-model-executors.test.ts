import { expect, test } from "bun:test";
import { executorStatus, reorderRules } from "../app/src/model/executors";
test("executor states describe verified readiness and overrides", () => {
  const runner = { id: "opencode#local", state: "ok" as const, until: null, reason: null };
  expect(executorStatus(runner).label).toBe("Not tested");
  expect(executorStatus(runner, { name: "local", kind: "endpoint" }).label).toBe("External OpenCode provider");
  expect(executorStatus(runner, { name: "local", kind: "endpoint", state: "ready" }).label).toBe("Ready");
  expect(executorStatus({ ...runner, state: "blocked" }).label).toBe("Blocked until unblocked");
  expect(executorStatus({ ...runner, state: "exhausted", until: 100 }).label).toContain("Limited until");
  expect(executorStatus({ ...runner, state: "broken", reason: "key refused" }).detail).toBe("key refused");
});
test("reordering changes only the selected rule and retains the default last", () => {
  const rules = [{ kinds: ["docs"], executors: ["a", "b"] }, { executors: ["b", "a"] }];
  expect(reorderRules(rules, 0, 1, -1)).toEqual([{ kinds: ["docs"], executors: ["b", "a"] }, rules[1]]);
  expect(reorderRules(rules, 0, 0, -1)).toEqual(rules);
  expect(rules[0]!.executors).toEqual(["a", "b"]);
});
test("a past passing test never overrides a current failure or missing key", () => {
  const runner = { id: "opencode#local", state: "ok" as const, until: null, reason: null };
  expect(executorStatus(runner, { name: "local", kind: "endpoint", state: "not_working", connection: { checked_at: "yesterday", key: "present", models: [] } }).label).toBe("Not working");
  expect(executorStatus(runner, { name: "local", kind: "endpoint", state: "ready", connection: { key: "missing", models: [] } }).label).toBe("Not working · Key missing");
});
