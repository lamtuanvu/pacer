import { expect, test } from "bun:test";
import * as protocol from "../src/plugins/protocol";
import { hostRangeAccepts } from "../src/plugins/manifest";

// Dropping any current or future reading field changes permission-bearing evidence.
const window = { name: "weekly", usedPct: 25, resetsAt: 200, lengthS: 604800, paced: true, stale: false, futureWindow: { level: 2 } };
const scope = { account: "work", identity: "public-fixture", runner: "codex", model: "public/code", host: "fixture" };
const fact = { id: "public-evidence", scope, source: "session-log", observedAt: 100, validUntil: 200, reason: "observed", budgetPolicy: "fixture", futureFact: true };
const reading = {
  windows: [window], capturedAt: 100, stale: false, source: "session-log", remoteHost: "fixture", error: "fixture warning", spendUsd: 12,
  availability: { state: "unknown", reason: "conflict", validUntil: 200, futureAvailability: "retained" },
  spending: { creditsAvailable: true, creditBalance: 8, paidConsumption: "unknown", futureSpending: [1] },
  evidence: { availability: [{ ...fact, value: "ready" }], budget: [{ ...fact, value: window }],
    spending: [{ ...fact, value: { creditsAvailable: true, creditBalance: 8, paidConsumption: "unknown" } }], futureEvidence: { keep: true } },
  alternatives: [{ windows: [], capturedAt: null, stale: true, futureAlternative: { preserve: true } }],
  futureReading: { nested: [null, "λ", { keep: true }] },
};

test("usage result validation retains recursive rich evidence and unknown fields", () => {
  const method = protocol.EXTENSION_METHODS["usage.read"];
  expect(method).toBeDefined();
  expect(method.result.parse(reading)).toEqual(reading);
  expect(method.result.safeParse({ ...reading, spending: { creditsAvailable: "yes", creditBalance: 8, paidConsumption: "unknown" } }).success).toBe(false);
  expect(method.result.safeParse({ ...reading, alternatives: [{ windows: [], capturedAt: null, stale: "no" }] }).success).toBe(false);
  expect(method.result.safeParse({ ...reading, evidence: { ...reading.evidence, budget: [{ ...fact, value: { ...window, usedPct: "25" } }] } }).success).toBe(false);
});

test("usage input projects account identity and budget clocks without forwarding credentials", () => {
  const safe = { provider: "codex", usage: "quota", account: { name: "work", kind: "codex", source: "pacer" }, accountHome: "/fixture/accounts/work",
    model: "public/code", weeklyTokens: 1000, weeklyUsd: 40, quotaSource: null, now: 100, readOnly: true, refresh: false };
  const schema = protocol.EXTENSION_METHODS["usage.read"]?.params;
  expect(schema).toBeDefined();
  expect(schema.parse({ ...safe, env: { FIXTURE_SECRET: "do-not-forward" }, account: { ...safe.account, connection: { key: "never-forward" }, home: "/unapproved" } })).toEqual(safe);
  expect(schema.safeParse({ ...safe, account: { ...safe.account, name: 7 } }).success).toBe(false);
  expect(schema.safeParse({ ...safe, now: Infinity }).success).toBe(false);
  expect(protocol.EXTENSION_METHODS["usage.read"].deadlineMs).toBe(10000);
});

test("future usage protocol keeps old diagnostic and agentSession contracts compatible", () => {
  expect(protocol.PLUGIN_PROTOCOL_VERSION).toBe("1.2.0");
  expect(hostRangeAccepts("^1", protocol.PLUGIN_PROTOCOL_VERSION)).toBe(true);
  expect(protocol.manifestSchema.safeParse({ id: "old-plugin", publisher: "public", version: "1.0.0", host: "^1", contributes: { diagnostic: {}, agentSession: {} }, capabilities: [{ name: "log" }] }).success).toBe(true);
  expect(protocol.helloResult.safeParse({ protocol: "1.0.0", id: "old-plugin", version: "1.0.0", contributes: ["diagnostic", "agentSession"] }).success).toBe(true);
  expect(protocol.EXTENSION_METHODS["agentSession.capabilities"].params.parse({ agent: "codex", version: "1" })).toEqual({ agent: "codex", version: "1" });
  expect(protocol.EXTENSION_METHODS["diagnostic.ping"].result.parse({ ok: true, uptimeS: 2 })).toEqual({ ok: true, uptimeS: 2 });
});

test("optional call metadata adds bounded correlation without requiring old peers to supply it", () => {
  const meta = (protocol as any).callMetadata;
  expect(meta).toBeDefined();
  expect(meta.parse(undefined)).toBeUndefined();
  expect(meta.parse({ capabilityCall: "a".repeat(32), future: "ignored" })).toEqual({ capabilityCall: "a".repeat(32), future: "ignored" });
  for (const capabilityCall of ["", "x".repeat(257), 7]) expect(meta.safeParse({ capabilityCall }).success).toBe(false);
});

// Correlation must appear in the canonical artifact consumed by Rust generation.
test("canonical schema includes additive correlation metadata", async () => {
  const { pluginProtocolSchema } = await import("../scripts/plugin-protocol-doc");
  const schema = pluginProtocolSchema() as { $defs: Record<string, any> };
  expect(schema.$defs["callMetadata"]).toBeDefined();
  expect(schema.$defs["callMetadata"].properties.capabilityCall.maxLength).toBe(256);
});

test("cursor state carries dirty retry metadata without changing cache envelopes", () => {
  const begin = protocol.CAPABILITY_METHODS["capability.usage.state.begin"];
  const commit = protocol.CAPABILITY_METHODS["capability.usage.state.commit"];
  expect(begin.result.parse({ lease: "lease", bytes: 0, version: 4, dirty: true })).toHaveProperty("dirty", true);
  expect(commit.params.parse({ lease: "lease", dirty: false })).toHaveProperty("dirty", false);
  expect(commit.params.parse({ lease: "lease" })).toEqual({ lease: "lease" });
});
