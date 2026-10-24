import { expect, test } from "bun:test";
import { runDecision, ladderEngine } from "../src/dispatch/engines";
import { request } from "./fixtures/dispatch";

test("replacement engine changes recommendation without changing executor bindings", async () => {
  const r = request();
  const other = { id: "reverse", version: "1", async decide(input: typeof r) { return { state: "ranked" as const, choices: [...input.candidates].reverse().map(c => ({ id: c.id, reason: "test", factors: [] })), step: "external", skipped: [] }; } };
  const preview = await runDecision(r, other);
  expect(preview.validation).toBe("valid");
  expect(preview.proposal).toMatchObject({ choices: [{ id: "b" }, { id: "a" }] });
  expect(preview.inputHash).toHaveLength(64);
  expect((await runDecision(r, ladderEngine)).proposal).toMatchObject({ choices: [{ id: "a" }] });
});
test("invalid, duplicated, timed out and mutated proposals never select a runner", async () => {
  const engine = (decide: (input: ReturnType<typeof request>) => Promise<unknown>) => ({ id: "test", version: "1", decide });
  for (const ids of [["forged"], ["a", "a"]]) {
    const result = await runDecision(request(), engine(async () => ({ state: "ranked", choices: ids.map(id => ({id, reason: "", factors: []})), step: "x", skipped: [] })));
    expect(result.validation).toBe("invalid"); expect(result.recommendedAction).toBe("queue"); expect(result.proposal).toBeNull();
  }
  const r = request(); r.config.timeoutMs = 5;
  expect((await runDecision(r, engine(() => new Promise(() => {})))).validation).toBe("timeout");
  expect((await runDecision(request(), engine(async input => { input.candidates.splice(0); return {}; }))).validation).toBe("invalid");
  expect((await runDecision(request(), engine(async () => ({state: "abstain", reason: "unknown", skipped: []})))).validation).toBe("valid");
});
test("absolute deadlines reject stale requests and late engine output", async () => {
  const r = request(); r.now = 100; r.deadline = 101;
  expect((await runDecision(r, ladderEngine, () => 102)).validation).toBe("timeout");
  let now = 100;
  const engine = {id: "late", version: "1", async decide() {now = 102; return {state: "abstain", reason: "late", skipped: []};}};
  expect((await runDecision(r, engine, () => now)).validation).toBe("timeout");
});
