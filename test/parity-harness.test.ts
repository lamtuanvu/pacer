import { expect, test } from "bun:test";
import { join } from "node:path";
import { parity } from "./parity-harness";
const fixture = join(import.meta.dir, "fixtures/parity-basic");
const command = [process.execPath, join(import.meta.dir, "fixtures/parity-peer.ts")];
const run = (mode = "same", extra = {}) => parity({ fixture, reference: command, candidate: [...command, mode], steps: [{ op: "write", params: { value: "kept" } }, { op: "read" }], ...extra });
test("two sessions compare results and persisted state on disposable copies", async () => { await run(); });
test("result mismatch is detected", async () => { await expect(run("result")).rejects.toThrow("response mismatch"); });
test("persisted state mismatch is detected", async () => { await expect(run("state")).rejects.toThrow("filesystem mismatch"); });
test("malformed RPC is rejected", async () => { await expect(run("malformed")).rejects.toThrow("malformed"); });
test("mismatched response IDs are rejected", async () => { await expect(run("id")).rejects.toThrow("id"); });
test("silent peer times out", async () => { await expect(run("timeout", { timeoutMs: 200 })).rejects.toThrow("timed out"); });
test("native requirements fail without independent native execution evidence", async () => { await expect(run("same", { native: ["write"] })).rejects.toThrow("native execution evidence unavailable"); });
test("business timestamps and IDs are compared exactly by default", async () => { await expect(run("timestamp")).rejects.toThrow("response mismatch"); });
test("real TypeScript stdio reference smoke", async () => {
  const core = [process.execPath, join(import.meta.dir, "../src/cli.ts"), "api", "--stdio"];
  await parity({ fixture, reference: core, candidate: core, steps: [{ op: "version.get", expect: "ok" }, { op: "nonexistent.operation", expect: "error" }] });
});
test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("explicit compiled front door smoke (forwarding only, no native claim)", async () => {
  await parity({ fixture, reference: process.env.PACER_TEST_REFERENCE_CORE ? [process.env.PACER_TEST_REFERENCE_CORE, "api", "--stdio"] : [process.execPath, join(import.meta.dir, "../src/cli.ts"), "api", "--stdio"], candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"], steps: [{ op: "version.get", expect: "ok" }, { op: "nonexistent.operation", expect: "error" }] });
});
test("expected success cannot silently accept equal application errors", async () => {
  await expect(run("error", { reference: [...command, "error"], steps: [{ op: "write", expect: "ok" }] })).rejects.toThrow("expected success");
});
