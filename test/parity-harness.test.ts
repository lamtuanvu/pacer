import { helloBody } from "../src/api/protocol";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { parity } from "./parity-harness";
const fixture = join(import.meta.dir, "fixtures/parity-basic");
const command = [process.execPath, join(import.meta.dir, "fixtures/parity-peer.ts")];
const coreArgv = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const run = (mode = "same", extra = {}) => parity({ fixture, reference: command, candidate: [...command, mode], steps: [{ op: "write", params: { value: "kept" } }, { op: "read" }], ...extra });
test("two sessions compare results and persisted state on disposable copies", async () => { await run(); });
test("result mismatch is detected", async () => { await expect(run("result")).rejects.toThrow("response mismatch"); });
test("persisted state mismatch is detected", async () => { await expect(run("state")).rejects.toThrow("filesystem mismatch"); });
test.each(["state-mode", "state-extra", "state-link"])("full persisted tree detects %s mismatch", async mode => {
  await expect(run(mode)).rejects.toThrow("filesystem mismatch");
});
test("candidate Bun install cache does not count as persisted state", async () => { await run("bun-cache"); });
test("candidate state beside Bun install cache still counts", async () => { await expect(run("bun-install-state")).rejects.toThrow("filesystem mismatch"); });
test("malformed RPC is rejected", async () => { await expect(run("malformed")).rejects.toThrow("malformed"); });
test("mismatched response IDs are rejected", async () => { await expect(run("id")).rejects.toThrow("id"); });
test("silent peer times out", async () => { await expect(run("timeout", { timeoutMs: 200 })).rejects.toThrow("timed out"); });
test("native requirements fail without independent native execution evidence", async () => { await expect(run("same", { native: ["write"] })).rejects.toThrow("native execution evidence unavailable"); });
test("native requirements must name an operation that was exercised", async () => {
  await expect(run("same", { native: ["never.called"] })).rejects.toThrow("native requirement never.called has no operation step");
});
test("zero native markers for a required request cannot certify parity", async () => {
  await expect(run("native-no-marker", { native: ["write"] })).rejects.toThrow("native execution evidence unavailable for write request 2");
});
test("one native marker cannot cover two correlated calls", async () => {
  await expect(run("native-once", { native: ["write"], steps: [
    { op: "write", params: { value: "kept" } }, { op: "write", params: { value: "kept" } },
  ] })).rejects.toThrow("native execution evidence unavailable");
});
test("duplicate native markers for one request cannot certify parity", async () => {
  await expect(run("native-duplicate", { native: ["write"] })).rejects.toThrow("native execution evidence unavailable");
});
test("native marker for an unknown request id cannot certify parity", async () => {
  await expect(run("native-unknown-id", { native: ["write"] })).rejects.toThrow("native execution evidence unavailable");
});
test("front-loaded native markers cannot cover a later call", async () => {
  await expect(run("native-frontloaded", { native: ["write"], steps: [
    { op: "write", params: { value: "kept" } }, { op: "write", params: { value: "kept" } },
  ] })).rejects.toThrow("native execution evidence unavailable");
});
test("business timestamps and IDs are compared exactly by default", async () => { await expect(run("timestamp")).rejects.toThrow("response mismatch"); });
test("real TypeScript stdio reference smoke", async () => {
  const cli = realpathSync(join(import.meta.dir, "../src/cli.ts"));
  const core = [process.execPath, "--preload", join(import.meta.dir, "fixtures/parity-stdin-ready.ts"), cli, "api", "--stdio"];
  const readyLine = JSON.stringify({ type: "pacer-parity-ready", main: cli, argv: [cli, "api", "--stdio"] });
  await parity({ fixture, reference: core, candidate: core, startup: { readyLine, timeoutMs: 30000 }, steps: [{ op: "version.get", expect: "ok" }, { op: "nonexistent.operation", expect: "error" }] });
}, 60000);
test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("explicit compiled front door smoke (forwarding only, no native claim)", async () => {
  await parity({ fixture, reference: process.env.PACER_TEST_REFERENCE_CORE ? [process.env.PACER_TEST_REFERENCE_CORE, "api", "--stdio"] : [process.execPath, join(import.meta.dir, "../src/cli.ts"), "api", "--stdio"], candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"], steps: [{ op: "version.get", expect: "ok" }, { op: "nonexistent.operation", expect: "error" }], candidateEnv: { PACER_CORE_ARGV: coreArgv } });
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

// Deliberately spend longer importing than the operation budget. Readiness must
// complete before hello starts, while a peer that never becomes ready still fails.
test("explicit startup readiness does not consume the operation deadline", async () => {
  await run("startup-delay", { reference: [...command, "startup-delay"], timeoutMs: 100,
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 1000 } });
});
test("startup readiness remains bounded independently of requests", async () => {
  await expect(run("startup-stall", { reference: [...command, "startup-stall"], timeoutMs: 100,
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 100 } })).rejects.toThrow("stdio startup timed out");
});

test("a ready peer still obeys the operation deadline", async () => {
  await expect(run("ready-timeout", { reference: [...command, "ready-timeout"], timeoutMs: 100,
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 1000 } })).rejects.toThrow("hello timed out");
});
test("startup failure retains the isolated child diagnostic", async () => {
  await expect(run("startup-error", { reference: [...command, "startup-error"], timeoutMs: 100,
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 1000 } })).rejects.toThrow("synthetic startup import failure");
});

test("stderr readiness cannot hide arbitrary non-JSON stdout", async () => {
  await expect(run("ready-noise", { reference: [...command, "ready-noise"], timeoutMs: 100,
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 1000 } })).rejects.toThrow("malformed JSON-RPC response");
});
test("CLI readiness preload rejects substituted executable arguments", async () => {
  const cli = realpathSync(join(import.meta.dir, "../src/cli.ts"));
  const wrong = [process.execPath, "--preload", join(import.meta.dir, "fixtures/parity-stdin-ready.ts"), cli, "--help"];
  await expect(parity({ fixture, reference: wrong, candidate: wrong, steps: [],
    startup: { readyLine: "pacer-parity-ready", timeoutMs: 1000 } })).rejects.toThrow("requires the actual CLI entry and api --stdio argv");
});

test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("feature-gated echo runs natively with strict evidence", async () => {
  await parity({ fixture, reference: [process.execPath, join(import.meta.dir, "fixtures/parity-native-peer.ts")],
    candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"],
    referenceEnv: { PACER_TEST_HELLO: JSON.stringify(helloBody()) }, candidateEnv: { PACER_DEBUG_NATIVE: "1", PACER_CORE_ARGV: coreArgv }, native: ["test.echo"],
    steps: [{ op: "test.echo", params: { ok: true }, expect: "ok" }] });
});
test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("echo mismatch is a parity failure", async () => {
  await expect(parity({ fixture, reference: [process.execPath, join(import.meta.dir, "fixtures/parity-native-peer.ts")],
    candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"],
    referenceEnv: { PACER_TEST_HELLO: JSON.stringify(helloBody()) }, candidateEnv: { PACER_DEBUG_NATIVE: "1", PACER_CORE_ARGV: coreArgv, PACER_TEST_ECHO_BREAK: "1" }, native: ["test.echo"],
    steps: [{ op: "test.echo", params: { ok: true } }] })).rejects.toThrow("response mismatch");
});
test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("every repeated echo call needs native execution evidence", async () => {
  await parity({ fixture, reference: [process.execPath, join(import.meta.dir, "fixtures/parity-native-peer.ts")],
    candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"],
    referenceEnv: { PACER_TEST_HELLO: JSON.stringify(helloBody()) }, candidateEnv: { PACER_DEBUG_NATIVE: "1", PACER_CORE_ARGV: coreArgv }, native: ["test.echo"],
    steps: [{ op: "test.echo", params: { n: 1 }, expect: "ok" }, { op: "test.echo", params: { n: 2 }, expect: "ok" }] });
});
test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("forced-forward echo cannot satisfy a native requirement", async () => {
  await expect(parity({ fixture, reference: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "api", "--stdio"],
    candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"],
    candidateEnv: { PACER_DEBUG_NATIVE: "1", PACER_CORE_ARGV: coreArgv, PACER_FORWARD_OPS: "test.echo" }, native: ["test.echo"],
    steps: [{ op: "test.echo", params: { ok: true }, expect: "error" }] })).rejects.toThrow("native execution evidence unavailable");
});

test.skipIf(!process.env.PACER_TEST_FRONT_DOOR)("real forwarded operation cannot satisfy native requirement", async () => {
  await expect(parity({ fixture, reference: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "api", "--stdio"],
    candidate: [process.env.PACER_TEST_FRONT_DOOR!, "api", "--stdio"],
    candidateEnv: { PACER_CORE_ARGV: coreArgv, PACER_DEBUG_NATIVE: "1" },
    native: ["version.get"], steps: [{ op: "version.get", expect: "ok" }] })).rejects.toThrow("native execution evidence unavailable");
});
