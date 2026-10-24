import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { makeCtx } from "../src/ctx";
import { buildModelInventory } from "../src/dispatch/inventory";
import { collectObservations, type ObservationAdapter } from "../src/dispatch/observations";

const scope = { runner: "codex", account: "codex" };
test("discovery never widens runner permission or invents default identity", () => {
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "test");
  const inventory = buildModelInventory(s, [{ source: "discovery", scope, method: "models", state: "known", observedAt: 1, expiresAt: 100, value: { models: [{ id: "unapproved", tier: "frontier", strengths: [] }] } }]);
  const model = inventory.find(m => m.runner === "codex")!;
  expect(model.binding).toEqual({ kind: "executor-default" });
  expect(model.actualModel).toBeNull();
  expect(model.tier).toBe("unknown");
  expect(inventory.filter(m => m.runner === "codex")).toHaveLength(1);
});
test("adapter failures are isolated and arbitrary provider payloads are discarded", async () => {
  const ctx = makeCtx();
  const bad: ObservationAdapter = { id: "bad", methods: ["usage"], async observe() { throw Error("secret-value"); } };
  const unsupported: ObservationAdapter = { id: "none", methods: [], async observe() { throw Error("must not call"); } };
  const good: ObservationAdapter = { id: "good", methods: ["health"], async observe() { return [{ source: "good", scope, method: "health", state: "known", observedAt: ctx.now, expiresAt: ctx.now + 10, value: { healthy: true }, secret: "secret-value" } as never]; } };
  const result = await collectObservations(ctx, [bad, unsupported, good], [scope]);
  expect(result.some(o => o.source === "bad" && o.state === "error")).toBe(true);
  expect(result.some(o => o.source === "none" && o.state === "unsupported")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("secret-value");
});
test("hung adapters cannot block observation collection", async () => {
  const result = await collectObservations(makeCtx(), [{ id: "hung", methods: ["usage"], observe: () => new Promise(() => {}) }], [scope], 5);
  expect(result.find(o => o.method === "usage")?.state).toBe("error");
});
test("fresh binding-scoped capability evidence affects only its model", () => {
  const s = validateStrategy({ planner: "claude-code", accounts: { "claude-code": {kind: "claude"}, codex: {kind: "codex"} }, runners: { codex: {models: [{id: "provider/a"}, {id: "provider/b"}]} } }, "test");
  const o = { source: "adapter", scope: {...scope, binding: {kind: "exact" as const, id: "provider/a"}}, method: "capabilities" as const, state: "known" as const, observedAt: 90, expiresAt: 110, value: {tools: true, context: 12000} };
  const inventory = buildModelInventory(s, [o], 100).filter(m => m.runner === "codex");
  expect(inventory[0].tools).toBe(true); expect(inventory[1].tools).toBeUndefined();
  expect(buildModelInventory(s, [o], 120).find(m => m.binding.kind === "exact" && m.binding.id === "provider/a")?.tools).toBeUndefined();
});
