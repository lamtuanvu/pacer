import { expect, test } from "bun:test";
import { CAPABILITY_METHODS, capabilityOf, usageReadParams } from "../src/plugins/protocol";

test("bounded FS/state chunks share their explicitly declared capability", () => {
  for (const name of ["stat", "readRange", "list"]) expect(capabilityOf(`capability.fs.${name}`)).toBe("fs.read");
  for (const name of ["begin", "readChunk", "stageChunk", "commit", "release"]) expect(capabilityOf(`capability.usage.state.${name}`)).toBe("usage.state");
  expect(capabilityOf("capability.process.outputChunk")).toBe("process.spawn");
  const schema = CAPABILITY_METHODS["capability.fs.readRange"]?.params;
  expect(schema).toBeDefined();
  const safe = { path: "/fixture/log", offset: 0, length: 262144, expected: { size: 9000000, mtimeMs: 100, inode: 1, device: 1 } };
  expect(schema.safeParse(safe).success).toBe(true);
  for (const change of [{ length: 262145 }, { offset: -1 }, { offset: Infinity }]) expect(schema.safeParse({ ...safe, ...change }).success).toBe(false);
  expect(CAPABILITY_METHODS["capability.fs.list"].params.safeParse({ dir: "/fixture", glob: "**/rollout-*.jsonl", limit: 1001 }).success).toBe(false);
});

test("spawn wire accepts bounded stdin and context but rejects malformed references", () => {
  const schema = CAPABILITY_METHODS["capability.process.spawn"]?.params;
  expect(schema).toBeDefined();
  const safe = { argv: ["arkcli", "usage", "plan", "--product", "coding-plan"], timeoutMs: 8000 };
  expect(schema.safeParse(safe).success).toBe(true);
  expect(schema.safeParse({ ...safe, timeoutMs: 1_800_000 }).success).toBe(true);
  expect(schema.safeParse({ ...safe, timeoutMs: 1_800_001 }).success).toBe(false);
  for (const change of [{ env: { PLAIN: "value" } }, { cwd: "/fixture/owned" }, { env: { KEY: {secretRef: "endpoint:owned"} } }]) expect(schema.safeParse({ ...safe, ...change }).success).toBe(true);
  expect(schema.safeParse({ ...safe, stdin: "owned input" }).success).toBe(true);
  for (const change of [{ stdin: "x".repeat(262145) }, { env: { KEY: {secretRef: "raw-value"} } }, { env: { KEY: {secretRef: "endpoint:owned", extra:true} } }]) expect(schema.safeParse({ ...safe, ...change }).success).toBe(false);
});

test("host-derived reader paths survive only explicit resources projection", () => {
  const params = { provider: "claude-code", usage: "quota" as const, account: null, accountHome: null, model: null, weeklyTokens: null, weeklyUsd: null,
    quotaSource: null, now: 1, refresh: false, readOnly: false,
    resources: { claudeFiles: ["/fixture/cache/claude.json"], codexSessions: "/fixture/sessions", credentials: "/fixture/secret" } };
  expect(usageReadParams.parse(params)).toEqual({ ...params, resources: { claudeFiles: ["/fixture/cache/claude.json"], codexSessions: "/fixture/sessions" } });
});

test("chunked result support is explicitly negotiated without changing legacy hello", async () => {
  const { helloParams, helloResult } = await import("../src/plugins/protocol");
  const legacy = { protocol: "1.0.0", id: "legacy-plugin", version: "1.0.0", contributes: ["diagnostic"] };
  expect(helloResult.parse(legacy)).toEqual(legacy);
  expect(helloResult.parse({ ...legacy, protocol: "1.1.0", features: ["chunkedResults"] })).toEqual({ ...legacy, protocol: "1.1.0", features: ["chunkedResults"] });
  expect(helloParams.shape.features).toBeDefined();
});
