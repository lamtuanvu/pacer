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

test("identical rejected hello cannot certify parity with no operation steps", async () => {
  await expect(run("hello-error", { reference: [...command, "hello-error"], steps: [] })).rejects.toThrow("hello: expected protocol 3.0.0 success");
});
test("identical wrong protocol hello cannot certify parity", async () => {
  await expect(run("hello-wrong", { reference: [...command, "hello-wrong"], steps: [] })).rejects.toThrow("hello: expected protocol 3.0.0 success");
});
test("fixture symlinks are refused before either child can mutate shared fixture state", async () => {
  const { mkdtempSync, cpSync, symlinkSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const temporary = mkdtempSync(join(tmpdir(), "pacer-parity-link-test-"));
  try {
    cpSync(fixture, temporary, { recursive: true });
    const original = readFileSync(join(temporary, "seed.json"), "utf8");
    symlinkSync("seed.json", join(temporary, "alias.json"));
    await expect(run("symlink-write", { fixture: temporary, reference: [...command, "symlink-write"], steps: [] })).rejects.toThrow("fixture symlinks are not supported");
    expect(readFileSync(join(temporary, "seed.json"), "utf8")).toBe(original);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test("shutdown deadline includes stdout held open by a descendant after direct child exits", async () => {
  const start = performance.now();
  await expect(run("inherited-stdout", { reference: [...command, "inherited-stdout"], steps: [], timeoutMs: 150 })).rejects.toThrow("stdio shutdown timed out");
  expect(performance.now() - start).toBeLessThan(1500);
});
test("request deadline covers stdin backpressure before a reply can be read", async () => {
  const start = performance.now();
  await expect(run("pause-input", {
    reference: [...command, "pause-input"], timeoutMs: 200,
    steps: [{ op: "write", params: { value: "x".repeat(8 * 1024 * 1024) } }],
  })).rejects.toThrow("write timed out");
  expect(performance.now() - start).toBeLessThan(1500);
});
