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

test("provider commands reject plugin-selected environment cwd and stdin", () => {
  const schema = CAPABILITY_METHODS["capability.process.spawn"]?.params;
  expect(schema).toBeDefined();
  const safe = { argv: ["arkcli", "usage", "plan", "--product", "coding-plan"], timeoutMs: 8000 };
  expect(schema.safeParse(safe).success).toBe(true);
  for (const change of [{ env: { FIXTURE_SECRET: "no" } }, { cwd: "/elsewhere" }, { stdin: "no" }]) expect(schema.safeParse({ ...safe, ...change }).success).toBe(false);
});

test("host-derived reader paths survive only explicit resources projection", () => {
  const params = { provider: "claude-code", account: null, accountHome: null, model: null, weeklyTokens: null, weeklyUsd: null,
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
