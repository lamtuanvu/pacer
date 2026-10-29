import { expect, test } from "bun:test";
import { manifestSchema, PLUGIN_PROTOCOL_VERSION, EXTENSION_METHODS, EXTENSION_POINTS, CAPABILITIES, CAPABILITY_METHODS } from "../src/plugins/protocol";
import { handOver } from "../src/discovery/handover";
import { fakeCtx } from "./helpers";
import type { Seen } from "../src/discovery/state";

const seen: Seen = { discoveryId: "a".repeat(26), name: "studio", version: "1.0.0", hints: "port=7", network: "k1", firstSeen: 1, lastSeen: 2 };
const plugin = (id: string, over: object = {}) => ({ id, enabled: true, contributes: ["pairing"], ...over }) as any;
const registry = (plugins: any[], answer: (id: string, method: string, params: unknown) => unknown) => {
  const calls: [string, string, unknown][] = [];
  return { calls, list: () => plugins, call: async (_ctx: unknown, id: string, method: string, params: unknown) => { calls.push([id, method, params]); return answer(id, method, params); } } as any;
};

test("protocol 1.5.0 has the pairing point, its method and the net.p2p capability", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.5.0");
  expect(EXTENSION_POINTS).toContain("pairing");
  expect(CAPABILITIES).toContain("net.p2p");
  const start = EXTENSION_METHODS["pairing.start"]!;
  expect(start.deadlineMs).toBe(5000);
  expect(start.params.safeParse({ discoveryId: seen.discoveryId, name: "studio", hints: "" }).success).toBe(true);
  expect(start.params.safeParse({ discoveryId: "nope", name: "studio", hints: "" }).success).toBe(false);
  expect(start.params.safeParse({ discoveryId: seen.discoveryId, name: "x".repeat(65), hints: "" }).success).toBe(false);
  expect(start.params.safeParse({ discoveryId: seen.discoveryId, name: "x", hints: "h".repeat(201) }).success).toBe(false);
  expect(start.result.safeParse({ accepted: true }).success).toBe(true);
  expect(start.result.safeParse({ bogus: 1 }).success).toBe(false);
  // Declarative: no host methods yet.
  expect(Object.keys(CAPABILITY_METHODS).some(m => m.startsWith("capability.net.p2p"))).toBe(false);
});

test("contributes.pairing requires net.p2p and host >= 1.5.0", () => {
  const base = { id: "demo", version: "1.0.0", publisher: "t", contributes: { pairing: {} } };
  expect(() => manifestSchema.parse({ ...base, host: ">=1.5.0" })).toThrow(/declares net.p2p/);
  expect(() => manifestSchema.parse({ ...base, host: "^1", capabilities: [{ name: "net.p2p" }] })).toThrow(/>=1.5.0/);
  expect(() => manifestSchema.parse({ ...base, host: "^1.4.0", capabilities: [{ name: "net.p2p" }] })).toThrow(/>=1.5.0/);
  expect(manifestSchema.parse({ ...base, host: ">=1.5.0", capabilities: [{ name: "net.p2p" }] }).id).toBe("demo");
  // net.p2p alone is fine on older host ranges; only the pairing contribution needs the floor.
  expect(manifestSchema.parse({ id: "demo", version: "1.0.0", publisher: "t", host: "^1", capabilities: [{ name: "net.p2p" }] }).id).toBe("demo");
});

test("handOver gives Pair to an enabled pairing plugin that accepts", async () => {
  const reg = registry([plugin("off", { enabled: false }), plugin("other", { contributes: ["ui"] }), plugin("demo")], () => ({ accepted: true }));
  expect(await handOver(fakeCtx(), seen, { registry: reg })).toEqual({ handedOver: true, plugin: "demo" });
  expect(reg.calls).toEqual([["demo", "pairing.start", { discoveryId: seen.discoveryId, name: "studio", hints: "port=7" }]]);
});

test("handOver validates the pairing.start result against the method's schema", async () => {
  expect(await handOver(fakeCtx(), seen, { registry: registry([plugin("demo")], () => ({ bogus: 1 })) })).toEqual({ handedOver: false });
  expect(await handOver(fakeCtx(), seen, { registry: registry([plugin("demo")], () => ({ accepted: "yes" })) })).toEqual({ handedOver: false });
  expect(await handOver(fakeCtx(), seen, { registry: registry([plugin("demo")], () => ({ accepted: false })) })).toEqual({ handedOver: false });
});

test("a plugin error is not handed over and the next plugin is tried", async () => {
  const reg = registry([plugin("broken"), plugin("good")], id => { if (id === "broken") throw new Error("boom"); return { accepted: true }; });
  expect(await handOver(fakeCtx(), seen, { registry: reg })).toEqual({ handedOver: true, plugin: "good" });
  const failing = registry([plugin("broken")], () => { throw new Error("boom"); });
  expect(await handOver(fakeCtx(), seen, { registry: failing })).toEqual({ handedOver: false });
});

test("with no pairing plugin nothing is called", async () => {
  const reg = registry([], () => ({ accepted: true }));
  expect(await handOver(fakeCtx(), seen, { registry: reg })).toEqual({ handedOver: false });
  expect(reg.calls).toEqual([]);
});

test("an invalid pairing.start result is logged to the plugin's log", async () => {
  const { readFileSync } = await import("node:fs");
  const { pluginLogPath } = await import("../src/plugins/host");
  const ctx = fakeCtx();
  await handOver(ctx, seen, { registry: registry([plugin("demo")], () => ({ bogus: 1 })) });
  expect(readFileSync(pluginLogPath(ctx, "demo"), "utf8")).toContain("invalid pairing.start result: accepted");
});

test("handOver stops at its overall time budget, so slow plugins cannot outlast the client (N2)", async () => {
  const { readFileSync } = await import("node:fs");
  const { pluginLogPath } = await import("../src/plugins/host");
  const ctx = fakeCtx();
  const options: any[] = [];
  const reg = { calls: [] as string[], list: () => [plugin("slow"), plugin("never")], call: (_c: unknown, id: string, _m: string, _p: unknown, o: unknown) => { reg.calls.push(id); options.push(o); return new Promise(() => {}); } } as any;
  const started = Date.now();
  expect(await handOver(ctx, seen, { registry: reg, budgetMs: 60 })).toEqual({ handedOver: false });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(reg.calls).toEqual(["slow"]);
  expect(options[0].deadlineMs).toBeLessThanOrEqual(60);
  expect(options[0].signal).toBeInstanceOf(AbortSignal);
  expect(readFileSync(pluginLogPath(ctx, "slow"), "utf8")).toContain("pairing.start failed: hand-over time budget");
});

test("a thrown plugin error is logged to the plugin's log (N2)", async () => {
  const { readFileSync } = await import("node:fs");
  const { pluginLogPath } = await import("../src/plugins/host");
  const ctx = fakeCtx();
  await handOver(ctx, seen, { registry: registry([plugin("broken")], () => { throw new Error("boom"); }) });
  expect(readFileSync(pluginLogPath(ctx, "broken"), "utf8")).toContain("pairing.start failed: boom");
});

test("a successful hand-over is recorded and closes the found-machine prompt; a refused one keeps it (N3)", async () => {
  const { pair } = await import("../src/discovery/handover");
  const { recordObservations } = await import("../src/discovery/radio");
  const { readState } = await import("../src/discovery/state");
  const { discoveryRuleInput } = await import("../src/discovery/prompts");
  const ctx = fakeCtx();
  const now = Math.floor(Date.now() / 1000);
  await recordObservations(ctx, [{ id: seen.discoveryId, name: "studio", v: "1", h: "" }], { now, network: null });
  const open = () => discoveryRuleInput(ctx, now, { registry: { list: () => [] } })!.prompted.map(p => p.discoveryId);
  expect(open()).toEqual([seen.discoveryId]);
  expect(await pair(ctx, readState(ctx).seen[seen.discoveryId], { registry: registry([plugin("demo")], () => ({ accepted: false })), now })).toEqual({ handedOver: false });
  expect(readState(ctx).seen[seen.discoveryId].handedOverAt).toBeUndefined();
  expect(open()).toEqual([seen.discoveryId]);
  expect(await pair(ctx, readState(ctx).seen[seen.discoveryId], { registry: registry([plugin("demo")], () => ({ accepted: true })), now: now + 5 })).toEqual({ handedOver: true, plugin: "demo" });
  expect(readState(ctx).seen[seen.discoveryId].handedOverAt).toBe(now + 5);
  expect(open()).toEqual([]);
});
