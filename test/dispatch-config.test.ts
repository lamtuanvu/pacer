import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { parseDispatchConfig } from "../src/config/dispatch";
import { observationSchema, modelRecordSchema, modelBindingSchema } from "../src/dispatch/types";

test("dispatch configuration is opt-in and rejects unsupported options", () => {
  expect(parseDispatchConfig(undefined)).toBeUndefined();
  expect(() => parseDispatchConfig({ engine: "remote" })).toThrow();
  expect(() => parseDispatchConfig({ engine: "ladder", hidden: true })).toThrow();
  expect(parseDispatchConfig({})!.steps[0].capacity).toBe("comfortable");
});

test("runner model declarations preserve defaults and reject duplicates", () => {
  const raw = { planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" } }, runners: { codex: { models: [{ id: "provider/a", tier: "medium" }] } } };
  const s = validateStrategy(raw, "test");
  expect(s.runners.codex.models).toEqual([{ id: "provider/a", tier: "medium", strengths: [] }]);
  expect(s.runners.codex.model).toBeNull();
  expect(() => validateStrategy({ ...raw, runners: { codex: { models: [{ id: "x" }, { id: "x" }] } } }, "test")).toThrow();
  expect(modelBindingSchema.parse({ kind: "executor-default" })).toEqual({ kind: "executor-default" });
});

test("model evidence preserves exact binding scope and observed provenance", () => {
  const observation = observationSchema.parse({ source: "test", scope: {runner: "codex", account: "codex", binding: {kind: "exact", id: "provider/a"}}, method: "capabilities", state: "known", observedAt: 1, expiresAt: 2, value: {tools: true} });
  expect(observation.scope.binding).toEqual({kind: "exact", id: "provider/a"});
  expect(modelRecordSchema.parse({runner: "codex", account: "codex", executor: "codex", binding: {kind: "exact", id: "provider/a"}, actualModel: null, tier: "unknown", strengths: [], provenance: "observed"}).provenance).toBe("observed");
});
